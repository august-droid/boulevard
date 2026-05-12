import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const HAS_SUPABASE = Boolean(url && anonKey);

// When env is missing we expose a `null` client and code paths fall back
// to local-only behavior. This lets the app run cold without a backend.
export const supabase: SupabaseClient | null = HAS_SUPABASE
  ? createClient(url, anonKey, {
      auth: {
        storage: AsyncStorage as never,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;
