import React, { useMemo } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { ExploreIcon, LibraryIcon, ProfileIcon, SearchIcon } from '@/components/Icon';
import { usePlaylists, UserPlaylist } from '@/contexts/PlaylistsContext';
import { usePlayer } from '@/contexts/PlayerContext';
import { songArtworkUri } from '@/lib/artwork';
import type { Song } from '@/types';

// Desktop-only left sidebar navigation + playlists. Rendered exclusively by
// DesktopShell, which only mounts for web at >=1024px — so this file never
// affects native or mobile-web layout.

export type DesktopTab = 'explore' | 'library' | 'profile';

interface Props {
  activeTab: DesktopTab;
  /** True while the full-player overlay is open — dims the tab highlight. */
  playerActive: boolean;
  onSelectTab: (tab: DesktopTab) => void;
  onOpenSearch: () => void;
}

export function DesktopSidebar({ activeTab, playerActive, onSelectTab, onOpenSearch }: Props) {
  const { playlists, create } = usePlaylists();
  const player = usePlayer();
  const catalog = player.catalog;

  // Resolve a playlist's song ids against the live catalog, then play it.
  const playPlaylist = useMemo(() => (pl: UserPlaylist) => {
    if (catalog.length === 0) return;
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const songs = pl.song_ids.map((id) => byId.get(id)).filter((s): s is Song => !!s);
    if (songs.length > 0) void player.playPlaylist(songs);
  }, [catalog, player]);

  return (
    <View style={styles.wrap}>
      <View style={styles.brand}>
        {/* Same Boulevard mark the native app uses (assets/icon.png). */}
        <Image
          source={require('../../../assets/icon.png')}
          style={styles.brandMark}
          contentFit="contain"
        />
        <Text style={styles.brandWord}>BOULEVARD</Text>
      </View>

      <View style={styles.nav}>
        <NavItem
          label="Explore"
          Icon={ExploreIcon}
          active={!playerActive && activeTab === 'explore'}
          onPress={() => onSelectTab('explore')}
        />
        <NavItem
          label="Search"
          Icon={SearchIcon}
          active={false}
          onPress={onOpenSearch}
        />
        <NavItem
          label="Library"
          Icon={LibraryIcon}
          active={!playerActive && activeTab === 'library'}
          onPress={() => onSelectTab('library')}
        />
        <NavItem
          label="Profile"
          Icon={ProfileIcon}
          active={!playerActive && activeTab === 'profile'}
          onPress={() => onSelectTab('profile')}
        />
      </View>

      <View style={styles.divider} />

      {/* Playlists. Tapping a playlist plays it; "+" creates a new one
          straight away and it appears in this list. */}
      <View style={styles.plHeader}>
        <Text style={styles.plHeaderText}>PLAYLISTS</Text>
        <Pressable
          onPress={() => { void create(`My Playlist #${playlists.length + 1}`); }}
          hitSlop={8}
          style={({ pressed }) => [styles.plAdd, pressed && styles.plAddPressed]}
          accessibilityLabel="New playlist"
        >
          <Text style={styles.plAddText}>+</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.plList} contentContainerStyle={styles.plListContent} showsVerticalScrollIndicator={false}>
        {playlists.length === 0 ? (
          <Text style={styles.plEmpty}>
            Your playlists appear here. Tap + to make one.
          </Text>
        ) : (
          playlists.map((pl) => (
            <PlaylistRow
              key={pl.id}
              playlist={pl}
              catalog={catalog}
              onPress={() => playPlaylist(pl)}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.footerText}>AI music, made for you.</Text>
      </View>
    </View>
  );
}

interface NavItemProps {
  label: string;
  Icon: typeof ExploreIcon;
  active: boolean;
  onPress: () => void;
}

function NavItem({ label, Icon, active, onPress }: NavItemProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.item,
        active && styles.itemActive,
        pressed && styles.itemPressed,
      ]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      {active && <View style={styles.activeBar} />}
      <Icon size={21} color={active ? metals.goldSolidHi : colors.textMuted} filled={active} />
      <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function PlaylistRow({ playlist, catalog, onPress }: {
  playlist: UserPlaylist;
  catalog: Song[];
  onPress: () => void;
}) {
  const coverUri = useMemo(() => {
    if (!playlist.cover_song_id) return null;
    const song = catalog.find((s) => s.id === playlist.cover_song_id);
    return song ? songArtworkUri(song) : null;
  }, [playlist.cover_song_id, catalog]);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.plRow, pressed && styles.itemPressed]}
      accessibilityLabel={`Play playlist ${playlist.name}`}
    >
      <View style={styles.plCover}>
        {coverUri ? (
          <Image source={{ uri: coverUri }} style={styles.plCoverImg} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <Text style={styles.plCoverFallback}>{playlist.name.charAt(0).toUpperCase()}</Text>
        )}
      </View>
      <View style={styles.plMeta}>
        <Text style={styles.plName} numberOfLines={1}>{playlist.name}</Text>
        <Text style={styles.plCount} numberOfLines={1}>
          {playlist.song_count} {playlist.song_count === 1 ? 'song' : 'songs'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 232,
    backgroundColor: '#0c0c0f',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: metals.platinum,
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.lg,
  },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 9,
  },
  brandWord: {
    color: metals.goldSolid,
    fontSize: 15,
    fontWeight: fonts.weight.bold,
    letterSpacing: 4,
    opacity: 0.92,
  },
  nav: { gap: 4 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 11,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  itemActive: {
    backgroundColor: colors.surface,
  },
  itemPressed: {
    backgroundColor: colors.surfaceHover,
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderRadius: 2,
    backgroundColor: metals.goldSolidHi,
  },
  itemLabel: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.1,
  },
  itemLabelActive: {
    color: colors.text,
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: metals.platinum,
    marginVertical: spacing.md,
    marginHorizontal: spacing.sm,
  },

  // ---- Playlists ----
  plHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  plHeaderText: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1.6,
  },
  plAdd: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  plAddPressed: { backgroundColor: colors.surfaceHover },
  plAddText: {
    color: colors.textMuted,
    fontSize: 17,
    fontWeight: fonts.weight.bold,
    lineHeight: 19,
  },
  plList: { flex: 1 },
  plListContent: { paddingVertical: spacing.xs },
  plEmpty: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    lineHeight: 17,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  plRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  plCover: {
    width: 38,
    height: 38,
    borderRadius: 6,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  plCoverImg: { width: '100%', height: '100%' },
  plCoverFallback: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
  },
  plMeta: { flex: 1, minWidth: 0 },
  plName: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
  },
  plCount: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: 1,
  },

  footer: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  footerText: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    letterSpacing: 0.2,
  },
});
