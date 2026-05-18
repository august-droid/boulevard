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

// Suno hands back "[instrumental]" — or a bare "Instrumental" — as the title
// for no-lyrics tracks. Collapsing all of those to one literal "Instrumental"
// turns an artist's page into a wall of identical rows, so instead we
// synthesize a stable, evocative name from the song's identity. The same seed
// always yields the same name, so titles never shuffle between catalog loads.
const INSTRUMENTAL_ADJECTIVES = [
  'Velvet', 'Midnight', 'Golden', 'Coastal', 'Paper', 'Hollow', 'Glass',
  'Northern', 'Quiet', 'Amber', 'Distant', 'Faded', 'Crimson', 'Silver',
  'Slow', 'Electric', 'Marble', 'Wandering', 'Frozen', 'Endless',
  'Restless', 'Silent', 'Neon', 'Pale', 'Lonely',
];
const INSTRUMENTAL_NOUNS = [
  'Drift', 'Mornings', 'Lantern', 'Tide', 'Tower', 'Engine', 'Air',
  'Garden', 'Hours', 'Echo', 'Horizon', 'Current', 'Bloom', 'Signal',
  'Pulse', 'Haze', 'Orbit', 'Vista', 'Mirage', 'Glow',
  'Static', 'Reverie', 'Window', 'Passage', 'Hymn',
];

/** FNV-1a — small, stable string hash with no dependencies. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic two-word name for a no-lyrics track. */
function generateInstrumentalTitle(seed: string): string {
  const h = hashSeed(seed || 'instrumental');
  const adj = INSTRUMENTAL_ADJECTIVES[h % INSTRUMENTAL_ADJECTIVES.length];
  const noun = INSTRUMENTAL_NOUNS[(h >>> 9) % INSTRUMENTAL_NOUNS.length];
  return `${adj} ${noun}`;
}

/**
 * Suno returns scaffolding tokens like "[instrumental]" or "[Verse]" as the
 * title when a track has no real name — common for songs with no lyrics.
 * Turn those into something human so the UI never shows raw brackets, and
 * give instrumentals a distinct synthesized name (seeded by `seed`, normally
 * the song id) so they don't all collapse to an identical "Instrumental".
 */
export function cleanSongTitle(
  raw: string | null | undefined,
  fallbackGenre?: string | null,
  seed?: string | null,
): string {
  const title = (raw ?? '').trim();
  const bracketed = /^\[.*\]$/.test(title);
  const inner = bracketed ? title.replace(/^\[+|\]+$/g, '').trim() : title;

  // Whole title is just the instrumental token ("[instrumental]" or a bare
  // "Instrumental") — synthesize a distinct name instead.
  if (/^instrument\w*$/i.test(inner)) {
    return generateInstrumentalTitle(seed || title || fallbackGenre || '');
  }

  // A real title never reduces to a single bracketed token.
  if (title && !bracketed) return title;
  // Other bracket scaffolding ([Verse], [Hook], …) — fall back gently.
  if (inner) return inner.charAt(0).toUpperCase() + inner.slice(1);
  const genre = (fallbackGenre ?? '').trim();
  return genre || 'Untitled';
}

function normalize(row: Song): Song {
  return {
    ...row,
    title: cleanSongTitle(row.title, row.genre, row.id),
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
 * Filter is a **quad-gate**:
 *
 *   1. `is_live = true`
 *   2. `approval_status = 'approved'`
 *   3. `approved_by_human = true`  ← only a real reviewer click can set this
 *   4. The song's artist is not hidden (top-70 rebuild filter).
 *
 * The third flag exists because (1) and (2) can be set by automation —
 * worker jobs, batch SQL fixes, or future auto-promote logic. The human
 * gate is the one signal that cannot be flipped without a person looking
 * at the song. The fourth gate keeps songs by backend-only artists out of
 * the public catalog even if they accidentally got approved.
 */
async function fetchAllLiveSongs(): Promise<Song[]> {
  if (!supabase) return [];
  const out: Song[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('songs')
      .select('*, artists!inner(is_hidden)')
      .eq('is_live', true)
      .eq('approval_status', 'approved')
      .eq('approved_by_human', true)
      .eq('artists.is_hidden', false)
      .order('launch_score', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error || !data) break;
    // Strip the embedded `artists` relation so callers see a clean Song shape.
    for (const row of data as (Song & { artists?: unknown })[]) {
      const { artists: _omit, ...rest } = row;
      out.push(rest as Song);
    }
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
