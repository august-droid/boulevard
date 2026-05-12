import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Social auth via Supabase OAuth + an in-app web browser.
//
// Each provider opens Supabase's OAuth URL in a SFAuthenticationSession
// (iOS) / Chrome Custom Tab (Android) bound to our app's deep-link scheme.
// On success Supabase redirects back to `boulevard://auth/callback`, the
// browser dismisses, and Supabase auto-installs the session.
//
// If Supabase isn't configured we resolve with `demo: true` so the caller
// can fall back to local "markSignedUp" — the UI flow still completes.

export type Provider = 'apple' | 'google' | 'facebook';

export interface SocialAuthResult {
  ok: boolean;
  /** True when Supabase wasn't configured; caller should fall back. */
  demo: boolean;
  /** Set when the user cancelled the browser sheet. */
  cancelled?: boolean;
  /** Set when something failed mid-flow. */
  error?: string;
}

const REDIRECT_PATH = 'auth/callback';

export async function signInWithProvider(provider: Provider): Promise<SocialAuthResult> {
  // Compute a redirect URI that works in dev (Expo Go's exp:// scheme) and
  // production (our custom `boulevard://` scheme).
  const redirectTo = Linking.createURL(REDIRECT_PATH);

  if (!HAS_SUPABASE || !supabase) {
    return { ok: false, demo: true };
  }

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      return { ok: false, demo: false, error: error?.message ?? 'No OAuth URL returned' };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, {
      showInRecents: false,
    });

    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { ok: false, demo: false, cancelled: true };
    }
    if (result.type !== 'success') {
      return { ok: false, demo: false, error: `auth flow ${result.type}` };
    }

    // Supabase v2 picks up the tokens from the redirect URL automatically when
    // we hand them to setSession; the URL fragment is in result.url.
    const url = result.url;
    const fragment = url.split('#')[1] ?? '';
    const params = new URLSearchParams(fragment);
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (access_token && refresh_token) {
      const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
      if (setErr) return { ok: false, demo: false, error: setErr.message };
    }

    return { ok: true, demo: false };
  } catch (e) {
    return { ok: false, demo: false, error: (e as Error).message };
  }
}
