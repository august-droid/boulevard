import { SongStats } from '@/types';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Reads per-song daily stats out of Supabase's `song_daily_stats` table.
// When stats aren't available we return an empty map and callers fall back
// to metadata priors (genre popularity, mood stickiness, etc).
//
// We cache the result for ~5 minutes so navigating between tabs or scrolling
// the Explore feed doesn't fan out a query every render.

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; map: Map<string, SongStats> } | null = null;
let inflight: Promise<Map<string, SongStats>> | null = null;

export async function fetchTodayStats(force = false): Promise<Map<string, SongStats>> {
  if (!HAS_SUPABASE || !supabase) return new Map();
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.map;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('song_daily_stats')
        .select('*')
        .eq('day', today);
      if (error || !data) {
        cache = { at: Date.now(), map: new Map() };
        return cache.map;
      }
      const map = new Map<string, SongStats>();
      for (const row of data) {
        map.set((row as SongStats).song_id, row as SongStats);
      }
      cache = { at: Date.now(), map };
      return map;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function clearStatsCache() {
  cache = null;
}
