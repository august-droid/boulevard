import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
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
import { NavigationProvider, SignupReason } from '@/contexts/NavigationContext';
import { DesktopShell } from '@/components/desktop/DesktopShell';
import { MediaSessionBridge } from '@/components/MediaSessionBridge';
import { FirstListenerModal } from '@/components/FirstListenerModal';
import { ListenMoreModal } from '@/components/ListenMoreModal';

// Gating model:
//   1) No signup required to start. The first launch creates an anonymous
//      Supabase session so likes, saves, and the recommender all work.
//   2) After 5 full listens (90% completion), we surface SignupSheet to
//      offer email / Apple / Google / TikTok / Facebook. The sheet only
//      fires once per user; "Maybe later" sets the marker.
//   3) After 10 full listens, the paywall fires. That is the only hard
//      gate. The 3-day free trial doubles as the upgrade flow.
//   4) Premium bypasses the cap entirely.

// The content tabs — everything except the player. The player is no longer
// a tab: it opens as a full-screen overlay layered ABOVE whatever the user
// was doing. That keeps the underlying content screen mounted, so its
// FlatList / ScrollView scroll position is never destroyed when the player
// opens or closes.
type ContentTab = Exclude<Tab, 'home'>;
const CONTENT_TABS: ContentTab[] = ['explore', 'library', 'profile'];

export function RootNavigator() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // Default content tab depends on personalization state:
  //   • Pre-unlock (<20 songs heard): Explore. The user is still teaching the
  //     recommender, so the discovery surface is the most useful landing.
  //   • Post-unlock: Library. Their personalized playlists are the prize
  //     they unlocked, so we land on it directly.
  // AuthProvider hydrates from AsyncStorage asynchronously, so the lazy
  // initializer will see `personalizationUnlockedAt: null` on cold start
  // even for returning unlocked users. We re-route once hydration finishes
  // — but only if the user hasn't manually navigated yet.
  const [tab, setTab] = useState<ContentTab>('explore');
  // Content tabs are mounted lazily on first visit and then kept mounted for
  // the lifetime of the app. Inactive tabs are hidden (display:none) rather
  // than unmounted, so a deep-scrolled FlatList / ScrollView keeps its exact
  // scroll position when the user opens the player or switches tabs.
  const [mountedTabs, setMountedTabs] = useState<Set<ContentTab>>(() => new Set<ContentTab>(['explore']));
  // The full-screen player overlay. Independent of `tab`: opening it does
  // NOT switch or unmount the content tab (or the artist page) underneath.
  // On web the listener lands straight in the player — /listen opens on the
  // now-playing surface with music armed to start (see PlayerContext). Native
  // still opens on a content tab.
  const [playerOpen, setPlayerOpen] = useState(Platform.OS === 'web');
  const [userHasNavigated, setUserHasNavigated] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  // The gated action that triggered the SignupSheet, so the sheet can name
  // it ("you need an account to like songs"). Null for nudge / gate opens.
  const [signupReason, setSignupReason] = useState<SignupReason | null>(null);
  // Artist profile stack. Push on openArtistProfile, pop on
  // closeArtistProfile. The top of the stack renders above the active
  // tab; MiniPlayer + BottomNav stay docked because they're rendered at
  // the root of this navigator, not inside the stack.
  const [artistStack, setArtistStack] = useState<string[]>([]);

  // Once AuthProvider populates personalizationUnlockedAt from AsyncStorage,
  // route the user to Library if they're already unlocked AND haven't yet
  // manually tapped a tab. Won't fire again after the user touches the nav.
  // Native only — on web the listener lands in the player and the surface
  // underneath stays Explore until they navigate there themselves.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (userHasNavigated) return;
    if (auth.personalizationUnlockedAt && tab !== 'library') {
      setTab('library');
      setMountedTabs((prev) => {
        if (prev.has('library')) return prev;
        const next = new Set(prev);
        next.add('library');
        return next;
      });
    }
  }, [auth.personalizationUnlockedAt, userHasNavigated, tab]);

  // Web — when a sign-in / sign-up completes, land the listener on Explore
  // and close the launch player overlay. `justSignedIn` covers both logging
  // into an existing account and creating a new one. Native keeps its own
  // post-auth flow untouched.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!auth.justSignedIn) return;
    setUserHasNavigated(true);
    setPlayerOpen(false);
    setMountedTabs((prev) => {
      if (prev.has('explore')) return prev;
      const next = new Set(prev);
      next.add('explore');
      return next;
    });
    setTab('explore');
  }, [auth.justSignedIn]);

  const handleTabChange = (next: Tab) => {
    setUserHasNavigated(true);
    // The Home tab button opens the player overlay. It deliberately does NOT
    // change the content tab, so dismissing the player returns the user to
    // the exact screen + scroll position they were on.
    if (next === 'home') {
      setPlayerOpen(true);
      return;
    }
    // A real content tab: close the player overlay and switch. Mount the
    // tab on first visit, then keep it mounted forever.
    setPlayerOpen(false);
    setMountedTabs((prev) => {
      if (prev.has(next)) return prev;
      const updated = new Set(prev);
      updated.add(next);
      return updated;
    });
    setTab(next);
  };

  // Premium paywall — fires when the 10-full-listens cap is hit. Re-fires
  // whenever `blockedAttempts` increments so that after the user dismisses
  // the paywall and tries to play again, the paywall comes back instead of
  // silently failing. Native only — the web app has no paywall.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (auth.isPremium) return;
    if (paywallOpen) return;
    if (!auth.completedLimitHit) return;
    setPaywallOpen(true);
    void auth.markPaywallShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.completedLimitHit, auth.isPremium, auth.blockedAttempts]);

  // Signup prompt — fires once when the user crosses 5 full listens AND
  // is still anonymous AND we haven't already shown the sheet. The
  // paywall always wins if both would fire simultaneously. Native only —
  // on web the login gate below replaces this completion-based prompt.
  useEffect(() => {
    if (Platform.OS === 'web') return;
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

  // Web login gate — the web app has no paywall. After 5 plays an anonymous
  // listener must sign in to continue. PlayerContext's checkWebGate blocks
  // the 6th play and bumps `blockedAttempts`; we open the sign-in sheet in
  // response. Driven by the blocked-play event (not the raw play count) so
  // the 5th song is never interrupted mid-listen. Re-fires on every blocked
  // attempt so a dismissed sheet reopens on the next play tap.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!auth.webLoginRequired) return;
    if (auth.blockedAttempts === 0) return;
    if (signupOpen) return;
    setSignupOpen(true);
  }, [auth.blockedAttempts, auth.webLoginRequired, signupOpen]);

  // Web only — a gentle, one-time "log in" nudge shortly after the app opens.
  // It is NOT a gate: the sheet is dismissible (webLoginRequired is false here,
  // so `mandatory` is false) and the listener can keep browsing anonymously.
  // signupPromptShownAt persists, so the nudge fires once per device, ever;
  // the top-bar "Log in" button is the always-available path after that.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!auth.isAnonymous) return;
    if (auth.signupPromptShownAt) return;
    const t = setTimeout(() => setSignupOpen(true), 1400);
    return () => clearTimeout(t);
  }, [auth.isAnonymous, auth.signupPromptShownAt]);

  // Bottom nav height (approx) — used to push the MiniPlayer up by the right amount.
  const NAV_HEIGHT = 56 + Math.max(insets.bottom, 8);

  // The mini player floats just above the nav on every surface EXCEPT while
  // the full player overlay is open (where it would be redundant). It shows
  // over the content tabs and over an open artist page alike.
  const showMini = !playerOpen && Boolean(auth.userId);

  // Open-player handler — Explore + Library + Artist + MiniPlayer all use
  // this to surface the full now-playing view after a tap. It only flips the
  // `playerOpen` flag: the content tab and the artist stack are left
  // untouched, so closing the player returns the user to exactly where they
  // were (same screen, same scroll, same artist page). Memoized so the
  // NavigationProvider's value reference is stable across renders.
  const openPlayer = React.useCallback(() => {
    setPlayerOpen(true);
  }, []);
  // Dismiss the full player overlay back to whatever was underneath.
  const closePlayer = React.useCallback(() => {
    setPlayerOpen(false);
  }, []);
  // Open-signup handler — the comments composer calls this when an
  // anonymous user taps a gated social action.
  const openSignup = React.useCallback((reason?: SignupReason) => {
    setSignupReason(reason ?? null);
    setSignupOpen(true);
  }, []);
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

  // Desktop web (>=1024px) gets the sidebar shell; native + mobile-web keep
  // the original layout. `isDesktop` is always false on native, so the native
  // app never reaches the DesktopShell branch.
  const isDesktop = Platform.OS === 'web' && width >= 1024;

  return (
    <NavigationProvider
      openPlayer={openPlayer}
      openSignup={openSignup}
      openArtistProfile={openArtistProfile}
      closeArtistProfile={closeArtistProfile}
    >
      {isDesktop ? (
        <DesktopShell
          tab={tab}
          mountedTabs={mountedTabs}
          onTabChange={handleTabChange}
          playerOpen={playerOpen}
          onOpenPlayer={openPlayer}
          onClosePlayer={closePlayer}
          topArtistId={topArtistId}
          onCloseArtist={closeArtistProfile}
        />
      ) : (
      <View style={styles.root}>
        {/* Content tabs. Every visited tab stays mounted; inactive tabs are
            hidden so their scroll position + state survive navigating to the
            player or another tab. On native that uses display:none (cheapest
            — skips layout/paint). On web display:none resets a scroll
            container's offset, so inactive web tabs stay laid out (absolute,
            opacity 0, non-interactive) to keep their scrollTop. collapsable
            ={false} keeps the native view alive on Android. */}
        <View style={styles.screen}>
          {CONTENT_TABS.map((t) =>
            mountedTabs.has(t) ? (
              <View
                key={t}
                style={tab === t ? styles.tabActive : styles.tabHidden}
                collapsable={false}
                pointerEvents={tab === t ? 'auto' : 'none'}
              >
                {t === 'explore' && <ExploreScreen />}
                {t === 'library' && <LibraryScreen />}
                {t === 'profile' && <ProfileScreen />}
              </View>
            ) : null,
          )}
        </View>
        {/* Artist profile overlay — sits above the tab content but below
            the player overlay and the docked mini-player / bottom nav. The
            stack lives in this navigator so similar-artist taps can push
            deeper, and it is NOT cleared when the player opens — closing
            the player returns the user to the same artist page. */}
        {topArtistId ? (
          <View style={styles.artistOverlay} pointerEvents="box-none">
            <ArtistProfileScreen
              key={topArtistId}
              artistId={topArtistId}
              onBack={closeArtistProfile}
            />
          </View>
        ) : null}
        {/* Full-screen player overlay — the top layer, above the artist
            overlay and the tabs. It mounts only while open; audio lives in
            PlayerContext (mounted above this navigator), so playback is
            unaffected by the player UI mounting / unmounting. */}
        {playerOpen ? (
          <View style={styles.playerOverlay}>
            <PlayerFeedScreen onDismiss={closePlayer} />
          </View>
        ) : null}
        {showMini && (
          <MiniPlayer
            onPress={openPlayer}
            bottomOffset={NAV_HEIGHT + 6}
          />
        )}
        <BottomNav active={playerOpen ? 'home' : tab} onChange={handleTabChange} />
      </View>
      )}
      {/* Hardware media keys → playback (web). No-op on native, where the
          OS audio session already handles them. */}
      <MediaSessionBridge />
      {/* "You discovered this first" celebration — self-gates on
          PlayerContext.firstListen; shared by both shells. */}
      <FirstListenerModal />
      {/* First-time explainer: recommendations sharpen the more you listen.
          Fires once, the first time the player is opened. */}
      <ListenMoreModal active={playerOpen} />
      {/* Paywall + signup sheets — shared by both shells. They are Modals, so
          they overlay regardless of tree position; native behavior of the
          mobile shell above is unchanged. */}
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
        reason={signupReason}
        onClose={() => {
          setSignupOpen(false);
          setSignupReason(null);
          void auth.markSignupPromptShown();
        }}
        // On web, once the free limit is reached the sheet is a hard gate:
        // no dismiss, no "Maybe later" — the user must sign in to continue.
        mandatory={Platform.OS === 'web' && auth.webLoginRequired}
      />
    </NavigationProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  screen: { flex: 1 },
  // Active content tab fills the screen. Inactive tabs stay mounted (so
  // their scroll position + component state are preserved).
  //
  // Native: inactive tabs use display:none — removed from layout, cheapest,
  // and native FlatList/ScrollView keep their offset across it.
  //
  // Web: display:none resets a scroll container's scrollTop, so inactive
  // tabs instead stay fully laid out as an absolute, transparent layer.
  // pointerEvents="none" (set on the View) keeps them click-through. Every
  // tab is absolute so there's no flow⇄absolute reflow on switch.
  tabActive: Platform.OS === 'web'
    ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
    : { flex: 1 },
  tabHidden: Platform.OS === 'web'
    ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 }
    : { display: 'none' },
  // Artist overlay covers the tab content but stops short of the docked
  // MiniPlayer + BottomNav (those float above this layer thanks to render
  // order). Background is the bg color so the underlying tab does not
  // bleed through during scroll.
  artistOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
  },
  // Player overlay covers everything below it (tabs + artist overlay). The
  // MiniPlayer + BottomNav still render after this in the tree, so the nav
  // remains tappable — matching the previous player-as-a-tab behavior.
  playerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
  },
});
