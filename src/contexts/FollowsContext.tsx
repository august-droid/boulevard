import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

// Lightweight follow store. The set of followed artist IDs lives in state
// so the UI can render follow / unfollow instantly; writes are mirrored to
// public.user_artist_follows so other devices and the new-release
// notification job can read them.

interface Ctx {
  ready: boolean;
  followedArtistIds: Set<string>;
  isFollowing: (artistId: string | null | undefined) => boolean;
  toggleFollow: (artistId: string) => Promise<void>;
}

const FollowsContext = createContext<Ctx | null>(null);

export function FollowsProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [ready, setReady] = useState(false);
  const [ids, setIds] = useState<Set<string>>(new Set());

  // Initial load from Supabase. We keep it in a Set for O(1) lookups.
  useEffect(() => {
    let cancelled = false;
    if (!userId || !supabase) { setReady(true); return; }
    (async () => {
      const { data } = await supabase
        .from('user_artist_follows')
        .select('artist_id')
        .eq('user_id', userId);
      if (cancelled) return;
      setIds(new Set((data ?? []).map((r) => r.artist_id as string)));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const isFollowing = useCallback((artistId: string | null | undefined) => {
    if (!artistId) return false;
    return ids.has(artistId);
  }, [ids]);

  const toggleFollow = useCallback(async (artistId: string) => {
    if (!userId || !supabase) return;
    const already = ids.has(artistId);
    // Optimistic: flip the local Set immediately so the UI feels instant.
    setIds((prev) => {
      const next = new Set(prev);
      if (already) next.delete(artistId); else next.add(artistId);
      return next;
    });
    try {
      if (already) {
        await supabase.from('user_artist_follows').delete().eq('user_id', userId).eq('artist_id', artistId);
      } else {
        await supabase.from('user_artist_follows').insert({ user_id: userId, artist_id: artistId });
      }
    } catch {
      // Roll back on failure.
      setIds((prev) => {
        const next = new Set(prev);
        if (already) next.add(artistId); else next.delete(artistId);
        return next;
      });
    }
  }, [ids, userId]);

  const value = useMemo<Ctx>(() => ({ ready, followedArtistIds: ids, isFollowing, toggleFollow }), [ready, ids, isFollowing, toggleFollow]);

  return <FollowsContext.Provider value={value}>{children}</FollowsContext.Provider>;
}

export function useFollows(): Ctx {
  const ctx = useContext(FollowsContext);
  if (!ctx) throw new Error('useFollows must be used inside <FollowsProvider>');
  return ctx;
}
