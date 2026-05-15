import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Registers an Expo push token for the current user and upserts it into
// public.push_tokens so the server can deliver replies/likes pushes.
//
// Safe to call repeatedly: Expo returns the same token for the same install,
// and the upsert is keyed on user_id (one device per user — matches the
// existing schema).

export async function registerPushTokenForUser(userId: string): Promise<string | null> {
  // Re-check permission. If the user already granted, this is instant.
  const perm = await Notifications.getPermissionsAsync();
  if (perm.status !== 'granted') return null;

  // Simulators / sessions without an EAS projectId throw inside the SDK.
  // We catch below and fail soft so this never blocks startup.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId ??
    undefined;
  if (!projectId) return null;

  let token: string;
  try {
    const res = await Notifications.getExpoPushTokenAsync({ projectId });
    token = res.data;
  } catch {
    return null;
  }

  if (!HAS_SUPABASE || !supabase) return token;
  try {
    await supabase
      .from('push_tokens')
      .upsert(
        {
          user_id: userId,
          expo_token: token,
          platform: Platform.OS,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
  } catch {
    // best-effort
  }
  return token;
}
