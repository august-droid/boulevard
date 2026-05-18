import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, SectionList, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, PlayContext } from '@/contexts/PlayerContext';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { Song } from '@/types';
import { SongRow } from '@/components/SongRow';
import { SearchIcon } from '@/components/Icon';
import { songArtworkUri } from '@/lib/artwork';
import { buildSearchIndex, type IndexedArtist } from '@/lib/search/searchIndex';
import {
  runSearch,
  type PlaylistHit,
  type GenreMoodHit,
  type TopResult,
} from '@/lib/search/searchEngine';
import { SESSION_WORLDS, worldToAnchor } from '@/lib/recommendation/SessionContext';
import { CHIP_MOODS } from '@/lib/mood/moodCatalog';

// Boulevard search — a discovery engine, not a title filter.
//
// The query and every indexed field are normalized (lowercase, apostrophe-
// and punctuation-insensitive) so "Don't Text First", "dont text first" and
// "dont text" all resolve to the same song. Results are ranked across title /
// artist / lyrics / genre / mood / tags and grouped into sections. Playback
// from search is an intentional choice, so each tap activates a contextual
// session (search / mood / genre) and logs a `searched` event for
// personalization. Input is debounced; matching runs over a pre-normalized
// index so it stays fast as the catalog grows.

interface Props {
  visible: boolean;
  onClose: () => void;
}

const DEBOUNCE_MS = 180;

type Row =
  | { kind: 'top'; top: TopResult }
  | { kind: 'song'; song: Song }
  | { kind: 'lyric'; song: Song }
  | { kind: 'artist'; artist: IndexedArtist }
  | { kind: 'playlist'; playlist: PlaylistHit }
  | { kind: 'genremood'; entry: GenreMoodHit };

export function SearchSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const { playlists: userPlaylists } = usePlaylists();
  const nav = useAppNav();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // Debounce the query so each keystroke doesn't trigger a full scan.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // One normalized index per catalog — every keystroke scans pre-normalized
  // strings, never re-lowercasing the catalog.
  const index = useMemo(() => buildSearchIndex(player.catalog), [player.catalog]);

  const playlistInput = useMemo(
    () => userPlaylists.map((p) => ({ id: p.id, name: p.name, song_ids: p.song_ids })),
    [userPlaylists],
  );

  const results = useMemo(
    () => runSearch(debounced, index, { worlds: SESSION_WORLDS, moods: CHIP_MOODS, userPlaylists: playlistInput }),
    [debounced, index, playlistInput],
  );

  const close = () => {
    setQuery('');
    setDebounced('');
    onClose();
  };

  // ---- tap handlers ----------------------------------------------------

  const playSong = (song: Song) => {
    player.recordSearchHit(song);
    const context: PlayContext = {
      sessionMode: 'search_focus',
      sessionAnchor: {
        genre: song.genre,
        artistId: song.artist_id ?? null,
        anchorMicrotags: song.microtags,
        label: results.query || song.title,
        refSongs: [song],
      },
    };
    void player.playSpecific(song, context);
    close();
  };

  const openArtist = (artist: IndexedArtist) => {
    nav.openArtistProfile(artist.id);
    close();
  };

  const playPlaylist = (pl: PlaylistHit) => {
    if (pl.songs.length === 0) return;
    player.recordSearchHit(pl.songs[0]);
    let context: PlayContext;
    if (pl.kind === 'world' && pl.world) {
      context = { sessionMode: 'mood_focus', sessionAnchor: worldToAnchor(pl.world) };
    } else if (pl.kind === 'mood' && pl.mood) {
      context = {
        sessionMode: 'mood_focus',
        sessionAnchor: {
          moodId: pl.mood.id,
          label: pl.title,
          anchorMicrotags: pl.mood.microtags,
          anchorMoodWords: pl.mood.moodWords,
        },
      };
    } else if (pl.kind === 'user') {
      context = { sessionMode: 'playlist_focus', sessionAnchor: { label: pl.title, refSongs: [pl.songs[0]] } };
    } else {
      context = { sessionMode: 'search_focus', sessionAnchor: { label: pl.title, refSongs: [pl.songs[0]] } };
    }
    void player.playPlaylist(pl.songs, context);
    close();
  };

  const playGenreMood = (entry: GenreMoodHit) => {
    if (entry.songs.length === 0) return;
    player.recordSearchHit(entry.songs[0]);
    const context: PlayContext =
      entry.kind === 'genre'
        ? {
            sessionMode: 'genre_focus',
            sessionAnchor: { genre: entry.genreValue, label: entry.label, refSongs: [entry.songs[0]] },
          }
        : {
            sessionMode: 'mood_focus',
            sessionAnchor: {
              moodId: entry.mood?.id ?? null,
              label: entry.label,
              anchorMicrotags: entry.mood?.microtags,
              anchorMoodWords: entry.mood?.moodWords,
            },
          };
    void player.playPlaylist(entry.songs, context);
    close();
  };

  // ---- sections --------------------------------------------------------

  const sections = useMemo(() => {
    const out: { title: string; data: Row[] }[] = [];
    if (results.topResult) out.push({ title: 'Top Result', data: [{ kind: 'top', top: results.topResult }] });
    if (results.songs.length > 0)
      out.push({ title: 'Songs', data: results.songs.map((s) => ({ kind: 'song', song: s }) as Row) });
    if (results.artists.length > 0)
      out.push({ title: 'Artists', data: results.artists.map((a) => ({ kind: 'artist', artist: a }) as Row) });
    if (results.playlists.length > 0)
      out.push({ title: 'Playlists', data: results.playlists.map((p) => ({ kind: 'playlist', playlist: p }) as Row) });
    if (results.similarSongs.length > 0)
      out.push({ title: 'Similar Songs', data: results.similarSongs.map((s) => ({ kind: 'song', song: s }) as Row) });
    if (results.genresMoods.length > 0)
      out.push({ title: 'Genres & Moods', data: results.genresMoods.map((e) => ({ kind: 'genremood', entry: e }) as Row) });
    if (results.lyricsMatches.length > 0)
      out.push({ title: 'Lyrics Matches', data: results.lyricsMatches.map((s) => ({ kind: 'lyric', song: s }) as Row) });
    return out;
  }, [results]);

  if (!visible) return null;

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'top': {
        const top = row.top;
        if (top.type === 'song')
          return <SongRow song={top.song} subtitle={top.song.artist_name ?? top.song.genre} onPress={() => playSong(top.song)} />;
        if (top.type === 'artist')
          return <ArtistRow artist={top.artist} onPress={() => openArtist(top.artist)} />;
        return <PlaylistRow playlist={top.playlist} onPress={() => playPlaylist(top.playlist)} />;
      }
      case 'song':
        return <SongRow song={row.song} subtitle={row.song.artist_name ?? row.song.genre} onPress={() => playSong(row.song)} />;
      case 'lyric':
        return (
          <SongRow
            song={row.song}
            subtitle={`Lyrics · ${row.song.artist_name ?? row.song.genre}`}
            onPress={() => playSong(row.song)}
          />
        );
      case 'artist':
        return <ArtistRow artist={row.artist} onPress={() => openArtist(row.artist)} />;
      case 'playlist':
        return <PlaylistRow playlist={row.playlist} onPress={() => playPlaylist(row.playlist)} />;
      case 'genremood':
        return <GenreMoodRow entry={row.entry} onPress={() => playGenreMood(row.entry)} />;
    }
  };

  const rowKey = (row: Row, i: number): string => {
    switch (row.kind) {
      case 'top': return 'top';
      case 'song': return `song_${row.song.id}`;
      case 'lyric': return `lyric_${row.song.id}`;
      case 'artist': return `artist_${row.artist.id}`;
      case 'playlist': return `pl_${row.playlist.id}`;
      case 'genremood': return `gm_${row.entry.id}`;
      default: return `row_${i}`;
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.bar}>
          <View style={styles.field}>
            <SearchIcon size={18} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Songs, artists, lyrics, moods…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
          <Pressable onPress={close} hitSlop={10} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
        <SectionList
          sections={sections}
          keyExtractor={rowKey}
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          renderItem={({ item }) => renderRow(item)}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          ListHeaderComponent={
            results.isFallback && results.message ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText}>{results.message}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {query.trim().length === 0
                  ? 'Search songs, artists, lyrics, genres and moods.'
                  : 'No results yet. Try a different word.'}
              </Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </Modal>
  );
}

// ---- rows --------------------------------------------------------------

function ArtistRow({ artist, onPress }: { artist: IndexedArtist; onPress: () => void }) {
  const subtitle = artist.primaryGenre
    ? `Artist · ${artist.primaryGenre}`
    : `Artist · ${artist.songCount} song${artist.songCount === 1 ? '' : 's'}`;
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Image
        source={{ uri: artist.imageUrl ?? undefined }}
        style={[styles.cover, styles.coverCircle]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        recyclingKey={artist.id}
      />
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>{artist.name}</Text>
        <Text style={styles.sub} numberOfLines={1}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

function PlaylistRow({ playlist, onPress }: { playlist: PlaylistHit; onPress: () => void }) {
  const cover = playlist.songs[0] ? songArtworkUri(playlist.songs[0]) : undefined;
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Image
        source={{ uri: cover ?? undefined }}
        style={styles.cover}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        recyclingKey={playlist.id}
      />
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>{playlist.title}</Text>
        <Text style={styles.sub} numberOfLines={1}>{playlist.subtitle}</Text>
      </View>
    </Pressable>
  );
}

function GenreMoodRow({ entry, onPress }: { entry: GenreMoodHit; onPress: () => void }) {
  const cover = entry.songs[0] ? songArtworkUri(entry.songs[0]) : undefined;
  const subtitle = `${entry.kind === 'genre' ? 'Genre' : 'Mood'} · ${entry.songs.length} song${
    entry.songs.length === 1 ? '' : 's'
  }`;
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Image
        source={{ uri: cover ?? undefined }}
        style={styles.cover}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        recyclingKey={entry.id}
      />
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>{entry.label}</Text>
        <Text style={styles.sub} numberOfLines={1}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  input: { flex: 1, color: colors.text, fontSize: fonts.size.md, padding: 0 },
  cancel: { paddingVertical: 6 },
  cancelText: { color: metals.goldHi, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  sectionHeader: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bg,
  },
  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  bannerText: { color: colors.textMuted, fontSize: fonts.size.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  cover: { width: 48, height: 48, borderRadius: radii.sm, backgroundColor: colors.surface },
  coverCircle: { borderRadius: 24 },
  meta: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  sub: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 2 },
  empty: { paddingTop: spacing.xxl, alignItems: 'center', paddingHorizontal: spacing.xl },
  emptyText: { color: colors.textMuted, fontSize: fonts.size.sm, textAlign: 'center' },
});
