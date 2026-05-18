import { Song, TasteProfile, SessionProfile, SongStats } from '@/types';
import { ChipMoodId, ChipMood, moodById } from '@/lib/mood/moodCatalog';
import { adjacentMoods, genresRelated } from '@/lib/recommendation/Adjacency';
import { scoreHabitFit, type HabitContext } from '@/lib/habit/HabitProfile';
import { scoreIdentityFit, type TasteIdentityProfile } from '@/lib/recommendation/TasteIdentityProfile';

// For You recommendation pool (spec PART 3 + PART 4).
//
// Produces a 20-30 song pool that feels like the user's taste but stays fresh
// every visit. The pool is a deliberate blend of four lanes:
//
//   core taste   ~50%  top moods, top microtags, favourite genres
//   adjacent     ~25%  one step away: related moods / genre families
//   fresh        ~15%  new or trending songs that match a strong taste signal
//   exploration  ~10%  strong global songs outside the user's usual lane
//
// Diversity constraints stop the pool from fatiguing the user (max 2 per
// artist, no long runs of one mood or one energy band). When the catalog is
// too small to satisfy everything, constraints relax in a fixed order so the
// shelf is never empty:
//   1. 24h shown-suppression  2. diversity  3. lane mix.

export interface ForYouInput {
  catalog: Song[];
  /** Lifetime taste — slow-changing, defines stable taste. */
  taste: TasteProfile | null;
  /** Session taste — fast-changing, adapts today's recommendations. */
  session: SessionProfile | null;
  /** Moods ordered by behavior score (MoodStore.orderedMoodIds). */
  topMoodIds: ChipMoodId[];
  /** Set when the user explicitly tapped a mood chip — shifts the blend to
   *  40% lifetime / 60% session mood. */
  sessionMoodId?: ChipMoodId | null;
  /** Song ids inside the 24h anti-repeat window (ExposureLog.suppressedIds). */
  suppressedIds?: Set<string>;
  /** Recently skipped song ids — drives the skip-similarity penalty. */
  recentSkippedIds?: string[];
  /** Per-song aggregate stats. Empty when offline / no analytics yet. */
  stats?: Map<string, SongStats>;
  /** Lifetime interaction count — drives cold-start handling. */
  interactionCount: number;
  /** Habit personalization — a soft, time-aware boost (HabitProfile.ts).
   *  Optional: a brand-new user has habit confidence 0, so this self-gates
   *  to a no-op until a genuine time-of-day pattern has formed. */
  habit?: HabitContext | null;
  /** Behavioural taste-identity profile (TasteIdentityProfile.ts). Optional:
   *  keeps the pool from drifting into identity mismatches even when genre /
   *  mood technically match. Self-gates on behavioural confidence. */
  identity?: TasteIdentityProfile | null;
  /** Target pool size. Clamped to 12-30; defaults to 28. */
  limit?: number;
  now?: number;
}

export type ForYouLane = 'core' | 'adjacent' | 'fresh' | 'exploration';

export interface ForYouResult {
  songs: Song[];
  /** How many songs landed in each lane — useful for debugging. */
  buckets: Record<ForYouLane, number>;
  /** Names of any constraints that had to be relaxed to fill the pool. */
  relaxed: string[];
}

const COLD_START_THRESHOLD = 5;
const FRESH_WINDOW_MS = 21 * 24 * 60 * 60 * 1000; // "new" = released in the last 3 weeks
const TASTE_STRONG = 4;   // taste+microtag sum above this counts as a strong core match
const MICROTAG_CAP = 12;  // cap the blended microtag contribution

interface Scored {
  song: Song;
  score: number;
  lane: ForYouLane;
  moodWord: string; // primary mood, for the same-mood run constraint
  energy: number;
}

/** Number of mood-signal axes (context / microtag / mood-word) a song shares
 *  with a mood. 0 means no match. */
function moodMatchCount(song: Song, mood: ChipMood): number {
  let n = 0;
  const ctx = song.primary_listener_contexts ?? [];
  const tags = song.microtags ?? [];
  for (const c of mood.contexts) if (ctx.includes(c)) n++;
  for (const t of mood.microtags) if (tags.includes(t)) n++;
  if (song.mood && mood.moodWords.includes(song.mood)) n++;
  return n;
}

function sumMicrotags(song: Song, scores: Record<string, number> | undefined): number {
  if (!scores) return 0;
  let s = 0;
  for (const t of song.microtags ?? []) s += scores[t] ?? 0;
  return s;
}

export function buildForYou(input: ForYouInput): ForYouResult {
  const now = input.now ?? Date.now();
  const limit = Math.max(12, Math.min(30, input.limit ?? 28));
  const suppressed = input.suppressedIds ?? new Set<string>();

  // ---- Session vs lifetime blend (spec PART 4). Tapping a mood chip tilts
  //      the microtag signal to 60% session / 40% lifetime. ----
  const moodActive = !!input.sessionMoodId;
  const lifetimeW = moodActive ? 0.4 : 0.7;
  const sessionW = moodActive ? 0.6 : 0.3;

  // Active moods: a tapped chip leads; otherwise the user's top behavior moods.
  const topMoods = (
    input.sessionMoodId
      ? [input.sessionMoodId, ...input.topMoodIds.filter((m) => m !== input.sessionMoodId)]
      : input.topMoodIds
  ).slice(0, 3);
  const coreMoodDefs = topMoods.map(moodById).filter((m): m is ChipMood => !!m);

  const adjMoodIdSet = new Set<ChipMoodId>();
  for (const m of topMoods) {
    for (const a of adjacentMoods(m)) if (!topMoods.includes(a)) adjMoodIdSet.add(a);
  }
  const adjMoodDefs = [...adjMoodIdSet].map(moodById).filter((m): m is ChipMood => !!m);

  // Favourite genres from lifetime taste (graceful when taste is null).
  const favGenres = input.taste
    ? Object.entries(input.taste.genre_scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([g]) => g)
    : [];

  // Skip-similarity tag set — microtags shared by recently skipped songs.
  const skipTags = new Set<string>();
  if (input.recentSkippedIds && input.recentSkippedIds.length > 0) {
    const skipSet = new Set(input.recentSkippedIds);
    for (const s of input.catalog) {
      if (skipSet.has(s.id)) for (const t of s.microtags ?? []) skipTags.add(t);
    }
  }

  // ---- Score + classify every eligible song. ----
  const scoreOne = (song: Song): Scored | null => {
    if (!song.audio_url) return null;
    if ((song.distribution_stage ?? 'new_test') === 'suppressed') return null;

    const stat = input.stats?.get(song.id);

    // microtag_match_score — blended lifetime + session.
    const lifeMt = sumMicrotags(song, input.taste?.microtag_scores);
    const sessMt = sumMicrotags(song, input.session?.microtag_scores);
    const microtagMatch = Math.max(
      -MICROTAG_CAP,
      Math.min(MICROTAG_CAP, lifetimeW * lifeMt + sessionW * sessMt),
    );

    // taste_match_score — genre / mood-word / vocal / bpm / energy affinity.
    let tasteMatch = 0;
    if (input.taste) {
      const t = input.taste;
      tasteMatch += (t.genre_scores[song.genre] ?? 0) * 1.2;
      if (song.mood) tasteMatch += (t.mood_scores[song.mood] ?? 0) * 0.7;
      tasteMatch += (t.vocal_preferences[song.vocal_type] ?? 0) * 0.4;
      if (t.bpm_preference != null && song.bpm != null) {
        tasteMatch += Math.max(0, 1 - Math.abs(song.bpm - t.bpm_preference) / 25);
      }
      if (t.energy_preference != null) {
        tasteMatch += Math.max(0, 1 - Math.abs(song.energy_score - t.energy_preference) / 0.4);
      }
    }

    // mood_match_score — best match across the user's core + adjacent moods.
    let coreMoodHits = 0;
    for (const m of coreMoodDefs) coreMoodHits = Math.max(coreMoodHits, moodMatchCount(song, m));
    let adjMoodHits = 0;
    for (const m of adjMoodDefs) adjMoodHits = Math.max(adjMoodHits, moodMatchCount(song, m));
    const moodMatch = coreMoodHits * 2 + adjMoodHits * 0.8;

    // completion / save predictions — real analytics first, analyzer priors
    // as a graceful fallback.
    const completionPred = stat ? stat.avg_completion : (song.hook_strength ?? 0.5);
    const savePred = stat ? stat.save_rate : (song.mainstream_fit ?? 0);
    const globalQuality =
      (song.launch_score ?? 0) * 1.0 +
      (song.quality_score ?? 0) * 0.5 +
      (stat ? stat.trending_score : 0) * 1.0;
    const hook = song.hook_strength ?? 0;

    // freshness_boost — newer releases and rising songs.
    let freshness = 0;
    let isFresh = false;
    if (song.created_at) {
      const age = now - Date.parse(song.created_at);
      if (Number.isFinite(age) && age >= 0 && age < FRESH_WINDOW_MS) {
        freshness = 1.5 * (1 - age / FRESH_WINDOW_MS);
        isFresh = true;
      }
    }
    if (stat && stat.velocity_score > 0.6) isFresh = true;

    // skip_similarity_penalty — shares microtags with recently skipped songs.
    let skipPenalty = 0;
    if (skipTags.size > 0) {
      let shared = 0;
      for (const t of song.microtags ?? []) if (skipTags.has(t)) shared++;
      skipPenalty = Math.min(6, shared * 0.8);
    }

    // Habit boost — "what this user usually plays at this time". Soft +
    // capped (HabitProfile self-caps); a new user's confidence is 0 so it
    // contributes nothing until a real pattern forms.
    const habitFit = scoreHabitFit(song, input.habit);

    // Identity boost — "does this song feel like this user?". Capped additive
    // modifier; self-gates on behavioural confidence. Keeps the pool from
    // recommending technically-matching-but-identity-wrong songs.
    const identityFit = scoreIdentityFit(song, input.identity);

    const score =
      tasteMatch +
      moodMatch +
      microtagMatch +
      completionPred * 2.0 +
      savePred * 2.0 +
      freshness +
      globalQuality +
      hook * 1.5 +
      habitFit +
      identityFit -
      skipPenalty;

    // ---- lane classification ----
    const tasteSum = microtagMatch + tasteMatch;
    const coreMood = coreMoodHits > 0;
    const adjMood = adjMoodHits > 0;
    const adjGenre = favGenres.some((g) => genresRelated(g, song.genre));
    const anyTasteSignal = tasteSum > 0 || moodMatch > 0;

    let lane: ForYouLane;
    if (coreMood || tasteSum >= TASTE_STRONG) lane = 'core';
    else if (adjMood || adjGenre) lane = 'adjacent';
    else if (isFresh && anyTasteSignal) lane = 'fresh';
    else lane = 'exploration';

    return { song, score, lane, moodWord: song.mood, energy: song.energy_score };
  };

  const scoredAll: Scored[] = [];
  for (const s of input.catalog) {
    const r = scoreOne(s);
    if (r) scoredAll.push(r);
  }
  scoredAll.sort((a, b) => b.score - a.score);

  // ---- Assemble with the lane mix + diversity, relaxing as needed. ----
  const result: Scored[] = [];
  const picked = new Set<string>();
  const artistCount = new Map<string, number>();
  const relaxed: string[] = [];

  // Lane mix. For cold-start users (first few sessions) we lean the pool
  // harder toward core-fit so Explore "doesn't feel random" before trust is
  // established — core 55 / adjacent 22 / fresh 13 / surprise ~10. Returning
  // users get the slightly broader 50 / 25 / 15 / 10 spread.
  const coldStart = input.interactionCount < COLD_START_THRESHOLD;
  const target: Record<ForYouLane, number> = {
    core: Math.round(limit * (coldStart ? 0.55 : 0.5)),
    adjacent: Math.round(limit * (coldStart ? 0.22 : 0.25)),
    fresh: Math.round(limit * (coldStart ? 0.13 : 0.15)),
    exploration: 0,
  };
  target.exploration = Math.max(0, limit - target.core - target.adjacent - target.fresh);

  const passesDiversity = (cand: Scored): boolean => {
    // Max 2 songs per artist in the pool.
    const aid = cand.song.artist_id ?? '__none__';
    if ((artistCount.get(aid) ?? 0) >= 2) return false;
    // Never the same artist back-to-back (spec PART 5B / onboarding rule).
    if (aid !== '__none__' && result.length > 0 &&
        (result[result.length - 1].song.artist_id ?? '__none__') === aid) {
      return false;
    }
    // Max 4 in a row sharing the exact same primary mood.
    if (cand.moodWord) {
      const tail = result.slice(-4);
      if (tail.length === 4 && tail.every((r) => r.moodWord === cand.moodWord)) return false;
    }
    // Max 3 in a row inside a tight energy band.
    const e3 = result.slice(-3);
    if (e3.length === 3 && e3.every((r) => Math.abs(r.energy - cand.energy) < 0.12)) return false;
    return true;
  };

  const add = (cand: Scored): void => {
    result.push(cand);
    picked.add(cand.song.id);
    const aid = cand.song.artist_id ?? '__none__';
    artistCount.set(aid, (artistCount.get(aid) ?? 0) + 1);
  };

  // One fill sweep. Repeats until no further song can be placed under the
  // current constraint set — diversity depends on the running tail, so a song
  // skipped early can become placeable later.
  const fill = (allowSuppressed: boolean, enforceDiversity: boolean, enforceMix: boolean): void => {
    const laneCount: Record<ForYouLane, number> = { core: 0, adjacent: 0, fresh: 0, exploration: 0 };
    for (const r of result) laneCount[r.lane]++;
    let progress = true;
    while (result.length < limit && progress) {
      progress = false;
      for (const cand of scoredAll) {
        if (result.length >= limit) break;
        if (picked.has(cand.song.id)) continue;
        if (!allowSuppressed && suppressed.has(cand.song.id)) continue;
        if (enforceMix && laneCount[cand.lane] >= target[cand.lane]) continue;
        if (enforceDiversity && !passesDiversity(cand)) continue;
        add(cand);
        laneCount[cand.lane]++;
        progress = true;
      }
    }
  };

  // Relaxation order (spec PART 3): suppression -> diversity -> lane mix.
  fill(false, true, true);
  if (result.length < limit) { relaxed.push('24h_suppression'); fill(true, true, true); }
  if (result.length < limit) { relaxed.push('diversity'); fill(true, false, true); }
  if (result.length < limit) { relaxed.push('lane_mix'); fill(true, false, false); }

  const buckets: Record<ForYouLane, number> = { core: 0, adjacent: 0, fresh: 0, exploration: 0 };
  for (const r of result) buckets[r.lane]++;

  return { songs: result.map((r) => r.song), buckets, relaxed };
}

/** Songs-heard past which the For You pool is genuinely personalised — below
 *  this it leans on editorial quality / freshness, so the UI copy must say so. */
export const FOR_YOU_PERSONALIZED_THRESHOLD = 12;

/**
 * Honest subtitle for the Explore "For You" shelf (Fix 4). Before the user has
 * enough listening history the pool is editorial (quality / freshness / hook),
 * NOT personalised — so claiming "Based on your listening" overpromises. This
 * surfaces a truthful cold-start label and only switches to the personalised
 * copy once behavioural confidence can back it.
 */
export function forYouSubtitle(songsHeard: number, moodActive: boolean): string {
  if (songsHeard >= FOR_YOU_PERSONALIZED_THRESHOLD) return 'Based on your listening';
  if (moodActive) return 'Trending for your mood';
  if (songsHeard < 5) return 'Starting with our best';
  return 'Popular on Boulevard right now';
}
