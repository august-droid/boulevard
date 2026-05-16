import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, metals } from '@/theme';
import { ExploreScreen } from '@/screens/ExploreScreen';
import { LibraryScreen } from '@/screens/LibraryScreen';
import { ProfileScreen } from '@/screens/ProfileScreen';
import { ArtistProfileScreen } from '@/screens/ArtistProfileScreen';
import { PlayerFeedScreen } from '@/screens/PlayerFeedScreen';
import { SearchSheet } from '@/components/SearchSheet';
import type { Tab } from '@/components/BottomNav';
import { DesktopSidebar, DesktopTab } from '@/components/desktop/DesktopSidebar';
import { DesktopTopBar } from '@/components/desktop/DesktopTopBar';
import { DesktopPlayerBar } from '@/components/desktop/DesktopPlayerBar';
import { ContextMenuProvider } from '@/components/desktop/SongContextMenu';

// DesktopShell — the web >=1024px layout. Rendered only by RootNavigator when
// `Platform.OS === 'web' && width >= 1024`; native and mobile-web never mount
// it, so this whole tree is desktop-web only.
//
// It owns no navigation state — RootNavigator stays the single source of
// truth and passes the same `tab` / `playerOpen` / artist-stack state used by
// the mobile shell. The content screens are reused as-is; only the chrome
// (sidebar, top bar, persistent player bar) is desktop-specific.
//
// Layout:
//   ┌─────────┬───────────────────────┐
//   │ sidebar │ top bar               │
//   │         ├───────────────────────┤
//   │         │ content (screens)     │
//   ├─────────┴───────────────────────┤
//   │ persistent player bar           │
//   └──────────────────────────────────┘
// The full-player overlay covers everything; the artist overlay covers only
// the content region, so the sidebar + player bar stay put — desktop-style.

const CONTENT_TABS: DesktopTab[] = ['explore', 'library', 'profile'];

interface Props {
  tab: DesktopTab;
  mountedTabs: Set<DesktopTab>;
  onTabChange: (tab: Tab) => void;
  playerOpen: boolean;
  onOpenPlayer: () => void;
  onClosePlayer: () => void;
  topArtistId: string | null;
  onCloseArtist: () => void;
}

export function DesktopShell({
  tab, mountedTabs, onTabChange, playerOpen,
  onOpenPlayer, onClosePlayer, topArtistId, onCloseArtist,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <ContextMenuProvider>
      <View style={styles.root}>
      <View style={styles.body}>
        <DesktopSidebar
          activeTab={tab}
          playerActive={playerOpen}
          onSelectTab={onTabChange}
          onOpenSearch={() => setSearchOpen(true)}
        />

        <View style={styles.main}>
          <DesktopTopBar
            onOpenSearch={() => setSearchOpen(true)}
            onOpenProfile={() => onTabChange('profile')}
          />

          {/* Content region — every visited screen stays mounted; inactive
              ones are an absolute transparent layer so their scroll position
              survives navigation (display:none would reset scrollTop). */}
          <View style={styles.content}>
            {CONTENT_TABS.map((t) =>
              mountedTabs.has(t) ? (
                <View
                  key={t}
                  style={tab === t ? styles.tabActive : styles.tabHidden}
                  pointerEvents={tab === t ? 'auto' : 'none'}
                >
                  {t === 'explore' && <ExploreScreen />}
                  {t === 'library' && <LibraryScreen />}
                  {t === 'profile' && <ProfileScreen />}
                </View>
              ) : null,
            )}

            {/* Artist page — covers only the content region; sidebar + player
                bar stay visible (desktop behavior). */}
            {topArtistId ? (
              <View style={styles.artistOverlay}>
                <ArtistProfileScreen
                  key={topArtistId}
                  artistId={topArtistId}
                  onBack={onCloseArtist}
                />
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* Persistent player bar — hidden only while the full player is open. */}
      {!playerOpen ? <DesktopPlayerBar onOpenPlayer={onOpenPlayer} /> : null}

      {/* Full-player overlay — full-window takeover, above everything. */}
      {playerOpen ? (
        <View style={styles.playerOverlay}>
          <PlayerFeedScreen onDismiss={onClosePlayer} />
        </View>
      ) : null}

      <SearchSheet visible={searchOpen} onClose={() => setSearchOpen(false)} />
      </View>
    </ContextMenuProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, flexDirection: 'row' },
  main: { flex: 1, flexDirection: 'column' },
  content: { flex: 1, backgroundColor: colors.bg },
  // Active screen fills the content region; inactive screens stay laid out
  // (absolute + transparent) so their scroll offset is preserved.
  tabActive: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  tabHidden: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
  artistOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: metals.platinum,
  },
  playerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
  },
});
