import type { Song } from '@/types';
import { normalize } from './normalize';

// Pre-normalized search index. Built once per catalog (memoized by the caller)
// so every keystroke is a cheap scan over already-normalized strings — no
// per-query lowercasing / punctuation work, even at ~10k songs.

export interface IndexedSong {
  song: Song;
  /** Normalized title. */
  title: string;
  /** Normalized artist name. */
  artist: string;
  /** Normalized genre + genres[], space-joined. */
  genreText: string;
  /** Normalized mood + moods[], space-joined. */
  moodText: string;
  /** Normalized microtags + activity_fit + listener contexts, space-joined. */
  tagText: string;
  /** Normalized plain-text lyrics. */
  lyrics: string;
}

/** An artist aggregated from the denormalized per-song artist columns. */
export interface IndexedArtist {
  id: string;
  name: string;
  nameNorm: string;
  imageUrl: string | null;
  primaryGenre: string | null;
  songCount: number;
  totalStreams: number;
}

export interface IndexedGenre {
  /** Display label as it appears in the catalog. */
  value: string;
  norm: string;
}

export interface SearchIndex {
  songs: IndexedSong[];
  artists: IndexedArtist[];
  genres: IndexedGenre[];
  byId: Map<string, Song>;
  catalog: Song[];
}

/** Most-frequent string in an array, or null. */
function mode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) { best = v; bestCount = n; }
  }
  return best;
}

export function buildSearchIndex(catalog: Song[]): SearchIndex {
  const songs: IndexedSong[] = [];
  const byId = new Map<string, Song>();
  const artistSongs = new Map<string, Song[]>();
  const genreSet = new Map<string, string>(); // norm -> display

  for (const s of catalog) {
    byId.set(s.id, s);

    const genreParts = [s.genre, ...(s.genres ?? [])];
    const moodParts = [s.mood, ...(s.moods ?? [])];
    const tagParts = [
      ...(s.microtags ?? []),
      ...(s.activity_fit ?? []),
      ...(s.primary_listener_contexts ?? []),
    ];
    const rawLyrics = s.lyrics ?? '';

    songs.push({
      song: s,
      title: normalize(s.title),
      artist: normalize(s.artist_name),
      genreText: normalize(genreParts.join(' ')),
      moodText: normalize(moodParts.join(' ')),
      tagText: normalize(tagParts.join(' ')),
      lyrics: normalize(rawLyrics),
    });

    if (s.artist_id) {
      const arr = artistSongs.get(s.artist_id) ?? [];
      arr.push(s);
      artistSongs.set(s.artist_id, arr);
    }
    if (s.genre) {
      const n = normalize(s.genre);
      if (n && !genreSet.has(n)) genreSet.set(n, s.genre);
    }
  }

  const artists: IndexedArtist[] = [];
  for (const [id, list] of artistSongs) {
    const recent = [...list].sort((a, b) =>
      (b.created_at ?? '').localeCompare(a.created_at ?? ''),
    );
    const name = recent.find((x) => x.artist_name)?.artist_name ?? 'Boulevard Artist';
    const imageUrl =
      list.find((x) => x.artist_image_url)?.artist_image_url ??
      list.find((x) => x.cover_url)?.cover_url ??
      null;
    const primaryGenre = mode(list.map((x) => x.genre).filter(Boolean) as string[]);
    const totalStreams = list.reduce((sum, x) => sum + (x.stream_count ?? 0), 0);
    artists.push({
      id,
      name,
      nameNorm: normalize(name),
      imageUrl,
      primaryGenre,
      songCount: list.length,
      totalStreams,
    });
  }

  const genres: IndexedGenre[] = [...genreSet.entries()].map(([norm, value]) => ({ norm, value }));

  return { songs, artists, genres, byId, catalog };
}
