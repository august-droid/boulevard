/**
 * Song artwork resolution — single source of truth.
 *
 * Boulevard generates a bespoke per-song cover for every track (the
 * music-factory cover-art engine). That cover is what every SONG surface
 * must show — the player, the mini-player, Explore tiles, the Explore hero,
 * Library rows, search results.
 *
 * The artist portrait (`artist_image_url`) is a DIFFERENT asset. It belongs
 * on the artist profile and on artist avatars (the little circular photo in
 * the "Artist: X" pill, the Top Artists shelf, the Following row). It must
 * never stand in for a song's artwork.
 *
 * Precedence is defined here, once, so it cannot drift per-screen again:
 *   1. song.cover_url        — the bespoke song cover (the answer ~always)
 *   2. song.artist_image_url — last-ditch fallback only when a song has no
 *                              cover at all (legacy rows)
 *   3. null                  — caller's <Artwork> renders its initial tile
 *
 * DO NOT inline `song.artist_image_url ?? song.cover_url` anywhere. That
 * inversion is exactly the "Tune Town showed the artist's face in the
 * player" bug. Always call `songArtworkUri()` for song artwork.
 */

export interface SongArtworkFields {
  cover_url?: string | null;
  artist_image_url?: string | null;
}

/** The image URI to display for a SONG. Cover first, artist portrait only as fallback. */
export function songArtworkUri(song: SongArtworkFields | null | undefined): string | null {
  if (!song) return null;
  return song.cover_url ?? song.artist_image_url ?? null;
}
