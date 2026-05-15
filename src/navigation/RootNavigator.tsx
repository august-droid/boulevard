import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme';
import { PlayerFeedScreen } from '@/screens/PlayerFeedScreen';
import { ExploreScreen } from '@/screens/ExploreScreen';
import { LibraryScreen } from '@/screens/LibraryScreen';
import { ProfileScreen } from '@/screens/ProfileScreen';
import { BottomNav, Tab } from '@/components/BottomNav';
import { MiniPlayer } from '@/components/MiniPlayer';
import { PaywallScreen } from '@/screens/PaywallScreen';
import { SignupSheet } from '@/screens/SignupSheet';
import { ArtistProfileScreen } from '@/screens/ArtistProfileScreen';
import { useAuth } from '@/contexts/AuthContext';
import { NavigationProvider } from '@/contexts/NavigationContext';

// Gating model:
//   1) No signup required to start. The first launch creates an anonymous
//      Supabase session so likes, saves, and the recommender all work.
//   2) After 5 full listens (90% completion), we surface SignupSheet to
//      offer email / Apple / Google / TikTok / Facebook. The sheet only
//      fires once per user; "Maybe later" sets the marker.
//   3) After 10 full listens, the paywall fires. That is the only hard
//      gate. The 3-day free trial doubles as the upgrade flow.
//   4) Premium bypasses the cap entirely.

export function RootNavigator() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  // Default tab depends on personalization state:
  //   • Pre-unlock (<20 songs heard): Explore. The user is still teaching the
  //     recommender, so the discovery surface is the most useful landing.
  //   • Post-unlock: Library. Their personalized playlists are the prize
  //     they unlocked, so we land on it directly.
  // AuthProvider hydrates from AsyncStorage asynchronously, so the lazy
  // initializer will see `personalizationUnlockedAt: null` on cold start
  // even for returning unlocked users. We re-route once hydration finishes
  // — but only if the user hasn't manually navigated yet.
  const [tab, setTab] = useState<Tab>('explore');
  // The non-home tab the user was on before opening the full-screen player.
  // Used to send them back when they tap the chevron or swipe down.
  const [previousNonHomeTab, setPreviousNonHomeTab] = useState<Tab>('explore');
  const [userHasNavigated, setUserHasNavigated] = useState(false);
  // Lazy-mount tabs on first visit, then keep them mounted with their
  // scroll position, loaded items and feed state intact. Tab switching
  // uses `display: 'none'` (RN preserves component state when display is
  // none) instead of unmount/remount. This is what fixes the "open the
  // player from Explore, dismiss, you're back at the top of Explore" bug.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(['explore']));
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  // Artist profile stack. Push on openArtistProfile, pop on
  // closeArtistProfile. The top of the stack renders above the active
  // tab; MiniPlayer + BottomNav stay docked because they're rendered at
  // the root of this navigator, not inside the stack.
  const [artistStack, setArtistStack] = useState<string[]>([]);

  // Once AuthProvider populates personalizationUnlockedAt from AsyncStorage,
  // route the user to Library if they're already unlocked AND haven't yet
  // manually tapped a tab. Won't fire again after the user touches the nav.
  useEffect(() => {
    if (userHasNavigated) return;
    if (auth.personalizationUnlockedAt && tab !== 'library') {
      setTab('library');
    }
  }, [auth.personalizationUnlockedAt, userHasNavigated, tab]);

  const handleTabChange = (next: Tab) => {
    setUserHasNavigated(true);
    // Remember the tab the user came from so the player can return to it
    // when dismissed.
    if (next === 'home' && tab !== 'home') {
      setPreviousNonHomeTab(tab);
    }
    // Mark the destination tab as visited so it gets mounted once and
    // then preserved across future tab switches.
    setVisitedTabs((prev) => {
      if (prev.has(next)) return prev;
      const out = new Set(prev);
      out.add(next);
      return out;
    });
    setTab(next);
  };

  // Premium paywall — fires when the 10-full-listens cap is hit. Re-fires
  // whenever `blockedAttempts` increments so that after the user dismisses
  // the paywall and tries to play again, the paywall comes back instead of
  // silently failing.
  useEffect(() => {
    if (auth.isPremium) return;
    if (paywallOpen) return;
    if (!auth.completedLimitHit) return;
    setPaywallOpen(true);
    void auth.markPaywallShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.completedLimitHit, auth.isPremium, auth.blockedAttempts]);

  // Signup prompt — fires once when the user crosses 5 full listens AND
  // is still anonymous AND we haven't already shown the sheet. The
  // paywall always wins if both would fire simultaneously.
  useEffect(() => {
    if (signupOpen || paywallOpen) return;
    if (!auth.isAnonymous) return;
    if (auth.signupPromptShownAt) return;
    if (auth.completedCount < 5) return;
    if (auth.completedLimitHit) return;  // paywall handles 10
    setSignupOpen(true);
  }, [
    auth.completedCount, auth.isAnonymous, auth.signupPromptShownAt,
    auth.completedLimitHit, signupOpen, paywallOpen,
  ]);

  // Bottom nav height (approx) — used to push the MiniPlayer up by the right amount.
  const NAV_HEIGHT = 56 + Math.max(insets.bottom, 8);

  // Home tab is the full now-playing screen, so the mini player would be
  // redundant there. On every other tab we float it just above the nav.
  const showMini = tab !== 'home' && Boolean(auth.userId);

  // Open-player handler — Explore + Library + MiniPlayer all use this to
  // surface the full now-playing view after a tap. Memoized so the
  // NavigationProvider's value reference is stable across renders.
  const openPlayer = React.useCallback(() => handleTabChange('home'), [tab]);
  // Open-signup handler — the comments composer calls this when an
  // anonymous user taps a gated social action.
  const openSignup = React.useCallback(() => setSignupOpen(true), []);
  // Artist profile stack handlers. Push lets the user drill into similar
  // artists from inside an artist page; pop walks back through the stack.
  // No-op when the same artist is already on top so accidental double
  // taps from a song row don't double-stack.
  const openArtistProfile = React.useCallback((artistId: string) => {
    if (!artistId) return;
    setArtistStack((prev) => (prev[prev.length - 1] === artistId ? prev : [...prev, artistId]));
  }, []);
  const closeArtistProfile = React.useCallback(() => {
    setArtistStack((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
  }, []);

  const topArtistId = artistStack[artistStack.length - 1] ?? null;

  return (
    <NavigationProvider
      openPlayer={openPlayer}
      openSignup={openSignup}
      openArtistProfile={openArtistProfile}
      closeArtistProfile={closeArtistProfile}
    >
      <View style={styles.root}>
        <View style={styles.screen}>
          {/* Tab screens are LAZY-MOUNTED on first visit and then kept
              mounted forever, with `display: 'none'` hiding the inactive
              ones. React Native preserves component state under
              display:none, so the user's scroll position, FlatList
              window, loaded recommendations, search input, etc. survive
              opening the player and coming back. The active screen is
              the only one in layout — inactive screens occupy zero
              space and receive no touch events. */}
          {visitedTabs.has('home') && (
            <View style={[StyleSheet.absoluteFill, { display: tab === 'home' ? 'flex' : 'none' }]}>
              <PlayerFeedScreen onDismiss={() => handleTabChange(previousNonHomeTab)} />
            </View>
          )}
          {visitedTabs.has('explore') && (
            <View style={[StyleSheet.absoluteFill, { display: tab === 'explore' ? 'flex' : 'none' }]}>
              <ExploreScreen />
            </View>
          )}
          {visitedTabs.has('library') && (
            <View style={[StyleSheet.absoluteFill, { display: tab === 'library' ? 'flex' : 'none' }]}>
              <LibraryScreen />
            </View>
          )}
          {visitedTabs.has('profile') && (
            <View style={[StyleSheet.absoluteFill, { display: tab === 'profile' ? 'flex' : 'none' }]}>
              <ProfileScreen />
            </View>
          )}
        </View>
        {/* Artist profile overlay — sits above the tab content but below
            the docked mini-player and bottom nav so playback controls
            remain visible while browsing an artist. The stack lives in
            this navigator so similar-artist taps can push deeper. */}
        {topArtistId ? (
          <View style={styles.artistOverlay} pointerEvents="box-none">
            <ArtistProfileScreen
              key={topArtistId}
              artistId={topArtistId}
              onBack={closeArtistProfile}
            />
          </View>
        ) : null}
        {showMini && (
          <MiniPlayer
            onPress={openPlayer}
            bottomOffset={NAV_HEIGHT + 6}
          />
        )}
        <BottomNav active={tab} onChange={handleTabChange} />
        <PaywallScreen
          visible={paywallOpen}
          onClose={() => setPaywallOpen(false)}
          onOpenSignIn={() => {
            // Close the paywall first so the SignupSheet slides up cleanly
            // over a single surface instead of stacking modals.
            setPaywallOpen(false);
            setSignupOpen(true);
          }}
        />
        <SignupSheet
          visible={signupOpen}
          onClose={() => {
            setSignupOpen(false);
            void auth.markSignupPromptShown();
          }}
        />
      </View>
    </NavigationProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  screen: { flex: 1 },
  // Artist overlay covers the tab content but stops short of the docked
  // MiniPlayer + BottomNav (those float above this layer thanks to render
  // order). Background is the bg color so the underlying tab does not
  // bleed through during scroll.
  artistOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
  },
});
