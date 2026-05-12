import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

// Local notification scheduled when the user hits the daily free cap.
// Fires at 9am the next morning, local time, reminding the user that their
// 20 songs are back. If the user opens the app before then, we cancel the
// pending notification so they don't get a redundant ping.

const NOTIF_ID_KEY = 'boulevard.daily_reset_notif_id';

function nextNineAm(): Date {
  const target = new Date();
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target;
}

/**
 * Schedule the "your 20 songs are back" notification for 9am tomorrow.
 * No-op if one is already scheduled (we don't want to stack duplicates).
 * Caller should call this once when the user hits the cap; it dedupes so
 * extra calls from later blocked-attempt events are harmless.
 */
export async function scheduleDailyResetNotification(): Promise<void> {
  try {
    const existing = await AsyncStorage.getItem(NOTIF_ID_KEY);
    if (existing) return;  // already scheduled

    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') return;  // user denied; silently skip

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Your daily songs are here',
        body: 'These AI tracks will blow your mind.',
        sound: 'default',
      },
      // Date triggers fire at the specified absolute local time.
      trigger: { type: 'date', date: nextNineAm() } as any,
    });
    await AsyncStorage.setItem(NOTIF_ID_KEY, id);
  } catch {
    // Notifications unavailable (web / sim without permission) — never let
    // this surface to the player flow.
  }
}

/**
 * Cancel any pending reset notification. Called whenever we know the user
 * has plays available again — either the day rolled over locally, or the
 * user explicitly came back into the app and we want to stop pinging.
 */
export async function cancelDailyResetNotification(): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(NOTIF_ID_KEY);
    if (!id) return;
    await Notifications.cancelScheduledNotificationAsync(id);
    await AsyncStorage.removeItem(NOTIF_ID_KEY);
  } catch {
    // Best-effort.
  }
}
