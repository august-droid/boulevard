import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Best-effort follower-count fetch for the Artist Profile screen. We pull
// from user_artist_follows with a HEAD count query so we never download the
// rows themselves, just the total. Cached for 5 minutes per artist so
// re-opening the screen doesn't fan out a query.

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; count: number }>();
const inflight = new Map<string, Promise<number | null>>();

export async function fetchFollowerCount(artistId: string): Promise<number | null> {
  if (!HAS_SUPABASE || !supabase || !artistId) return null;
  const cached = cache.get(artistId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.count;
  const existing = inflight.get(artistId);
  if (existing) return existing;

  const p = (async () => {
    try {
      const { count, error } = await supabase!
        .from('user_artist_follows')
        .select('*', { count: 'exact', head: true })
        .eq('artist_id', artistId);
      if (error) return null;
      const n = count ?? 0;
      cache.set(artistId, { at: Date.now(), count: n });
      return n;
    } catch {
      return null;
    } finally {
      inflight.delete(artistId);
    }
  })();
  inflight.set(artistId, p);
  return p;
}

/** Bump cached count optimistically when the local user follows / unfollows.
 *  Keeps the hero stat row in sync with the follow button without re-fetching. */
export function bumpFollowerCache(artistId: string, delta: number) {
  const cached = cache.get(artistId);
  if (!cached) return;
  cache.set(artistId, { at: cached.at, count: Math.max(0, cached.count + delta) });
}
