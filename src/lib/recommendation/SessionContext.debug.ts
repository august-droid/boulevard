/* eslint-disable no-console */
import type { Song } from '@/types';
import {
  SessionContextEngine,
  contextBoost,
  explainContextBoost,
  decayWeight,
  SESSION_WORLDS,
  worldToAnchor,
  buildWorldPlaylist,
} from './SessionContext';

// ============================================================
// Verification harness for the Contextual Session Engine.
//
//   npx tsx src/lib/recommendation/SessionContext.debug.ts
//
// NOT shipped — proves the behaviours the spec asked to demonstrate:
//   • session-mode activation
//   • progressive decay (strong → partial → blend → stale)
//   • per-mode context weighting (artist / mood boosts)
//   • real-time context switching (pivot)
//   • skip-streak confidence collapse → wider exploration
//   • anti-fatigue penalty
//   • freshness: serialize → restore, stale snapshot dropped
//   • performance
// ============================================================

let SEED = 99;
const rng = () => { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; };

function makeSong(id: string, o: Partial<Song> = {}): Song {
  return {
    id, title: id, audio_url: `u/${id}`, cover_url: `c/${id}`,
    genre: 'Pop', bpm: 120, mood: 'longing', energy_score: 0.5,
    vocal_type: 'female', similarity_cluster: 1, drop_timestamps: [],
    intro_length: 8, activity_fit: [], duration_seconds: 180,
    artist_id: 'artist_X', microtags: ['reverb_wash', 'synth_lead'],
    hook_strength: 0.6, mainstream_fit: 0.6, launch_score: 0.5,
    quality_score: 0.6, uniqueness_score_v2: 0.4, weirdness_score: 0.3,
    distribution_stage: 'rising', ...o,
  };
}

function pass(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  return ok;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function main() {
  let ok = true;
  const check = (l: string, c: boolean, d = '') => { ok = pass(l, c, d) && ok; };
  const T0 = 1_000_000_000_000;

  console.log('\n============ CONTEXTUAL SESSION ENGINE — VERIFICATION ============\n');

  // ---- 1. Mode activation ----
  console.log('1) SESSION-MODE ACTIVATION');
  const eng = new SessionContextEngine();
  check('starts in default mode', eng.current(T0).mode === 'default');
  const anchorSong = makeSong('A1', { artist_id: 'artist_A', genre: 'Afrobeats', microtags: ['log_drum', 'warm_vocal'] });
  eng.activate('artist_focus', { artistId: 'artist_A', refSongs: [anchorSong], label: 'Artist A' }, T0);
  const c1 = eng.current(T0);
  check('artist_focus is active', c1.mode === 'artist_focus');
  check('confidence seeded on activation', c1.confidence > 0.5, `confidence ${c1.confidence.toFixed(2)}`);

  // ---- 2. Progressive decay ----
  console.log('\n2) PROGRESSIVE DECAY (strong → partial → blend → stale)');
  for (const [label, sec] of [['5 min', 300], ['30 min', 1800], ['3 h', 10800], ['8 h', 28800]] as const) {
    const d = decayWeight(sec);
    console.log(`   ${label.padEnd(7)} → phase ${d.phase.padEnd(8)} weight ${d.weight.toFixed(3)}`);
  }
  check('0-15 min is strong + full weight', decayWeight(300).phase === 'strong' && decayWeight(300).weight === 1);
  check('15-60 min partially decays', decayWeight(1800).phase === 'partial' && decayWeight(1800).weight < 1);
  check('1-6 h blends down', decayWeight(10800).phase === 'blend' && decayWeight(10800).weight < 0.45);
  check('next-day is stale', decayWeight(28800).phase === 'stale' && decayWeight(28800).weight <= 0.1);

  // ---- 3. Per-mode context weighting ----
  console.log('\n3) CONTEXT WEIGHTING (artist_focus + mood_focus)');
  const ctxArtist = eng.current(T0);
  const sameArtist = makeSong('SA', { artist_id: 'artist_A', genre: 'Afrobeats', microtags: ['log_drum', 'warm_vocal'] });
  const unrelated = makeSong('UN', { artist_id: 'artist_Z', genre: 'Metal', microtags: ['distorted_guitar'] });
  const bSame = contextBoost(sameArtist, ctxArtist);
  const bOther = contextBoost(unrelated, ctxArtist);
  console.log(`   artist_focus: same-artist boost ${bSame.toFixed(2)}  |  unrelated ${bOther.toFixed(2)}`);
  console.log('   why (same):', explainContextBoost(sameArtist, ctxArtist));
  check('artist_focus boosts the same artist', bSame > 2);
  check('artist_focus boosts same-artist far more than unrelated', bSame > bOther + 3);

  const moodEng = new SessionContextEngine();
  moodEng.activate('mood_focus', {
    anchorMicrotags: ['reverb_wash', 'dreamy_lyrics'], anchorMoodWords: ['longing'], anchorEnergy: 0.45,
    label: 'Late Night',
  }, T0);
  const ctxMood = moodEng.current(T0);
  const onMood = makeSong('OM', { microtags: ['reverb_wash', 'dreamy_lyrics'], mood: 'longing', energy_score: 0.45 });
  const offMood = makeSong('FM', { microtags: ['hard_808_kick', 'gang_vocal'], mood: 'reckless', energy_score: 0.95 });
  const bOn = contextBoost(onMood, ctxMood);
  const bOff = contextBoost(offMood, ctxMood);
  console.log(`   mood_focus: on-mood boost ${bOn.toFixed(2)}  |  abrupt mood-break ${bOff.toFixed(2)}`);
  check('mood_focus boosts an emotionally-consistent song', bOn > 2);
  check('mood_focus penalises an abrupt mood break', bOff < 0);

  // ---- 4. Real-time context switching (pivot) ----
  console.log('\n4) REAL-TIME CONTEXT SWITCHING');
  eng.activate('mood_focus', worldToAnchor(SESSION_WORLDS[3]), T0 + 2 * MIN); // Euphoric EDM
  const piv = eng.current(T0 + 2 * MIN);
  check('activating a new mode pivots instantly', piv.mode === 'mood_focus');
  check('the previous artist anchor is gone', piv.anchor.artistId == null);

  // ---- 5. Skip-streak collapse → wider exploration ----
  console.log('\n5) SKIP-STREAK CONFIDENCE COLLAPSE');
  const skipEng = new SessionContextEngine();
  skipEng.activate('genre_focus', { genre: 'House', label: 'EDM' }, T0);
  const confBefore = skipEng.current(T0).confidence;
  const skipSong = makeSong('SK', { genre: 'House' });
  for (let i = 0; i < 3; i++) skipEng.registerOutcome(skipSong, ['skip_under_15'], true, T0 + i * MIN);
  const confAfter = skipEng.current(T0 + 3 * MIN).confidence;
  console.log(`   confidence ${confBefore.toFixed(2)} → ${confAfter.toFixed(2)} after 3 skips`);
  check('3 skips collapse confidence (exploration widens)', confAfter < confBefore * 0.5);

  // reinforcement raises it back
  skipEng.registerOutcome(skipSong, ['replay'], false, T0 + 4 * MIN);
  check('a replay reinforces the mode', skipEng.current(T0 + 4 * MIN).confidence > confAfter);

  // ---- 6. Anti-fatigue ----
  console.log('\n6) ANTI-FATIGUE (no artist overload)');
  const fatEng = new SessionContextEngine();
  const fatAnchor = makeSong('FA', { artist_id: 'artist_A', genre: 'Afrobeats', microtags: ['log_drum'] });
  fatEng.activate('artist_focus', { artistId: 'artist_A', refSongs: [fatAnchor] }, T0);
  const cand = makeSong('CAND', { artist_id: 'artist_A', genre: 'Afrobeats', microtags: ['log_drum'] });
  const boostFresh = contextBoost(cand, fatEng.current(T0));
  // Play the same artist repeatedly to overload the rolling window.
  for (let i = 0; i < 4; i++) {
    fatEng.registerOutcome(makeSong('p' + i, { artist_id: 'artist_A' }), ['completion_over_70'], true, T0 + i * MIN);
  }
  const boostFatigued = contextBoost(cand, fatEng.current(T0 + 4 * MIN));
  console.log(`   same-artist boost: fresh ${boostFresh.toFixed(2)} → after overload ${boostFatigued.toFixed(2)}`);
  check('anti-fatigue suppresses an overloaded artist', boostFatigued < boostFresh);

  // ---- 7. Freshness — serialize / restore ----
  console.log('\n7) FRESHNESS (serialize → restore with decay)');
  const saveEng = new SessionContextEngine();
  saveEng.activate('mood_focus', worldToAnchor(SESSION_WORLDS[0]), T0); // Night Drive
  const snapshot = saveEng.serialize();
  const restored = new SessionContextEngine();
  const okRestore = restored.restore(snapshot, T0 + 90 * MIN); // reopened 90 min later
  check('a recent session restores', okRestore && restored.current(T0 + 90 * MIN).mode === 'mood_focus');
  check('restored session is decayed, not full-strength',
    restored.current(T0 + 90 * MIN).decayPhase !== 'strong');
  const staleEng = new SessionContextEngine();
  staleEng.activate('mood_focus', worldToAnchor(SESSION_WORLDS[0]), T0);
  const stale = new SessionContextEngine();
  const okStale = stale.restore(staleEng.serialize(), T0 + 14 * HOUR); // next day
  check('a >12h-old session is dropped (next day feels fresh)',
    !okStale && stale.current(T0 + 14 * HOUR).mode === 'default');

  // ---- 8. Explore worlds ----
  console.log('\n8) EXPLORE WORLDS (dynamic, distinct, emotionally consistent)');
  // A catalog where every song carries one world's microtags + energy + mood.
  const worldCatalog: Song[] = [];
  SESSION_WORLDS.forEach((w, wi) => {
    for (let i = 0; i < 14; i++) {
      worldCatalog.push(makeSong(`${w.id}_${i}`, {
        artist_id: `art_${wi}_${i % 5}`,
        microtags: w.microtags,
        mood: w.moodWords[i % w.moodWords.length],
        energy_score: Math.min(1, Math.max(0, w.energy + (rng() - 0.5) * 0.1)),
        similarity_cluster: wi,
      }));
    }
  });
  const nightDrive = buildWorldPlaylist(worldCatalog, SESSION_WORLDS[0], 24);
  const euphoricEdm = buildWorldPlaylist(worldCatalog, SESSION_WORLDS[3], 24);
  console.log(`   "${SESSION_WORLDS[0].label}" → ${nightDrive.length} songs  |  ` +
    `"${SESSION_WORLDS[3].label}" → ${euphoricEdm.length} songs`);
  check('a world generates a non-empty playlist', nightDrive.length > 0 && euphoricEdm.length > 0);
  const overlap = nightDrive.filter((s) => euphoricEdm.some((e) => e.id === s.id)).length;
  check('two worlds feel distinct (low song overlap)', overlap <= 2, `${overlap} shared`);
  const ndTags = new Set(SESSION_WORLDS[0].microtags);
  const consistent = nightDrive.every((s) =>
    (s.microtags ?? []).some((t) => ndTags.has(t)) ||
    SESSION_WORLDS[0].moodWords.includes(s.mood) ||
    Math.abs(s.energy_score - SESSION_WORLDS[0].energy) <= 0.34);
  check('every world song is emotionally consistent with the world', consistent);
  const wArtists = new Map<string, number>();
  for (const s of nightDrive) wArtists.set(s.artist_id ?? '?', (wArtists.get(s.artist_id ?? '?') ?? 0) + 1);
  check('world playlist keeps artist diversity (<=2 per artist)',
    [...wArtists.values()].every((n) => n <= 2));

  // ---- 9. Performance ----
  console.log('\n9) PERFORMANCE');
  const songs = Array.from({ length: 150 }, (_, i) => makeSong('perf' + i, { artist_id: 'a' + (i % 12) }));
  const perfEng = new SessionContextEngine();
  perfEng.activate('mood_focus', worldToAnchor(SESSION_WORLDS[2]), T0);
  const t0 = Date.now();
  const ITER = 500;
  for (let i = 0; i < ITER; i++) {
    perfEng.registerOutcome(songs[i % songs.length], ['completion_over_70'], true, T0 + i * 1000);
    const ctx = perfEng.current(T0 + i * 1000);
    for (const s of songs) contextBoost(s, ctx);
  }
  const ms = (Date.now() - t0) / ITER;
  console.log(`   avg per cycle (1 outcome + 150 boosts): ${ms.toFixed(4)} ms`);
  check('context cycle is fast (<3ms)', ms < 3);

  console.log('\n============', ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED', '============\n');
  if (!ok) process.exitCode = 1;
}

main();
