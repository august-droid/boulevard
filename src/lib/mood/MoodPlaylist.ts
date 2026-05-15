import { Song, TasteProfile } from '@/types';

// Mood-driven personalized playlists.
//
// Architecture:
//
//   Mood = INTENT (objective; same for everyone).
//          Defined by listener contexts + microtags + mood words + BPM gate.
//   Taste = the user's personal version of that intent.
//          Microtag scores, genre prefs, mood-word prefs, vocal prefs.
//
// Two users tapping the same mood get different songs because the
// personalization layer re-orders the mood-eligible pool by their
// individual TasteProfile signals — plus freshness rules so the
// playlist doesn't loop the same song twice in a session.
//
// Pipeline:
//   1. Hard mood filter — songs that don't even hint at the mood are
//      excluded outright (BPM gate + at-least-1-axis-match).
//   2. Multi-component scoring — moodFit, taste, freshness, quality.
//      User-stage weights tilt the mix toward quality+moodFit for new
//      users and toward personalized taste for returning users.
//   3. Artist diversity cap — no more than 2 songs per artist in the
//      result so a "Sad" pick doesn't surface 8 songs from Hollow June.
//
// All scores are exposed via the debug variant so the dashboard or
// dev menu can print *why* a song landed in the playlist.

export type MoodId = 'hyped' | 'chill' | 'sad' | 'party' | 'focus' | 'main_character' | 'gym' | 'running';

export interface Mood {
  id: MoodId;
  emoji: string;
  label: string;
  description: string;
  /** Listener contexts (from the analyzer) that signal this mood. */
  contexts: string[];
  /** Microtags that signal this mood. */
  microtags: string[];
  /** Song mood words (existing `mood` field) that align. */
  moodWords: string[];
  /** Optional hard BPM gate. Songs outside the range are filtered out entirely.
   *  Used for cadence-locked moods like Running (typical step cadence 160–180 SPM). */
  bpmRange?: [number, number];
  /** Optional energy gate. Songs with energy_score outside this band are
   *  filtered. 0..1 scale. Used for Focus (low) and Hyped (high). */
  energyRange?: [number, number];
}

export const MOODS: Mood[] = [
  {
    id: 'hyped', emoji: '🔥', label: 'Hyped', description: 'Bring the energy',
    contexts: ['workout', 'peak_set', 'club_pregame', 'high_energy_listen'],
    microtags: ['peak_energy', 'high_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal'],
    moodWords: ['confident', 'reckless', 'defiant', 'euphoric'],
    energyRange: [0.55, 1.0],
  },
  {
    id: 'chill', emoji: '😌', label: 'Chill', description: 'Easy listening',
    contexts: ['chill_focus', 'casual_listen', 'low_energy_listen'],
    microtags: ['low_energy', 'mid_energy', 'dreamy_lyrics', 'intimate_vocal', 'reverb_wash'],
    moodWords: ['tender', 'longing'],
    energyRange: [0.0, 0.55],
  },
  {
    id: 'sad', emoji: '🥲', label: 'Sad', description: 'Feelings only',
    contexts: ['reflective_alone'],
    microtags: ['melancholic_lyrics', 'low_energy', 'whispered_vocal', 'piano_loop'],
    moodWords: ['vulnerable', 'longing', 'haunted'],
    energyRange: [0.0, 0.55],
  },
  {
    id: 'party', emoji: '🎉', label: 'Party', description: 'Get the room going',
    contexts: ['club_pregame', 'peak_set'],
    microtags: ['dance_tempo', 'peak_tempo', 'peak_energy', 'club_lyrics', 'four_on_the_floor', 'dembow_pattern'],
    moodWords: ['euphoric', 'reckless'],
    energyRange: [0.5, 1.0],
  },
  {
    id: 'focus', emoji: '🎯', label: 'Focus', description: 'Lock in',
    contexts: ['chill_focus'],
    microtags: ['instrumental_track', 'low_energy', 'mid_energy', 'piano_loop', 'tape_warmth'],
    moodWords: [],
    energyRange: [0.0, 0.5],
  },
  {
    id: 'main_character', emoji: '😎', label: 'Main Character', description: 'Walk in like that',
    contexts: ['peak_set', 'studio_session'],
    microtags: ['flex_lyrics', 'high_energy', 'peak_energy', 'autotune_cry', 'gold_chain'],
    moodWords: ['confident', 'defiant'],
  },
  {
    id: 'gym', emoji: '💪', label: 'Gym', description: 'Lift to your sound',
    contexts: ['workout', 'peak_set'],
    microtags: ['peak_energy', 'high_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal', 'four_on_the_floor'],
    moodWords: ['confident', 'reckless', 'defiant', 'euphoric'],
    energyRange: [0.6, 1.0],
  },
  {
    id: 'running', emoji: '🏃', label: 'Running', description: 'Match your stride',
    contexts: ['workout', 'peak_set'],
    microtags: ['peak_energy', 'high_energy', 'dance_tempo', 'up_tempo', 'peak_tempo', 'four_on_the_floor'],
    moodWords: ['confident', 'euphoric', 'defiant'],
    bpmRange: [150, 180],
  },
];

export function moodById(id: MoodId): Mood | undefined {
  return MOODS.find((m) => m.id === id);
}

// ---------- Personalization context ----------

export interface MoodPlaylistContext {
  catalog: Song[];
  taste: TasteProfile | null;
  /** Most recently played song IDs, most-recent-first. Drives freshness
   *  penalties. PlayerContext owns this list. */
  recentSongIds: string[];
  /** Lifetime interactions (likes + skips + full listens). Crosses the
   *  cold-start threshold so weights tilt from quality-first to
   *  taste-first once the user has signal. */
  interactionCount: number;
  limit?: number;
  /** Max songs from any single artist in the result (default 2). */
  maxPerArtist?: number;
}

// Threshold past which we trust the user's TasteProfile signal over
// editorial quality priors. Same value as RecommendationEngine.
const COLD_START_THRESHOLD = 5;

/** Component score breakdown for one song. Useful for debug + admin. */
export interface SongScoreBreakdown {
  song: Song;
  moodFit: number;
  taste: number;
  freshness: number;
  quality: number;
  final: number;
  reasons: string[];
  /** When set, the song was eligible but was DROPPED from the final
   *  result (e.g. artist diversity cap hit). */
  dropped?: string;
}

// ---------- Component scoring ----------

function scoreMoodFit(song: Song, mood: Mood): { value: number; reasons: string[] } {
  const reasons: string[] = [];

  // Hard BPM gate (Running) — no amount of microtag overlap salvages
  // a 90 BPM ballad for a 150-180 BPM Running playlist.
  if (mood.bpmRange && song.bpm != null) {
    const [lo, hi] = mood.bpmRange;
    if (song.bpm < lo || song.bpm > hi) return { value: -Infinity, reasons: [`bpm ${song.bpm} outside ${lo}-${hi}`] };
  }

  // Soft energy gate — outside-band songs still pass, but mood-fit
  // suffers. Hard-reject only when the energy is wildly wrong (>0.3
  // delta from band midpoint). Tunable.
  if (mood.energyRange != null && song.energy_score != null) {
    const [lo, hi] = mood.energyRange;
    if (song.energy_score < lo - 0.15 || song.energy_score > hi + 0.15) {
      return { value: -Infinity, reasons: [`energy ${song.energy_score.toFixed(2)} wildly outside ${lo}-${hi}`] };
    }
  }

  // At least 1 match across the 3 mood-signal axes.
  let matches = 0;
  const contexts = song.primary_listener_contexts ?? [];
  const tags = song.microtags ?? [];
  for (const c of mood.contexts) if (contexts.includes(c)) { matches++; reasons.push(`ctx:${c}`); }
  for (const t of mood.microtags) if (tags.includes(t)) { matches++; reasons.push(`tag:${t}`); }
  if (song.mood && mood.moodWords.includes(song.mood)) { matches++; reasons.push(`mood:${song.mood}`); }
  if (matches === 0) return { value: -Infinity, reasons: ['no mood-axis match'] };

  return { value: matches * 2, reasons };
}

function scoreTaste(song: Song, taste: TasteProfile | null): { value: number; reasons: string[] } {
  if (!taste) return { value: 0, reasons: [] };
  const reasons: string[] = [];
  let v = 0;

  // Microtag overlap (primary lifetime signal). Capped to keep one
  // strong-tag song from dominating.
  const tags = song.microtags ?? [];
  if (tags.length > 0) {
    let tagSum = 0;
    for (const t of tags) tagSum += taste.microtag_scores?.[t] ?? 0;
    const capped = Math.max(-8, Math.min(8, tagSum));
    v += capped;
    if (Math.abs(capped) >= 2) reasons.push(`microtags ${capped >= 0 ? '+' : ''}${capped.toFixed(1)}`);
  }

  // Genre affinity — multiplier 1.5 since genre is a strong taste prior.
  const gScore = taste.genre_scores?.[song.genre] ?? 0;
  if (gScore !== 0) {
    v += gScore * 1.5;
    if (Math.abs(gScore) >= 1) reasons.push(`genre ${song.genre} ${gScore >= 0 ? '+' : ''}${(gScore * 1.5).toFixed(1)}`);
  }

  // Mood-word affinity — softer (multiplier 0.8). Some users gravitate
  // toward 'confident' songs across many genres; this captures that.
  if (song.mood) {
    const mScore = taste.mood_scores?.[song.mood] ?? 0;
    if (mScore !== 0) v += mScore * 0.8;
  }

  // Vocal preference — softer still (multiplier 0.4).
  if (song.vocal_type) {
    const vScore = taste.vocal_preferences?.[song.vocal_type] ?? 0;
    if (vScore !== 0) v += vScore * 0.4;
  }

  // Cluster (mood-board) affinity if available — same multiplier as mood.
  if (song.similarity_cluster != null) {
    const clusterKey = String(song.similarity_cluster);
    const cScore = taste.similarity_cluster_scores?.[clusterKey] ?? 0;
    if (cScore !== 0) v += cScore * 0.5;
  }

  return { value: v, reasons };
}

function scoreFreshness(song: Song, recentSongIds: string[]): { value: number; reasons: string[] } {
  // recentSongIds[0] is the most recently played. We treat the first
  // 8 as "this hour" (very fresh, hard penalty), 9-30 as "today"
  // (medium), 31+ as "historical" (mild bonus for unheard-in-a-while).
  const idx = recentSongIds.indexOf(song.id);
  if (idx === -1) return { value: 1.0, reasons: ['unheard recently'] };
  if (idx < 8) return { value: -12, reasons: ['played in the last hour'] };
  if (idx < 30) return { value: -5, reasons: ['played today'] };
  return { value: -1, reasons: ['heard before'] };
}

function scoreQuality(song: Song): { value: number; reasons: string[] } {
  const hook = song.hook_strength ?? 0;
  const mass = song.mainstream_fit ?? 0;
  const launch = song.launch_score ?? 0;
  const v = hook * 1.5 + mass * 0.5 + launch * 0.5;
  const reasons: string[] = [];
  if (hook > 0.65) reasons.push(`strong hook ${hook.toFixed(2)}`);
  if (mass > 0.65) reasons.push(`mainstream ${mass.toFixed(2)}`);
  if (launch > 0 && launch !== 0.5) reasons.push(`launch ${launch.toFixed(2)}`);
  return { value: v, reasons };
}

// ---------- Public API ----------

interface ComponentWeights {
  moodFit: number;
  taste: number;
  freshness: number;
  quality: number;
}

/** Weights tilt toward quality + mood-fit for cold-start users (no
 *  signal yet) and toward personalization for users who have engaged. */
function weightsForUser(interactionCount: number): ComponentWeights {
  const cold = interactionCount < COLD_START_THRESHOLD;
  return cold
    ? { moodFit: 1.5, taste: 0.5, freshness: 1.0, quality: 1.3 }
    : { moodFit: 1.0, taste: 1.6, freshness: 1.0, quality: 0.7 };
}

/** Internal — build a sorted, deduped, artist-diversified playlist for
 *  a mood. Returns the songs (or, in debug mode, the full score
 *  breakdown for every eligible song). */
function buildPlaylistInternal(
  mood: Mood,
  ctx: MoodPlaylistContext,
): { songs: Song[]; breakdown: SongScoreBreakdown[] } {
  const limit = ctx.limit ?? 20;
  const maxPerArtist = ctx.maxPerArtist ?? 2;
  const weights = weightsForUser(ctx.interactionCount);

  // Filter suppressed songs outright — same posture as the main ranker.
  const eligible = ctx.catalog.filter((s) => (s.distribution_stage ?? 'new_test') !== 'suppressed');

  const breakdown: SongScoreBreakdown[] = [];
  for (const song of eligible) {
    const moodFit = scoreMoodFit(song, mood);
    if (!Number.isFinite(moodFit.value)) continue; // hard-filtered

    const taste = scoreTaste(song, ctx.taste);
    const freshness = scoreFreshness(song, ctx.recentSongIds);
    const quality = scoreQuality(song);

    const final =
      moodFit.value * weights.moodFit +
      taste.value * weights.taste +
      freshness.value * weights.freshness +
      quality.value * weights.quality;

    breakdown.push({
      song,
      moodFit: moodFit.value,
      taste: taste.value,
      freshness: freshness.value,
      quality: quality.value,
      final,
      reasons: [...moodFit.reasons, ...taste.reasons, ...freshness.reasons, ...quality.reasons],
    });
  }

  breakdown.sort((a, b) => b.final - a.final);

  // Artist diversity cap so a mood doesn't surface 8 songs from the
  // same artist. The user explicitly asked for this.
  const songs: Song[] = [];
  const perArtist = new Map<string, number>();
  for (const item of breakdown) {
    if (songs.length >= limit) {
      item.dropped = 'limit reached';
      continue;
    }
    const aid = item.song.artist_id ?? '__unknown__';
    const count = perArtist.get(aid) ?? 0;
    if (count >= maxPerArtist) {
      item.dropped = `artist cap (${maxPerArtist}) reached`;
      continue;
    }
    songs.push(item.song);
    perArtist.set(aid, count + 1);
  }

  // Fallback: mood filter too narrow + diversity cap pushed result
  // below 3 → rank the whole catalog by quality so the user never
  // sees a near-empty playlist. Catalog-depth bug, not algo bug.
  if (songs.length < 3) {
    const qualityFallback = eligible
      .map((s) => ({ song: s, score: scoreQuality(s).value }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.song);
    return { songs: qualityFallback, breakdown };
  }

  return { songs, breakdown };
}

/**
 * Build a personalized playlist for a mood.
 *
 * Two call signatures supported:
 *
 *   buildMoodPlaylist(mood, ctx)
 *      — preferred. Full personalization context.
 *
 *   buildMoodPlaylist(mood, catalog, taste, limit?)
 *      — legacy. No freshness penalty (recentSongIds = []) and treats
 *        the user as fully-engaged. Kept so old call sites still work
 *        while migrations land.
 */
export function buildMoodPlaylist(mood: Mood, ctx: MoodPlaylistContext): Song[];
export function buildMoodPlaylist(mood: Mood, catalog: Song[], taste: TasteProfile | null, limit?: number): Song[];
export function buildMoodPlaylist(
  mood: Mood,
  ctxOrCatalog: MoodPlaylistContext | Song[],
  tasteArg?: TasteProfile | null,
  limitArg?: number,
): Song[] {
  const ctx: MoodPlaylistContext = Array.isArray(ctxOrCatalog)
    ? {
        catalog: ctxOrCatalog,
        taste: tasteArg ?? null,
        recentSongIds: [],
        interactionCount: COLD_START_THRESHOLD, // treat legacy callers as warm
        limit: limitArg ?? 20,
      }
    : ctxOrCatalog;
  return buildPlaylistInternal(mood, ctx).songs;
}

/** Same as buildMoodPlaylist but ALSO returns the per-song score
 *  breakdown for debugging / admin / dev-menu inspection. */
export function buildMoodPlaylistDebug(mood: Mood, ctx: MoodPlaylistContext): {
  songs: Song[];
  breakdown: SongScoreBreakdown[];
  weights: ComponentWeights;
  isNewUser: boolean;
} {
  const r = buildPlaylistInternal(mood, ctx);
  return {
    songs: r.songs,
    breakdown: r.breakdown,
    weights: weightsForUser(ctx.interactionCount),
    isNewUser: ctx.interactionCount < COLD_START_THRESHOLD,
  };
}
