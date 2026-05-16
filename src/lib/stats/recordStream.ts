import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Qualified-stream counting.
//
// A "stream" is counted once per play session, when the listener reaches
// >= 30 seconds OR >= 70% of the song — whichever comes first. PlayerContext
// owns the per-session guard (one stream per play); this module owns the
// write.
//
// The write goes through the `record_stream` Postgres RPC — never a direct
// table write — so the client cannot set the counter itself and the stream
// is stamped with the server-trusted auth.uid(). Every Boulevard surface
// (web, iOS, Android, and the desktop app, which loads the web app) calls
// this same function against the same Supabase backend, so the count is
// global and consistent.
//
// See sql/2026-05-16_stream_counting.sql for the backend side.

/** A play counts as a stream once it reaches this many milliseconds... */
export const STREAM_MIN_MS = 30_000;
/** ...or this fraction of the song's duration — whichever comes first. */
export const STREAM_MIN_RATIO = 0.7;

/** True once `positionMillis` qualifies as a stream for a song of length `durationMillis`. */
export function qualifiesAsStream(positionMillis: number, durationMillis: number): boolean {
  if (positionMillis >= STREAM_MIN_MS) return true;
  if (durationMillis > 0 && positionMillis / durationMillis >= STREAM_MIN_RATIO) return true;
  return false;
}

/**
 * Record one qualified stream for `songId`. Identical on web + native.
 *
 * Returns the song's post-increment lifetime stream count — so a return of
 * `1` means this listener was the first ever, platform-wide. Returns `null`
 * when Supabase isn't configured or the write failed; playback is never
 * disrupted either way.
 */
export async function recordStream(songId: string): Promise<number | null> {
  if (!HAS_SUPABASE || !supabase || !songId) return null;
  try {
    const { data, error } = await supabase.rpc('record_stream', { p_song_id: songId });
    if (error) return null;
    const n = Number(data);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // Best-effort analytics — a failed stream write must never affect playback.
    return null;
  }
}
