import { Song } from '@/types';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { SEED_SONGS } from '@/lib/seed/songs';

// Catalog loader. Returns the best available source of songs in priority order:
//   1) Supabase `songs` where status = 'live'
//   2) Bundled JSON catalog as a guaranteed fallback
//   3) Empty (UI shows a loading state)
//
// We also normalize a couple of shape quirks so app code can rely on a clean
// Song shape regardless of where the row came from.

const PAGE_SIZE = 500;
const MAX_PAGES = 20; // hard ceiling at ~10k songs

interface LoadResult {
  songs: Song[];
  source: 'supabase' | 'local' | 'empty';
}

function normalize(row: Song): Song {
  return {
    ...row,
    genres: row.genres && row.genres.length > 0 ? row.genres : [row.genre],
    moods: row.moods && row.moods.length > 0 ? row.moods : [row.mood],
    drop_timestamps: row.drop_timestamps ?? [],
    activity_fit: row.activity_fit ?? [],
    intro_length: row.intro_length ?? 0,
    is_featured: row.is_featured ?? false,
    launch_score: row.launch_score ?? 0,
    quality_score: row.quality_score ?? 0,
    suppression_score: row.suppression_score ?? 0,
    status: row.status ?? 'live',
    source: row.source ?? 'seed',
  };
}

/**
 * Paginated pull so we can scale to thousands of songs without hitting
 * Supabase's default 1000-row limit.
 *
 * Filter is a **triple-gate**:
 *
 *   1. `is_live = true`
 *   2. `approval_status = 'approved'`
 *   3. `approved_by_human = true`  ← only a real reviewer click can set this
 *
 * The third flag exists because (1) and (2) can be set by automation —
 * worker jobs, batch SQL fixes, or future auto-promote logic. The human
 * gate is the one signal that cannot be flipped without a person looking
 * at the song. No piece of automation can push a song live until a human
 * has approved it in the dashboard.
 */
async function fetchAllLiveSongs(): Promise<Song[]> {
  if (!supabase) return [];
  const out: Song[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('songs')
      .select('*')
      .eq('is_live', true)
      .eq('approval_status', 'approved')
      .eq('approved_by_human', true)
      .order('launch_score', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error || !data) break;
    out.push(...(data as Song[]));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

export async function loadCatalog(): Promise<LoadResult> {
  if (HAS_SUPABASE && supabase) {
    try {
      const data = await fetchAllLiveSongs();
      if (data.length > 0) {
        return { songs: data.map(normalize), source: 'supabase' };
      }
    } catch {
      // fall through
    }
  }

  if (SEED_SONGS.length > 0) {
    return { songs: SEED_SONGS.map(normalize), source: 'local' };
  }

  return { songs: [], source: 'empty' };
}
