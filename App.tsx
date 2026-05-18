import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { AuthProvider } from '@/contexts/AuthContext';
import { ExperimentProvider } from '@/contexts/ExperimentContext';
import { PlayerProvider } from '@/contexts/PlayerContext';
import { ExploreProvider } from '@/contexts/ExploreContext';
import { FollowsProvider } from '@/contexts/FollowsContext';
import { PlaylistsProvider } from '@/contexts/PlaylistsContext';
import { CommentsProvider } from '@/contexts/CommentsContext';
import { RootNavigator } from '@/navigation/RootNavigator';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MoodPickerSheet } from '@/components/MoodPickerSheet';
import { SignInConfirmation } from '@/components/SignInConfirmation';
import { initAppsFlyer, logAppsFlyerEvent } from '@/lib/attribution/AppsFlyer';
import { recoverFromOAuthRedirect } from '@/lib/auth/socialAuth';

// Foreground-presentation handler — when a local notification fires while
// the app is open, show it as a banner with sound. Without this, foreground
// notifications are silently swallowed by iOS. The web app has no local
// notifications, so this is skipped there.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export default function App() {
  // Request notification permission on first launch. We only need this for
  // the personalization-unlock local notification right now, so a single
  // prompt is enough — if denied, the modal + haptic still fire. Web never
  // prompts: the browser permission popup would be unsolicited and the web
  // app schedules no notifications anyway.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.getPermissionsAsync()
      .then((perm) => {
        if (perm.status === 'undetermined') {
          return Notifications.requestPermissionsAsync();
        }
      })
      .catch(() => {});
  }, []);

  // Web only — recover from a failed OAuth round-trip. When an anonymous
  // listener picks "Continue with Google" but that account already exists,
  // linkIdentity fails and the provider redirects back with `?error=` query
  // params; this re-runs OAuth as a plain sign-in to the existing account.
  // No-op on native and on a clean load.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    void recoverFromOAuthRedirect();
  }, []);

  // Initialize AppsFlyer install attribution, then log the app-open event.
  // Fully fire-and-forget: initAppsFlyer no-ops without a dev key and never
  // throws, so this cannot delay or break launch. On web it resolves to an
  // inert no-op module.
  useEffect(() => {
    initAppsFlyer()
      .then(() => logAppsFlyerEvent('af_app_opened'))
      .catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#0a0a0c' }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <AuthProvider>
            {/* Experiment provider sits just inside Auth so useExperiment()
                can read the subject id. It never blocks rendering: until the
                active-tests load (and forever, with no backend) every surface
                sees an inert handle and renders its built-in default. */}
            <ExperimentProvider>
              <FollowsProvider>
                <PlaylistsProvider>
                  <CommentsProvider>
                    <PlayerProvider>
                      <ExploreProvider>
                        <StatusBar style="light" />
                        <RootNavigator />
                        {/* First-launch mood greeter. Self-gates on AsyncStorage
                            so it only ever shows once per install. Lives inside
                            PlayerProvider so it can call playPlaylist directly. */}
                        <MoodPickerSheet />
                        {/* Brief checkmark shown once when the user signs in. */}
                        <SignInConfirmation />
                      </ExploreProvider>
                    </PlayerProvider>
                  </CommentsProvider>
                </PlaylistsProvider>
              </FollowsProvider>
            </ExperimentProvider>
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
