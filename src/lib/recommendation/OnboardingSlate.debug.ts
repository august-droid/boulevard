/* eslint-disable no-console */
import type { Song } from '@/types';
import {
  OnboardingSlate,
  ONBOARDING_SLOT_ROLES,
  type OnboardingSignalKind,
} from './OnboardingSlate';

// ============================================================
// Verification harness for the first-session onboarding slate.
//
// NOT shipped — nothing in the app imports this. It is a runnable proof:
//
//   npx tsx src/lib/recommendation/OnboardingSlate.debug.ts
//
// It exercises the slate against a synthetic catalog and prints the
// behaviours the spec asked to demonstrate:
//   • the first 10-song slate roles
//   • score / slate changes after skip + completion
//   • recovery behaviour after a hard skip
//   • anchored-surprise validation
//   • artist-repeat prevention
//   • timing (no major slowdown)
// ============================================================

let SEED = 12345;
/** Deterministic PRNG so the proof output is reproducible run-to-run. */
function rng(): number {
  SEED = (SEED * 1664525 + 1013904223) % 4294967296;
  return SEED / 4294967296;
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

function makeSong(i: number, overrides: Partial<Song> = {}): Song {
  const cluster = i % 6;
  const genres = ['Pop', 'Afrobeats', 'House', 'Indie Rock', 'Trap', 'R&B'];
  const moods = ['euphoric', 'warm', 'confident', 'longing', 'reckless', 'tender'];
  const tagPools = [
    ['four_on_the_floor', 'bright_synth', 'big_hook'],
    ['log_drum', 'shaker_groove', 'warm_vocal'],
    ['piano_stab', 'rolling_bass', 'club_lyrics'],
    ['jangly_guitar', 'reverb_wash', 'dreamy_lyrics'],
    ['hard_808_kick', 'gang_vocal', 'aggressive_lyrics'],
    ['intimate_vocal', 'rhodes_chords', 'whispered_vocal'],
  ];
  // A shared tag pool that crosses clusters — real catalogs always have some
  // cross-cluster overlap, which is what makes "anchored surprise" possible.
  const sharedTags = ['catchy_melody', 'clean_mix', 'radio_ready'];
  return {
    id: `s${i}`,
    title: `Song ${i}`,
    audio_url: `https://cdn/${i}.mp3`,
    cover_url: `https://cdn/${i}.jpg`,
    genre: genres[cluster],
    bpm: 90 + cluster * 12 + Math.floor(rng() * 8),
    mood: moods[cluster],
    energy_score: 0.2 + cluster * 0.12 + rng() * 0.08,
    vocal_type: (['female', 'male', 'mixed'] as const)[i % 3],
    similarity_cluster: cluster,
    drop_timestamps: [],
    intro_length: 8,
    activity_fit: [],
    duration_seconds: 180,
    artist_id: `artist_${i % 11}`,
    artist_name: `Artist ${i % 11}`,
    microtags: [...tagPools[cluster], sharedTags[i % 3]],
    hook_strength: 0.4 + rng() * 0.55,
    mainstream_fit: 0.35 + rng() * 0.6,
    launch_score: 0.3 + rng() * 0.6,
    quality_score: 0.4 + rng() * 0.5,
    uniqueness_score_v2: rng() * 0.7,
    weirdness_score: rng() * 0.5,
    distribution_stage: 'rising',
    ...overrides,
  };
}

const CATALOG: Song[] = Array.from({ length: 54 }, (_, i) => makeSong(i));

function pass(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  return ok;
}

function adjacentArtistRepeat(slate: OnboardingSlate): boolean {
  const rows = slate.debugSnapshot().slate;
  // debugSnapshot doesn't expose artist; re-derive from CATALOG by title.
  let repeat = false;
  for (let i = 1; i < rows.length; i++) {
    const a = CATALOG.find((s) => s.title === rows[i - 1].title)?.artist_id;
    const b = CATALOG.find((s) => s.title === rows[i].title)?.artist_id;
    if (a && b && a === b) repeat = true;
  }
  return repeat;
}

/** Anchors shared between two songs — mirrors OnboardingSlate.anchorMatchCount. */
function anchors(a: Song, b: Song): number {
  let n = 0;
  if (a.bpm != null && b.bpm != null && Math.abs(a.bpm - b.bpm) <= 14) n++;
  if (Math.abs(a.energy_score - b.energy_score) <= 0.16) n++;
  if (a.vocal_type === b.vocal_type) n++;
  if (a.mood === b.mood) n++;
  if ((a.microtags ?? []).some((t) => (b.microtags ?? []).includes(t))) n++;
  if (a.similarity_cluster === b.similarity_cluster || a.genre === b.genre) n++;
  return n;
}
const byTitle = (t: string) => CATALOG.find((s) => s.title === t)!;
const inCluster = (c: number) => CATALOG.filter((s) => s.similarity_cluster === c);
// Mirrors OnboardingSlate.clusterKey — genre-first (similarity_cluster is
// often a single default value catalog-wide, so genre is the real cluster).
const clusterKeyOf = (s: Song) => s.genre || String(s.similarity_cluster);

function main() {
  let ok = true;
  const check = (label: string, cond: boolean, detail = '') => { ok = pass(label, cond, detail) && ok; };

  console.log('\n================ ONBOARDING SLATE — VERIFICATION ================\n');

  // ---- 1. Initial 10-song slate + roles ----
  console.log('1) FIRST 10-SONG SLATE (blueprint roles)');
  console.log('   blueprint:', ONBOARDING_SLOT_ROLES.join(' → '));
  const slate = new OnboardingSlate(CATALOG, { safetyMode: true });
  console.log(slate.describe());
  const snap0 = slate.debugSnapshot();
  check('slate has exactly 10 slots', snap0.slate.length === 10);
  check('slot roles match the blueprint',
    snap0.slate.every((r, i) => r.role === ONBOARDING_SLOT_ROLES[i]));

  // ---- 2. Artist-repeat prevention ----
  console.log('\n2) ARTIST-REPEAT PREVENTION');
  check('no two adjacent slate songs share an artist', !adjacentArtistRepeat(slate));

  // ---- 3. Anchored-surprise validation ----
  // Anchored surprise only applies once there is positive behaviour to anchor
  // to — before any signal the surprise slots are wide exploration. So feed a
  // fresh slate two completions, then verify its surprise slots are anchored.
  console.log('\n3) ANCHORED-SURPRISE VALIDATION');
  const sSlate = new OnboardingSlate(CATALOG, { safetyMode: true });
  const sc5 = inCluster(5);
  sSlate.applySignal(sc5[0], ['completion_over_70'], true);
  sSlate.applySignal(sc5[1], ['completion_over_70', 'save'], true);
  const sSnap = sSlate.debugSnapshot();
  const sRefs = [sc5[0], sc5[1], ...sSnap.slate.slice(0, 2).map((r) => byTitle(r.title))];
  for (const r of sSnap.slate.filter((x) => x.role === 'surprise')) {
    const song = byTitle(r.title);
    const shared = Math.max(...sRefs.map((ref) => anchors(song, ref)));
    check(`surprise "${r.title}" shares >=1 anchor with a positive/trust pick`,
      shared >= 1, `${shared} shared anchors`);
  }

  // ---- 4. LEAN-IN: 2 completions in one cluster → exploit leans into it ----
  console.log('\n4) LEAN-IN AFTER 2 COMPLETIONS (same cluster)');
  console.log('   confidence before any signal:', snap0.confidence, `(${snap0.confidenceBucket})`);
  const c5 = inCluster(5);
  const leanKey = clusterKeyOf(c5[0]);
  slate.applySignal(c5[0], ['completion_over_70'], true);
  slate.applySignal(c5[1], ['completion_over_70', 'save'], true);
  const snap4 = slate.debugSnapshot();
  console.log(`   after 2 completions in cluster "${leanKey}" → confidence`,
    snap4.confidence, `(${snap4.confidenceBucket})`, '| lean-in:', snap4.leanClusters);
  check('confidence rose after strong positives', snap4.confidence > snap0.confidence);
  check('cluster with 2 completions flips to LEAN-IN',
    snap4.leanClusters.includes(leanKey));
  const exploitRow = snap4.slate.find((r) => r.role === 'exploit')!;
  check('exploit slot leans into the learned cluster',
    exploitRow.cluster === leanKey,
    `exploit = "${exploitRow.title}" cluster ${exploitRow.cluster}`);

  // ---- 5. RECOVERY + SUPPRESS after a hard skip ----
  console.log('\n5) RECOVERY + SUPPRESSION AFTER HARD SKIP');
  const d1 = inCluster(1);
  const skipKey = clusterKeyOf(d1[0]);
  const beforeSkip = slate.debugSnapshot().confidence;
  slate.applySignal(d1[0], ['skip_under_5'], true); // hard skip → recovery armed
  const snap5 = slate.debugSnapshot();
  console.log(`   after HARD SKIP in cluster "${skipKey}" → confidence`,
    snap5.confidence, `(${snap5.confidenceBucket})`);
  console.log(slate.describe());
  check('confidence dropped after the hard skip', snap5.confidence < beforeSkip);
  const recoveryRow = snap5.slate[snap5.playedCount]; // the next song
  check('next song after a hard skip is a RECOVERY slot',
    recoveryRow?.role === 'recovery',
    recoveryRow ? `slot ${recoveryRow.slot} "${recoveryRow.title}"` : 'none');
  if (recoveryRow) {
    check('recovery song avoids the hard-skipped cluster',
      recoveryRow.cluster !== skipKey);
  }
  slate.applySignal(d1[1], ['skip_under_15'], true); // 2nd skip in cluster → suppress
  const snap5b = slate.debugSnapshot();
  check('2 skips in a cluster SUPPRESS it',
    snap5b.suppressedClusters.includes(skipKey),
    'suppressed: ' + JSON.stringify(snap5b.suppressedClusters));
  const upcoming = snap5b.slate.slice(snap5b.playedCount).map((r) => r.cluster);
  check('suppressed cluster is gone from all upcoming slots',
    !upcoming.includes(skipKey));

  // ---- 6. Performance ----
  console.log('\n6) PERFORMANCE (no heavy work during playback)');
  const t0 = Date.now();
  const fresh = new OnboardingSlate(CATALOG, { safetyMode: true });
  const buildMs = Date.now() - t0;
  const t1 = Date.now();
  const ITER = 300;
  for (let i = 0; i < ITER; i++) {
    const kinds: OnboardingSignalKind[] =
      [pick(['completion_over_70', 'skip_under_15', 'listen_30s', 'save'])];
    fresh.applySignal(pick(CATALOG), kinds, false); // ended=false ⇒ never completes
  }
  const rerankMs = (Date.now() - t1) / ITER;
  console.log(`   slate build: ${buildMs} ms   |   avg re-rank over ${ITER}: ${rerankMs.toFixed(4)} ms`);
  check('build is fast (<50ms)', buildMs < 50);
  check('re-rank is fast (<5ms avg)', rerankMs < 5);

  console.log('\n================', ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED', '================\n');
  if (!ok) process.exitCode = 1;
}

main();
