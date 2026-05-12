import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { AuthProvider } from '@/contexts/AuthContext';
import { PlayerProvider } from '@/contexts/PlayerContext';
import { RootNavigator } from '@/navigation/RootNavigator';
import { ErrorBoundary } from '@/components/ErrorBoundary';

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
            <PlayerProvider>
              <StatusBar style="light" />
              <RootNavigator />
            </PlayerProvider>
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
