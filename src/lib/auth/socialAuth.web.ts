import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Web build of social auth.
//
// On native, OAuth runs through an in-app browser bound to the `boulevard://`
// deep-link scheme. On web there is no deep link — Supabase OAuth is a plain
// full-page redirect: we send the browser to the provider, the provider sends
// it back to our origin, and `detectSessionInUrl` (enabled for web in
// supabase.ts) installs the session on reload. Metro resolves this file
// instead of socialAuth.ts whenever it builds for `Platform.OS === 'web'`.
//
// When the user is anonymous we call linkIdentity so the social identity
// attaches to the existing auth.uid — likes, saves, taste and playlists all
// survive the upgrade. Otherwise we call signInWithOAuth.

export type Provider = 'apple' | 'google' | 'facebook' | 'tiktok';

export interface SocialAuthResult {
  ok: boolean;
  /** True when Supabase wasn't configured; caller should fall back. */
  demo: boolean;
  /** Set when the user cancelled (not reachable on web — kept for parity). */
  cancelled?: boolean;
  /** Set when something failed before the redirect. */
  error?: string;
}

export async function signInWithProvider(provider: Provider): Promise<SocialAuthResult> {
  if (!HAS_SUPABASE || !supabase) {
    return { ok: false, demo: true };
  }

  try {
    // Come back to the web app itself after the provider round-trip.
    const redirectTo = window.location.origin;

    const { data: sessionData } = await supabase.auth.getSession();
    const isAnon = sessionData.session?.user?.is_anonymous === true;

    const { data, error } = isAnon
      ? await supabase.auth.linkIdentity({
          provider: provider as never,
          options: { redirectTo },
        })
      : await supabase.auth.signInWithOAuth({
          provider: provider as never,
          options: { redirectTo },
        });

    if (error) {
      return { ok: false, demo: false, error: friendlyOAuthError(error.message, provider) };
    }

    // signInWithOAuth redirects on its own; linkIdentity does not always.
    // Navigating to the returned URL is safe in both cases.
    if (data?.url) {
      window.location.assign(data.url);
    }

    // The page is navigating away — this resolution is effectively unused.
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
