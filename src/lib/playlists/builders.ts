import { Song } from '@/types';
import { TasteProfile } from '@/types';
import { rankCandidates } from '@/lib/recommendation/RecommendationEngine';
import { LibraryStore } from '@/lib/library/LibraryStore';

// Library playlist builders. Each returns the ordered list of songs that
// belongs in a given dynamic playlist, plus a cover image (the first song's
// cover, so the playlist always looks alive even with a tiny catalog).
//
// All builders are pure — they never mutate inputs and never call the network.
// They run client-side on the catalog the player already has, which keeps the
// Library tab instant and offline-capable.

export interface BuiltPlaylist {
  id: PlaylistId;
  name: string;
  description: string;
  songs: Song[];
  /** First song's cover, or null if the playlist is empty. */
  coverUrl: string | null;
}

export type PlaylistId =
  | 'new_for_you'
  | 'from_your_follows'
  | 'saved'
  | 'daily_you_1'
  | 'daily_you_2'
  | 'daily_you_3';

// ---- New For You -----------------------------------------------------
//
// Fresh songs the user hasn't heard yet, ranked by their taste profile.
// We hand off to the same recommendation engine that powers auto-advance —
// so what shows up here is exactly what the queue would feed next.
export function buildNewForYou(
  catalog: Song[],
  library: LibraryStore | null,
  taste: TasteProfile | null,
  recentSongIds: string[],
  interactionCount: number,
): BuiltPlaylist {
  const heardIds = new Set<string>(recentSongIds);
  library?.recent().forEach((s) => heardIds.add(s.id));
  const fresh = catalog.filter((s) => !heardIds.has(s.id));

  // Rank using the live taste profile so saved/replayed signals already pull
  // future picks toward the user's preferred sounds.
  const songs = taste
    ? rankCandidates(fresh, {
        taste,
        vibe: null,
        recentSongIds,
        interactionCount,
        stats: new Map(),
      }, [], 40)
    : fresh.slice(0, 40);

  return {
    id: 'new_for_you',
    name: 'New For You',
    description: 'Fresh songs picked by AI for your taste.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- From Your Follows ------------------------------------------------
//
// Songs from the artists the user follows. Newest-released first, capped
// at 40. Surfaces above generic recommendations so following an artist
// actually affects what shows up.
export function buildFromYourFollows(catalog: Song[], followedArtistIds: Set<string>): BuiltPlaylist {
  const songs = catalog
    .filter((s) => s.artist_id && followedArtistIds.has(s.artist_id))
    .sort((a, b) => {
      const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bd - ad;
    })
    .slice(0, 40);
  return {
    id: 'from_your_follows',
    name: 'From Your Follows',
    description: 'New songs from artists you follow.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- Saved -----------------------------------------------------------
//
// Songs the user explicitly bookmarked. Newest save first.
export function buildSaved(library: LibraryStore | null): BuiltPlaylist {
  const songs = library ? [...library.saved()] : [];
  return {
    id: 'saved',
    name: 'Saved Songs',
    description: 'Tracks you bookmarked.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- Daily You × 3 --------------------------------------------------
//
// Three personalized daily mixes, each anchored in a different genre the
// user actually listens to. Replaces the previous fixed-persona playlists
// (CEO Mode / Gym Beast / Your Best Ones) which made the same fixed pitch
// to every user regardless of taste.
//
// Top genres are picked in this priority order:
//   1. taste.genre_scores — the live preference profile (best signal).
//   2. saved + recent songs in the local library — a cold-start fallback
//      that captures what the user has actually engaged with.
//   3. The catalog's three most-represented genres — last-resort default
//      so a brand-new user still sees three Daily You tiles instead of
//      an empty Library.
//
// Within each genre the songs are ranked by the live taste profile so
// "what shows up here" actually tracks what the user's been replaying
// and saving.

const DAILY_YOU_SIZE = 24;

/** Return the top N genres the user prefers, deduped + ordered. */
export function pickTopGenres(
  catalog: Song[],
  library: LibraryStore | null,
  taste: TasteProfile | null,
  count: number,
): string[] {
  const tally = new Map<string, number>();
  const bump = (genre: string | undefined | null, weight: number) => {
    if (!genre) return;
    tally.set(genre, (tally.get(genre) ?? 0) + weight);
  };

  // 1. Taste profile scores (strongest signal).
  if (taste?.genre_scores) {
    for (const [g, score] of Object.entries(taste.genre_scores)) {
      bump(g, score * 10);
    }
  }
  // 2. Saved + recent library songs (warm fallback).
  if (library) {
    for (const s of library.saved()) bump(s.genre, 3);
    for (const s of library.recent()) bump(s.genre, 1);
  }
  // 3. Catalog distribution (cold-start fallback).
  for (const s of catalog) bump(s.genre, 0.001);

  const sorted = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g);

  // Dedupe (entries() is unique but defensive) and trim.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of sorted) {
    if (!seen.has(g)) { seen.add(g); out.push(g); }
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Build one of the three Daily You playlists, anchored to `genre`.
 *   index — 1, 2, or 3 (drives the display name).
 */
export function buildDailyYou(
  catalog: Song[],
  taste: TasteProfile | null,
  recentSongIds: string[],
  interactionCount: number,
  genre: string | undefined,
  index: 1 | 2 | 3,
): BuiltPlaylist {
  const id: PlaylistId =
    index === 1 ? 'daily_you_1' : index === 2 ? 'daily_you_2' : 'daily_you_3';
  const name = `Daily You #${index}`;

  if (!genre) {
    return {
      id,
      name,
      description: 'Personalized for your taste.',
      songs: [],
      coverUrl: null,
    };
  }

  const inGenre = catalog.filter((s) => s.genre === genre);

  // Use the same recommendation engine that powers the queue so this mix
  // ranks identically to "what comes next" within the same genre.
  const songs = taste
    ? rankCandidates(inGenre, {
        taste,
        vibe: null,
        recentSongIds,
        interactionCount,
        stats: new Map(),
      }, [], DAILY_YOU_SIZE)
    : inGenre.slice(0, DAILY_YOU_SIZE);

  return {
    id,
    name,
    description: `Your daily ${genre} mix.`,
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}
