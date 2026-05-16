import { Song } from '@/types';

// Artist variation rules (spec PART 5B).
//
// In normal discovery the same artist must never be queued back-to-back and
// should be spaced out across the next few songs. Explicit artist-focused
// sessions (artist page Play Top Songs, Start Radio, opening an album, manual
// same-artist selection, direct replay) opt out via `artistFocused`.

export interface ArtistSpacingContext {
  /** Artist of the song currently playing / about to play. */
  currentArtistId?: string | null;
  /** Artist ids of recently played or queued songs, most recent first. */
  recentArtistIds?: string[];
  /** True inside an explicit artist-focused session — disables all penalties. */
  artistFocused?: boolean;
}

// Effectively bans the same artist as the very next song.
const IMMEDIATE_PENALTY = 1000;
// Within the last 3 songs.
const NEAR_PENALTY = 14;
// Within the last 3-5 songs.
const SOFT_PENALTY = 5;

/**
 * Penalty (>= 0) to subtract from a candidate's recommendation score so the
 * same artist does not stack up in algorithmic playback. Returns 0 inside an
 * explicit artist-focused session.
 */
export function artistRepeatPenalty(
  songArtistId: string | null | undefined,
  ctx: ArtistSpacingContext,
): number {
  if (ctx.artistFocused) return 0;
  const aid = songArtistId ?? null;
  if (!aid) return 0;
  if (ctx.currentArtistId && aid === ctx.currentArtistId) return IMMEDIATE_PENALTY;
  const recent = ctx.recentArtistIds ?? [];
  const idx = recent.indexOf(aid);
  if (idx === -1) return 0;
  if (idx < 3) return NEAR_PENALTY;
  if (idx < 5) return SOFT_PENALTY;
  return 0;
}

/**
 * Reorder a song list so the same artist is not adjacent, and ideally not
 * within `spacing` positions. Pure — never drops or adds songs, only reorders.
 *
 *  - `lockCount` keeps the first N songs fixed (the currently-playing song, or
 *    a user-curated playlist that must play in its given order).
 *  - If the list is too artist-thin to satisfy the spacing, the rule relaxes
 *    automatically: first allowing closer spacing, then as an absolute last
 *    resort placing the same artist adjacently.
 */
export function spaceArtists(
  songs: Song[],
  opts: { spacing?: number; lockCount?: number } = {},
): Song[] {
  const spacing = Math.max(1, opts.spacing ?? 3);
  const lockCount = Math.max(0, Math.min(opts.lockCount ?? 0, songs.length));
  if (songs.length - lockCount <= 1) return songs.slice();

  const result: Song[] = songs.slice(0, lockCount);
  const pool = songs.slice(lockCount);

  while (pool.length > 0) {
    const windowArtists = result.slice(-spacing).map((s) => s.artist_id ?? null);

    // Prefer a song whose artist is outside the spacing window.
    let pickIdx = pool.findIndex((s) => !windowArtists.includes(s.artist_id ?? null));

    // Relax step 1: allow anything that is not an immediate repeat.
    if (pickIdx === -1 && result.length > 0) {
      const lastArtist = result[result.length - 1].artist_id ?? null;
      pickIdx = pool.findIndex((s) => (s.artist_id ?? null) !== lastArtist);
    }

    // Relax step 2: list is artist-thin — take the next song as-is.
    if (pickIdx === -1) pickIdx = 0;

    result.push(pool.splice(pickIdx, 1)[0]);
  }

  return result;
}

/**
 * Reorder a freshly-produced batch so the same artist is not stacked, anchored
 * by the tail of the queue it will be appended to. The existing queue is never
 * modified — only the reordered batch is returned. This keeps a user-curated
 * queue prefix (a playlist, an artist's own songs) in its exact given order
 * while still spacing the algorithmic extension that follows it.
 */
export function spaceProducedBatch(existing: Song[], batch: Song[], spacing = 3): Song[] {
  if (batch.length <= 1) return batch.slice();
  const anchor = existing.slice(-spacing);
  const combined = spaceArtists([...anchor, ...batch], { lockCount: anchor.length, spacing });
  return combined.slice(anchor.length);
}
