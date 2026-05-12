import { Song, TasteProfile, Activity, SongStats } from '@/types';

// Rule-based recommendation engine.
//
// Every candidate song gets a score in roughly [0, 10]. Higher = better match.
// We then sample songs probabilistically with a small exploration boost so the
// feed doesn't lock into a single cluster after one strong signal.

export interface ScoreInput {
  taste: TasteProfile | null;
  vibe: Activity | null;
  recentSongIds: string[]; // most recently played, to penalize repetition
  /** Total interactions so far. Drives cold-start vs personalized blend. */
  interactionCount: number;
  /** Per-song aggregate stats. Empty in MVP / when offline. */
  stats?: Map<string, SongStats>;
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
    // Songs can carry multiple genres/moods. Take the best matching score
    // for each axis so a multi-tag song isn't penalized for its less popular
    // tag — but still allow a strongly disliked tag to drag the song down.
    const songGenres = (song.genres && song.genres.length > 0) ? song.genres : [song.genre];
    const songMoods = (song.moods && song.moods.length > 0) ? song.moods : [song.mood];
    // During cold-start, weight the taste signal less aggressively so it
    // doesn't drown out the editorial signals above.
    const tasteWeight = coldStart ? 0.4 : 1.0;
    score += tasteWeight * Math.max(...songGenres.map((g) => taste.genre_scores[g] ?? 0));
    score += tasteWeight * Math.max(...songMoods.map((m) => taste.mood_scores[m] ?? 0));
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

  // Explicit vibe context dominates regardless of cold-start.
  if (vibe) {
    if (song.activity_fit.includes(vibe)) score += 4;
    else score -= 1.5;
  }

  // Penalize recently played to keep the feed fresh.
  if (ctx.recentSongIds.includes(song.id)) score -= RECENT_PENALTY;

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

  // A little noise so deterministic ties don't always resolve the same way.
  score += (Math.random() - 0.5) * EXPLORATION_NOISE;

  return score;
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
  const scored = catalog
    .filter((s) => !avoid.has(s.id))
    .map((s) => ({ song: s, score: scoreSong(s, ctx) }))
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
  return chosen;
}
