import { Song, Artist, SongStats } from '@/types';

// Boulevard does not currently maintain a separate `artists` table — every
// song carries denormalized artist_id / artist_name / artist_image_url.
// These helpers aggregate the catalog client-side to produce a full Artist
// record on demand, plus the supporting queries the Artist Profile screen
// needs (top songs, latest drops, similar artists, radio queue).
//
// Pure functions: no network. Stats / followers come in as arguments so the
// caller decides where they're sourced from.

/** Stable per-id hash, used to seed the deterministic baselines below. */
function hashId(songId: string): number {
  let h = 0;
  for (let i = 0; i < songId.length; i++) {
    h = ((h << 5) - h) + songId.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Stable per-id baseline so play counts have variety on cold start. Same
 *  shape as ExploreScreen.baselinePlays so the two surfaces agree. */
function baselinePlays(songId: string): number {
  return 1200 + (hashId(songId) % 90000);
}

/** Combined per-song play count (server stats + deterministic baseline). */
export function songPlays(song: Song, stats: Map<string, SongStats>): number {
  const live = stats.get(song.id)?.plays ?? 0;
  return baselinePlays(song.id) + live;
}

/** Deterministic plays-per-listener ratio (4..10) for a song. Real listeners
 *  replay tracks, so dividing plays by this yields a believable unique-
 *  listener estimate that always reads lower than the raw play count. */
function playsPerListener(songId: string): number {
  return 4 + (hashId(songId) % 7); // 4..10
}

/** Estimated monthly listeners for one song: its play count converted to a
 *  unique-listener count. Always >= 1 when the song has any plays. */
function songMonthlyListeners(song: Song, stats: Map<string, SongStats>): number {
  return Math.max(1, Math.round(songPlays(song, stats) / playsPerListener(song.id)));
}

/** Pull every song associated with this artist out of the catalog. */
export function getArtistSongs(catalog: Song[], artistId: string): Song[] {
  return catalog.filter((s) => s.artist_id === artistId);
}

/**
 * Best available portrait for an artist. `artist_image_url` is denormalized
 * onto every Song, but plenty of rows ship without it — so a single recent
 * row missing the portrait must not blank the artist's avatar. Scan ALL of
 * the artist's songs for the first real portrait; only fall back to a song
 * cover when the artist genuinely has no portrait anywhere.
 */
export function resolveArtistImage(
  catalog: Song[],
  artistId: string | null | undefined,
): string | null {
  if (!artistId) return null;
  const songs = getArtistSongs(catalog, artistId);
  for (const s of songs) {
    if (s.artist_image_url) return s.artist_image_url;
  }
  for (const s of songs) {
    if (s.cover_url) return s.cover_url;
  }
  return null;
}

/** Top N songs for an artist, sorted by:
 *    1) server play count + baseline (best signal we have),
 *    2) launch_score (editorial),
 *    3) created_at desc (recency tiebreak).
 *  Mirrors the spec: play_count → save_count → created_at. We don't track
 *  per-song save counts client-side, so launch_score stands in. */
export function getTopSongs(
  catalog: Song[],
  artistId: string,
  stats: Map<string, SongStats>,
  limit = 5,
): Song[] {
  const songs = getArtistSongs(catalog, artistId);
  return [...songs]
    .sort((a, b) => {
      const ap = songPlays(a, stats);
      const bp = songPlays(b, stats);
      if (bp !== ap) return bp - ap;
      const al = a.launch_score ?? 0;
      const bl = b.launch_score ?? 0;
      if (bl !== al) return bl - al;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    })
    .slice(0, limit);
}

/** Newest songs by this artist. Falls back to launch_score when created_at
 *  is missing so the section is never empty. */
export function getLatestDrops(
  catalog: Song[],
  artistId: string,
  limit = 6,
): Song[] {
  const songs = getArtistSongs(catalog, artistId);
  return [...songs]
    .sort((a, b) => {
      const ad = a.created_at ?? '';
      const bd = b.created_at ?? '';
      if (ad && bd) return bd.localeCompare(ad);
      if (bd) return 1;
      if (ad) return -1;
      return (b.launch_score ?? 0) - (a.launch_score ?? 0);
    })
    .slice(0, limit);
}

/** Most-frequent string in an array, or null. */
function mode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}

/** Build a full Artist record from the catalog. Returns null when no song
 *  matches — caller should treat that as "artist not found" and bail. */
export function getArtistById(
  catalog: Song[],
  artistId: string,
  stats: Map<string, SongStats>,
  followerCount: number | null = null,
): Artist | null {
  const songs = getArtistSongs(catalog, artistId);
  if (songs.length === 0) return null;

  // Prefer the artist's most-recent name / image (in case the catalog has
  // older rows with stale metadata).
  const sortedRecent = [...songs].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );
  const name = sortedRecent[0].artist_name ?? 'Boulevard Artist';
  // Scan every song for a real portrait — don't blank the hero just because
  // the most-recent row happens to miss artist_image_url.
  const image = resolveArtistImage(catalog, artistId);

  const primary = mode(songs.map((s) => s.genre).filter(Boolean) as string[]);

  const monthlyListeners = songs.reduce(
    (sum, s) => sum + songMonthlyListeners(s, stats),
    0,
  );

  return {
    id: artistId,
    name,
    image_url: image,
    primary_genre: primary,
    song_count: songs.length,
    monthly_listeners: monthlyListeners,
    follower_count: followerCount,
  };
}

/** Find similar artists, ranked by how much they share with the target.
 *  Score = genre match (3) + shared moods (1 each) + shared microtags (0.5).
 *  Limited to artists with at least one song in the catalog. */
export function getSimilarArtists(
  catalog: Song[],
  artistId: string,
  stats: Map<string, SongStats>,
  limit = 8,
): Artist[] {
  const target = getArtistById(catalog, artistId, stats);
  if (!target) return [];
  const targetMoods = new Set(
    catalog
      .filter((s) => s.artist_id === artistId)
      .flatMap((s) => s.moods ?? [s.mood].filter(Boolean) as string[])
      .map((m) => m.toLowerCase()),
  );
  const targetTags = new Set(
    catalog
      .filter((s) => s.artist_id === artistId)
      .flatMap((s) => s.microtags ?? [])
      .map((m) => m.toLowerCase()),
  );

  // Bucket the catalog by artist_id so we score each candidate once.
  const byId = new Map<string, Song[]>();
  for (const s of catalog) {
    if (!s.artist_id || s.artist_id === artistId) continue;
    const arr = byId.get(s.artist_id) ?? [];
    arr.push(s);
    byId.set(s.artist_id, arr);
  }

  const scored: { id: string; score: number }[] = [];
  for (const [id, songs] of byId) {
    let score = 0;
    const genres = new Set(songs.map((s) => s.genre?.toLowerCase()).filter(Boolean));
    if (target.primary_genre && genres.has(target.primary_genre.toLowerCase())) score += 3;
    const moods = new Set(songs.flatMap((s) => s.moods ?? [s.mood].filter(Boolean) as string[]).map((m) => m.toLowerCase()));
    for (const m of moods) if (targetMoods.has(m)) score += 1;
    const tags = new Set(songs.flatMap((s) => s.microtags ?? []).map((m) => m.toLowerCase()));
    for (const t of tags) if (targetTags.has(t)) score += 0.5;
    if (score > 0) scored.push({ id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const out: Artist[] = [];
  for (const { id } of scored) {
    const a = getArtistById(catalog, id, stats);
    if (a) out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

/** Build an "Artist Radio" queue:
 *    1) all this artist's songs (interleaved roughly by score),
 *    2) top songs from similar artists,
 *    3) songs that share a mood/microtag with the target artist.
 *  De-duped, capped so the queue is meaty but not absurd. */
export function buildArtistRadio(
  catalog: Song[],
  artistId: string,
  stats: Map<string, SongStats>,
  limit = 30,
): Song[] {
  const own = getTopSongs(catalog, artistId, stats, 8);
  const similar = getSimilarArtists(catalog, artistId, stats, 6);
  const similarSongs: Song[] = [];
  for (const a of similar) {
    similarSongs.push(...getTopSongs(catalog, a.id, stats, 3));
  }

  const seen = new Set<string>();
  const out: Song[] = [];
  const push = (s: Song) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  // Lead with the artist's strongest two so radio "feels like them" up front.
  for (const s of own.slice(0, 2)) push(s);
  // Interleave: 1 own, 1 similar so we don't burn the artist's catalog in
  // the first 8 tracks.
  let oi = 2;
  let si = 0;
  while (out.length < limit && (oi < own.length || si < similarSongs.length)) {
    if (oi < own.length) push(own[oi++]);
    if (si < similarSongs.length) push(similarSongs[si++]);
  }

  // Mood/microtag tail — fill any remaining slots with broad-genre songs
  // that share a mood or microtag, so radio doesn't dead-end on a tiny
  // artist with two songs.
  if (out.length < limit) {
    const target = getArtistById(catalog, artistId, stats);
    const targetMoods = new Set(
      catalog
        .filter((s) => s.artist_id === artistId)
        .flatMap((s) => s.moods ?? [s.mood].filter(Boolean) as string[])
        .map((m) => m.toLowerCase()),
    );
    const targetTags = new Set(
      catalog
        .filter((s) => s.artist_id === artistId)
        .flatMap((s) => s.microtags ?? [])
        .map((m) => m.toLowerCase()),
    );
    const tail = catalog
      .filter((s) => !seen.has(s.id))
      .map((s) => {
        let score = 0;
        if (target?.primary_genre && s.genre?.toLowerCase() === target.primary_genre.toLowerCase()) score += 1;
        for (const m of (s.moods ?? [s.mood].filter(Boolean) as string[])) {
          if (targetMoods.has(m.toLowerCase())) score += 1;
        }
        for (const t of (s.microtags ?? [])) {
          if (targetTags.has(t.toLowerCase())) score += 0.5;
        }
        score += songPlays(s, stats) / 50000;
        return { song: s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { song } of tail) {
      if (out.length >= limit) break;
      push(song);
    }
  }

  return out;
}

/** Pretty-print large play / follower counts. Mirrors ExploreScreen. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
