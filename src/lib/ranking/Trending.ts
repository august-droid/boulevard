import { Song, SongStats } from '@/types';

// Trending ranking for the Explore tab.
//
// We never rank purely by listens — raw plays bias toward whatever's been on
// the feed longest. Instead we combine six signals with hand-tuned weights:
//
//   plays_24h        recency-windowed volume
//   replay_rate      replays / plays  (sticky songs)
//   save_rate        saves / plays    (intent to revisit)
//   completion_rate  avg completion %
//   keep_rate        1 - skip_rate    (anti-skip)
//   velocity         (plays_today - plays_prev_day) / max(plays_prev_day, 1)
//
// The MVP often runs before any real user data exists, so the catalog ships
// with synthetic priors derived from each song's metadata + a deterministic
// daily salt. As real PlayMetrics roll in from Supabase aggregations they
// override the synthetic numbers for the matching songs.

export interface PlayMetrics {
  plays_24h: number;
  replays: number;
  saves: number;
  completions_70: number; // count of plays where completion >= 70%
  skips: number;
  plays_prev_day: number;
}

const ZERO: PlayMetrics = {
  plays_24h: 0,
  replays: 0,
  saves: 0,
  completions_70: 0,
  skips: 0,
  plays_prev_day: 0,
};

// Weights sum loosely to ~1.0 so a "good on every axis" song scores near 1.
const W = {
  plays_24h: 0.18,
  replay_rate: 0.22,
  save_rate: 0.18,
  completion_rate: 0.14,
  keep_rate: 0.14,
  velocity: 0.14,
};

// Cap plays_24h's contribution so a runaway hit doesn't dominate every list.
const PLAYS_CAP = 5000;

export interface RankedSong {
  song: Song;
  score: number;
  metrics: PlayMetrics;
}

export function scoreTrending(song: Song, m: PlayMetrics, daySaltHash: number): number {
  const plays = Math.max(0, m.plays_24h);
  const playsNorm = Math.min(1, plays / PLAYS_CAP);
  const replayRate = plays > 0 ? clamp01(m.replays / plays) : 0;
  const saveRate = plays > 0 ? clamp01(m.saves / plays) : 0;
  const completionRate = plays > 0 ? clamp01(m.completions_70 / plays) : 0;
  const keepRate = plays > 0 ? clamp01(1 - m.skips / plays) : 0;

  // Velocity: today vs yesterday. Clip to [-1, 1] then translate to [0, 1].
  const prev = Math.max(1, m.plays_prev_day);
  const rawVelocity = (plays - prev) / prev;
  const velocity = clamp01(0.5 + Math.max(-1, Math.min(1, rawVelocity)) / 2);

  const score =
    W.plays_24h * playsNorm +
    W.replay_rate * replayRate +
    W.save_rate * saveRate +
    W.completion_rate * completionRate +
    W.keep_rate * keepRate +
    W.velocity * velocity;

  // Daily salt — a small deterministic jitter so the list rotates day to day
  // without the whole top going stale. ±0.05 at most.
  const salt = (hashCombine(daySaltHash, hashString(song.id)) % 1000) / 1000;
  return score + (salt - 0.5) * 0.1;
}

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function hashCombine(a: number, b: number) { return Math.abs(((a * 0x9e3779b1) ^ b) | 0); }

// ----- Synthetic priors -------------------------------------------------
//
// Before real metrics arrive we fake plausible numbers per song from its
// metadata. Goal: the Explore page looks alive on day 0 and the same song
// keeps roughly the same rank across renders today, but rotates tomorrow.

const POPULAR_GENRES = new Set(['pop', 'edm', 'house', 'hiphop', 'rnb']);
const STICKY_MOODS = new Set(['euphoric', 'energetic', 'romantic', 'happy', 'moody']);

export function synthesizeMetrics(song: Song, daySaltHash: number): PlayMetrics {
  const seed = hashCombine(daySaltHash, hashString(song.id));
  const rand01 = (offset: number) => ((seed ^ (offset * 2654435761)) % 10000) / 10000;

  // Baseline plays influenced by genre popularity, cluster, and a daily rng.
  const genreBoost = POPULAR_GENRES.has(song.genre) ? 1.6 : 1.0;
  const moodBoost = STICKY_MOODS.has(song.mood) ? 1.3 : 1.0;
  const base = 300 + rand01(1) * 1800;
  const plays_24h = Math.round(base * genreBoost * moodBoost);

  // Sticky songs have higher replay/save/completion rates.
  const sticky = (moodBoost - 1) + (genreBoost - 1) * 0.5;
  const replay_rate = clamp01(0.04 + rand01(2) * 0.18 + sticky * 0.05);
  const save_rate = clamp01(0.02 + rand01(3) * 0.12 + sticky * 0.04);
  const completion_rate = clamp01(0.35 + rand01(4) * 0.45 + sticky * 0.08);
  const skip_rate = clamp01(0.08 + rand01(5) * 0.35 - sticky * 0.05);

  // Velocity: a fraction of songs are "rising", most are stable.
  const isRising = rand01(6) < 0.2;
  const prev_factor = isRising ? 0.35 + rand01(7) * 0.4 : 0.85 + rand01(7) * 0.3;
  const plays_prev_day = Math.max(1, Math.round(plays_24h * prev_factor));

  return {
    plays_24h,
    replays: Math.round(plays_24h * replay_rate),
    saves: Math.round(plays_24h * save_rate),
    completions_70: Math.round(plays_24h * completion_rate),
    skips: Math.round(plays_24h * skip_rate),
    plays_prev_day,
  };
}

// ----- Section recipes --------------------------------------------------
//
// Each section is a (filter + custom score-tilt) over the catalog. The same
// rankSongs() function powers all of them so the cards stay consistent.

export type SectionId =
  | 'trending_now'
  | 'rising_fast'
  | 'most_replayed'
  | 'boulevard_picks'
  | 'new_today'
  | 'night_drive'
  | 'gym_heat';

interface SectionRecipe {
  id: SectionId;
  title: string;
  subtitle: string;
  // Optional filter; defaults to "all songs".
  filter?: (s: Song) => boolean;
  // Optional bias function — added to the base trending score.
  bias?: (s: Song, m: PlayMetrics) => number;
  limit: number;
}

export const SECTION_RECIPES: SectionRecipe[] = [
  {
    id: 'trending_now',
    title: 'Trending Now',
    subtitle: 'What everyone is on right now',
    limit: 12,
  },
  {
    id: 'rising_fast',
    title: 'Rising Fast',
    subtitle: 'Climbing harder than the rest',
    bias: (_s, m) => {
      // Tilt toward velocity over raw plays.
      const prev = Math.max(1, m.plays_prev_day);
      const v = Math.min(1, Math.max(-0.5, (m.plays_24h - prev) / prev));
      return v * 0.6;
    },
    limit: 12,
  },
  {
    id: 'most_replayed',
    title: 'Most Replayed',
    subtitle: 'Songs people can’t stop hitting again',
    bias: (_s, m) => {
      const rate = m.plays_24h > 0 ? m.replays / m.plays_24h : 0;
      return rate * 0.6;
    },
    limit: 12,
  },
  {
    id: 'boulevard_picks',
    title: 'Boulevard Picks',
    subtitle: 'Hand-picked for the feed',
    // A simple curation rule: high completion + low skip.
    bias: (_s, m) => {
      const comp = m.plays_24h > 0 ? m.completions_70 / m.plays_24h : 0;
      const keep = m.plays_24h > 0 ? 1 - m.skips / m.plays_24h : 0;
      return (comp + keep) * 0.3;
    },
    limit: 10,
  },
  {
    id: 'new_today',
    title: 'New Today',
    subtitle: 'Just dropped',
    // Sort by created_at when available, falling back to score.
    bias: (s) => {
      if (!s.created_at) return 0;
      const ageHours = (Date.now() - new Date(s.created_at).getTime()) / 3.6e6;
      // Songs less than 24h old get a big bump that decays over a week.
      if (ageHours < 24) return 0.6;
      if (ageHours < 168) return 0.6 * (1 - (ageHours - 24) / 144);
      return 0;
    },
    limit: 10,
  },
  {
    id: 'night_drive',
    title: 'Night Drive',
    subtitle: 'For the long road home',
    filter: (s) => s.activity_fit.includes('driving') || s.activity_fit.includes('late_night'),
    limit: 12,
  },
  {
    id: 'gym_heat',
    title: 'Gym Heat',
    subtitle: 'Engineered to push',
    filter: (s) => s.activity_fit.includes('gym') || s.activity_fit.includes('aggressive'),
    limit: 12,
  },
];

// ----- Public API ------------------------------------------------------

export interface RankerInput {
  catalog: Song[];
  /**
   * Optional real metrics keyed by song id, derived from PlayMetrics shape.
   * Used by callers that want to override individual signals manually.
   */
  realMetrics?: Map<string, PlayMetrics>;
  /**
   * Server-rolled-up SongStats from `song_daily_stats`. When present, the
   * `trending_score` field is used directly instead of recomputing the
   * blend client-side — the server already did the math with the same
   * weights, so we want to honor it.
   */
  serverStats?: Map<string, SongStats>;
  /** Date used for synthetic daily rotation. Defaults to today (UTC). */
  date?: Date;
}

export interface ExploreSection extends Omit<SectionRecipe, 'filter' | 'bias'> {
  songs: RankedSong[];
}

function daySalt(date: Date): number {
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return hashString(iso);
}

export function buildExplore(input: RankerInput): ExploreSection[] {
  const date = input.date ?? new Date();
  const salt = daySalt(date);
  const real = input.realMetrics ?? new Map<string, PlayMetrics>();
  const server = input.serverStats ?? new Map<string, SongStats>();

  // Pre-compute the base score for every song. Order of preference:
  //   1) server-rolled stats from song_daily_stats (trusted, fresh-as-cron)
  //   2) caller-supplied real metrics (manual overrides)
  //   3) synthesized priors from metadata + daily salt (offline / day-zero)
  const baseScored: RankedSong[] = input.catalog.map((song) => {
    const serverStat = server.get(song.id);
    if (serverStat && serverStat.plays > 0) {
      // Convert SongStats back into the PlayMetrics shape so section biases
      // (which still need plays_24h, replays, etc.) keep working.
      const metrics: PlayMetrics = {
        plays_24h: serverStat.plays,
        replays: Math.round(serverStat.plays * serverStat.replay_rate),
        saves: Math.round(serverStat.plays * serverStat.save_rate),
        completions_70: Math.round(serverStat.plays * serverStat.avg_completion),
        skips: Math.round(serverStat.plays * serverStat.skip_rate),
        plays_prev_day: Math.max(1, Math.round(serverStat.plays / Math.max(0.1, 0.5 + serverStat.velocity_score))),
      };
      // Trust the server's blended score, with a small per-render jitter so
      // ties don't always resolve the same way.
      const jitter = (Math.random() - 0.5) * 0.05;
      return { song, score: serverStat.trending_score + jitter, metrics };
    }
    const metrics = real.get(song.id) ?? synthesizeMetrics(song, salt);
    const score = scoreTrending(song, metrics, salt);
    return { song, score, metrics };
  });

  // Track used IDs across sections so we don't repeat the same song everywhere.
  // We allow overlap but penalize it — a fresh section gets dibs.
  const usage = new Map<string, number>();

  return SECTION_RECIPES.map((recipe) => {
    const filtered = recipe.filter
      ? baseScored.filter((r) => recipe.filter!(r.song))
      : baseScored;

    const sorted = [...filtered]
      .map((r) => {
        const bias = recipe.bias ? recipe.bias(r.song, r.metrics) : 0;
        const repeatPenalty = (usage.get(r.song.id) ?? 0) * 0.15;
        return { ...r, score: r.score + bias - repeatPenalty };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, recipe.limit);

    for (const r of sorted) usage.set(r.song.id, (usage.get(r.song.id) ?? 0) + 1);

    return {
      id: recipe.id,
      title: recipe.title,
      subtitle: recipe.subtitle,
      limit: recipe.limit,
      songs: sorted,
    };
  });
}

// ----- Hero pick -------------------------------------------------------

/** Pick a single hero song for the top of Explore — highest overall trending. */
export function pickHero(sections: ExploreSection[]): RankedSong | null {
  const trending = sections.find((s) => s.id === 'trending_now');
  return trending && trending.songs.length > 0 ? trending.songs[0] : null;
}
