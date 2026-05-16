import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { AuthProvider } from '@/contexts/AuthContext';
import { PlayerProvider } from '@/contexts/PlayerContext';
import { ExploreProvider } from '@/contexts/ExploreContext';
import { FollowsProvider } from '@/contexts/FollowsContext';
import { PlaylistsProvider } from '@/contexts/PlaylistsContext';
import { CommentsProvider } from '@/contexts/CommentsContext';
import { RootNavigator } from '@/navigation/RootNavigator';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MoodPickerSheet } from '@/components/MoodPickerSheet';
import { initAppsFlyer, logAppsFlyerEvent } from '@/lib/attribution/AppsFlyer';

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
                    </ExploreProvider>
                  </PlayerProvider>
                </CommentsProvider>
              </PlaylistsProvider>
            </FollowsProvider>
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
