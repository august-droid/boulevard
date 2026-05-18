/* eslint-disable no-console */
// ============================================================
// QA simulation for the Explore "worlds" genre-coherence fix.
//
//   npx tsx src/lib/recommendation/Worlds.usersim.ts
//
// Pure + deterministic. Verifies the 4 coherence/trust fixes:
//  1+2. genre worlds stay genre-coherent (no K-pop/Festival-House drift),
//       energy-alone can't qualify a song into a world,
//  3.   the autoplay tail (contextBoost) stays on-genre for genre worlds,
//       while mood worlds stay cross-genre,
//  4.   "For You" copy is honest at cold-start.
// Also: adjacent discovery still works, identity scoring untouched, fast.
// ============================================================

import type { Song } from '@/types';
import {
  SESSION_WORLDS, buildWorldPlaylist, worldToAnchor,
  SessionContextEngine, contextBoost, type SessionWorld,
} from './SessionContext';
import { forYouSubtitle } from './ForYouEngine';
import { TasteIdentityProfile } from './TasteIdentityProfile';

let SEED = 20260517;
function rng(): number { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; }
Math.random = rng;

// ---- synthetic catalog --------------------------------------------------
let uid = 0;
function S(genre: string, mood: string, tags: string[], energy: number): Song {
  const id = `s${uid++}_${genre.replace(/\W+/g, '')}`;
  return {
    id, title: id, audio_url: `u/${id}`, cover_url: '',
    genre, bpm: 120, mood, energy_score: energy, vocal_type: 'mixed',
    similarity_cluster: 0, drop_timestamps: [], intro_length: 0, activity_fit: [],
    duration_seconds: 180, artist_id: `${id}_art`, artist_name: id,
    microtags: tags, hook_strength: 0.55 + rng() * 0.35, mainstream_fit: 0.4 + rng() * 0.4,
    distribution_stage: 'rising',
  };
}
function many(n: number, genre: string, mood: string, tags: string[], energy: number): Song[] {
  return Array.from({ length: n }, () => S(genre, mood, tags, energy + (rng() - 0.5) * 0.08));
}

const CATALOG: Song[] = [
  // --- Afrobeats family ---
  ...many(4, 'Afrobeats', 'warm', ['log_drum', 'shaker_groove', 'warm_vocal'], 0.62),
  ...many(3, 'Amapiano', 'euphoric', ['log_drum', 'shaker_groove'], 0.6),
  ...many(3, 'Dancehall', 'warm', ['shaker_groove'], 0.64),       // afro-adjacent
  ...many(2, 'Highlife', 'warm', ['warm_vocal'], 0.6),            // afro-adjacent
  // --- EDM family ---
  ...many(4, 'EDM', 'euphoric', ['four_on_the_floor', 'peak_energy', 'big_hook'], 0.9),
  ...many(3, 'Tech House', 'reckless', ['four_on_the_floor', 'peak_energy'], 0.88),
  ...many(3, 'Festival House', 'euphoric', ['four_on_the_floor', 'big_hook'], 0.9),
  ...many(2, 'Future Bass', 'euphoric', ['big_hook'], 0.88),      // edm-adjacent
  // --- Trap family ---
  ...many(4, 'Trap', 'reckless', ['hard_808_kick', 'gang_vocal', 'aggressive_lyrics'], 0.88),
  ...many(3, 'Drill', 'defiant', ['hard_808_kick', 'aggressive_lyrics'], 0.9),
  ...many(2, 'Phonk', 'reckless', ['hard_808_kick'], 0.86),
  ...many(2, 'Melodic Rap', 'defiant', ['hard_808_kick'], 0.82),  // trap-adjacent
  ...many(2, 'Hyperpop', 'reckless', ['big_hook'], 0.85),         // trap-adjacent
  // --- Indie family ---
  ...many(4, 'Indie Rock', 'longing', ['jangly_guitar', 'reverb_wash', 'dreamy_lyrics'], 0.45),
  ...many(3, 'Bedroom Pop', 'tender', ['reverb_wash', 'dreamy_lyrics'], 0.42),
  ...many(2, 'Dream Pop', 'tender', ['jangly_guitar', 'reverb_wash'], 0.46),
  ...many(2, 'Alt Folk', 'longing', ['jangly_guitar'], 0.4),     // indie-adjacent
  ...many(2, 'Lo-Fi Beats', 'tender', ['dreamy_lyrics'], 0.38),  // indie-adjacent
  // --- OUTSIDE / leak-bait: euphoric + high-energy, would pass the OLD gate ---
  ...many(3, 'K-Pop', 'euphoric', ['big_hook'], 0.7),
  ...many(2, 'Bubblegum Pop', 'euphoric', ['big_hook'], 0.8),
  ...many(2, 'Adult Contemporary', 'warm', [], 0.55),
  // --- cross-genre "moody" songs — fuel for the MOOD worlds ---
  S('Indie Rock', 'longing', ['reverb_wash', 'synth_lead'], 0.5),
  S('Synthwave', 'longing', ['synth_lead', 'reverb_wash'], 0.5),
  S('Melodic Rap', 'confident', ['synth_lead'], 0.52),
  S('Afro R&B', 'longing', ['reverb_wash'], 0.48),
  S('Alt Pop', 'haunted', ['piano_loop', 'melancholic_lyrics'], 0.32),
  S('Neoclassical', 'vulnerable', ['piano_loop', 'whispered_vocal'], 0.3),
  S('Trip Hop', 'haunted', ['whispered_vocal', 'melancholic_lyrics'], 0.34),
  S('Dream Pop', 'longing', ['whispered_vocal', 'piano_loop'], 0.33),
];

// ---- harness ------------------------------------------------------------
let ok = true;
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) ok = false;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function header(s: string): void { console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`); }
const worldById = (id: string) => SESSION_WORLDS.find((w) => w.id === id)!;

/** Genre tier of a song against a world (mirrors SessionContext.classifyGenre). */
function tierOf(s: Song, w: SessionWorld): 'primary' | 'adjacent' | 'outside' {
  const g = s.genre.toLowerCase();
  if ((w.primaryGenres ?? []).some((k) => g.includes(k))) return 'primary';
  if ((w.adjacentGenres ?? []).some((k) => g.includes(k))) return 'adjacent';
  return 'outside';
}
const genreSet = (songs: Song[]) => [...new Set(songs.map((s) => s.genre))];

// ============================================================
// GENRE WORLDS — must stay genre-coherent, no cross-genre drift.
// ============================================================
for (const wid of ['sunset_afrobeats', 'euphoric_edm', 'rage_trap', 'floating_indie']) {
  const w = worldById(wid);
  header(`GENRE WORLD — ${w.label}`);
  const list = buildWorldPlaylist(CATALOG, w, 28);
  const tiers = list.map((s) => tierOf(s, w));
  const outside = list.filter((s, i) => tiers[i] === 'outside');
  const adjacentCount = tiers.filter((t) => t === 'adjacent').length;
  console.log(`  size ${list.length}  genres: ${JSON.stringify(genreSet(list))}`);
  check(`${w.label}: every song is on-genre (primary or adjacent) — no cross-genre drift`,
    outside.length === 0, outside.length ? `leaked: ${genreSet(outside)}` : '');
  check(`${w.label}: world is well-populated`, list.length >= 8, `size ${list.length}`);
  check(`${w.label}: adjacent discovery still works (adjacent genres present)`,
    adjacentCount > 0, `${adjacentCount} adjacent songs`);
}

// Targeted leak checks — the exact bug from the report.
header('TARGETED — no cross-genre leak (the reported bug)');
{
  const afro = buildWorldPlaylist(CATALOG, worldById('sunset_afrobeats'), 28).map((s) => s.genre);
  check('Sunset Afrobeats never serves Festival House (the reported bug)',
    !afro.includes('Festival House'));
  check('Sunset Afrobeats never serves K-Pop', !afro.includes('K-Pop'));
  const edm = buildWorldPlaylist(CATALOG, worldById('euphoric_edm'), 28).map((s) => s.genre);
  check('Euphoric EDM never serves random pop (Bubblegum / Adult Contemporary)',
    !edm.includes('Bubblegum Pop') && !edm.includes('Adult Contemporary'));
  check('Euphoric EDM never serves K-Pop', !edm.includes('K-Pop'));
  const trap = buildWorldPlaylist(CATALOG, worldById('rage_trap'), 28).map((s) => s.genre);
  check('Rage Trap never serves soft indie',
    !trap.some((g) => ['Indie Rock', 'Bedroom Pop', 'Dream Pop', 'Lo-Fi Beats'].includes(g)));
}

// ============================================================
// MOOD WORLDS — intentionally cross-genre, must stay broad.
// ============================================================
for (const wid of ['night_drive', 'heartbreak_spiral']) {
  const w = worldById(wid);
  header(`MOOD WORLD — ${w.label} (cross-genre is intended)`);
  const list = buildWorldPlaylist(CATALOG, w, 28);
  const genres = genreSet(list);
  console.log(`  size ${list.length}  genres: ${JSON.stringify(genres)}`);
  check(`${w.label}: stays broad — spans 3+ distinct genres`, genres.length >= 3,
    `${genres.length} genres`);
  check(`${w.label}: is well-populated`, list.length >= 3, `size ${list.length}`);
}

// ============================================================
// FIX 3 — autoplay tail (contextBoost) stays coherent.
// ============================================================
header('FIX 3 — autoplay continuation stays on-theme');
{
  // Genre world: the mood_focus tail must keep boosting the world's genre.
  const afroEng = new SessionContextEngine();
  afroEng.activate('mood_focus', worldToAnchor(worldById('sunset_afrobeats')));
  const afroCtx = afroEng.current();
  const afroSong = CATALOG.find((s) => s.genre === 'Afrobeats')!;
  const kpopSong = CATALOG.find((s) => s.genre === 'K-Pop')!;
  check('genre world autoplay boosts the on-genre song over an off-genre one',
    contextBoost(afroSong, afroCtx) > contextBoost(kpopSong, afroCtx),
    `afro ${contextBoost(afroSong, afroCtx).toFixed(2)} vs k-pop ${contextBoost(kpopSong, afroCtx).toFixed(2)}`);
  check('genre world autoplay actively penalises the off-genre song',
    contextBoost(kpopSong, afroCtx) < 0,
    `k-pop ${contextBoost(kpopSong, afroCtx).toFixed(2)}`);

  // Mood world: the tail must NOT genre-lock — cross-genre stays welcome.
  const ndEng = new SessionContextEngine();
  ndEng.activate('mood_focus', worldToAnchor(worldById('night_drive')));
  const ndCtx = ndEng.current();
  const ndSynth = CATALOG.find((s) => s.genre === 'Synthwave')!;
  const ndAfroRnb = CATALOG.find((s) => s.genre === 'Afro R&B')!;
  check('mood world autoplay stays cross-genre (two different genres both welcomed)',
    contextBoost(ndSynth, ndCtx) > 0 && contextBoost(ndAfroRnb, ndCtx) > 0,
    `synthwave ${contextBoost(ndSynth, ndCtx).toFixed(2)} afro-r&b ${contextBoost(ndAfroRnb, ndCtx).toFixed(2)}`);
  check('mood-world anchor carries NO genre lock (cross-genre by design)',
    worldToAnchor(worldById('night_drive')).primaryGenres === undefined);
}

// ============================================================
// FIX 4 — honest "For You" copy.
// ============================================================
header('FIX 4 — For You labeling is honest');
{
  check('brand-new user → "Starting with our best" (not "Based on your listening")',
    forYouSubtitle(0, false) === 'Starting with our best');
  check('a little history, no mood → "Popular on Boulevard right now"',
    forYouSubtitle(8, false) === 'Popular on Boulevard right now');
  check('a little history, mood tapped → "Trending for your mood"',
    forYouSubtitle(8, true) === 'Trending for your mood');
  check('enough history → switches to "Based on your listening"',
    forYouSubtitle(20, false) === 'Based on your listening');
  let neverLies = true;
  for (let n = 0; n < 12; n++) {
    if (forYouSubtitle(n, false) === 'Based on your listening') neverLies = false;
    if (forYouSubtitle(n, true) === 'Based on your listening') neverLies = false;
  }
  check('below the personalization threshold it NEVER claims "Based on your listening"', neverLies);
}

// ============================================================
// CROSS-CUTTING — personalization untouched, relax fallback, performance.
// ============================================================
header('CROSS-CUTTING — identity intact / relax fallback / performance');
{
  // Identity scoring still works inside a world AND does not break genre
  // coherence — a world built with an identity profile stays on-genre.
  const identity = new TasteIdentityProfile();
  for (let r = 0; r < 4; r++) {
    for (const s of CATALOG.filter((x) => x.genre === 'Afrobeats')) {
      identity.update(s, ['completion_over_70', 'save'], true);
    }
  }
  const afroWithIdentity = buildWorldPlaylist(CATALOG, worldById('sunset_afrobeats'), 28, identity);
  const w = worldById('sunset_afrobeats');
  check('identity-scored world is still 100% genre-coherent (personalization intact)',
    afroWithIdentity.every((s) => tierOf(s, w) !== 'outside'));

  // Relax fallback — a genre world on a catalog with ZERO matching genre must
  // still return SOMETHING rather than an empty world.
  const edmOnly = CATALOG.filter((s) => tierOf(s, worldById('euphoric_edm')) === 'primary');
  const afroOnSparse = buildWorldPlaylist(edmOnly, worldById('sunset_afrobeats'), 28);
  check('relax fallback — a genre-sparse catalog still yields a non-empty world',
    afroOnSparse.length > 0, `size ${afroOnSparse.length}`);

  // Performance — building every world is cheap (additive scoring only).
  const t0 = Date.now();
  for (let r = 0; r < 80; r++) for (const world of SESSION_WORLDS) buildWorldPlaylist(CATALOG, world, 28);
  const elapsed = Date.now() - t0;
  check('640 world builds are fast (<200ms — no perf regression)', elapsed < 200, `${elapsed}ms`);
}

header(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
if (!ok) process.exitCode = 1;
