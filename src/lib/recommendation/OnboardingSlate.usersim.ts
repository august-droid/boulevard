/* eslint-disable no-console */
// 3-new-user end-to-end simulation for the personalization algorithm.
//
//   npx tsx src/lib/recommendation/OnboardingSlate.usersim.ts
//
// Runs the onboarding slate + contextual session engine as three brand-new
// users with deliberately different tastes (EDM, sad-indie, rap) and verifies
// the algorithm personalizes for each. The synthetic catalog sets
// `similarity_cluster` to 0 on EVERY song on purpose — that reproduces the
// real live catalog (147/150 songs share one cluster id), so this doubles as
// a regression test for the genre-first clusterKey fix: if cluster identity
// fell back to `similarity_cluster` the diversity cap would collapse the
// slate. Math.random is seeded so the run is deterministic.

import type { Song } from '@/types';
import { OnboardingSlate } from './OnboardingSlate';
import { SessionContextEngine, contextBoost } from './SessionContext';

// ---- deterministic RNG (also patched over Math.random) --------------------
let SEED = 20260516;
function rng(): number { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; }
Math.random = rng;

// ---- synthetic catalog ----------------------------------------------------
// Three taste families + a mainstream-pop pool for trust anchors. EVERY song
// has similarity_cluster = 0 (reproduces the degenerate live catalog).
interface Fam { genres: string[]; tags: string[]; mood: string; energy: [number, number]; }
const FAMILIES: Record<string, Fam> = {
  edm:   { genres: ['House', 'Tech House', 'EDM Dance', 'Festival House'],
           tags: ['peak_energy', 'dance_tempo', 'four_on_the_floor', 'club_lyrics', 'mood_euphoric'],
           mood: 'euphoric', energy: [0.74, 0.95] },
  indie: { genres: ['Indie Rock', 'Bedroom Pop', 'Dark Alt-Pop', 'Dream Pop'],
           tags: ['melancholic_lyrics', 'intimate_vocal', 'reverb_wash', 'dreamy_lyrics', 'mood_sad'],
           mood: 'longing', energy: [0.20, 0.46] },
  rap:   { genres: ['Melodic Rap', 'Trap', 'Drill', 'Rap'],
           tags: ['hard_808_kick', 'aggressive_lyrics', 'flex_lyrics', 'gang_vocal', 'mood_confident'],
           mood: 'confident', energy: [0.60, 0.90] },
  pop:   { genres: ['Stadium Pop Anthem', 'Country Pop'],
           tags: ['big_hook', 'radio_ready', 'mood_warm'],
           mood: 'warm', energy: [0.5, 0.7] },
};

function makeSong(fam: string, i: number): Song {
  const f = FAMILIES[fam];
  const g = f.genres[i % f.genres.length];
  return {
    id: `${fam}_${i}`, title: `${g} ${i}`, audio_url: `u/${fam}/${i}`, cover_url: '',
    genre: g, bpm: 90 + Math.floor(rng() * 70), mood: f.mood,
    energy_score: f.energy[0] + rng() * (f.energy[1] - f.energy[0]),
    vocal_type: (['female', 'male', 'mixed'] as const)[i % 3],
    similarity_cluster: 0,                       // ← degenerate on purpose
    drop_timestamps: [], intro_length: 0, activity_fit: [], duration_seconds: 180,
    artist_id: `${fam}_art_${i % 6}`, artist_name: `${fam} artist ${i % 6}`,
    microtags: f.tags,
    hook_strength: 0.45 + rng() * 0.5, mainstream_fit: (fam === 'pop' ? 0.7 : 0.3) + rng() * 0.3,
    launch_score: 0.4 + rng() * 0.5, quality_score: 0.5 + rng() * 0.4,
    uniqueness_score_v2: rng() * 0.6, weirdness_score: rng() * 0.4,
    distribution_stage: 'rising',
  };
}
const CATALOG: Song[] = [];
for (const fam of ['edm', 'indie', 'rap']) for (let i = 0; i < 24; i++) CATALOG.push(makeSong(fam, i));
for (let i = 0; i < 10; i++) CATALOG.push(makeSong('pop', i));

// ---- simulated listeners --------------------------------------------------
interface User { name: string; fam: string; loved: string[]; energy: number; tags: string[]; }
const USERS: User[] = [
  { name: 'A · EDM/club', fam: 'edm', loved: FAMILIES.edm.genres, energy: 0.85,
    tags: ['dance', 'peak_energy', 'four_on', 'club', 'euphoric'] },
  { name: 'B · Sad indie', fam: 'indie', loved: FAMILIES.indie.genres, energy: 0.32,
    tags: ['melanchol', 'intimate', 'reverb', 'dreamy', 'sad'] },
  { name: 'C · Rap/hype', fam: 'rap', loved: FAMILIES.rap.genres, energy: 0.78,
    tags: ['808', 'aggressive', 'flex', 'gang', 'confident'] },
];

function appeal(u: User, s: Song): number {
  const g = u.loved.includes(s.genre) ? 1 : 0.12;
  const e = 1 - Math.min(1, Math.abs(s.energy_score - u.energy) / 0.5);
  const hits = (s.microtags ?? []).filter((t) => u.tags.some((k) => t.includes(k))).length;
  return 0.55 * g + 0.25 * e + 0.20 * Math.min(1, hits / 3);
}
function react(a: number): string[] {
  if (a >= 0.7) return rng() < 0.6 ? ['completion_over_70', 'save'] : ['completion_over_70'];
  if (a >= 0.55) return ['listen_60s'];
  if (a >= 0.4) return ['listen_30s'];
  if (a >= 0.25) return ['skip_under_15'];
  return ['skip_under_5'];
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

let ok = true;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok = cond && ok;
};

function runUser(u: User) {
  console.log(`\n${'='.repeat(64)}\nUSER ${u.name}\n${'='.repeat(64)}`);
  const slate = new OnboardingSlate(CATALOG, { safetyMode: true });
  const journey: { role: string; genre: string; appeal: number; reaction: string }[] = [];
  for (let step = 0; step < 10; step++) {
    const next = slate.serve(1, []);
    if (next.length === 0) break;
    const song = next[0];
    const a = appeal(u, song);
    const kinds = react(a);
    journey.push({
      role: slate.debugSnapshot().slate[step]?.role ?? '?',
      genre: song.genre, appeal: a, reaction: kinds.join('+'),
    });
    slate.applySignal(song, kinds as never[], true);
  }
  journey.forEach((j, i) =>
    console.log(`  ${String(i + 1).padStart(2)} [${j.role.padEnd(9)}] ${j.genre.padEnd(20)} appeal ${j.appeal.toFixed(2)}  ${j.reaction}`));

  const front = avg(journey.slice(0, 4).map((j) => j.appeal));
  const back = avg(journey.slice(6).map((j) => j.appeal));
  const snap = slate.debugSnapshot();
  console.log(`  front ${front.toFixed(2)} → back ${back.toFixed(2)} | confidence ${snap.confidence} ` +
    `(${snap.confidenceBucket}) | lean-in ${JSON.stringify(snap.leanClusters)}`);
  check(`${u.name}: slate built all 10 slots (clusterKey fix — degenerate similarity_cluster)`,
    snap.slate.length === 10);
  check(`${u.name}: learns — back-half appeal >= front-half`, back >= front - 0.05,
    `${front.toFixed(2)} → ${back.toFixed(2)}`);
  // Slot 9 is the exploit position. A hard skip on slot 8 can re-cast it to a
  // recovery slot (intended) — either way the song there should be in-lane.
  const exploitSlot = journey[8];
  check(`${u.name}: exploit-position slot (9) lands in the user's lane`,
    !!exploitSlot && u.loved.includes(exploitSlot.genre),
    `slot 9 = ${exploitSlot?.role}/${exploitSlot?.genre}`);
  check(`${u.name}: lean-in cluster is the user's genre family`,
    snap.leanClusters.some((c) => u.loved.includes(c)),
    JSON.stringify(snap.leanClusters));
  return journey.map((j) => j.genre + j.role);
}

function main() {
  console.log(`\n3-USER ALGORITHM SIMULATION — ${CATALOG.length} songs, all similarity_cluster=0\n`);
  const sigs = USERS.map(runUser);

  console.log(`\n${'='.repeat(64)}\nCROSS-USER DIVERGENCE\n${'='.repeat(64)}`);
  const ov = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;
  console.log(`  shared slate entries  A∩B ${ov(sigs[0], sigs[1])}  A∩C ${ov(sigs[0], sigs[2])}  B∩C ${ov(sigs[1], sigs[2])}`);
  check('3 distinct tastes produce distinct slates',
    ov(sigs[0], sigs[1]) <= 4 && ov(sigs[0], sigs[2]) <= 4 && ov(sigs[1], sigs[2]) <= 4);

  console.log(`\n${'='.repeat(64)}\nCONTEXTUAL SESSION ENGINE\n${'='.repeat(64)}`);
  const edm = CATALOG.find((s) => s.genre === 'House')!;
  const indie = CATALOG.find((s) => s.genre === 'Bedroom Pop')!;
  const rapS = CATALOG.filter((s) => s.genre === 'Trap');
  const eA = new SessionContextEngine();
  eA.activate('genre_focus', { genre: 'House', refSongs: [edm] });
  check('genre_focus(House) boosts House over indie',
    contextBoost(edm, eA.current()) > contextBoost(indie, eA.current()));
  const eB = new SessionContextEngine();
  eB.activate('mood_focus', { anchorMicrotags: indie.microtags, anchorMoodWords: [indie.mood], anchorEnergy: indie.energy_score, refSongs: [indie] });
  check('mood_focus(sad) boosts the sad song over an EDM song',
    contextBoost(indie, eB.current()) > contextBoost(edm, eB.current()));
  const eC = new SessionContextEngine();
  eC.activate('artist_focus', { artistId: rapS[0].artist_id, refSongs: [rapS[0]] });
  const otherArtist = rapS.find((s) => s.artist_id !== rapS[0].artist_id) ?? indie;
  check('artist_focus boosts the same artist over a different one',
    contextBoost(rapS[0], eC.current()) > contextBoost(otherArtist, eC.current()));

  console.log(`\n${'='.repeat(64)}\n${ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n${'='.repeat(64)}\n`);
  if (!ok) process.exitCode = 1;
}

main();
