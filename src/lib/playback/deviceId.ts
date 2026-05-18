import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import uuid from 'react-native-uuid';

// A stable per-device id + a human label. Boulevard Connect uses the id to
// tell one signed-in device of an account from another, and the label to
// render "Playing on <device>" on the devices that are acting as remotes.

const ID_KEY = 'boulevard.connect.device_id';

let cachedId: string | null = null;

/** Stable id for THIS device/install — generated once, then persisted. */
export async function getDeviceId(): Promise<string> {
  if (cachedId) return cachedId;
  try {
    const stored = await AsyncStorage.getItem(ID_KEY);
    if (stored) {
      cachedId = stored;
      return stored;
    }
  } catch {
    // Storage unavailable — fall through and generate an ephemeral id.
  }
  const fresh = String(uuid.v4());
  cachedId = fresh;
  try {
    await AsyncStorage.setItem(ID_KEY, fresh);
  } catch {
    // Best-effort — an ephemeral id still works for this app session.
  }
  return fresh;
}

/** Human label for the "Playing on <device>" hint shown on other devices. */
export function getDeviceLabel(): string {
  if (Platform.OS === 'ios') return 'the iOS app';
  if (Platform.OS === 'android') return 'the Android app';
  // Web — distinguish a phone browser from a desktop browser.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? 'a phone browser' : 'a desktop browser';
}
