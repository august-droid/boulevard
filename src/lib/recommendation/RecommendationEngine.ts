import { Song, TasteProfile, SessionProfile, Activity, SongStats } from '@/types';
import { artistRepeatPenalty } from '@/lib/recommendation/artistSpacing';
import { contextBoost, type ActiveSessionContext } from '@/lib/recommendation/SessionContext';

// Rule-based recommendation engine.
//
// Every candidate song gets a score in roughly [0, 10]. Higher = better match.
// We then sample songs probabilistically with a small exploration boost so the
// feed doesn't lock into a single cluster after one strong signal.

export interface ScoreInput {
  taste: TasteProfile | null;
  /** "Right now" preference. Multiplicative tilt over the base score. */
  session?: SessionProfile | null;
  vibe: Activity | null;
  recentSongIds: string[]; // most recently played, to penalize repetition
  /** Total interactions so far. Drives cold-start vs personalized blend. */
  interactionCount: number;
  /** Per-song aggregate stats. Empty in MVP / when offline. */
  stats?: Map<string, SongStats>;
  /** Artist of the currently-playing song — feeds the artist-variation rule. */
  currentArtistId?: string | null;
  /** Artist ids of recently played songs, most recent first. */
  recentArtistIds?: string[];
  /** True inside an explicit artist-focused session — disables the penalty. */
  artistFocused?: boolean;
  /** Active contextual-session bias (Contextual Session Engine — a
   *  complementary layer). Optional: when absent the ranker behaves exactly
   *  as it did before the session engine existed. */
  context?: ActiveSessionContext | null;
}

const RECENT_PENALTY = 4;     // big hit if we just played this
const EXPLORATION_NOISE = 0.6; // jitter added per song; small relative to score range

// Below this many interactions we treat the user as "new" and lean on
// editorial signals (launch_score) + genre diversity rather than the still-
// noisy taste profile. Aligns with the 10-songs signup gate.
const COLD_START_THRESHOLD = 10;

// Auto-suppression: when a song's measured performance is bad on its own
// merits, take its recommendation score down a peg. Tuned to fire only on
// genuinely struggling songs, not minor underperformers.
const SUPPRESS_SKIP_THRESHOLD = 0.55;     // > 55% of plays end in a skip
const SUPPRESS_POSITIVE_THRESHOLD = 0.10; // and combined positive rate < 10%
const SUPPRESS_PENALTY = 3.0;

// Per-spec: microtags should influence ranking MORE than genre. We halve
// genre/mood weight and let microtags carry the load.
const GENRE_MOOD_WEIGHT = 0.5;
// Microtag sum is capped so a song with 25 hot tags doesn't completely
// crowd out everything else. With per-tag scores typically 0.5–3, the cap
// lets a strong-match song add ~+12 over baseline.
const MICROTAG_LIFETIME_CAP = 12;
// Session can move the score by up to ±6. "I'm in workout mode" or "skip
// all the slow songs" should reshape the queue within a handful of taps.
const SESSION_TAG_CAP = 6;

export function scoreSong(song: Song, ctx: ScoreInput): number {
  let score = 1.0; // baseline so unfamiliar users still get something to play

  const { taste, vibe } = ctx;
  const coldStart = ctx.interactionCount < COLD_START_THRESHOLD;

  if (coldStart) {
    // Lean on editorial signals. launch_score is 0..1; multiplying by 3 puts
    // it in the same range as a strong taste-profile genre score.
    score += (song.launch_score ?? 0) * 3.0;
    if (song.is_featured) score += 1.2;
  }

  if (taste) {
    // During cold-start, weight the taste signal less aggressively so it
    // doesn't drown out the editorial signals above.
    const tasteWeight = coldStart ? 0.4 : 1.0;

    // --- PRIMARY SIGNAL: microtag overlap. ---
    // Sum the user's lifetime microtag scores for every tag this song
    // carries. A song with 15 microtags that each match a +1 user score
    // contributes +15 (pre-cap). This is intentionally the heaviest signal.
    const songMicrotags = song.microtags ?? [];
    if (songMicrotags.length > 0 && taste.microtag_scores) {
      let sum = 0;
      for (const t of songMicrotags) sum += taste.microtag_scores[t] ?? 0;
      // Cap to keep one extremely tag-rich song from monopolizing the queue.
      const capped = Math.max(-MICROTAG_LIFETIME_CAP, Math.min(MICROTAG_LIFETIME_CAP, sum));
      score += tasteWeight * capped;
    }

    // --- SECONDARY SIGNAL: genre/mood/cluster/vocal (halved per spec). ---
    const songGenres = (song.genres && song.genres.length > 0) ? song.genres : [song.genre];
    const songMoods = (song.moods && song.moods.length > 0) ? song.moods : [song.mood];
    score += tasteWeight * GENRE_MOOD_WEIGHT * Math.max(...songGenres.map((g) => taste.genre_scores[g] ?? 0));
    score += tasteWeight * GENRE_MOOD_WEIGHT * Math.max(...songMoods.map((m) => taste.mood_scores[m] ?? 0));
    score += tasteWeight * (taste.similarity_cluster_scores[String(song.similarity_cluster)] ?? 0) * 1.2;
    score += tasteWeight * (taste.vocal_preferences[song.vocal_type] ?? 0);

    // BPM match: full credit within ±8 bpm, fading out by ±25.
    if (taste.bpm_preference != null && song.bpm != null) {
      const diff = Math.abs(song.bpm - taste.bpm_preference);
      const bpmFit = Math.max(0, 1 - diff / 25);
      score += tasteWeight * bpmFit;
    }

    // Energy match: full credit within 0.1, fading out by 0.4.
    if (taste.energy_preference != null) {
      const diff = Math.abs(song.energy_score - taste.energy_preference);
      const energyFit = Math.max(0, 1 - diff / 0.4);
      score += tasteWeight * energyFit;
    }

    for (const a of song.activity_fit) {
      score += tasteWeight * ((taste.activity_scores[a] ?? 0) * 0.5);
    }
  }

  // --- SESSION SIGNAL: short-window mood adapter. ---
  // Sums the user's CURRENT-session microtag scores for this song's tags.
  // Works even in cold-start — three positive plays this session is enough
  // to start shaping recommendations toward what the user is into right now.
  if (ctx.session && song.microtags && song.microtags.length > 0) {
    let sessionSum = 0;
    for (const t of song.microtags) sessionSum += ctx.session.microtag_scores[t] ?? 0;
    score += Math.max(-SESSION_TAG_CAP, Math.min(SESSION_TAG_CAP, sessionSum));
  }

  // Explicit vibe context dominates regardless of cold-start.
  if (vibe) {
    if (song.activity_fit.includes(vibe)) score += 4;
    else score -= 1.5;
  }

  // Penalize recently played to keep the feed fresh.
  if (ctx.recentSongIds.includes(song.id)) score -= RECENT_PENALTY;

  // --- Stage gating: shape exposure based on the song's distribution stage. ---
  //  • suppressed: hard cut unless the user has *strong* affinity (a rescue path)
  //  • new_test:   serve only to users whose microtags overlap with the song's
  //                — initial test pool selection.
  //  • rising:     small boost so promising songs get more reps quickly.
  //  • trending:   sizeable boost so winners spread to the whole base.
  const stage = song.distribution_stage ?? 'new_test';
  if (stage === 'suppressed') {
    // Strict — suppressed songs never reach the user, regardless of affinity.
    // The "superfan rescue" path was removed pre-launch: once human review or
    // catalog stats kill a song, it's gone. Admin can flip the stage back
    // manually if needed.
    return -Infinity;
  } else if (stage === 'new_test') {
    // Only show to users whose tags overlap. Below the threshold the song
    // is invisible to this user — that's how we keep the test pool tight.
    // Skip the gate when:
    //   • cold-start user (no taste profile yet to match against)
    //   • migration-window user — has interactions but no microtag history
    //     because the microtag system was added after they started using
    //     the app. Without this carve-out they'd see nothing until the
    //     first song in the catalog gets promoted past new_test.
    const userScores = ctx.taste?.microtag_scores;
    const userHasMicrotagHistory = userScores && Object.keys(userScores).length > 0;
    if (userHasMicrotagHistory && ctx.interactionCount >= COLD_START_THRESHOLD) {
      const overlap = computeOverlap(song.microtags, userScores);
      if (overlap < 0.5) return -Infinity;
    }
    // Inside the test pool — small boost so the song actually gets reps.
    score += 1.5;
  } else if (stage === 'rising') {
    score += 1.0;
  } else if (stage === 'trending') {
    score += 2.0;
  }

  // Auto-suppression — when measured behavior tells us this song isn't
  // landing for anyone, reduce its rank. We require BOTH high skip rate
  // AND low positive engagement so a song that's purely "skim-listened" but
  // still saved/shared keeps its place.
  const stat = ctx.stats?.get(song.id);
  if (stat) {
    const positiveRate = stat.save_rate + stat.replay_rate + stat.share_rate;
    if (stat.skip_rate > SUPPRESS_SKIP_THRESHOLD && positiveRate < SUPPRESS_POSITIVE_THRESHOLD) {
      score -= SUPPRESS_PENALTY;
    }
    // Small positive bump for songs that *are* landing well — keeps healthy
    // catalog flowing without an explicit "popular" toggle.
    else if (positiveRate > 0.3 && stat.skip_rate < 0.25) {
      score += 0.6;
    }
  }

  // Universal quality lift from the analyzer — these aren't user-personalised,
  // they're catalog-wide priors. Hook strength matters most because a strong
  // hook is the single biggest predictor of replay across users.
  if (song.hook_strength != null) score += song.hook_strength * 1.5;
  if (song.mainstream_fit != null && coldStart) score += song.mainstream_fit * 0.8;

  // Artist-variation rule (spec PART 5B): keep the same artist from stacking
  // up in the auto-extended queue. No-op inside artist-focused sessions.
  score -= artistRepeatPenalty(song.artist_id, {
    currentArtistId: ctx.currentArtistId,
    recentArtistIds: ctx.recentArtistIds,
    artistFocused: ctx.artistFocused,
  });

  // Contextual Session Engine (complementary layer): a TEMPORARY additive
  // bias toward the user's current intent — artist universe, mood world,
  // genre lane, search, or discovery. Already folds in confidence × time
  // decay, so it fades smoothly back into long-term taste. Returns 0 when no
  // context is active, leaving everything above this line fully preserved.
  if (ctx.context) score += contextBoost(song, ctx.context);

  // A little noise so deterministic ties don't always resolve the same way.
  score += (Math.random() - 0.5) * EXPLORATION_NOISE;

  return score;
}

/**
 * Sum of microtag scores for a song, against a user's lifetime profile.
 * Used to decide whether a `new_test` or `suppressed` song should be served
 * to this user. Returns 0 if either side is missing.
 */
function computeOverlap(
  songMicrotags: string[] | undefined,
  userMicrotagScores: Record<string, number> | undefined,
): number {
  if (!songMicrotags || !userMicrotagScores) return 0;
  let sum = 0;
  for (const t of songMicrotags) sum += userMicrotagScores[t] ?? 0;
  return sum;
}

/**
 * Quality-only fallback used when the main ranker can't find any personalised
 * matches — small catalogs, esoteric taste, every song still in `new_test`,
 * etc. Never returns random songs from the full catalog; instead picks from
 * the top quality slice so the user still gets something playable.
 *
 * Priority:
 *   1. Exclude `suppressed` and recently played outright.
 *   2. Score by hook_strength + mainstream_fit + stage boost.
 *   3. Take the top ~30% as the "quality window."
 *   4. Random shuffle inside the window so two stalled queues don't return
 *      the same song every time.
 */
function qualityFallback(catalog: Song[], avoidIds: string[], count: number): Song[] {
  const avoid = new Set(avoidIds);
  const eligible = catalog
    .filter((s) => !avoid.has(s.id))
    .filter((s) => (s.distribution_stage ?? 'new_test') !== 'suppressed')
    .map((s) => {
      const stage = s.distribution_stage ?? 'new_test';
      const stageBoost = stage === 'trending' ? 2 : stage === 'rising' ? 1 : 0;
      const quality =
        (s.hook_strength ?? 0) * 1.5 +
        (s.mainstream_fit ?? 0) * 1.0 +
        stageBoost;
      return { song: s, score: quality };
    })
    .sort((a, b) => b.score - a.score);

  if (eligible.length === 0) return [];

  // Top quality window — take the top 30% (or at least `count` items so we
  // can always fill the queue when the eligible pool is small).
  const windowSize = Math.max(count, Math.ceil(eligible.length * 0.3));
  const window = eligible.slice(0, windowSize);

  // Fisher-Yates partial shuffle so two empty-pick fallbacks don't return
  // the same songs in the same order. Random *only* inside the quality slice.
  for (let i = 0; i < Math.min(count, window.length); i++) {
    const j = i + Math.floor(Math.random() * (window.length - i));
    [window[i], window[j]] = [window[j], window[i]];
  }
  return window.slice(0, count).map((x) => x.song);
}

/**
 * Rank a catalog and return the top `count` songs, excluding any in `avoidIds`.
 * Used by QueueManager's producer.
 *
 * In cold-start mode we enforce *genre diversity* in the returned list — a new
 * user shouldn't be served eight lofi tracks in a row just because lofi has
 * many entries in the catalog. Once the user has interacted with enough songs
 * we relax this and let the taste profile drive density.
 */
export function rankCandidates(
  catalog: Song[],
  ctx: ScoreInput,
  avoidIds: string[],
  count: number,
): Song[] {
  const avoid = new Set(avoidIds);
  // Filter out -Infinity *before* the weighted sampler — those are stage-gated
  // (suppressed or new_test-without-overlap) and must be invisible to this
  // user, not just down-ranked. Without this, Math.max(0.05, -Infinity) = 0.05
  // would silently put them back in the picker.
  const scored = catalog
    .filter((s) => !avoid.has(s.id))
    .map((s) => ({ song: s, score: scoreSong(s, ctx) }))
    .filter((t) => Number.isFinite(t.score))
    .sort((a, b) => b.score - a.score);

  // Take a slightly-larger top window and sample to introduce variety.
  const windowSize = Math.min(scored.length, Math.max(count * 3, count + 6));
  const top = scored.slice(0, windowSize);
  const chosen: Song[] = [];

  const coldStart = ctx.interactionCount < COLD_START_THRESHOLD;
  // In cold-start, cap how many songs from any single genre we hand back in
  // the same batch. With 8 picks and ~10 genres this comes out to a healthy
  // spread without starving any cluster.
  const PER_GENRE_CAP = coldStart ? 2 : Infinity;
  const genreCount: Record<string, number> = {};

  while (chosen.length < count && top.length > 0) {
    // Weighted pick — songs with higher score are more likely.
    const weights = top.map((t) => Math.max(0.05, t.score));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let pickIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) { pickIdx = i; break; }
    }
    const candidate = top[pickIdx].song;
    top.splice(pickIdx, 1);

    // Cold-start diversity cap.
    const g = candidate.genre;
    if ((genreCount[g] ?? 0) >= PER_GENRE_CAP) continue;

    chosen.push(candidate);
    genreCount[g] = (genreCount[g] ?? 0) + 1;
  }

  // Quality fallback: the main path produced nothing (everything blocked,
  // every match recently played, etc.). Hand back the top quality slice so
  // the queue never stalls — but never random low-quality songs.
  if (chosen.length === 0) {
    return qualityFallback(catalog, avoidIds, count);
  }
  return chosen;
}
