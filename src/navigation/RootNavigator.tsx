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
import { useAuth } from '@/contexts/AuthContext';

// Gating model:
//   1) No signup required to start.
//   2) Free users get 20 plays/day.
//   3) When the daily cap is hit, the premium paywall opens — that's the
//      *only* signup point. The 3-day free trial doubles as the account
//      creation flow (handled inside PaywallScreen → startTrial).
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
  const [userHasNavigated, setUserHasNavigated] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);

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
    setTab(next);
  };

  // Premium paywall — fires when the daily cap is hit. Re-fires whenever
  // `blockedAttempts` increments so that after the user dismisses the
  // paywall and tries to play again, the paywall comes back instead of
  // silently failing.
  useEffect(() => {
    if (auth.isPremium) return;
    if (paywallOpen) return;
    if (!auth.dailyLimitHit) return;
    setPaywallOpen(true);
    void auth.markPaywallShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.dailyLimitHit, auth.isPremium, auth.blockedAttempts]);

  // Bottom nav height (approx) — used to push the MiniPlayer up by the right amount.
  const NAV_HEIGHT = 56 + Math.max(insets.bottom, 8);

  // Home tab is the full now-playing screen, so the mini player would be
  // redundant there. On every other tab we float it just above the nav.
  const showMini = tab !== 'home' && Boolean(auth.userId);

  return (
    <View style={styles.root}>
      <View style={styles.screen}>
        {tab === 'home' && <PlayerFeedScreen />}
        {tab === 'explore' && <ExploreScreen />}
        {tab === 'library' && <LibraryScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </View>
      {showMini && (
        <MiniPlayer
          onPress={() => handleTabChange('home')}
          bottomOffset={NAV_HEIGHT + 6}
        />
      )}
      <BottomNav active={tab} onChange={handleTabChange} />
      <PaywallScreen visible={paywallOpen} onClose={() => setPaywallOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  screen: { flex: 1 },
});
