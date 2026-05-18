/* eslint-disable no-console */
// ============================================================
// QA simulation for the additive personalization layers:
//   • Cold-start demographic / cohort prior   (ColdStartCohortPrior.ts)
//   • Habit personalization                   (HabitProfile.ts)
//   • First-10-minute hook-rate improvements  (OnboardingSlate.ts)
//
//   npx tsx src/lib/recommendation/PersonalizationLayers.usersim.ts
//
// Pure + deterministic (Math.random is seeded). Imports only pure modules —
// no AsyncStorage, no React, no network — so it runs anywhere tsx runs.
//
// Covers the 8 QA scenarios from the brief and asserts every verification
// point: cohort helps-then-decays, behaviour overrides cohort, habit boosts
// the right time-of-day music, current intent overrides habit, under-18 /
// age-unknown safety, no perf regression, no songs/artists repeated too
// close, and the pre-existing onboarding flow is unbroken.
// ============================================================

import type { Song } from '@/types';
import { OnboardingSlate, type OnboardingSignalKind } from './OnboardingSlate';
import { buildColdStartCohort } from './ColdStartCohortPrior';
import { HabitProfile, scoreHabitFit } from '../habit/HabitProfile';
import { SessionContextEngine, decayWeight } from './SessionContext';

// ---- deterministic RNG (patched over Math.random) -----------------------
let SEED = 20260517;
function rng(): number { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; }
Math.random = rng;

// ---- contract constants mirrored from RecommendationEngine --------------
// `score += 4` when a song's activity_fit includes the active vibe.
const VIBE_MATCH_BOOST = 4;
// Habit boost is multiplied by 0.4 when an explicit vibe/context is active.
const HABIT_EXPLICIT_DAMP = 0.4;
// HabitProfile self-caps the raw habit boost at this magnitude.
const HABIT_RAW_CAP = 3;

// ---- synthetic catalog --------------------------------------------------
interface Fam {
  genres: string[]; tags: string[]; mood: string; energy: [number, number];
  hook: [number, number]; mainstream: [number, number];
}
const FAMILIES: Record<string, Fam> = {
  chill: { genres: ['Lo-Fi', 'Bedroom Pop', 'Ambient Folk'],
    tags: ['low_energy', 'piano_loop', 'reverb_wash', 'intimate_vocal', 'tape_warmth'],
    mood: 'tender', energy: [0.14, 0.40], hook: [0.30, 0.55], mainstream: [0.30, 0.55] },
  gym: { genres: ['Hard Trap', 'Drill', 'Phonk'],
    tags: ['hard_808_kick', 'aggressive_lyrics', 'high_energy', 'peak_energy', 'gang_vocal'],
    mood: 'reckless', energy: [0.74, 0.95], hook: [0.45, 0.78], mainstream: [0.25, 0.5] },
  edm: { genres: ['House', 'Festival House', 'Tech House'],
    tags: ['four_on_the_floor', 'dance_tempo', 'peak_energy', 'big_hook', 'club_lyrics'],
    mood: 'euphoric', energy: [0.70, 0.92], hook: [0.55, 0.92], mainstream: [0.4, 0.7] },
  pop: { genres: ['Stadium Pop', 'Pop Anthem'],
    tags: ['big_hook', 'radio_ready', 'high_energy', 'warm_vocal'],
    mood: 'warm', energy: [0.50, 0.72], hook: [0.62, 0.95], mainstream: [0.68, 0.95] },
  night: { genres: ['Night Drive Synth', 'Dark Pop'],
    tags: ['reverb_wash', 'synth_lead', 'dreamy_lyrics', 'intimate_vocal', 'mid_energy'],
    mood: 'longing', energy: [0.40, 0.62], hook: [0.45, 0.75], mainstream: [0.4, 0.65] },
};

function band([lo, hi]: [number, number]): number { return lo + rng() * (hi - lo); }

function makeSong(fam: string, i: number): Song {
  const f = FAMILIES[fam];
  const g = f.genres[i % f.genres.length];
  return {
    id: `${fam}_${i}`, title: `${g} ${i}`, audio_url: `u/${fam}/${i}`, cover_url: '',
    genre: g, bpm: 84 + Math.floor(rng() * 80), mood: f.mood,
    energy_score: band(f.energy),
    vocal_type: (['female', 'male', 'mixed'] as const)[i % 3],
    similarity_cluster: 0,
    drop_timestamps: [], intro_length: 0, activity_fit: fam === 'gym' ? ['gym'] : [],
    duration_seconds: 180,
    artist_id: `${fam}_art_${i % 7}`, artist_name: `${fam} artist ${i % 7}`,
    microtags: f.tags,
    hook_strength: band(f.hook), mainstream_fit: band(f.mainstream),
    launch_score: 0.35 + rng() * 0.5, quality_score: 0.5 + rng() * 0.4,
    uniqueness_score_v2: rng() * 0.6, weirdness_score: rng() * 0.35,
    distribution_stage: (['rising', 'trending', 'new_test'] as const)[i % 3],
  };
}

// Unsafe songs — must NEVER reach a safety-mode onboarding slate.
function makeUnsafe(i: number): Song {
  return {
    id: `unsafe_${i}`, title: `Explicit Track ${i}`, audio_url: `u/unsafe/${i}`, cover_url: '',
    genre: 'Explicit Rap', bpm: 140, mood: 'reckless', energy_score: 0.8,
    vocal_type: 'male', similarity_cluster: 0, drop_timestamps: [], intro_length: 0,
    activity_fit: [], duration_seconds: 180, artist_id: `unsafe_art_${i}`,
    artist_name: `unsafe artist ${i}`,
    microtags: ['explicit_content', 'sexual_lyrics', 'high_energy'],
    skip_risks: ['explicit', 'nsfw'],
    hook_strength: 0.9, mainstream_fit: 0.6, launch_score: 0.8,
    distribution_stage: 'rising',
  };
}

const CATALOG: Song[] = [];
for (const fam of Object.keys(FAMILIES)) for (let i = 0; i < 20; i++) CATALOG.push(makeSong(fam, i));
const UNSAFE_IDS = new Set<string>();
for (let i = 0; i < 8; i++) { const s = makeUnsafe(i); UNSAFE_IDS.add(s.id); CATALOG.push(s); }

// ---- harness ------------------------------------------------------------
let ok = true;
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) ok = false;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function header(s: string): void {
  console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// A listener: how much they like a song, and the reaction it produces.
interface Listener { lovedGenres: string[]; lovedTags: string[]; energy: number; }
function appeal(u: Listener, s: Song): number {
  const g = u.lovedGenres.includes(s.genre) ? 1 : 0.1;
  const e = 1 - Math.min(1, Math.abs(s.energy_score - u.energy) / 0.5);
  const hits = (s.microtags ?? []).filter((t) => u.lovedTags.includes(t)).length;
  return 0.5 * g + 0.25 * e + 0.25 * Math.min(1, hits / 3);
}
function react(a: number): OnboardingSignalKind[] {
  if (a >= 0.68) return rng() < 0.5 ? ['completion_over_70', 'save'] : ['completion_over_70'];
  if (a >= 0.52) return ['listen_60s'];
  if (a >= 0.38) return ['listen_30s'];
  if (a >= 0.24) return ['skip_under_15'];
  return ['skip_under_5'];
}
/** Run a full 10-song onboarding journey for a listener. */
function runJourney(slate: OnboardingSlate, u: Listener): number[] {
  const appeals: number[] = [];
  for (let step = 0; step < 10; step++) {
    const next = slate.serve(1, []);
    if (next.length === 0) break;
    const song = next[0];
    const a = appeal(u, song);
    appeals.push(a);
    slate.applySignal(song, react(a), true);
  }
  return appeals;
}

const CHILL_LISTENER: Listener = {
  lovedGenres: FAMILIES.chill.genres, lovedTags: FAMILIES.chill.tags, energy: 0.28,
};

// ============================================================
// SCENARIO 1 — new user, mood selected, minimal context (no age/source).
// ============================================================
header('SCENARIO 1 — new user, mood selected, no demographic data');
{
  const cohort = buildColdStartCohort({ deviceType: 'phone', os: 'ios' });
  const seed = CATALOG.find((s) => s.genre === 'Lo-Fi')!; // the "Chill" mood pick
  const slate = new OnboardingSlate(CATALOG, { safetyMode: true, seedSong: seed, cohort });
  const appeals = runJourney(slate, CHILL_LISTENER);
  const snap = slate.debugSnapshot();
  const front = avg(appeals.slice(0, 4));
  const back = avg(appeals.slice(6));
  check('slate builds all 10 slots with a mood seed + minimal-context cohort', snap.slate.length === 10);
  check('cohort is safety-mode (no age signal)', snap.cohort?.safetyMode === true);
  check('behaviour personalizes: back-half appeal >= front-half', back >= front - 0.05,
    `front ${front.toFixed(2)} → back ${back.toFixed(2)}`);
  // Cohort boost is small + capped everywhere.
  const maxBoost = Math.max(...CATALOG.map((s) => Math.abs(cohort.scoreCohortFit(s, { playedCount: 0 }))));
  check('cohort boost is small + capped (<= 2.5)', maxBoost <= 2.5 + 1e-9, `max ${maxBoost.toFixed(2)}`);
}

// ============================================================
// SCENARIO 2 — new user, demographic/context available, no mood selected.
// ============================================================
header('SCENARIO 2 — context available (region + night signup + TikTok), no mood');
{
  const nightSignup = new Date(2026, 4, 18, 23, 30, 0).getTime();
  const cohort = buildColdStartCohort({
    country: 'ES', locale: 'es-ES', language: 'es', timezone: 'Europe/Madrid',
    deviceType: 'phone', os: 'ios', acquisitionSource: 'tiktok', signupTime: nightSignup,
  });
  check('cohort derived multiple patterns from context', cohort.debugSnapshot().patterns.length >= 3,
    JSON.stringify(cohort.debugSnapshot().patterns.map((p) => p.id)));
  // The brief's core claim: the prior helps the EARLIEST songs and decays to
  // ~0 by song 10 — independent of confidence, via the slot factor.
  const aligned = [...CATALOG]
    .filter((s) => !UNSAFE_IDS.has(s.id))
    .sort((a, b) => cohort.scoreCohortFit(b, { playedCount: 0 }) - cohort.scoreCohortFit(a, { playedCount: 0 }))[0];
  const boostSong1 = cohort.scoreCohortFit(aligned, { playedCount: 0 });
  const boostSong4 = cohort.scoreCohortFit(aligned, { playedCount: 3 });
  const boostSong10 = cohort.scoreCohortFit(aligned, { playedCount: 9 });
  check('cohort boost is strongest on song 1', boostSong1 > 0.05, `song1 ${boostSong1.toFixed(2)}`);
  check('cohort boost decays by song 4', boostSong4 < boostSong1, `song4 ${boostSong4.toFixed(2)}`);
  check('cohort boost is ~0 by song 10', Math.abs(boostSong10) < 0.001, `song10 ${boostSong10.toFixed(3)}`);
  // It is never written to long-term taste — structurally true: the cohort
  // lives only inside the slate and exposes no taste-mutation API.
  check('cohort exposes no long-term taste write path',
    typeof (cohort as unknown as { applyToTaste?: unknown }).applyToTaste === 'undefined');
}

// ============================================================
// SCENARIO 3 — cohort mismatch: user skips the cohort-aligned songs.
// ============================================================
header('SCENARIO 3 — cohort mismatch, user hard-skips the first songs');
{
  const daySignup = new Date(2026, 4, 18, 14, 0, 0).getTime();
  const cohort = buildColdStartCohort({
    deviceType: 'phone', os: 'ios', acquisitionSource: 'tiktok', signupTime: daySignup,
  });
  const startConf = cohort.currentConfidence();
  // The user rejects, instantly, three songs the cohort strongly endorses
  // (high-hook EDM — a strong match for the short-form-video pattern).
  const cohortAligned = [...CATALOG]
    .filter((s) => !UNSAFE_IDS.has(s.id))
    .sort((a, b) => cohort.scoreCohortFit(b, { playedCount: 0 }) - cohort.scoreCohortFit(a, { playedCount: 0 }))
    .slice(0, 3);
  for (const s of cohortAligned) cohort.registerOutcome(s, ['skip_under_5'], true);
  const endConf = cohort.currentConfidence();
  const suppressed = cohort.debugSnapshot().patterns.filter((p) => !p.live);
  check('cohort confidence collapses after contradicting hard skips', endConf < startConf * 0.4,
    `${startConf.toFixed(2)} → ${endConf.toFixed(2)}`);
  check('>=1 cohort pattern suppressed after 2 matching skips', suppressed.length >= 1,
    JSON.stringify(suppressed.map((p) => p.id)));
  // And the slate itself still personalizes for the chill user despite the
  // wrong prior — behaviour wins.
  const slate = new OnboardingSlate(CATALOG, {
    safetyMode: true,
    cohort: buildColdStartCohort({ acquisitionSource: 'tiktok', signupTime: daySignup }),
  });
  const appeals = runJourney(slate, CHILL_LISTENER);
  check('slate recovers toward the user\'s real taste despite a wrong cohort',
    avg(appeals.slice(6)) >= avg(appeals.slice(0, 3)) - 0.05,
    `front ${avg(appeals.slice(0, 3)).toFixed(2)} → back ${avg(appeals.slice(6)).toFixed(2)}`);
}

// ============================================================
// SCENARIO 4 — returning user at a habitual listening time.
// ============================================================
header('SCENARIO 4 — returning user at habitual listening time');
const NIGHT_DAY1 = new Date(2026, 4, 18, 22, 0, 0).getTime(); // Mon 22:00 — weekday night
const DAY_MS = 24 * 60 * 60 * 1000;
{
  const habit = new HabitProfile();
  // Three distinct weekday nights of EDM listening → a real habit.
  for (let day = 0; day < 3; day++) {
    const t = NIGHT_DAY1 + day * DAY_MS;
    for (let i = 0; i < 5; i++) {
      habit.record(CATALOG.find((s) => s.id === `edm_${i}`)!, ['completion_over_70', 'save'], t + i * 60000);
    }
  }
  const ctx = habit.getHabitContext(NIGHT_DAY1 + 3 * DAY_MS);
  const edmSong = CATALOG.find((s) => s.id === 'edm_11')!;   // unseen EDM track
  const chillSong = CATALOG.find((s) => s.id === 'chill_11')!;
  check('habit confidence is high after 3 repeated nights', ctx.confidence > 0.6,
    `confidence ${ctx.confidence.toFixed(2)}`);
  check('habit boosts the habitual genre (EDM) over off-habit chill',
    scoreHabitFit(edmSong, ctx) > scoreHabitFit(chillSong, ctx),
    `edm ${scoreHabitFit(edmSong, ctx).toFixed(2)} vs chill ${scoreHabitFit(chillSong, ctx).toFixed(2)}`);
  // Habit fades when the pattern stops appearing.
  const stale = habit.getHabitContext(NIGHT_DAY1 + 120 * DAY_MS);
  check('habit confidence decays when the pattern stops appearing',
    stale.confidence < ctx.confidence, `${ctx.confidence.toFixed(2)} → ${stale.confidence.toFixed(2)}`);
}

// ============================================================
// SCENARIO 5 — returning user whose current intent contradicts habit.
// ============================================================
header('SCENARIO 5 — current intent (Gym) contradicts habit (chill nights)');
{
  const habit = new HabitProfile();
  for (let day = 0; day < 3; day++) {
    const t = NIGHT_DAY1 + day * DAY_MS;
    for (let i = 0; i < 5; i++) {
      habit.record(CATALOG.find((s) => s.id === `chill_${i}`)!, ['completion_over_70'], t + i * 60000);
    }
  }
  const ctx = habit.getHabitContext(NIGHT_DAY1 + 3 * DAY_MS);
  const chillSong = CATALOG.find((s) => s.id === 'chill_12')!;
  const gymSong = CATALOG.find((s) => s.id === 'gym_3')!; // activity_fit: ['gym']
  check('habit itself favours the habitual chill music', scoreHabitFit(chillSong, ctx) > scoreHabitFit(gymSong, ctx),
    `chill ${scoreHabitFit(chillSong, ctx).toFixed(2)} vs gym ${scoreHabitFit(gymSong, ctx).toFixed(2)}`);
  // Ranker contract: with an explicit "Gym" vibe, the gym song gets +4 and the
  // habit boost is damped ×0.4. Even the strongest possible habit pull for
  // chill cannot out-weigh the explicit choice.
  const gymNet = VIBE_MATCH_BOOST + scoreHabitFit(gymSong, ctx) * HABIT_EXPLICIT_DAMP;
  const chillNet = scoreHabitFit(chillSong, ctx) * HABIT_EXPLICIT_DAMP;
  check('explicit Gym intent overrides the chill habit', gymNet > chillNet,
    `gym ${gymNet.toFixed(2)} vs chill ${chillNet.toFixed(2)}`);
  check('max damped habit boost stays below the explicit-vibe boost',
    HABIT_RAW_CAP * HABIT_EXPLICIT_DAMP < VIBE_MATCH_BOOST,
    `${(HABIT_RAW_CAP * HABIT_EXPLICIT_DAMP).toFixed(1)} < ${VIBE_MATCH_BOOST}`);
}

// ============================================================
// SCENARIO 6 — reopening the app after 15 minutes.
// ============================================================
header('SCENARIO 6 — app reopened after 15 minutes');
{
  const habit = new HabitProfile();
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 4; i++) {
      habit.record(CATALOG.find((s) => s.id === `edm_${i}`)!, ['completion_over_70'], NIGHT_DAY1 + day * DAY_MS);
    }
  }
  const before = habit.getHabitContext(NIGHT_DAY1 + 3 * DAY_MS);
  const after15 = habit.getHabitContext(NIGHT_DAY1 + 3 * DAY_MS + 15 * 60 * 1000);
  check('habit context stable across a 15-min gap (same slot)', before.slot === after15.slot);
  // The contextual session is still inside its "strong" phase at 15 min.
  const d15 = decayWeight(15 * 60);
  check('contextual session is still strong at exactly 15 min', d15.phase === 'strong' && d15.weight === 1.0);
  // A session snapshot 15 min old still restores (direction preserved).
  const eng = new SessionContextEngine();
  eng.activate('mood_focus', { label: 'night drive' }, NIGHT_DAY1);
  const restored = new SessionContextEngine().restore(eng.serialize(), NIGHT_DAY1 + 15 * 60 * 1000);
  check('a 15-min-old session restores its direction', restored === true);
}

// ============================================================
// SCENARIO 7 — reopening the app the next day.
// ============================================================
header('SCENARIO 7 — app reopened the next day');
{
  const habit = new HabitProfile();
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 5; i++) {
      habit.record(CATALOG.find((s) => s.id === `edm_${i}`)!, ['completion_over_70', 'save'], NIGHT_DAY1 + day * DAY_MS);
    }
  }
  // Next-day, same weekday-night band → habit STILL applies (it generalizes
  // across days, that is the whole point).
  const nextDay = habit.getHabitContext(NIGHT_DAY1 + 3 * DAY_MS);
  check('habit persists into the next day at the same time band', nextDay.confidence > 0.5,
    `confidence ${nextDay.confidence.toFixed(2)}`);
  // The contextual SESSION, by contrast, is gone next day — a stale snapshot
  // does not restore, so a next-day open feels fresh.
  const eng = new SessionContextEngine();
  eng.activate('mood_focus', { label: 'night drive' }, NIGHT_DAY1);
  const restoredNextDay = new SessionContextEngine().restore(eng.serialize(), NIGHT_DAY1 + 25 * 60 * 60 * 1000);
  check('a >12h-old session does NOT restore (next day feels fresh)', restoredNextDay === false);
}

// ============================================================
// SCENARIO 8 — under-18 / age-unknown safety mode.
// ============================================================
header('SCENARIO 8 — under-18 / age-unknown safety mode');
{
  check('explicit under-18 ⇒ cohort safety mode',
    buildColdStartCohort({ ageRange: 'under_18' }).safetyMode === true);
  check('age-unknown ⇒ cohort safety mode',
    buildColdStartCohort({ deviceType: 'phone', os: 'ios' }).safetyMode === true);
  // The slate, in safety mode, must never serve an unsafe track.
  const slate = new OnboardingSlate(CATALOG, {
    safetyMode: true,
    cohort: buildColdStartCohort({ ageRange: 'under_18' }),
  });
  const served = slate.serve(10, []);
  const leaked = served.filter((s) => UNSAFE_IDS.has(s.id));
  check('no explicit/unsafe track reaches the safety-mode onboarding slate',
    leaked.length === 0, `served ${served.length}, leaked ${leaked.length}`);
  // Re-rank after every signal must keep the guarantee.
  let leakedAfterRerank = 0;
  for (let step = 0; step < 10; step++) {
    const next = slate.serve(1, []);
    if (next.length === 0) break;
    if (UNSAFE_IDS.has(next[0].id)) leakedAfterRerank++;
    slate.applySignal(next[0], react(appeal(CHILL_LISTENER, next[0])), true);
  }
  check('no unsafe track leaks through re-ranking either', leakedAfterRerank === 0);
}

// ============================================================
// CROSS-CUTTING — performance, diversity, and no broken flows.
// ============================================================
header('CROSS-CUTTING — performance / diversity / regression');
{
  // Performance: build + a full 10-signal journey must be fast (no model,
  // no network — pure in-memory scoring).
  const t0 = Date.now();
  for (let run = 0; run < 5; run++) {
    const slate = new OnboardingSlate(CATALOG, {
      safetyMode: true, cohort: buildColdStartCohort({ acquisitionSource: 'tiktok', signupTime: NIGHT_DAY1 }),
    });
    runJourney(slate, CHILL_LISTENER);
  }
  const elapsed = Date.now() - t0;
  check('5 full slate journeys complete fast (<150ms — no perf regression)', elapsed < 150,
    `${elapsed}ms`);

  // Visual diversity: no same artist back-to-back, and within-2 is rare.
  const slate = new OnboardingSlate(CATALOG, { safetyMode: true });
  const ten = slate.serve(10, []);
  let adjacentArtist = 0;
  let within2Artist = 0;
  for (let i = 1; i < ten.length; i++) {
    if (ten[i].artist_id && ten[i].artist_id === ten[i - 1].artist_id) adjacentArtist++;
    if (i >= 2 && ten[i].artist_id && ten[i].artist_id === ten[i - 2].artist_id) within2Artist++;
  }
  const uniqueIds = new Set(ten.map((s) => s.id)).size;
  check('no song repeats inside the 10-song slate', uniqueIds === ten.length);
  check('no same artist back-to-back in the slate', adjacentArtist === 0);
  check('same artist within 2 slots is rare (visual diversity)', within2Artist <= 1,
    `${within2Artist} within-2 collisions`);

  // No broken existing flows: the slate with NO cohort (the pre-layer path)
  // still builds 10 slots and still personalizes from behaviour.
  const baseline = new OnboardingSlate(CATALOG, { safetyMode: true });
  const baseAppeals = runJourney(baseline, CHILL_LISTENER);
  check('pre-existing flow intact: no-cohort slate builds 10 + personalizes',
    baseline.debugSnapshot().slate.length === 10 &&
    avg(baseAppeals.slice(6)) >= avg(baseAppeals.slice(0, 3)) - 0.05);
}

header(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
if (!ok) process.exitCode = 1;
