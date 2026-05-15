import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

// User-created playlists. Backed by public.user_playlists +
// public.user_playlist_songs. We keep the index in state so the picker
// modal renders instantly; mutations write through to Supabase.

export interface UserPlaylist {
  id: string;
  name: string;
  cover_song_id: string | null;
  song_count: number;
  song_ids: string[];      // ordered, for fast "is song X in playlist Y" checks
}

interface Ctx {
  ready: boolean;
  playlists: UserPlaylist[];
  /** Returns the new playlist on success, null on failure (RLS, network). */
  create: (name: string) => Promise<UserPlaylist | null>;
  /** Returns true on success. */
  rename: (playlistId: string, name: string) => Promise<boolean>;
  /** Returns true on success. */
  remove: (playlistId: string) => Promise<boolean>;
  /** Returns true on success, false if RLS/network reverted the optimistic flip. */
  toggleSong: (playlistId: string, songId: string) => Promise<boolean>;
  isInPlaylist: (playlistId: string, songId: string) => boolean;
}

const PlaylistsContext = createContext<Ctx | null>(null);

export function PlaylistsProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [ready, setReady] = useState(false);
  const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);

  // Pull every playlist + its song ids in one round-trip.
  const refresh = useCallback(async () => {
    if (!userId || !supabase) { setReady(true); return; }
    const { data: rows } = await supabase
      .from('user_playlists')
      .select('id, name, cover_song_id, user_playlist_songs(song_id, position)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (!rows) { setPlaylists([]); setReady(true); return; }
    const next: UserPlaylist[] = (rows as unknown as Array<{ id: string; name: string; cover_song_id: string | null; user_playlist_songs: { song_id: string; position: number }[] }>).map((r) => {
      const ids = (r.user_playlist_songs ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((x) => x.song_id);
      return { id: r.id, name: r.name, cover_song_id: r.cover_song_id, song_count: ids.length, song_ids: ids };
    });
    setPlaylists(next);
    setReady(true);
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async (name: string) => {
    if (!userId || !supabase || !name.trim()) return null;
    const { data, error } = await supabase
      .from('user_playlists')
      .insert({ user_id: userId, name: name.trim() })
      .select('id, name, cover_song_id')
      .single();
    if (error || !data) return null;
    const pl: UserPlaylist = { id: data.id, name: data.name, cover_song_id: data.cover_song_id, song_count: 0, song_ids: [] };
    setPlaylists((cur) => [pl, ...cur]);
    return pl;
  }, [userId]);

  const rename = useCallback(async (playlistId: string, name: string): Promise<boolean> => {
    if (!supabase || !name.trim()) return false;
    setPlaylists((cur) => cur.map((p) => p.id === playlistId ? { ...p, name: name.trim() } : p));
    const { error } = await supabase.from('user_playlists').update({ name: name.trim() }).eq('id', playlistId);
    if (error) { await refresh(); return false; }
    return true;
  }, [refresh]);

  const remove = useCallback(async (playlistId: string): Promise<boolean> => {
    if (!supabase) return false;
    setPlaylists((cur) => cur.filter((p) => p.id !== playlistId));
    const { error } = await supabase.from('user_playlists').delete().eq('id', playlistId);
    if (error) { await refresh(); return false; }
    return true;
  }, [refresh]);

  // Add or remove a song from a playlist (idempotent toggle).
  const toggleSong = useCallback(async (playlistId: string, songId: string): Promise<boolean> => {
    if (!supabase) return false;
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return false;
    const has = pl.song_ids.includes(songId);
    // Optimistic update.
    setPlaylists((cur) => cur.map((p) => {
      if (p.id !== playlistId) return p;
      const ids = has ? p.song_ids.filter((id) => id !== songId) : [...p.song_ids, songId];
      return { ...p, song_ids: ids, song_count: ids.length, cover_song_id: p.cover_song_id ?? (has ? null : songId) };
    }));
    try {
      if (has) {
        const { error } = await supabase.from('user_playlist_songs').delete().eq('playlist_id', playlistId).eq('song_id', songId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('user_playlist_songs').insert({ playlist_id: playlistId, song_id: songId, position: pl.song_ids.length });
        if (error) throw error;
        // Set cover to the first song added (idempotent: only if currently null).
        if (!pl.cover_song_id) {
          await supabase.from('user_playlists').update({ cover_song_id: songId }).eq('id', playlistId);
        }
      }
      return true;
    } catch {
      // Roll back on failure.
      await refresh();
      return false;
    }
  }, [playlists, refresh]);

  const isInPlaylist = useCallback((playlistId: string, songId: string) => {
    const pl = playlists.find((p) => p.id === playlistId);
    return pl ? pl.song_ids.includes(songId) : false;
  }, [playlists]);

  const value = useMemo<Ctx>(() => ({ ready, playlists, create, rename, remove, toggleSong, isInPlaylist }), [ready, playlists, create, rename, remove, toggleSong, isInPlaylist]);

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylists(): Ctx {
  const ctx = useContext(PlaylistsContext);
  if (!ctx) throw new Error('usePlaylists must be used inside <PlaylistsProvider>');
  return ctx;
}
