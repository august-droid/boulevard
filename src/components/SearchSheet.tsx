import React, { useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, FlatList, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, PlayContext } from '@/contexts/PlayerContext';
import { Song } from '@/types';
import { SongRow } from '@/components/SongRow';
import { SearchIcon } from '@/components/Icon';

// Lightweight catalog search opened from the Explore header. Filters the live
// catalog by title / artist / genre. Tapping a result plays it immediately and
// closes the sheet — search playback is a manual, intentional choice, so it is
// never filtered by the 24h discovery anti-repeat.

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function SearchSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const [query, setQuery] = useState('');

  const results = useMemo<Song[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return player.catalog
      .filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          (s.artist_name ?? '').toLowerCase().includes(q) ||
          s.genre.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [query, player.catalog]);

  const playAndClose = (s: Song) => {
    const q = query.trim();
    // A query that exactly names a catalog genre is genre intent ("enter a
    // genre lane" → genre_focus); anything else is a manual search whose
    // results should feel intentional (→ search_focus: high relevance, low
    // novelty). Either way the contextual-session engine activates before
    // playback so the queue tail follows the intent.
    const isGenreQuery =
      q.length > 0 && player.catalog.some((c) => c.genre.toLowerCase() === q.toLowerCase());
    const context: PlayContext = isGenreQuery
      ? {
          sessionMode: 'genre_focus',
          sessionAnchor: { genre: s.genre, label: q, refSongs: [s] },
        }
      : {
          sessionMode: 'search_focus',
          sessionAnchor: {
            genre: s.genre,
            artistId: s.artist_id ?? null,
            anchorMicrotags: s.microtags,
            label: q || s.title,
            refSongs: [s],
          },
        };
    void player.playSpecific(s, context);
    setQuery('');
    onClose();
  };

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.bar}>
          <View style={styles.field}>
            <SearchIcon size={18} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search songs and artists"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
        <FlatList
          data={results}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <SongRow
              song={item}
              subtitle={item.artist_name ?? item.genre}
              onPress={() => playAndClose(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {query.trim().length === 0
                  ? 'Search for any song or artist.'
                  : 'No matches.'}
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
  empty: { paddingTop: spacing.xxl, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: fonts.size.sm },
});
