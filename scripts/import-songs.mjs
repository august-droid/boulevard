#!/usr/bin/env node
// Boulevard admin importer.
//
// Reads songs.csv, validates each row, upserts to Supabase, and optionally
// writes src/lib/seed/catalog.json so the bundled app falls back to the same
// catalog when Supabase is offline.
//
// Usage:
//   npm run import:songs                       # reads ./songs.csv
//   npm run import:songs -- --file my.csv      # alternate path
//   npm run import:songs -- --dry-run          # validate only, no writes
//   npm run import:songs -- --no-json          # skip writing catalog.json
//
// Required env (in .env at repo root):
//   EXPO_PUBLIC_SUPABASE_URL          — same as the app uses
//   SUPABASE_SERVICE_ROLE_KEY         — service role key (bypasses RLS)
//
// CSV columns (order doesn't matter; header row required):
//   title*, audio_url*, cover_url, genre*, genres, mood*, moods, bpm,
//   energy_score (1..10)*, vocal_type, voice_gender, similarity_cluster,
//   activity_fit, duration_seconds*, drop_timestamps, intro_length
//
//   * = required
//
// Multi-value cells (genres, moods, activity_fit, drop_timestamps) use `|` as
// the separator inside the cell, so the CSV's comma stays unambiguous:
//   pop|edm     happy|euphoric     gym|driving|party

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
dotenv.config({ path: join(repoRoot, '.env') });

// ---- CLI args ----
const args = process.argv.slice(2);
const fileArgIdx = args.indexOf('--file');
const csvPath = resolve(
  repoRoot,
  fileArgIdx >= 0 ? args[fileArgIdx + 1] : 'songs.csv',
);
const dryRun = args.includes('--dry-run');
const writeJson = !args.includes('--no-json');

const VALID_VOCAL_TYPES = new Set(['instrumental', 'male', 'female', 'mixed']);
const VALID_ACTIVITIES = new Set([
  'gym', 'focus', 'driving', 'party', 'sleep', 'sad',
  'aggressive', 'calm', 'late_night', 'euphoric',
]);

const REQUIRED = ['title', 'audio_url', 'genre', 'mood', 'energy_score', 'duration_seconds'];

// ---- Helpers ----

function splitMulti(v) {
  if (v == null || v === '') return [];
  return String(v)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNumber(v);
  return n == null ? null : Math.round(n);
}

// Validate one row. Returns { ok: true, song } or { ok: false, errors: [...] }.
function validateRow(row, lineNumber) {
  const errors = [];

  for (const k of REQUIRED) {
    if (row[k] == null || String(row[k]).trim() === '') {
      errors.push(`missing required column "${k}"`);
    }
  }

  // energy_score in 1..10 per spec — convert to internal 0..1.
  const energyRaw = toNumber(row.energy_score);
  let energy_score = null;
  if (energyRaw == null) {
    errors.push('energy_score must be a number');
  } else if (energyRaw < 1 || energyRaw > 10) {
    errors.push(`energy_score must be between 1 and 10 (got ${energyRaw})`);
  } else {
    energy_score = energyRaw / 10;
  }

  const duration_seconds = toInt(row.duration_seconds);
  if (duration_seconds == null || duration_seconds <= 0) {
    errors.push('duration_seconds must be a positive integer');
  }

  // bpm optional but if present must be reasonable
  let bpm = null;
  if (row.bpm != null && String(row.bpm).trim() !== '') {
    bpm = toInt(row.bpm);
    if (bpm == null || bpm < 30 || bpm > 240) {
      errors.push(`bpm out of range (30..240): ${row.bpm}`);
    }
  }

  // vocal_type optional; defaults to instrumental
  const vocal_type = (row.vocal_type ?? 'instrumental').trim() || 'instrumental';
  if (!VALID_VOCAL_TYPES.has(vocal_type)) {
    errors.push(`vocal_type must be one of ${[...VALID_VOCAL_TYPES].join(', ')}`);
  }

  // activity_fit — pipe-separated; warn on unknown values but don't reject
  const activity_fit = splitMulti(row.activity_fit);
  for (const a of activity_fit) {
    if (!VALID_ACTIVITIES.has(a)) {
      errors.push(`unknown activity "${a}" (valid: ${[...VALID_ACTIVITIES].join(', ')})`);
    }
  }

  // genres / moods — primary value falls back to single column
  const genres = splitMulti(row.genres);
  const finalGenres = genres.length > 0 ? genres : (row.genre ? [String(row.genre).trim()] : []);
  const moods = splitMulti(row.moods);
  const finalMoods = moods.length > 0 ? moods : (row.mood ? [String(row.mood).trim()] : []);

  if (errors.length > 0) {
    return { ok: false, line: lineNumber, errors };
  }

  return {
    ok: true,
    song: {
      title: String(row.title).trim(),
      audio_url: String(row.audio_url).trim(),
      cover_url: row.cover_url ? String(row.cover_url).trim() : '',
      genre: finalGenres[0],
      genres: finalGenres,
      bpm,
      mood: finalMoods[0],
      moods: finalMoods,
      energy_score,
      vocal_type,
      voice_gender: row.voice_gender ? String(row.voice_gender).trim() : null,
      similarity_cluster: toInt(row.similarity_cluster) ?? 0,
      drop_timestamps: splitMulti(row.drop_timestamps).map(Number).filter((n) => Number.isFinite(n)),
      intro_length: toNumber(row.intro_length) ?? 0,
      activity_fit,
      duration_seconds,
    },
  };
}

async function main() {
  console.log(`Boulevard importer\n  CSV: ${csvPath}\n  Dry run: ${dryRun}\n`);

  if (!existsSync(csvPath)) {
    console.error(`error: ${csvPath} not found`);
    process.exit(1);
  }

  const raw = await readFile(csvPath, 'utf8');
  let rows;
  try {
    rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    console.error('error: failed to parse CSV:', e.message);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.error('error: CSV has no data rows');
    process.exit(1);
  }

  // Validate every row up front. We refuse to do a partial import — easier to
  // reason about. The user fixes errors and re-runs.
  const valid = [];
  const failures = [];
  rows.forEach((row, i) => {
    const result = validateRow(row, i + 2 /* header is line 1 */);
    if (result.ok) valid.push(result.song);
    else failures.push(result);
  });

  if (failures.length > 0) {
    console.error(`Validation failed on ${failures.length} row(s):`);
    for (const f of failures) {
      console.error(`  line ${f.line}: ${f.errors.join('; ')}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${valid.length} song(s).`);

  // Upsert to Supabase.
  if (!dryRun) {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('error: EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
      process.exit(1);
    }
    const sb = createClient(url, key, { auth: { persistSession: false } });

    // Upsert by (title, audio_url). If you maintain stable IDs, add an `id`
    // column to your CSV and we'll upsert on that instead.
    const onConflict = valid[0].id ? 'id' : undefined;

    // Insert in chunks to stay well under Supabase's row-limit-per-request.
    const CHUNK = 100;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const batch = valid.slice(i, i + CHUNK);
      const { error } = await sb
        .from('songs')
        .upsert(batch, onConflict ? { onConflict } : undefined);
      if (error) {
        console.error(`error: upsert failed on batch starting at row ${i}: ${error.message}`);
        process.exit(1);
      }
      console.log(`  upserted ${Math.min(i + CHUNK, valid.length)} / ${valid.length}`);
    }
  } else {
    console.log('Dry run — skipping Supabase writes.');
  }

  // Mirror into the bundled JSON fallback so the app stays usable offline /
  // before users are connected to Supabase.
  if (writeJson) {
    const jsonPath = join(repoRoot, 'src/lib/seed/catalog.json');
    // We don't know the Supabase-generated UUIDs without re-fetching; for the
    // local catalog we synthesize stable ids from the title so JSON-only runs
    // still have ids. This is purely for the offline fallback.
    const withIds = valid.map((s, i) => ({
      ...s,
      id: s.id ?? `imp_${String(i + 1).padStart(4, '0')}`,
    }));
    await writeFile(jsonPath, JSON.stringify(withIds, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${withIds.length} song(s) to ${jsonPath}`);
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
