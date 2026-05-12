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
