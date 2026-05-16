import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { PlaylistPicker } from '@/components/PlaylistPicker';
import type { Song } from '@/types';

// Web build of the song context-menu system — a Spotify-style right-click
// menu for desktop. Metro picks the native no-op (SongContextMenu.tsx) on
// iOS/Android. Lean action set (existing APIs only):
//   • Play           → player.playSpecific
//   • Add to Playlist → existing PlaylistPicker modal
//   • Go to Artist    → nav.openArtistProfile

interface MenuState { song: Song; x: number; y: number; }

const Ctx = createContext<{ openSongMenu: (song: Song, x: number, y: number) => void } | null>(null);

export function useSongContextMenu(): { openSongMenu: (song: Song, x: number, y: number) => void } {
  return useContext(Ctx) ?? { openSongMenu: () => {} };
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pickerSongId, setPickerSongId] = useState<string | null>(null);

  const openSongMenu = useCallback((song: Song, x: number, y: number) => {
    setMenu({ song, x, y });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const value = useMemo(() => ({ openSongMenu }), [openSongMenu]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <DesktopContextMenu
        menu={menu}
        onClose={closeMenu}
        onAddToPlaylist={(songId) => { setMenu(null); setPickerSongId(songId); }}
      />
      <PlaylistPicker
        visible={pickerSongId != null}
        songId={pickerSongId}
        onClose={() => setPickerSongId(null)}
      />
    </Ctx.Provider>
  );
}

// Wraps a song card / row and opens the context menu on right-click.
export function RightClickable({ song, children }: { song: Song; children: React.ReactNode }) {
  const { openSongMenu } = useSongContextMenu();
  const ref = useRef<View>(null);

  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    const handler = (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      openSongMenu(song, me.clientX, me.clientY);
    };
    node.addEventListener('contextmenu', handler);
    return () => node.removeEventListener('contextmenu', handler);
  }, [song, openSongMenu]);

  return <View ref={ref}>{children}</View>;
}

function DesktopContextMenu({ menu, onClose, onAddToPlaylist }: {
  menu: MenuState | null;
  onClose: () => void;
  onAddToPlaylist: (songId: string) => void;
}) {
  const player = usePlayer();
  const nav = useAppNav();

  // Dismiss on Escape, scroll, or window resize.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const { song, x, y } = menu;
  const hasArtist = !!song.artist_id;

  // Clamp the menu inside the viewport.
  const MENU_W = 212;
  const MENU_H = hasArtist ? 150 : 104;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(x, winW - MENU_W - 8));
  const top = Math.max(8, Math.min(y, winH - MENU_H - 8));

  return (
    <View style={styles.layer}>
      {/* Backdrop — any click dismisses. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.menu, { left, top, width: MENU_W }]}>
        <MenuItem
          label="Play"
          onPress={() => { void player.playSpecific(song); onClose(); }}
        />
        <MenuItem
          label="Add to Playlist"
          onPress={() => onAddToPlaylist(song.id)}
        />
        {hasArtist ? (
          <MenuItem
            label="Go to Artist"
            onPress={() => {
              if (song.artist_id) nav.openArtistProfile(song.artist_id);
              onClose();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function MenuItem({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
    >
      <Text style={styles.itemLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject, zIndex: 9999 },
  menu: {
    position: 'absolute',
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinumHi,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  },
  itemPressed: { backgroundColor: colors.surfaceHover },
  itemLabel: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.medium,
  },
});
