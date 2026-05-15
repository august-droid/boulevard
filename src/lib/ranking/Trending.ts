import { Song, SongStats, TasteProfile } from '@/types';

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

// ----- Section catalog --------------------------------------------------
//
// Explore is a fixed sequence of shelves. They all draw from the same
// per-song base score, but each shelf ranks on a different axis so the page
// never reads like several copies of the same chart:
//
//   New Releases          newest by created_at
//   Trending Now          recent velocity (today vs yesterday), not raw plays
//   New For You           personalized, and only songs not played yet
//   Top Artists Today     artist portraits (rendered separately in Explore)
//   Popular on Boulevard  total play count
//   Hidden Gems           unusual tracks that still land
//   Recently Played       the user's own listening history
//
// "Most Popular" and "Trending" used to share one blended score, so they
// surfaced near-identical songs. Splitting the axes (recency vs velocity vs
// total plays) is what makes the shelves feel genuinely distinct.

export type SectionId =
  | 'new_releases'
  | 'trending_now'
  | 'new_for_you'
  | 'top_artists'
  | 'popular_boulevard'
  | 'hidden_gems'
  | 'recently_played';

const SECTION_META: Record<SectionId, { title: string; subtitle: string; limit: number }> = {
  new_releases:      { title: 'New Releases',         subtitle: 'Fresh on Boulevard',                   limit: 12 },
  trending_now:      { title: 'Trending Now',         subtitle: 'Picking up speed right now',           limit: 12 },
  new_for_you:       { title: 'New For You',          subtitle: 'Picks from songs you have not played', limit: 12 },
  top_artists:       { title: 'Top Artists Today',    subtitle: 'Most played in the last 24 hours',     limit: 10 },
  popular_boulevard: { title: 'Popular on Boulevard', subtitle: 'Most played of all time',              limit: 12 },
  hidden_gems:       { title: 'Hidden Gems',          subtitle: 'Unusual tracks that still land',       limit: 12 },
  recently_played:   { title: 'Recently Played',      subtitle: 'Pick up where you left off',           limit: 12 },
};

// ----- Play-count model -------------------------------------------------
//
// Every song gets a deterministic baseline play count so the catalog reads
// as alive on day zero rather than every song showing "0 plays". Real plays
// from song_daily_stats are layered on top, so the number genuinely grows as
// people stream. baselinePlays is stable per song.id. Explore renders this
// exact number on tile subtitles, so the Popular on Boulevard ranking and
// the displayed counts always agree.

const BASELINE_MIN = 20_000;
const BASELINE_MAX = 400_000;

export function baselinePlays(songId: string): number {
  let h = 0;
  for (let i = 0; i < songId.length; i++) {
    h = ((h << 5) - h) + songId.charCodeAt(i);
    h |= 0;
  }
  return BASELINE_MIN + (Math.abs(h) % (BASELINE_MAX - BASELINE_MIN));
}

/** Total plays for a song: deterministic baseline + live server plays. */
export function displayPlays(songId: string, serverStats: Map<string, SongStats>): number {
  return baselinePlays(songId) + (serverStats.get(songId)?.plays ?? 0);
}

// ----- Public API ------------------------------------------------------

export interface RankerInput {
  catalog: Song[];
  /** Server-rolled SongStats from song_daily_stats, keyed by song id. */
  serverStats?: Map<string, SongStats>;
  /** Optional manual metric overrides, keyed by song id. */
  realMetrics?: Map<string, PlayMetrics>;
  /** Date used for the synthetic daily rotation. Defaults to today. */
  date?: Date;
  /** Lifetime taste profile. Personalizes the New For You shelf. */
  taste?: TasteProfile | null;
  /** Ids of songs the user has already played. New For You excludes these. */
  playedSongIds?: Set<string>;
  /** The user's recently-played songs, newest first. Powers Recently Played. */
  recentSongs?: Song[];
}

export interface ExploreSection {
  id: SectionId;
  title: string;
  subtitle: string;
  limit: number;
  songs: RankedSong[];
}

function daySalt(date: Date): number {
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return hashString(iso);
}

/** Deterministic 0..1 jitter per song, reseeded daily so shelves rotate. */
function rotationJitter(songId: string, salt: number): number {
  return (hashCombine(salt, hashString(songId)) % 1000) / 1000;
}

// Build the base ranked list: a PlayMetrics + trending score for every song.
// Order of preference per song:
//   1) server-rolled stats from song_daily_stats (trusted, fresh-as-cron)
//   2) caller-supplied real metrics (manual overrides)
//   3) synthesized priors from metadata + daily salt (offline / day-zero)
function baseRank(input: RankerInput, salt: number): RankedSong[] {
  const real = input.realMetrics ?? new Map<string, PlayMetrics>();
  const server = input.serverStats ?? new Map<string, SongStats>();
  return input.catalog.map((song) => {
    const serverStat = server.get(song.id);
    if (serverStat && serverStat.plays > 0) {
      // Convert SongStats back into the PlayMetrics shape so the velocity
      // ranker works off a single uniform metrics object.
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
}

// Sort comparator for New Releases: newest created_at first, with editorial
// launch_score as the tiebreak (and the fallback for songs that ship without
// a timestamp, e.g. the bundled seed catalog).
function newReleaseCmp(a: Song, b: Song): number {
  const at = a.created_at ? Date.parse(a.created_at) : NaN;
  const bt = b.created_at ? Date.parse(b.created_at) : NaN;
  const av = Number.isNaN(at) ? -Infinity : at;
  const bv = Number.isNaN(bt) ? -Infinity : bt;
  if (av !== bv) return bv - av;
  return (b.launch_score ?? 0) - (a.launch_score ?? 0);
}

// Velocity-first score for Trending Now. Uses the server velocity signal when
// present, otherwise today-vs-yesterday from the synthetic metrics. This is
// deliberately NOT raw plays, so Trending Now no longer mirrors the Popular
// on Boulevard chart. A hook-strength nudge plus daily jitter break ties so
// the shelf rotates.
function velocityRank(r: RankedSong, server: Map<string, SongStats>, salt: number): number {
  const stat = server.get(r.song.id);
  let velocity: number;
  if (stat && stat.plays > 0) {
    velocity = clamp01(stat.velocity_score);
  } else {
    const prev = Math.max(1, r.metrics.plays_prev_day);
    const raw = (r.metrics.plays_24h - prev) / prev;
    velocity = clamp01(0.5 + Math.max(-1, Math.min(1, raw)) / 2);
  }
  const hookNudge = (r.song.hook_strength ?? 0) * 0.05;
  return velocity + hookNudge + (rotationJitter(r.song.id, salt) - 0.5) * 0.06;
}

// Personalized score for New For You: lifetime microtag overlap layered on
// catalog-wide quality priors. Cold-start users (no taste profile yet) just
// get the quality ranking. Daily jitter keeps the shelf fresh.
function scoreForYou(song: Song, taste: TasteProfile | null, salt: number): number {
  let score =
    (song.hook_strength ?? 0) * 1.5 +
    (song.mainstream_fit ?? 0) * 0.8 +
    (song.launch_score ?? 0) * 1.0;

  if (taste) {
    const tags = song.microtags ?? [];
    if (tags.length > 0 && taste.microtag_scores) {
      let sum = 0;
      for (const t of tags) sum += taste.microtag_scores[t] ?? 0;
      score += Math.max(-12, Math.min(12, sum));
    }
    const genres = song.genres && song.genres.length > 0 ? song.genres : [song.genre];
    const moods = song.moods && song.moods.length > 0 ? song.moods : [song.mood];
    score += 0.5 * Math.max(0, ...genres.map((g) => taste.genre_scores[g] ?? 0));
    score += 0.5 * Math.max(0, ...moods.map((m) => taste.mood_scores[m] ?? 0));
  }

  return score + (rotationJitter(song.id, salt) - 0.5) * 0.1;
}

function section(id: SectionId, songs: RankedSong[]): ExploreSection {
  const meta = SECTION_META[id];
  return { id, title: meta.title, subtitle: meta.subtitle, limit: meta.limit, songs };
}

export function buildExplore(input: RankerInput): ExploreSection[] {
  const date = input.date ?? new Date();
  const salt = daySalt(date);
  const server = input.serverStats ?? new Map<string, SongStats>();
  const played = input.playedSongIds ?? new Set<string>();
  const taste = input.taste ?? null;
  const recentSongs = input.recentSongs ?? [];

  const baseScored = baseRank(input, salt);
  const byId = new Map(baseScored.map((r) => [r.song.id, r] as const));

  // ---- Cross-section dedupe -------------------------------------------
  // A song must not appear twice on a single Explore load. Sections claim
  // songs in a fixed priority order; a lower-priority shelf skips anything
  // an earlier shelf already took:
  //   New Releases > New For You > Trending Now > Genre shelves > Popular
  // Genre shelves render curated genre artwork rather than song tiles, so
  // they hold their slot in the order but claim nothing here. Hidden Gems,
  // Top Artists and Recently Played sit outside the dedupe set by design.
  const claimed = new Set<string>();
  const take = (ranked: RankedSong[], limit: number): RankedSong[] => {
    const out: RankedSong[] = [];
    for (const r of ranked) {
      if (claimed.has(r.song.id)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    for (const r of out) claimed.add(r.song.id);
    return out;
  };

  // 1. New Releases — newest by created_at.
  const newReleases = take(
    [...baseScored].sort((a, b) => newReleaseCmp(a.song, b.song)),
    SECTION_META.new_releases.limit,
  );

  // 2. New For You — personalized, strictly songs the user has not played.
  const newForYou = take(
    baseScored
      .filter((r) => !played.has(r.song.id))
      .map((r) => ({ r, k: scoreForYou(r.song, taste, salt) }))
      .sort((a, b) => b.k - a.k)
      .map((x) => x.r),
    SECTION_META.new_for_you.limit,
  );

  // 3. Trending Now — recent velocity, not raw plays.
  const trending = take(
    baseScored
      .map((r) => ({ r, k: velocityRank(r, server, salt) }))
      .sort((a, b) => b.k - a.k)
      .map((x) => x.r),
    SECTION_META.trending_now.limit,
  );

  // 4. (Genre shelves render in Explore, between Trending Now and Popular.)

  // 5. Popular on Boulevard — ranked by total play count.
  const popular = take(
    [...baseScored].sort(
      (a, b) => displayPlays(b.song.id, server) - displayPlays(a.song.id, server),
    ),
    SECTION_META.popular_boulevard.limit,
  );

  // Hidden Gems — unusual tracks that still work. Outside the dedupe set, so
  // a standout weird track can also appear on an earlier shelf.
  const hiddenGems = [...baseScored]
    .filter((r) => (r.song.weirdness_score ?? 0) >= 0.6)
    .map((r) => ({ r, k: r.score + (r.song.weirdness_score ?? 0) * 0.4 }))
    .sort((a, b) => b.k - a.k)
    .slice(0, SECTION_META.hidden_gems.limit)
    .map((x) => x.r);

  // Recently Played — the user's own history, newest first. Not ranked and
  // not deduped: it is literally what they listened to.
  const recently = recentSongs
    .slice(0, SECTION_META.recently_played.limit)
    .map((song) => byId.get(song.id) ?? { song, score: 0, metrics: ZERO });

  const sections: ExploreSection[] = [
    section('new_releases', newReleases),
    section('trending_now', trending),
    section('new_for_you', newForYou),
    section('top_artists', []),
    section('popular_boulevard', popular),
    section('hidden_gems', hiddenGems),
    section('recently_played', recently),
  ];

  // Drop empty song shelves (tiny or still-loading catalog) but always keep
  // Top Artists — it renders from a separate artist aggregation in Explore.
  return sections.filter((s) => s.id === 'top_artists' || s.songs.length > 0);
}

// ----- Hero pick -------------------------------------------------------

/** Pick a single hero song for the top of Explore — the #1 trending song. */
export function pickHero(sections: ExploreSection[]): RankedSong | null {
  const trending = sections.find((s) => s.id === 'trending_now');
  return trending && trending.songs.length > 0 ? trending.songs[0] : null;
}
