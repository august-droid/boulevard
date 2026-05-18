import type { Song } from '@/types';
import type { SearchIndex, IndexedSong, IndexedArtist } from './searchIndex';
import { normalize, tokenize } from './normalize';
import { CHIP_MOODS, type ChipMood, type ChipMoodId } from '@/lib/mood/moodCatalog';
import { SESSION_WORLDS, buildWorldPlaylist, type SessionWorld } from '@/lib/recommendation/SessionContext';

// Boulevard search engine.
//
// A discovery engine, not an exact-title filter. It ranks the whole catalog
// across title / artist / lyrics / genre / mood / tags, resolves discovery
// terms ("gym", "late night", "villain mode") through an alias table, and
// groups the output into the sections the search UI renders. Pure + sync:
// it works off the pre-normalized SearchIndex, so it is cheap per keystroke.

// ---- public result shape ----------------------------------------------

export type PlaylistKind = 'user' | 'world' | 'mood' | 'virtual';

export interface PlaylistHit {
  id: string;
  kind: PlaylistKind;
  title: string;
  subtitle: string;
  /** Resolved, ready-to-play songs. */
  songs: Song[];
  /** Set for kind 'world' — used to build the mood_focus session anchor. */
  world?: SessionWorld;
  /** Set for kind 'mood'. */
  mood?: ChipMood;
}

export interface GenreMoodHit {
  id: string;
  label: string;
  kind: 'genre' | 'mood';
  songs: Song[];
  /** Display genre label (kind 'genre'). */
  genreValue?: string;
  /** Set for kind 'mood'. */
  mood?: ChipMood;
}

export type TopResult =
  | { type: 'song'; song: Song }
  | { type: 'artist'; artist: IndexedArtist }
  | { type: 'playlist'; playlist: PlaylistHit };

export interface SearchResults {
  query: string;
  topResult: TopResult | null;
  songs: Song[];
  artists: IndexedArtist[];
  playlists: PlaylistHit[];
  similarSongs: Song[];
  genresMoods: GenreMoodHit[];
  lyricsMatches: Song[];
  isFallback: boolean;
  message: string | null;
}

const EMPTY: SearchResults = {
  query: '',
  topResult: null,
  songs: [],
  artists: [],
  playlists: [],
  similarSongs: [],
  genresMoods: [],
  lyricsMatches: [],
  isFallback: false,
  message: null,
};

export interface SearchOptions {
  worlds?: SessionWorld[];
  moods?: ChipMood[];
  userPlaylists?: { id: string; name: string; song_ids: string[] }[];
}

// ---- limits ------------------------------------------------------------

const SONGS_LIMIT = 24;
const ARTISTS_LIMIT = 12;
const PLAYLISTS_LIMIT = 8;
const GENRES_MOODS_LIMIT = 10;
const LYRICS_LIMIT = 12;
const SIMILAR_LIMIT = 12;
const PLAYLIST_SONGS = 40;
const TOP_RESULT_FLOOR = 120;

// ---- discovery alias table (requirement 7) -----------------------------

interface AliasEntry {
  genres?: string[];
  moodIds?: ChipMoodId[];
  moodWords?: string[];
  microtags?: string[];
  activities?: string[];
}

const RAW_ALIASES: Record<string, AliasEntry> = {
  rap: { genres: ['rap', 'hip hop', 'hip-hop', 'hiphop', 'trap', 'drill', 'melodic rap'] },
  'hip hop': { genres: ['rap', 'hip hop', 'hip-hop', 'hiphop', 'trap'] },
  edm: { genres: ['edm', 'electronic', 'house', 'techno', 'dance', 'trance', 'dubstep'] },
  electronic: { genres: ['edm', 'electronic', 'house', 'techno', 'dance'] },
  latin: { genres: ['latin', 'reggaeton', 'afrobeat', 'afrobeats', 'amapiano', 'dancehall'] },
  country: { genres: ['country', 'americana', 'folk'] },
  pop: { genres: ['pop'] },
  'r b': { genres: ['r&b', 'rnb', 'soul', 'neo-soul', 'neo soul', 'trap soul'] },
  rnb: { genres: ['r&b', 'rnb', 'soul', 'neo-soul', 'neo soul', 'trap soul'] },
  blues: { genres: ['blues'] },
  indie: { genres: ['indie', 'bedroom pop', 'dream pop', 'shoegaze', 'alt'] },
  gym: { activities: ['gym'], moodIds: ['hyped'], microtags: ['peak_energy', 'high_energy', 'hard_808_kick'] },
  workout: { activities: ['gym'], moodIds: ['hyped'] },
  party: { activities: ['party'], moodIds: ['party'] },
  sad: { moodIds: ['sad'] },
  lonely: { moodIds: ['sad', 'heartbreak'], moodWords: ['lonely', 'longing'] },
  heartbreak: { moodIds: ['heartbreak'] },
  confident: { moodIds: ['confidence', 'main_character'], moodWords: ['confident'] },
  confidence: { moodIds: ['confidence', 'main_character'] },
  sexy: { moodIds: ['confidence', 'main_character'], microtags: ['intimate_vocal', 'close_mic_vocal'] },
  chill: { moodIds: ['chill'] },
  'late night': { moodIds: ['night_drive'], microtags: ['late_night_imagery', 'late_night_tempo'] },
  'night drive': { moodIds: ['night_drive'] },
  driving: { activities: ['driving'], moodIds: ['night_drive'] },
  focus: { activities: ['focus'], moodIds: ['focus'] },
  summer: { moodIds: ['party'], moodWords: ['warm', 'carefree', 'joyful'] },
  'main character': { moodIds: ['main_character'] },
  'villain mode': {
    moodIds: ['main_character', 'confidence'],
    moodWords: ['defiant', 'menacing', 'reckless'],
    microtags: ['aggressive_lyrics'],
  },
};

const SEARCH_ALIASES: Map<string, AliasEntry> = new Map(
  Object.entries(RAW_ALIASES).map(([k, v]) => [normalize(k), v]),
);

// ---- match primitives --------------------------------------------------

type MatchKind = 'exact' | 'prefix' | 'partial' | 'tokens';

function fieldMatch(field: string, q: string, qTokens: string[]): MatchKind | null {
  if (!field || !q) return null;
  if (field === q) return 'exact';
  if (field.startsWith(q)) return 'prefix';
  if (field.includes(q)) return 'partial';
  if (qTokens.length > 1 && qTokens.every((t) => field.includes(t))) return 'tokens';
  return null;
}

/** OR-combined catalog filter — used to materialize alias / mood / genre lanes. */
interface MatchSpec {
  genres: string[];
  moodWords: string[];
  microtags: string[];
  activities: string[];
}

function songMatchesSpec(idx: IndexedSong, spec: MatchSpec): boolean {
  for (const g of spec.genres) if (g && idx.genreText.includes(g)) return true;
  for (const m of spec.moodWords) if (m && idx.moodText.includes(m)) return true;
  for (const t of spec.microtags) if (t && idx.tagText.includes(t)) return true;
  for (const a of spec.activities) if (a && idx.tagText.includes(a)) return true;
  return false;
}

function aliasToSpec(a: AliasEntry, moods: ChipMood[]): MatchSpec {
  const moodWords = [...(a.moodWords ?? [])];
  const microtags = [...(a.microtags ?? [])];
  for (const id of a.moodIds ?? []) {
    const m = moods.find((x) => x.id === id);
    if (m) {
      moodWords.push(...m.moodWords);
      microtags.push(...m.microtags);
    }
  }
  return {
    genres: (a.genres ?? []).map(normalize).filter(Boolean),
    moodWords: moodWords.map(normalize).filter(Boolean),
    microtags: microtags.map(normalize).filter(Boolean),
    activities: (a.activities ?? []).map(normalize).filter(Boolean),
  };
}

/** Resolve one normalized term to a catalog filter — alias, then catalog
 *  genre, then mood chip. Null when the term carries no discovery meaning. */
function resolveTermSpec(term: string, index: SearchIndex, moods: ChipMood[]): MatchSpec | null {
  if (!term) return null;
  const alias = SEARCH_ALIASES.get(term);
  if (alias) return aliasToSpec(alias, moods);
  if (term.length >= 2 && index.genres.some((g) => g.norm.includes(term))) {
    return { genres: [term], moodWords: [], microtags: [], activities: [] };
  }
  const mood = moods.find(
    (m) => normalize(m.label) === term || m.moodWords.some((w) => normalize(w) === term),
  );
  if (mood) return aliasToSpec({ moodIds: [mood.id] }, moods);
  return null;
}

function songsForSpecs(index: SearchIndex, specs: MatchSpec[], limit: number): Song[] {
  if (specs.length === 0) return [];
  return index.songs
    .filter((idx) => specs.every((spec) => songMatchesSpec(idx, spec)))
    .map((idx) => idx.song)
    .sort((a, b) => (b.stream_count ?? 0) - (a.stream_count ?? 0))
    .slice(0, limit);
}

function songsForGenre(index: SearchIndex, genreNorm: string, limit: number): Song[] {
  return index.songs
    .filter((idx) => idx.genreText.includes(genreNorm))
    .map((idx) => idx.song)
    .sort((a, b) => (b.stream_count ?? 0) - (a.stream_count ?? 0))
    .slice(0, limit);
}

function songsForMood(index: SearchIndex, mood: ChipMood, limit: number): Song[] {
  const tags = mood.microtags.map(normalize);
  const words = mood.moodWords.map(normalize);
  const contexts = mood.contexts.map(normalize);
  const scored: { song: Song; score: number }[] = [];
  for (const idx of index.songs) {
    let score = 0;
    for (const t of tags) if (t && idx.tagText.includes(t)) score += 2;
    for (const w of words) if (w && idx.moodText.includes(w)) score += 1.5;
    for (const c of contexts) if (c && idx.tagText.includes(c)) score += 1;
    if (mood.energyRange) {
      const [lo, hi] = mood.energyRange;
      if (idx.song.energy_score >= lo && idx.song.energy_score <= hi) score += 1;
    }
    if (score > 0) scored.push({ song: idx.song, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.song.stream_count ?? 0) - (a.song.stream_count ?? 0));
  return scored.slice(0, limit).map((x) => x.song);
}

function trendingSongs(index: SearchIndex, limit: number): Song[] {
  return [...index.catalog]
    .sort(
      (a, b) =>
        (b.stream_count ?? 0) - (a.stream_count ?? 0) ||
        (b.launch_score ?? 0) - (a.launch_score ?? 0),
    )
    .slice(0, limit);
}

// ---- similarity --------------------------------------------------------

function topSongsForArtist(index: SearchIndex, artistId: string, n: number): Song[] {
  return index.songs
    .filter((idx) => idx.song.artist_id === artistId)
    .map((idx) => idx.song)
    .sort((a, b) => (b.stream_count ?? 0) - (a.stream_count ?? 0))
    .slice(0, n);
}

/** Songs close to a reference song — shared microtags / genre / mood, with a
 *  nudge toward the same artist (requirement 6). Cross-section de-duping is
 *  the caller's job (via takeUnique). */
function similarSongsForSong(index: SearchIndex, ref: Song, limit: number): Song[] {
  const refTags = new Set(ref.microtags ?? []);
  const refMoods = new Set([ref.mood, ...(ref.moods ?? [])].filter(Boolean));
  const scored: { song: Song; score: number }[] = [];
  for (const idx of index.songs) {
    const s = idx.song;
    if (s.id === ref.id) continue;
    let score = 0;
    if (s.genre && ref.genre && s.genre === ref.genre) score += 3;
    let shared = 0;
    for (const t of s.microtags ?? []) if (refTags.has(t)) shared++;
    score += Math.min(8, shared * 2);
    for (const m of [s.mood, ...(s.moods ?? [])]) if (m && refMoods.has(m)) score += 1;
    if (s.artist_id && s.artist_id === ref.artist_id) score += 2;
    if (score > 0) score += (s.hook_strength ?? 0) * 0.5;
    if (score > 0) scored.push({ song: s, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.song.stream_count ?? 0) - (a.song.stream_count ?? 0));
  return scored.slice(0, limit).map((x) => x.song);
}

/** Artists that share genre / mood / microtags with the target. */
function similarArtists(index: SearchIndex, artistId: string, limit: number): IndexedArtist[] {
  const byArtist = new Map<string, Song[]>();
  for (const idx of index.songs) {
    const aid = idx.song.artist_id;
    if (!aid) continue;
    const arr = byArtist.get(aid) ?? [];
    arr.push(idx.song);
    byArtist.set(aid, arr);
  }
  const targetSongs = byArtist.get(artistId);
  if (!targetSongs || targetSongs.length === 0) return [];
  const targetGenres = new Set(targetSongs.map((s) => (s.genre ?? '').toLowerCase()).filter(Boolean));
  const targetMoods = new Set(
    targetSongs.flatMap((s) => [s.mood, ...(s.moods ?? [])]).filter(Boolean).map((m) => m.toLowerCase()),
  );
  const targetTags = new Set(targetSongs.flatMap((s) => s.microtags ?? []).map((t) => t.toLowerCase()));

  const scored: { id: string; score: number }[] = [];
  for (const [id, songs] of byArtist) {
    if (id === artistId) continue;
    let score = 0;
    const genres = new Set(songs.map((s) => (s.genre ?? '').toLowerCase()).filter(Boolean));
    for (const g of genres) if (targetGenres.has(g)) score += 3;
    const moods = new Set(
      songs.flatMap((s) => [s.mood, ...(s.moods ?? [])]).filter(Boolean).map((m) => m.toLowerCase()),
    );
    for (const m of moods) if (targetMoods.has(m)) score += 1;
    const tags = new Set(songs.flatMap((s) => s.microtags ?? []).map((t) => t.toLowerCase()));
    for (const t of tags) if (targetTags.has(t)) score += 0.5;
    if (score > 0) scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: IndexedArtist[] = [];
  for (const { id } of scored) {
    const a = index.artists.find((x) => x.id === id);
    if (a) out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- helpers -----------------------------------------------------------

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Identity key for a song in result lists. Title + artist, not id — the
 *  catalog can hold separate rows with an identical title AND artist, and
 *  showing both reads as a duplicate to the user. */
function songKey(s: Song): string {
  return normalize(s.title) + '|' + normalize(s.artist_name);
}

/** Append songs whose title+artist key has not been shown yet, up to limit. */
function takeUnique(songs: Song[], used: Set<string>, limit: number): Song[] {
  const out: Song[] = [];
  for (const s of songs) {
    const k = songKey(s);
    if (used.has(k)) continue;
    used.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

const TITLE_SCORE: Record<MatchKind, number> = { exact: 1000, prefix: 600, partial: 420, tokens: 300 };
const ARTIST_FIELD_SCORE: Record<MatchKind, number> = { exact: 260, prefix: 230, partial: 175, tokens: 140 };
const ARTIST_SCORE: Record<MatchKind, number> = { exact: 1000, prefix: 600, partial: 380, tokens: 260 };
const WORLD_SCORE: Record<MatchKind, number> = { exact: 900, prefix: 600, partial: 380, tokens: 300 };
const MOOD_SCORE: Record<MatchKind, number> = { exact: 850, prefix: 560, partial: 360, tokens: 280 };
const USER_PL_SCORE: Record<MatchKind, number> = { exact: 950, prefix: 620, partial: 400, tokens: 300 };
const GENRE_SCORE: Record<MatchKind, number> = { exact: 800, prefix: 520, partial: 340, tokens: 260 };

function songTiebreak(s: Song): number {
  return (
    Math.min(60, (s.stream_count ?? 0) / 4000) +
    (s.launch_score ?? 0) * 8 +
    (s.hook_strength ?? 0) * 4
  );
}

// ---- main --------------------------------------------------------------

export function runSearch(rawQuery: string, index: SearchIndex, opts: SearchOptions = {}): SearchResults {
  const query = (rawQuery ?? '').trim();
  const q = normalize(query);
  if (q.length === 0) return { ...EMPTY };

  const qTokens = q.split(' ');
  const moods = opts.moods ?? CHIP_MOODS;
  const worlds = opts.worlds ?? SESSION_WORLDS;
  const userPlaylists = opts.userPlaylists ?? [];

  // Mood chips the query implies — via the full query OR any single token, so
  // "sad songs" still surfaces the Sad mood even though "sad songs" is not
  // itself an alias key.
  const impliedMoods = new Set<ChipMoodId>();
  for (const term of [q, ...qTokens]) {
    for (const id of SEARCH_ALIASES.get(term)?.moodIds ?? []) impliedMoods.add(id);
  }

  // ---- score songs (title / artist / lyrics) --------------------------
  type SongHit = { song: Song; score: number; category: 'title' | 'artist' | 'lyrics' };
  const songHits: SongHit[] = [];
  for (const idx of index.songs) {
    let best = 0;
    let category: SongHit['category'] = 'title';

    const tk = fieldMatch(idx.title, q, qTokens);
    if (tk) { best = TITLE_SCORE[tk]; category = 'title'; }

    const ak = fieldMatch(idx.artist, q, qTokens);
    if (ak && ARTIST_FIELD_SCORE[ak] > best) { best = ARTIST_FIELD_SCORE[ak]; category = 'artist'; }

    if (idx.lyrics) {
      let lyricScore = 0;
      if (q.length >= 3 && idx.lyrics.includes(q)) lyricScore = 240;
      else if (qTokens.every((t) => t.length >= 3 && idx.lyrics.includes(t))) lyricScore = 130;
      if (lyricScore > best) { best = lyricScore; category = 'lyrics'; }
    }

    if (best > 0) songHits.push({ song: idx.song, score: best + songTiebreak(idx.song), category });
  }
  songHits.sort((a, b) => b.score - a.score);

  // ---- score artists --------------------------------------------------
  type ArtistHit = { artist: IndexedArtist; score: number };
  const artistHits: ArtistHit[] = [];
  for (const a of index.artists) {
    const k = fieldMatch(a.nameNorm, q, qTokens);
    if (k) artistHits.push({ artist: a, score: ARTIST_SCORE[k] + Math.min(60, a.totalStreams / 4000) });
  }
  artistHits.sort((a, b) => b.score - a.score);

  // ---- virtual mix from alias / genre / mood resolution ---------------
  const virtualSpecs: MatchSpec[] = [];
  const fullAlias = SEARCH_ALIASES.get(q);
  if (fullAlias) {
    virtualSpecs.push(aliasToSpec(fullAlias, moods));
  } else {
    for (const t of qTokens) {
      const spec = resolveTermSpec(t, index, moods);
      if (spec) virtualSpecs.push(spec);
    }
  }
  const virtualSongs = songsForSpecs(index, virtualSpecs, PLAYLIST_SONGS);

  // ---- score playlists (user / world / mood / virtual) ----------------
  type PLHit = { hit: PlaylistHit; score: number };
  const plHits: PLHit[] = [];

  for (const up of userPlaylists) {
    const k = fieldMatch(normalize(up.name), q, qTokens);
    if (!k) continue;
    const songs = up.song_ids
      .map((id) => index.byId.get(id))
      .filter((s): s is Song => !!s);
    if (songs.length === 0) continue;
    plHits.push({
      score: USER_PL_SCORE[k],
      hit: {
        id: `user_${up.id}`,
        kind: 'user',
        title: up.name,
        subtitle: `Your playlist · ${songs.length} song${songs.length === 1 ? '' : 's'}`,
        songs,
      },
    });
  }

  for (const w of worlds) {
    const labelK = fieldMatch(normalize(w.label), q, qTokens);
    let score = labelK ? WORLD_SCORE[labelK] : 0;
    if (!score && w.moodWords.some((mw) => qTokens.includes(normalize(mw)))) score = 280;
    if (!score) continue;
    const songs = buildWorldPlaylist(index.catalog, w, 28);
    if (songs.length === 0) continue;
    plHits.push({
      score,
      hit: {
        id: `world_${w.id}`,
        kind: 'world',
        title: w.label,
        subtitle: `Boulevard World · ${songs.length} songs`,
        songs,
        world: w,
      },
    });
  }

  for (const m of moods) {
    const labelK = fieldMatch(normalize(m.label), q, qTokens);
    let score = labelK ? MOOD_SCORE[labelK] : 0;
    if (!score && m.moodWords.some((mw) => qTokens.includes(normalize(mw)))) score = 260;
    if (!score && impliedMoods.has(m.id)) score = 250;
    if (!score) continue;
    const songs = songsForMood(index, m, PLAYLIST_SONGS);
    if (songs.length === 0) continue;
    plHits.push({
      score,
      hit: {
        id: `mood_${m.id}`,
        kind: 'mood',
        title: m.label,
        subtitle: `Mood mix · ${songs.length} songs`,
        songs,
        mood: m,
      },
    });
  }

  if (virtualSpecs.length > 0 && virtualSongs.length >= 5) {
    plHits.push({
      score: virtualSpecs.length === 1 ? 520 : 470,
      hit: {
        id: `virtual_${q}`,
        kind: 'virtual',
        title: titleCase(query),
        subtitle: `Mix · ${virtualSongs.length} songs`,
        songs: virtualSongs,
      },
    });
  }

  // Dedupe playlists by normalized title (keep the highest-scoring source).
  plHits.sort((a, b) => b.score - a.score);
  const seenPlTitle = new Set<string>();
  const playlists: PlaylistHit[] = [];
  for (const { hit } of plHits) {
    const key = normalize(hit.title);
    if (seenPlTitle.has(key)) continue;
    seenPlTitle.add(key);
    playlists.push(hit);
    if (playlists.length >= PLAYLISTS_LIMIT) break;
  }

  // ---- genres & moods -------------------------------------------------
  type GMHit = { hit: GenreMoodHit; score: number };
  const gmHits: GMHit[] = [];
  const aliasGenreNeedles = new Set(virtualSpecs.flatMap((s) => s.genres));
  for (const g of index.genres) {
    const k = fieldMatch(g.norm, q, qTokens);
    let score = k ? GENRE_SCORE[k] : 0;
    if (!score && [...aliasGenreNeedles].some((n) => g.norm.includes(n))) score = 300;
    if (!score) continue;
    const songs = songsForGenre(index, g.norm, PLAYLIST_SONGS);
    if (songs.length === 0) continue;
    gmHits.push({ score, hit: { id: `genre_${g.norm}`, label: g.value, kind: 'genre', genreValue: g.value, songs } });
  }
  for (const m of moods) {
    const labelK = fieldMatch(normalize(m.label), q, qTokens);
    let score = labelK ? MOOD_SCORE[labelK] : 0;
    if (!score && m.moodWords.some((mw) => qTokens.includes(normalize(mw)))) score = 260;
    if (!score && impliedMoods.has(m.id)) score = 250;
    if (!score) continue;
    const songs = songsForMood(index, m, PLAYLIST_SONGS);
    if (songs.length === 0) continue;
    gmHits.push({ score, hit: { id: `gm_mood_${m.id}`, label: m.label, kind: 'mood', mood: m, songs } });
  }
  gmHits.sort((a, b) => b.score - a.score);
  const genresMoods = gmHits.slice(0, GENRES_MOODS_LIMIT).map((x) => x.hit);

  // ---- pick the Top Result --------------------------------------------
  const bestSong = songHits[0];
  const bestArtist = artistHits[0];
  const bestPl = plHits[0];
  let topResult: TopResult | null = null;
  {
    const songScore = bestSong?.score ?? 0;
    const artistScore = bestArtist?.score ?? 0;
    const plScore = bestPl?.score ?? 0;
    const top = Math.max(songScore, artistScore, plScore);
    if (top >= TOP_RESULT_FLOOR) {
      if (songScore === top && bestSong) topResult = { type: 'song', song: bestSong.song };
      else if (artistScore === top && bestArtist) topResult = { type: 'artist', artist: bestArtist.artist };
      else if (bestPl) topResult = { type: 'playlist', playlist: bestPl.hit };
    }
  }
  const topArtistId = topResult?.type === 'artist' ? topResult.artist.id : null;
  // A playlist promoted to Top Result must not repeat in the Playlists section.
  const topPlaylistId = topResult?.type === 'playlist' ? topResult.playlist.id : null;
  const finalPlaylists = topPlaylistId
    ? playlists.filter((p) => p.id !== topPlaylistId)
    : playlists;

  // Every song-bearing section shares one "already shown" set keyed by
  // title+artist, so a song (or a look-alike catalog row) never appears
  // twice across Top Result / Songs / Similar Songs / Lyrics Matches.
  const usedSongs = new Set<string>();
  if (topResult?.type === 'song') usedSongs.add(songKey(topResult.song));

  // ---- Songs section (title + artist matches) -------------------------
  const songsSection = takeUnique(
    songHits.filter((h) => h.category !== 'lyrics').map((h) => h.song),
    usedSongs,
    SONGS_LIMIT,
  );

  // ---- Lyrics Matches section -----------------------------------------
  const lyricsMatches = takeUnique(
    songHits.filter((h) => h.category === 'lyrics').map((h) => h.song),
    usedSongs,
    LYRICS_LIMIT,
  );

  // ---- Artists section (matches + similar) ----------------------------
  const artists: IndexedArtist[] = [];
  const artistIds = new Set<string>();
  for (const h of artistHits) {
    if (h.artist.id === topArtistId || artistIds.has(h.artist.id)) continue;
    artistIds.add(h.artist.id);
    artists.push(h.artist);
    if (artists.length >= ARTISTS_LIMIT) break;
  }
  const seedArtistId =
    topArtistId ??
    (bestArtist && bestArtist.score >= ARTIST_SCORE.prefix ? bestArtist.artist.id : null);
  if (seedArtistId) {
    for (const a of similarArtists(index, seedArtistId, ARTISTS_LIMIT)) {
      if (a.id === topArtistId || artistIds.has(a.id)) continue;
      artistIds.add(a.id);
      artists.push(a);
      if (artists.length >= ARTISTS_LIMIT) break;
    }
  }

  // ---- Similar Songs section ------------------------------------------
  let similarSongs: Song[] = [];
  if (topResult?.type === 'song') {
    similarSongs = takeUnique(
      similarSongsForSong(index, topResult.song, SIMILAR_LIMIT * 3),
      usedSongs,
      SIMILAR_LIMIT,
    );
  } else if (topResult?.type === 'artist') {
    const pool: Song[] = [];
    for (const a of similarArtists(index, topResult.artist.id, 6)) {
      pool.push(...topSongsForArtist(index, a.id, 3));
    }
    similarSongs = takeUnique(pool, usedSongs, SIMILAR_LIMIT);
  }

  // ---- fallback (requirement 10) --------------------------------------
  const hasPrimary = topResult !== null || songsSection.length > 0;
  const isFallback = !hasPrimary;
  let message: string | null = null;
  if (isFallback) {
    message = 'No exact match found. Showing similar songs.';
    const related = virtualSongs.length > 0 ? virtualSongs : trendingSongs(index, 16);
    similarSongs = takeUnique(related, usedSongs, SIMILAR_LIMIT);
  }

  return {
    query,
    topResult,
    songs: songsSection,
    artists,
    playlists: finalPlaylists,
    similarSongs,
    genresMoods,
    lyricsMatches,
    isFallback,
    message,
  };
}
