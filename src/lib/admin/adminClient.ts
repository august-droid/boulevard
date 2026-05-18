import { Song } from '@/types';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Admin client — talks to the review_song RPC and the songs table to fetch
// the human-review queue. Used by the in-app Review screen (Profile →
// Review Queue) so you can approve from your phone.

export interface PendingSong extends Song {
  // Quality breakdown surfaced from songs row + queue row to help reviewer
  // decide quickly without playing every track end-to-end.
  intro_strength?: number | null;
  hook_quality?: number | null;
  vocal_quality?: number | null;
  production_quality?: number | null;
  replayability_score?: number | null;
  // The original suno_prompt — helps you spot which archetypes are landing.
  suno_prompt?: string | null;
  subgenre?: string | null;
}

/**
 * The "most viral" timestamp of a song (in seconds) — where a reviewer
 * should start listening to judge a track fastest. Boulevard's intros are
 * dead weight for review: the hook is what decides approval.
 *
 * Priority:
 *   1. First drop (drop_timestamps) — the moment the song's hook lands.
 *   2. End of the intro (intro_length) — straight into the first vocal/hook.
 *   3. A fixed skip-the-intro offset as a last resort.
 *
 * Returns 0 (play from the top) for short songs or when the computed start
 * would be trivially close to the beginning — so nothing ever feels broken.
 */
export function viralStartSeconds(song: Song): number {
  const duration = song.duration_seconds ?? 0;
  // Short song — there's no intro worth skipping; just play it whole.
  if (duration <= 30) return 0;
  // Never start so late the reviewer can't hear the song land + finish.
  const maxStart = Math.max(0, duration - 20);

  const drops = (song.drop_timestamps ?? []).filter(
    (t) => Number.isFinite(t) && t > 2 && t < duration,
  );

  let start: number;
  if (drops.length > 0) {
    start = Math.min(...drops); // earliest drop = the hook first hits
  } else if (typeof song.intro_length === 'number' && song.intro_length > 2) {
    start = song.intro_length;
  } else {
    start = Math.min(24, duration * 0.22); // sensible "skip the intro" default
  }

  start = Math.min(start, maxStart);
  return start < 3 ? 0 : Math.round(start);
}

/** Returns true if the given user_id is in public.admin_users. */
export async function isAdmin(userId: string): Promise<boolean> {
  if (!HAS_SUPABASE || !supabase || !userId) return false;
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Fetch every song still awaiting human review (approved_by_human=false,
 * approval_status='pending'). Pulls the matching songs_queue row in the
 * same call so the UI can show the prompt + per-dimension quality scores.
 */
export async function fetchPendingSongs(limit = 50): Promise<PendingSong[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  try {
    const { data, error } = await supabase
      .from('songs')
      .select(`
        *,
        songs_queue:queue_id (
          suno_prompt, subgenre,
          intro_strength, hook_quality, vocal_quality,
          production_quality, replayability_score
        )
      `)
      .eq('approved_by_human', false)
      .eq('approval_status', 'pending')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    // Flatten the join so callers see one object per song.
    return data.map((row: any) => {
      const q = row.songs_queue ?? {};
      return {
        ...row,
        intro_strength: q.intro_strength ?? null,
        hook_quality: q.hook_quality ?? null,
        vocal_quality: q.vocal_quality ?? null,
        production_quality: q.production_quality ?? null,
        replayability_score: q.replayability_score ?? null,
        suno_prompt: q.suno_prompt ?? null,
        subgenre: q.subgenre ?? null,
      } as PendingSong;
    });
  } catch {
    return [];
  }
}

type ReviewAction = 'approve' | 'reject' | 'regenerate';

export async function reviewSong(opts: {
  userId: string;
  songId: string;
  action: ReviewAction;
  rating?: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!HAS_SUPABASE || !supabase) return { ok: false, error: 'no-supabase' };
  try {
    const { error } = await supabase.rpc('review_song', {
      p_user_id: opts.userId,
      p_song_id: opts.songId,
      p_action: opts.action,
      p_rating: opts.rating ?? null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
