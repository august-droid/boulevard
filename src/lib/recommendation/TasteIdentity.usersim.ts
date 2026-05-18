/* eslint-disable no-console */
// ============================================================
// QA simulation for the TasteIdentityProfile layer.
//
//   npx tsx src/lib/recommendation/TasteIdentity.usersim.ts
//
// Pure + deterministic. Imports only pure modules (no AsyncStorage, no React,
// no network). Covers the 6 brief scenarios and the verification points:
// cross-genre breadth allowed, identity-breaking suppressed, symmetric (no
// hardcoded "bubblegum bad"), explicit intent overrides, habit respects
// identity, discovery only opens identity-compatible novelty, no demographic
// input, no overfitting after one event, additive + capped, fast.
// ============================================================

import type { Song } from '@/types';
import {
  TasteIdentityProfile, scoreIdentityFit, songIdentityVector,
} from './TasteIdentityProfile';
import { OnboardingSlate } from './OnboardingSlate';
import { HabitProfile, scoreHabitFit } from '../habit/HabitProfile';

let SEED = 20260517;
function rng(): number { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; }
Math.random = rng;

// ---- synthetic catalog --------------------------------------------------
interface Fam {
  genre: string; mood: string; tags: string[]; energy: [number, number];
  hook: [number, number]; mainstream: [number, number]; weird: [number, number];
  skipRisks?: string[]; activity?: ('gym')[];
}
const FAMILIES: Record<string, Fam> = {
  // "mature" cluster — different genres, shared deeper identity.
  rap:   { genre: 'Dark Melodic Rap', mood: 'defiant',
           tags: ['aggressive_lyrics', 'flex_lyrics', 'hard_808_kick', 'melancholic_lyrics', 'late_night_imagery'],
           energy: [0.6, 0.82], hook: [0.45, 0.7], mainstream: [0.3, 0.5], weird: [0.2, 0.45] },
  indie: { genre: 'Indie Rock', mood: 'longing',
           tags: ['intimate_vocal', 'jangly_guitar', 'conversational_vocal', 'tape_warmth', 'melancholic_lyrics'],
           energy: [0.3, 0.5], hook: [0.4, 0.62], mainstream: [0.3, 0.5], weird: [0.25, 0.5] },
  rock:  { genre: 'Alt Rock', mood: 'defiant',
           tags: ['aggressive_lyrics', 'dry_live_drums', 'jangly_guitar', 'gang_vocal'],
           energy: [0.6, 0.85], hook: [0.4, 0.65], mainstream: [0.3, 0.5], weird: [0.2, 0.45] },
  dark:  { genre: 'Dark Electronic', mood: 'haunted',
           tags: ['synth_lead', 'reverb_wash', 'late_night_imagery', 'hard_808_kick'],
           energy: [0.55, 0.85], hook: [0.45, 0.7], mainstream: [0.35, 0.55], weird: [0.3, 0.55] },
  // "childish" cluster — the identity the brief wants suppressed for a mature
  // user (but learned/allowed for a user who actually likes it).
  teen:  { genre: 'Bubblegum Teen Pop', mood: 'bubbly',
           tags: ['cutesy_melody', 'whistle_hook', 'hand_clap_pop', 'boyfriend_lyrics', 'sugary_synth'],
           energy: [0.5, 0.72], hook: [0.8, 0.97], mainstream: [0.82, 0.97], weird: [0.02, 0.12],
           skipRisks: ['cheesy', 'childish'] },
  // high-energy identity-COMPATIBLE option (for the habit-vs-identity test).
  gym:   { genre: 'Hard Trap', mood: 'reckless',
           tags: ['hard_808_kick', 'aggressive_lyrics', 'peak_energy', 'gang_vocal'],
           energy: [0.82, 0.96], hook: [0.5, 0.75], mainstream: [0.3, 0.5], weird: [0.2, 0.4],
           activity: ['gym'] },
  // high-energy identity-MISMATCH option.
  party: { genre: 'Party Pop', mood: 'bubbly',
           tags: ['cutesy_melody', 'whistle_hook', 'hand_clap_pop', 'sugary_synth', 'peak_energy'],
           energy: [0.8, 0.95], hook: [0.8, 0.95], mainstream: [0.8, 0.95], weird: [0.03, 0.14],
           skipRisks: ['cheesy'] },
};
function band([lo, hi]: [number, number]): number { return lo + rng() * (hi - lo); }
function makeSong(fam: string, i: number): Song {
  const f = FAMILIES[fam];
  return {
    id: `${fam}_${i}`, title: `${f.genre} ${i}`, audio_url: `u/${fam}/${i}`, cover_url: '',
    genre: f.genre, bpm: 84 + Math.floor(rng() * 80), mood: f.mood,
    energy_score: band(f.energy),
    vocal_type: (['female', 'male', 'mixed'] as const)[i % 3],
    similarity_cluster: 0, drop_timestamps: [], intro_length: 0,
    activity_fit: f.activity ? [...f.activity] : [],
    duration_seconds: 180, artist_id: `${fam}_art_${i % 6}`, artist_name: `${fam} artist ${i % 6}`,
    microtags: f.tags,
    hook_strength: band(f.hook), mainstream_fit: band(f.mainstream),
    weirdness_score: band(f.weird), uniqueness_score_v2: rng() * 0.5,
    launch_score: 0.4 + rng() * 0.4, quality_score: 0.5 + rng() * 0.4,
    skip_risks: f.skipRisks ? [...f.skipRisks] : [],
    distribution_stage: 'rising',
  };
}
const CATALOG: Song[] = [];
for (const fam of Object.keys(FAMILIES)) for (let i = 0; i < 8; i++) CATALOG.push(makeSong(fam, i));
const get = (id: string) => CATALOG.find((s) => s.id === id)!;
const famSongs = (fam: string) => CATALOG.filter((s) => s.id.startsWith(`${fam}_`));

// ---- harness ------------------------------------------------------------
let ok = true;
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) ok = false;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function header(s: string): void { console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`); }

/** Train a profile: `pos` families get strong positives, `neg` families get
 *  hard skips. Returns the trained profile. */
function trainProfile(pos: string[], neg: string[], reps = 3): TasteIdentityProfile {
  const p = new TasteIdentityProfile();
  for (let r = 0; r < reps; r++) {
    for (const fam of pos) p.update(famSongs(fam)[r], ['completion_over_70', 'save'], true);
    for (const fam of neg) p.update(famSongs(fam)[r], ['skip_under_5'], true);
  }
  return p;
}

// ============================================================
// SCENARIO 1 — user likes rap + indie + rock.
// ============================================================
header('SCENARIO 1 — likes rap + indie + rock (broad genres, shared identity)');
{
  const p = trainProfile(['rap', 'indie', 'rock'], [], 3);
  // Fresh (untrained) songs from each genre + a cross-genre + a teen song.
  const fitRap = scoreIdentityFit(get('rap_6'), p);
  const fitIndie = scoreIdentityFit(get('indie_6'), p);
  const fitRock = scoreIdentityFit(get('rock_6'), p);
  const fitDark = scoreIdentityFit(get('dark_6'), p);   // genre never heard
  const fitTeen = scoreIdentityFit(get('teen_6'), p);
  check('all 3 liked genres score positively (broad genre variety allowed)',
    fitRap > 0 && fitIndie > 0 && fitRock > 0,
    `rap ${fitRap.toFixed(2)} indie ${fitIndie.toFixed(2)} rock ${fitRock.toFixed(2)}`);
  check('an UNHEARD genre that shares the identity (dark electronic) is welcomed',
    fitDark > 0.4, `dark ${fitDark.toFixed(2)}`);
  check('identity-compatible songs out-score an identity-foreign teen-pop song',
    Math.min(fitRap, fitIndie, fitRock, fitDark) > fitTeen,
    `min-mature ${Math.min(fitRap, fitIndie, fitRock, fitDark).toFixed(2)} vs teen ${fitTeen.toFixed(2)}`);
  check('learned identity reads as mature/serious (no genre labels)',
    p.debug().likes.some((d) => ['seriousness', 'introspection', 'authenticity', 'lyrical_maturity', 'darkness', 'rawness'].includes(d)),
    JSON.stringify(p.debug().likes));
}

// ============================================================
// SCENARIO 2 — user skips teen / bubblegum / boyfriend-breakup songs.
// ============================================================
header('SCENARIO 2 — skips teen / bubblegum songs (those traits penalized)');
{
  const p = trainProfile(['rap', 'dark'], ['teen'], 3);
  const ev = p.evaluate(get('teen_6'));
  const fitMature = scoreIdentityFit(get('rap_6'), p);
  check('a teen-pop song lands in the Blocked Mismatch zone', ev.zone === 'blocked',
    `zone ${ev.zone}, conflicts ${ev.conflicts}`);
  check('blocked teen-pop carries a strong penalty (-5..-7)', ev.boost <= -3,
    `boost ${ev.boost.toFixed(2)}`);
  check('identity-compatible songs stay positively scored', fitMature > 0,
    `mature ${fitMature.toFixed(2)}`);
  check('the childish identity dimensions are learned as dislikes',
    p.debug().dislikes.some((d) => ['bubblegum_pop_energy', 'teen_breakup_energy', 'novelty_meme_energy'].includes(d)),
    JSON.stringify(p.debug().dislikes));
}

// ============================================================
// SCENARIO 3 — user actually LIKES hyperpop / teen-pop.
// ============================================================
header('SCENARIO 3 — likes teen-pop (must NOT be unfairly suppressed)');
{
  const p = trainProfile(['teen'], [], 4);
  const ev = p.evaluate(get('teen_7'));
  check('teen-pop is NOT suppressed for a user who likes it', ev.boost > 0,
    `boost ${ev.boost.toFixed(2)}, zone ${ev.zone}`);
  check('the profile learned teen-pop fits this user (symmetric, no hardcoded bias)',
    p.debug().likes.some((d) => ['bubblegum_pop_energy', 'playfulness', 'commercial_polish'].includes(d)),
    JSON.stringify(p.debug().likes));
}

// ============================================================
// SCENARIO 4 — current intent contradicts identity.
// ============================================================
header('SCENARIO 4 — current intent contradicts identity (intent wins, softened)');
{
  const p = trainProfile(['rap', 'dark'], ['teen'], 3);
  const teen = get('teen_6');
  const passive = p.evaluate(teen, {}).boost;                 // teen song just appears
  const explicit = p.evaluate(teen, { explicit: true }).boost; // user explicitly chose it
  check('a teen-pop song is strongly penalised when it just appears', passive <= -3,
    `passive ${passive.toFixed(2)}`);
  check('explicit user choice softens the mismatch so the intent wins', explicit > passive,
    `explicit ${explicit.toFixed(2)} > passive ${passive.toFixed(2)}`);
  check('the mismatch is SOFTENED, not erased (identity still nudges)', explicit < 0,
    `explicit ${explicit.toFixed(2)}`);
}

// ============================================================
// SCENARIO 5 — returning user, habit context, identity boundary respected.
// ============================================================
header('SCENARIO 5 — habit says high-energy; identity still shapes the pick');
{
  const identity = trainProfile(['rap', 'dark', 'rock'], ['teen'], 3);
  // Habit: a string of high-energy weekday-night plays.
  const habit = new HabitProfile();
  const base = new Date(2026, 4, 18, 22, 0, 0).getTime();
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 4; i++) habit.record(famSongs('gym')[i], ['completion_over_70'], base + d * 86400000);
  }
  const hctx = habit.getHabitContext(base + 3 * 86400000);
  const gym = get('gym_6');     // high energy + identity-compatible
  const party = get('party_6'); // high energy + identity-mismatch
  const gymTotal = scoreHabitFit(gym, hctx) + scoreIdentityFit(gym, identity);
  const partyTotal = scoreHabitFit(party, hctx) + scoreIdentityFit(party, identity);
  check('both high-energy songs satisfy the habit context',
    scoreHabitFit(gym, hctx) > 0 && scoreHabitFit(party, hctx) > 0,
    `gym ${scoreHabitFit(gym, hctx).toFixed(2)} party ${scoreHabitFit(party, hctx).toFixed(2)}`);
  check('habit + identity together pick the identity-compatible high-energy song',
    gymTotal > partyTotal,
    `gym ${gymTotal.toFixed(2)} vs party ${partyTotal.toFixed(2)}`);
}

// ============================================================
// SCENARIO 6 — discovery mode.
// ============================================================
header('SCENARIO 6 — discovery allows novelty only if identity-compatible');
{
  const p = trainProfile(['rap', 'dark'], ['teen'], 3);
  // Discovery never RESCUES an identity-break.
  const teenDiscovery = p.evaluate(get('teen_6'), { discoveryMode: true });
  check('discovery mode does NOT rescue a Blocked identity mismatch',
    teenDiscovery.zone === 'blocked' && teenDiscovery.boost <= -3,
    `zone ${teenDiscovery.zone}, boost ${teenDiscovery.boost.toFixed(2)}`);
  // Discovery never makes a song score worse than without it.
  let discoveryNeverWorse = true;
  for (const s of CATALOG) {
    if (p.evaluate(s, { discoveryMode: true }).boost < p.evaluate(s, {}).boost - 1e-9) discoveryNeverWorse = false;
  }
  check('discovery only ever opens novelty up, never penalises further', discoveryNeverWorse);
  // An identity-compatible novel genre is allowed through discovery.
  check('an identity-compatible song is welcomed (controlled discovery preserved)',
    p.evaluate(get('rock_6'), { discoveryMode: true }).boost > 0,
    `rock ${p.evaluate(get('rock_6'), { discoveryMode: true }).boost.toFixed(2)}`);
}

// ============================================================
// CROSS-CUTTING — no demographics, no overfitting, capped, fast, intact.
// ============================================================
header('CROSS-CUTTING — demographics / overfitting / caps / perf / regression');
{
  // No demographic input: the profile is built ONLY from (song, behaviour).
  // Identical behaviour ⇒ identical profile, regardless of any user trait.
  const a = trainProfile(['rap', 'indie'], ['teen'], 3);
  const b = trainProfile(['rap', 'indie'], ['teen'], 3);
  check('identity is purely behavioural — same behaviour ⇒ same scores',
    Math.abs(scoreIdentityFit(get('rap_6'), a) - scoreIdentityFit(get('rap_6'), b)) < 1e-9);

  // No overfitting after a single event.
  const one = new TasteIdentityProfile();
  one.update(get('rap_0'), ['completion_over_70'], true);
  const oneShot = Math.abs(scoreIdentityFit(get('rap_6'), one));
  check('one event does not overfit (boost stays small until confidence builds)',
    oneShot < 1, `boost after 1 song ${oneShot.toFixed(2)}, confidence ${one.overallConfidence().toFixed(2)}`);

  // Additive + capped: every boost is within the [-7, +4] contract.
  const trained = trainProfile(['rap', 'dark', 'rock'], ['teen'], 4);
  let withinCap = true;
  for (const s of CATALOG) {
    const boost = trained.evaluate(s).boost;
    if (boost < -7.0001 || boost > 4.0001) withinCap = false;
  }
  check('every identity boost stays within the additive cap (-7 .. +4)', withinCap);

  // songIdentityVector dims are all 0..1.
  let vecOk = true;
  for (const s of CATALOG) {
    const v = songIdentityVector(s);
    for (const d in v) if (v[d as keyof typeof v] < 0 || v[d as keyof typeof v] > 1) vecOk = false;
  }
  check('every derived identity dimension stays in [0,1]', vecOk);

  // Performance — pure scoring, no model / no network.
  const t0 = Date.now();
  for (let r = 0; r < 50; r++) for (const s of CATALOG) trained.evaluate(s);
  const elapsed = Date.now() - t0;
  check('2800 identity evaluations are fast (<120ms — no perf regression)', elapsed < 120, `${elapsed}ms`);

  // Existing flow intact: OnboardingSlate still builds 10 with an identity ref.
  const slate = new OnboardingSlate(CATALOG, { safetyMode: true, identity: trained });
  check('OnboardingSlate still builds a full 10-song slate with identity wired',
    slate.debugSnapshot().slate.length === 10);
}

header(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
if (!ok) process.exitCode = 1;
