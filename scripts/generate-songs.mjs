#!/usr/bin/env node
// Boulevard generation pipeline.
//
//   prompts.json  →  Suno v5.5  →  songs_queue (raw_audio_url)
//                                       ↓
//                                 Quality filter
//                                       ↓
//                  approve  →  promote_song_to_catalog()  →  public.songs (status='live')
//                  review   →  manual queue, status='completed'
//                  reject   →  status='rejected' with reason
//
// Usage:
//   npm run generate:songs                       # reads ./prompts.json
//   npm run generate:songs -- --file my.json     # alternate path
//   npm run generate:songs -- --max 5            # cap how many to fan out
//
// NOTE: There is no `--auto-promote` flag. By design. Generated songs land
// in songs_queue with status='completed' and (via promote_song_to_catalog)
// in songs with approved_by_human=false. The only way to flip a song live
// is the human-review dashboard. This prevents any bug, accident, or
// over-eager batch script from pushing mediocre music to users.
//
// .env requirements:
//   EXPO_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY      # bypasses RLS to write songs_queue/songs
//   SUNO_API_KEY                   # Suno v5.5 API key
//   SUNO_BASE_URL                  # optional override, defaults to https://api.suno.ai
//
// Note: R2 upload is left as a stub — when you have a Cloudflare R2 bucket
// configured, fill in uploadToR2() below. Until then, the script stores
// Suno's CDN URL directly in songs.audio_url, which works but isn't the
// resilient path we want long-term.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
dotenv.config({ path: join(repoRoot, '.env') });

// ---- args ----
const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const promptsPath = resolve(repoRoot, fileArg >= 0 ? args[fileArg + 1] : 'prompts.json');
const maxArg = args.indexOf('--max');
const MAX = maxArg >= 0 ? parseInt(args[maxArg + 1], 10) : Infinity;
// --auto-promote is intentionally NOT supported. Every generated song must
// go through the human-review dashboard before reaching the app.

// ---- env ----
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUNO_KEY = process.env.SUNO_API_KEY;
const SUNO_BASE = process.env.SUNO_BASE_URL ?? 'https://api.suno.ai';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
if (!SUNO_KEY) {
  console.error('Missing SUNO_API_KEY in .env — add your Suno v5.5 key.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---- Suno helpers (inline, mirrors src/lib/generation/SunoClient.ts) ----
async function sunoGenerate(req) {
  const res = await fetch(`${SUNO_BASE}/api/v5/generate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUNO_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: req.prompt,
      style: req.style,
      vocal_gender: req.vocal_gender,
      title: req.title,
      target_duration_seconds: req.target_duration_seconds ?? 180,
      model: 'v5.5',
    }),
  });
  if (!res.ok) throw new Error(`suno generate ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sunoTask(task_id) {
  const res = await fetch(`${SUNO_BASE}/api/v5/tasks/${encodeURIComponent(task_id)}`, {
    headers: { 'Authorization': `Bearer ${SUNO_KEY}` },
  });
  if (!res.ok) throw new Error(`suno task ${res.status}: ${await res.text()}`);
  return res.json();
}

async function waitForSuno(task_id, timeoutMs = 6 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const t = await sunoTask(task_id);
    if (t.status === 'completed' || t.status === 'failed') return t;
    if (Date.now() > deadline) return { ...t, status: 'failed', error_message: 'timeout' };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---- R2 upload stub ----
// Replace with @aws-sdk/client-s3 or Cloudflare's REST API.
async function uploadToR2(_sourceUrl, _key) {
  // Returning null tells the caller to fall back to the Suno URL.
  return null;
}

// ---- Quality (inline copy of QualityFilter thresholds) ----
const W = { intro: 0.15, hook: 0.25, vocal: 0.20, prod: 0.15, replay: 0.25 };
const HARD = 0.30, APPROVE = 0.70, REVIEW = 0.50;
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function heuristicScores(taskResult, vocal_gender) {
  const m = taskResult.metrics ?? {};
  const dur = taskResult.duration_seconds ?? 0;
  const durFit = dur >= 90 && dur <= 300 ? 1 : dur > 0 ? 0.4 : 0.1;
  const isVocal = vocal_gender && vocal_gender !== 'instrumental';
  return {
    intro_strength: clamp01(0.55 + (m.coherence ?? 0.5) * 0.35),
    hook_quality: clamp01(0.50 + (m.coherence ?? 0.5) * 0.30 + durFit * 0.15),
    vocal_quality: isVocal ? clamp01((m.vocal_clarity ?? 0.5) * 0.85 + 0.10) : 1.0,
    production_quality: clamp01((m.audio_quality ?? 0.5) * 0.80 + durFit * 0.15),
    replayability_score: clamp01(0.45 + (m.coherence ?? 0.5) * 0.25 + (m.audio_quality ?? 0.5) * 0.20),
  };
}
function decide(b) {
  const q = clamp01(
    W.intro * b.intro_strength + W.hook * b.hook_quality + W.vocal * b.vocal_quality +
    W.prod * b.production_quality + W.replay * b.replayability_score
  );
  if (b.vocal_quality < HARD) return { verdict: 'reject', q, reason: 'vocals_broken' };
  if (b.intro_strength < HARD) return { verdict: 'reject', q, reason: 'weak_intro' };
  if (b.hook_quality < HARD) return { verdict: 'reject', q, reason: 'weak_chorus' };
  if (b.production_quality < HARD) return { verdict: 'reject', q, reason: 'ai_artifacts' };
  if (b.replayability_score < HARD) return { verdict: 'reject', q, reason: 'low_replayability' };
  if (q >= APPROVE) return { verdict: 'approve', q };
  if (q >= REVIEW) return { verdict: 'review', q, reason: 'borderline_quality' };
  return { verdict: 'reject', q, reason: 'low_overall_quality' };
}

// ---- One prompt → one queue row → one verdict ----
async function processPrompt(prompt) {
  // 1) Enqueue. Inserting up-front means the queue row exists even if Suno
  // crashes mid-flight — we can find orphans by status='generating'.
  const { data: queued, error: qErr } = await sb
    .from('songs_queue')
    .insert({
      title: prompt.title ?? null,
      genre: prompt.genre ?? null,
      mood: prompt.mood ?? null,
      vocal_gender: prompt.vocal_gender ?? null,
      suno_prompt: prompt.suno_prompt,
      status: 'pending',
    })
    .select('id')
    .single();
  if (qErr) throw new Error(`enqueue failed: ${qErr.message}`);
  const queueId = queued.id;
  console.log(`  [${queueId}] enqueued`);

  // 2) Kick off Suno.
  await sb.from('songs_queue').update({ status: 'generating', attempts: 1 }).eq('id', queueId);
  let task;
  try {
    const start = await sunoGenerate({
      prompt: prompt.suno_prompt,
      style: prompt.genre,
      vocal_gender: prompt.vocal_gender,
      title: prompt.title,
      target_duration_seconds: prompt.target_duration_seconds,
    });
    await sb.from('songs_queue').update({ task_id: start.task_id }).eq('id', queueId);
    task = await waitForSuno(start.task_id);
  } catch (e) {
    await sb.from('songs_queue').update({
      status: 'failed', error_message: e.message ?? String(e),
    }).eq('id', queueId);
    console.log(`  [${queueId}] FAILED: ${e.message}`);
    return;
  }

  if (task.status === 'failed' || !task.audio_url) {
    await sb.from('songs_queue').update({
      status: 'failed', error_message: task.error_message ?? 'no audio_url',
    }).eq('id', queueId);
    console.log(`  [${queueId}] FAILED: ${task.error_message ?? 'no audio_url'}`);
    return;
  }

  // 3) Optionally upload to R2 for durable hosting.
  const r2Url = await uploadToR2(task.audio_url, `${queueId}.mp3`).catch(() => null);

  // 4) Score + decide.
  const breakdown = heuristicScores(task, prompt.vocal_gender);
  const verdict = decide(breakdown);

  await sb.from('songs_queue').update({
    status: 'completed',
    raw_audio_url: task.audio_url,
    r2_audio_url: r2Url,
    cover_url: task.cover_url,
    title: task.title ?? prompt.title,
    intro_strength: breakdown.intro_strength,
    hook_quality: breakdown.hook_quality,
    vocal_quality: breakdown.vocal_quality,
    production_quality: breakdown.production_quality,
    replayability_score: breakdown.replayability_score,
    quality_score: verdict.q,
    rejection_reason: verdict.verdict === 'reject' ? verdict.reason : null,
  }).eq('id', queueId);

  if (verdict.verdict === 'reject') {
    await sb.from('songs_queue').update({ status: 'rejected' }).eq('id', queueId);
    console.log(`  [${queueId}] REJECTED (${verdict.reason}, q=${verdict.q.toFixed(2)})`);
    return;
  }

  // No code path here pushes to live. Every completed row sits in the queue
  // awaiting human review in the dashboard.
  console.log(`  [${queueId}] ${verdict.verdict.toUpperCase()} (q=${verdict.q.toFixed(2)}) — awaiting human review`);
}

// ---- main ----
async function main() {
  if (!existsSync(promptsPath)) {
    console.error(`prompts file not found: ${promptsPath}`);
    process.exit(1);
  }
  const raw = await readFile(promptsPath, 'utf8');
  let prompts;
  try { prompts = JSON.parse(raw); } catch (e) {
    console.error(`failed to parse prompts: ${e.message}`); process.exit(1);
  }
  if (!Array.isArray(prompts)) {
    console.error('prompts file must contain a JSON array'); process.exit(1);
  }

  const work = prompts.slice(0, MAX);
  console.log(`Boulevard generation pipeline\n  prompts: ${work.length} (of ${prompts.length})\n  every song requires human dashboard approval before going live.\n`);

  // Run sequentially so we don't blast Suno with concurrent requests. A
  // production pipeline would have a concurrency control / rate limiter.
  for (const p of work) {
    if (!p.suno_prompt) {
      console.log(`  SKIP (missing suno_prompt): ${JSON.stringify(p).slice(0, 80)}`);
      continue;
    }
    try {
      await processPrompt(p);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
