import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { AuthProvider } from '@/contexts/AuthContext';
import { PlayerProvider } from '@/contexts/PlayerContext';
import { FollowsProvider } from '@/contexts/FollowsContext';
import { PlaylistsProvider } from '@/contexts/PlaylistsContext';
import { CommentsProvider } from '@/contexts/CommentsContext';
import { RootNavigator } from '@/navigation/RootNavigator';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MoodPickerSheet } from '@/components/MoodPickerSheet';

// Foreground-presentation handler — when a local notification fires while
// the app is open, show it as a banner with sound. Without this, foreground
// notifications are silently swallowed by iOS.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  // Request notification permission on first launch. We only need this for
  // the personalization-unlock local notification right now, so a single
  // prompt is enough — if denied, the modal + haptic still fire.
  useEffect(() => {
    Notifications.getPermissionsAsync()
      .then((perm) => {
        if (perm.status === 'undetermined') {
          return Notifications.requestPermissionsAsync();
        }
      })
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
                    <StatusBar style="light" />
                    <RootNavigator />
                    {/* First-launch mood greeter. Self-gates on AsyncStorage
                        so it only ever shows once per install. Lives inside
                        PlayerProvider so it can call playPlaylist directly. */}
                    <MoodPickerSheet />
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
