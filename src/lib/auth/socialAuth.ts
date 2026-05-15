import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Social auth via Supabase OAuth + an in-app web browser.
//
// Each provider opens Supabase's OAuth URL in a SFAuthenticationSession
// (iOS) or Chrome Custom Tab (Android) bound to our app's deep-link scheme.
// On success Supabase redirects back to `boulevard://auth/callback`, the
// browser dismisses, and Supabase auto-installs the session.
//
// When the current session is anonymous we call linkIdentity instead of
// signInWithOAuth. linkIdentity attaches the social identity to the same
// auth.uid the user already has, so likes, saves, taste, playlists, push
// tokens, and the RevenueCat customer all stay attached after the upgrade.
//
// If Supabase isn't configured we resolve with `demo: true` so the caller
// can fall back to local "markSignedUp" — the UI flow still completes.

export type Provider = 'apple' | 'google' | 'facebook' | 'tiktok';

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
    // Is the user currently anonymous? If so, link the provider to the
    // existing uid instead of replacing the session.
    const { data: sessionData } = await supabase.auth.getSession();
    const isAnon = sessionData.session?.user?.is_anonymous === true;

    const { data, error } = isAnon
      ? await supabase.auth.linkIdentity({
          provider: provider as any,
          options: { redirectTo, skipBrowserRedirect: true },
        })
      : await supabase.auth.signInWithOAuth({
          provider: provider as any,
          options: { redirectTo, skipBrowserRedirect: true },
        });

    if (error || !data?.url) {
      return { ok: false, demo: false, error: friendlyOAuthError(error?.message, provider) };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, {
      showInRecents: false,
    });

    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { ok: false, demo: false, cancelled: true };
    }
    if (result.type !== 'success') {
      return { ok: false, demo: false, error: `Sign-in did not complete. Please try again.` };
    }

    // Supabase v2 picks up the tokens from the redirect URL automatically
    // when we hand them to setSession; the URL fragment is in result.url.
    // linkIdentity uses the same redirect shape, so the same parser works.
    const url = result.url;
    const fragment = url.split('#')[1] ?? '';
    const params = new URLSearchParams(fragment);
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (access_token && refresh_token) {
      const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
      if (setErr) return { ok: false, demo: false, error: friendlyOAuthError(setErr.message, provider) };
    }

    return { ok: true, demo: false };
  } catch (e) {
    return { ok: false, demo: false, error: friendlyOAuthError((e as Error).message, provider) };
  }
}

function friendlyOAuthError(raw: string | undefined, provider: Provider): string {
  const s = (raw || '').toLowerCase();
  if (s.includes('provider is not enabled')) {
    return `${labelFor(provider)} sign-in is not available right now.`;
  }
  if (s.includes('identity is already linked')) {
    return 'That account is already linked to another user.';
  }
  if (s.includes('network')) {
    return 'Network error. Check your connection and try again.';
  }
  return raw && raw.length < 140 ? raw : `Could not sign in with ${labelFor(provider)}. Please try again.`;
}

function labelFor(p: Provider): string {
  return p === 'tiktok' ? 'TikTok' : p.charAt(0).toUpperCase() + p.slice(1);
}
