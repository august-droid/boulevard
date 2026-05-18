/* eslint-disable no-console */
// ============================================================
// QA simulation for the Surprise Me controlled-discovery engine.
//
//   npx tsx src/lib/recommendation/SurpriseEngine.usersim.ts
//
// Pure + deterministic. Covers the brief's four listener types (rap, indie,
// EDM, mixed-taste) plus cold-start, and the verification points:
//   • surprises feel intentional   — medium-risk band, not random
//   • no identity-breaking songs   — zero blocked-zone / anti-identity songs
//   • adjacent discovery works     — queue leans on adjacent, not core, lanes
//   • replay/save potential high   — mean collaborative upside stays strong
//   • session quality holds        — no extreme-risk songs, queue never empty
// ============================================================

import type { Song, TasteProfile, SongStats, SessionProfile } from '@/types';
import { buildSurpriseQueue } from './SurpriseEngine';
import { TasteIdentityProfile } from './TasteIdentityProfile';
import type { ChipMoodId } from '@/lib/mood/moodCatalog';

let SEED = 20260517;
function rng(): number { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; }
Math.random = rng;

// ---- synthetic catalog --------------------------------------------------
interface Fam {
  genre: string;
  mood: string;
  tags: string[];
  energy: [number, number];
  /** [replay_rate, save_rate, avg_completion, skip_rate] bands. */
  stats: [[number, number], [number, number], [number, number], [number, number]];
  skipRisks?: string[];
}
const FAMILIES: Record<string, Fam> = {
  // ---- mature cluster — shared identity, different genres ----
  rap:     { genre: 'melodic rap', mood: 'defiant',
             tags: ['aggressive_lyrics', 'flex_lyrics', 'hard_808_kick', 'late_night_imagery', 'melancholic_lyrics'],
             energy: [0.6, 0.82], stats: [[0.4, 0.6], [0.35, 0.55], [0.68, 0.88], [0.08, 0.22]] },
  trap:    { genre: 'trap', mood: 'reckless',
             tags: ['hard_808_kick', 'gang_vocal', 'aggressive_lyrics', 'peak_energy'],
             energy: [0.78, 0.94], stats: [[0.4, 0.58], [0.32, 0.5], [0.62, 0.82], [0.12, 0.28]] },
  darkelec:{ genre: 'electronic', mood: 'haunted',
             tags: ['synth_lead', 'reverb_wash', 'late_night_imagery', 'hard_808_kick'],
             energy: [0.5, 0.78], stats: [[0.38, 0.56], [0.34, 0.52], [0.66, 0.86], [0.1, 0.24]] },
  rock:    { genre: 'alt rock', mood: 'defiant',
             tags: ['aggressive_lyrics', 'dry_live_drums', 'jangly_guitar', 'gang_vocal'],
             energy: [0.6, 0.85], stats: [[0.36, 0.54], [0.3, 0.48], [0.64, 0.84], [0.12, 0.26]] },
  indie:   { genre: 'indie rock', mood: 'longing',
             tags: ['intimate_vocal', 'jangly_guitar', 'conversational_vocal', 'tape_warmth', 'melancholic_lyrics'],
             energy: [0.3, 0.52], stats: [[0.38, 0.56], [0.36, 0.54], [0.7, 0.9], [0.08, 0.2]] },
  folk:    { genre: 'indie folk', mood: 'tender',
             tags: ['acoustic_guitar', 'warm_vocal', 'intimate_vocal', 'vinyl_crackle'],
             energy: [0.25, 0.46], stats: [[0.36, 0.54], [0.34, 0.52], [0.68, 0.88], [0.08, 0.22]] },
  dreampop:{ genre: 'dream pop', mood: 'longing',
             tags: ['reverb_wash', 'dreamy_lyrics', 'synth_lead', 'jangly_guitar'],
             energy: [0.35, 0.56], stats: [[0.37, 0.55], [0.33, 0.51], [0.66, 0.86], [0.1, 0.24]] },
  // ---- dance cluster ----
  edm:     { genre: 'house', mood: 'euphoric',
             tags: ['four_on_the_floor', 'peak_energy', 'big_hook', 'synth_lead'],
             energy: [0.82, 0.96], stats: [[0.42, 0.6], [0.3, 0.5], [0.6, 0.82], [0.12, 0.3]] },
  techno:  { genre: 'techno', mood: 'reckless',
             tags: ['four_on_the_floor', 'peak_tempo', 'dance_tempo', 'synth_lead'],
             energy: [0.8, 0.95], stats: [[0.4, 0.58], [0.3, 0.48], [0.62, 0.82], [0.14, 0.3]] },
  afro:    { genre: 'afrobeats', mood: 'warm',
             tags: ['log_drum', 'shaker_groove', 'warm_vocal', 'dance_tempo'],
             energy: [0.55, 0.74], stats: [[0.4, 0.56], [0.35, 0.5], [0.7, 0.86], [0.1, 0.22]] },
  // ---- anti-identity cluster — the brief's "random teen-pop / bubblegum" ----
  teen:    { genre: 'bubblegum teen pop', mood: 'bubbly',
             tags: ['cutesy_melody', 'whistle_hook', 'hand_clap_pop', 'boyfriend_lyrics', 'sugary_synth'],
             energy: [0.5, 0.74], stats: [[0.14, 0.3], [0.1, 0.24], [0.4, 0.6], [0.35, 0.62]],
             skipRisks: ['cheesy', 'childish'] },
};

function band([lo, hi]: [number, number]): number { return lo + rng() * (hi - lo); }

const CATALOG: Song[] = [];
const STATS = new Map<string, SongStats>();
for (const fam of Object.keys(FAMILIES)) {
  const f = FAMILIES[fam];
  for (let i = 0; i < 11; i++) {
    const id = `${fam}_${i}`;
    CATALOG.push({
      id, title: `${f.genre} ${i}`, audio_url: `u/${id}`, cover_url: '',
      genre: f.genre, bpm: 90 + Math.floor(rng() * 70), mood: f.mood,
      energy_score: band(f.energy),
      vocal_type: (['female', 'male', 'mixed'] as const)[i % 3],
      similarity_cluster: 0, drop_timestamps: [], intro_length: 0, activity_fit: [],
      duration_seconds: 180, artist_id: `${fam}_art_${i % 5}`, artist_name: `${fam} artist ${i % 5}`,
      microtags: [...f.tags],
      hook_strength: 0.45 + rng() * 0.4, mainstream_fit: 0.3 + rng() * 0.4,
      weirdness_score: 0.25 + rng() * 0.35, uniqueness_score_v2: rng() * 0.5,
      launch_score: 0.4 + rng() * 0.4, quality_score: 0.5 + rng() * 0.4,
      skip_risks: f.skipRisks ? [...f.skipRisks] : [],
      distribution_stage: i % 3 === 0 ? 'new_test' : 'rising',
    });
    STATS.set(id, {
      song_id: id, plays: 500 + Math.floor(rng() * 4000), unique_listeners: 200,
      avg_completion: band(f.stats[2]), skip_rate: band(f.stats[3]),
      save_rate: band(f.stats[1]), replay_rate: band(f.stats[0]),
      share_rate: 0.1, velocity_score: rng() * 0.7, trending_score: rng() * 0.6,
    });
  }
}
const famSongs = (fam: string) => CATALOG.filter((s) => s.id.startsWith(`${fam}_`));
const famOf = (s: Song) => s.id.split('_')[0];

// ---- profile builders ---------------------------------------------------

/** Train a behavioural identity: `pos` families get strong positives, `neg`
 *  families get hard skips. */
function trainIdentity(pos: string[], neg: string[], reps = 4): TasteIdentityProfile {
  const p = new TasteIdentityProfile();
  for (let r = 0; r < reps; r++) {
    for (const fam of pos) p.update(famSongs(fam)[r], ['completion_over_70', 'save'], true);
    for (const fam of neg) p.update(famSongs(fam)[r], ['skip_under_5'], true);
  }
  return p;
}

/** Build a lifetime TasteProfile from the `pos` families' genres + microtags. */
function makeTaste(pos: string[]): TasteProfile {
  const genre_scores: Record<string, number> = {};
  const microtag_scores: Record<string, number> = {};
  const mood_scores: Record<string, number> = {};
  for (const fam of pos) {
    const f = FAMILIES[fam];
    genre_scores[f.genre] = (genre_scores[f.genre] ?? 0) + 5;
    mood_scores[f.mood] = (mood_scores[f.mood] ?? 0) + 4;
    for (const t of f.tags) microtag_scores[t] = (microtag_scores[t] ?? 0) + 3;
  }
  return {
    user_id: 'sim', genre_scores, mood_scores, microtag_scores,
    bpm_preference: null, energy_preference: null,
    vocal_preferences: { instrumental: 0, male: 0, female: 0, mixed: 0 },
    activity_scores: {}, similarity_cluster_scores: {},
  };
}

// ---- harness ------------------------------------------------------------
let ok = true;
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) ok = false;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function header(s: string): void { console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`); }

interface ListenerCase {
  name: string;
  coreFams: string[];           // genres the user lives in
  identityPos: string[];        // families that trained the identity
  topMoodIds: ChipMoodId[];
}

function runListener(c: ListenerCase): void {
  header(`${c.name} — core: ${c.coreFams.join(' + ')}`);
  const identity = trainIdentity(c.identityPos, ['teen'], 4);
  const taste = makeTaste(c.coreFams);
  const result = buildSurpriseQueue({
    catalog: CATALOG,
    taste,
    identity,
    session: null,
    topMoodIds: c.topMoodIds,
    stats: STATS,
    limit: 26,
  });

  const fams = result.songs.map(famOf);
  const teenCount = fams.filter((f) => f === 'teen').length;
  const coreCount = fams.filter((f) => c.coreFams.includes(f)).length;
  // Discovery = anything outside the user's core lane that is not the
  // anti-identity (teen) family.
  const discoveryCount = fams.filter((f) => !c.coreFams.includes(f) && f !== 'teen').length;
  const coreFrac = result.songs.length ? coreCount / result.songs.length : 0;
  const inBand = result.picks.filter((p) => p.surpriseRiskScore >= 0.34 && p.surpriseRiskScore <= 0.7).length;
  const maxRisk = Math.max(0, ...result.picks.map((p) => p.surpriseRiskScore));
  const blockedZone = result.picks.filter((p) => p.zone === 'blocked').length;
  const famSpread = new Set(fams).size;

  console.log(`  queue=${result.songs.length}  families={${[...new Set(fams)].sort().join(',')}}`);
  console.log(`  debug: ${JSON.stringify(result.debug)}`);

  // 1. no identity-breaking songs
  check('zero anti-identity (teen/bubblegum) songs in the queue', teenCount === 0,
    `teen ${teenCount}`);
  check('zero blocked-zone songs in the queue', blockedZone === 0);
  check('no extreme-risk song surfaced (all risk < 0.8)', maxRisk < 0.8,
    `maxRisk ${maxRisk.toFixed(2)}`);
  // 2. adjacent discovery works
  check('queue is overwhelmingly discovery, not the core lane',
    discoveryCount >= result.songs.length * 0.8,
    `discovery ${discoveryCount}/${result.songs.length}`);
  check('queue is not just the core lane (controlled discovery, not "for you")',
    coreFrac < 0.5, `core ${(coreFrac * 100).toFixed(0)}%`);
  check('queue spans multiple genres (≥3 families)', famSpread >= 3, `${famSpread} families`);
  // 3. surprises feel intentional — medium-risk band
  check('most picks land in the medium-risk band', inBand / Math.max(1, result.picks.length) >= 0.5,
    `${inBand}/${result.picks.length} in band`);
  check('mean risk is controlled-medium (0.3..0.72)',
    result.debug.meanRisk >= 0.3 && result.debug.meanRisk <= 0.72,
    `meanRisk ${result.debug.meanRisk.toFixed(3)}`);
  // 4. replay/save potential stays high
  check('mean collaborative upside stays strong (≥0.22)', result.debug.meanUpside >= 0.22,
    `meanUpside ${result.debug.meanUpside.toFixed(3)}`);
  // 5. session quality does not collapse
  check('queue is full / does not collapse (≥20 songs)', result.songs.length >= 20,
    `${result.songs.length} songs`);
}

runListener({
  name: 'RAP LISTENER', coreFams: ['rap'], identityPos: ['rap'],
  topMoodIds: ['hyped', 'main_character'],
});
runListener({
  name: 'INDIE LISTENER', coreFams: ['indie'], identityPos: ['indie'],
  topMoodIds: ['chill', 'night_drive'],
});
runListener({
  name: 'EDM LISTENER', coreFams: ['edm'], identityPos: ['edm'],
  topMoodIds: ['party', 'hyped'],
});
runListener({
  name: 'MIXED-TASTE LISTENER', coreFams: ['rap', 'indie', 'edm'],
  identityPos: ['rap', 'indie', 'edm'],
  topMoodIds: ['hyped', 'chill'],
});

// ---- cold-start ---------------------------------------------------------
header('COLD-START USER — no taste, no identity (must not crash / collapse)');
{
  const result = buildSurpriseQueue({
    catalog: CATALOG, taste: null, identity: null, session: null,
    topMoodIds: [], stats: STATS, limit: 26,
  });
  check('cold-start still produces a full queue', result.songs.length >= 20,
    `${result.songs.length} songs`);
  check('cold-start queue spans many genres (broad discovery)',
    new Set(result.songs.map(famOf)).size >= 5,
    `${new Set(result.songs.map(famOf)).size} families`);
  check('cold-start still avoids extreme risk',
    Math.max(0, ...result.picks.map((p) => p.surpriseRiskScore)) < 0.8);
}

// ---- session coherence --------------------------------------------------
header('SESSION COHERENCE — a live session profile must not break the engine');
{
  const identity = trainIdentity(['rap'], ['teen'], 4);
  const session: SessionProfile = {
    microtag_scores: { hard_808_kick: 2, aggressive_lyrics: 1.5, synth_lead: 1 },
    last_interaction_at: Date.now(),
  };
  const result = buildSurpriseQueue({
    catalog: CATALOG, taste: makeTaste(['rap']), identity, session,
    topMoodIds: ['hyped', 'main_character'], stats: STATS, limit: 26,
  });
  check('session-aware run still produces a clean controlled queue',
    result.songs.length >= 20 && result.picks.every((p) => p.zone !== 'blocked'),
    `${result.songs.length} songs`);
  check('session-aware run still excludes anti-identity songs',
    result.songs.every((s) => famOf(s) !== 'teen'));
}

console.log(`\n${'='.repeat(72)}`);
console.log(ok ? 'ALL SURPRISE-ME CHECKS PASSED' : 'SOME SURPRISE-ME CHECKS FAILED');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
