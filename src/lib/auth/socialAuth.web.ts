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
//
// linkIdentity fails when the social account is ALREADY a Boulevard user:
// Supabase returns `identity_already_exists` (the identity can't attach to
// two uids). That failure arrives after the redirect, as `?error=` query
// params — recoverFromOAuthRedirect() handles it on the next app load by
// re-running OAuth as a plain sign-in to the existing account.

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

// Carries the provider across the OAuth full-page redirect so the on-load
// recovery handler knows which provider to retry as a sign-in.
const PENDING_PROVIDER_KEY = 'boulevard.oauth_pending_provider';
// One-shot guard: once a failed anonymous link has been retried as a
// sign-in, we do not retry again — a persistent error must not spin the
// page in a redirect loop. Reset on each user-initiated OAuth attempt.
const RETRY_GUARD_KEY = 'boulevard.oauth_retry_done';
// Set right before any OAuth full-page redirect. AuthContext reads it on the
// next load and, if the session came back signed-in, fires the one-time
// "you're signed in" confirmation. Read-once — AuthContext clears it.
export const SIGNED_IN_CELEBRATE_KEY = 'boulevard.signin_celebrate';

// Where the provider should send the browser back: the app's own URL with
// any query/hash stripped. It MUST be `origin + pathname`, never the bare
// origin — the web app is served at /listen, and a bare-origin redirect lands
// the user on the marketing site instead of back in the app.
function appRedirectUrl(): string {
  return window.location.origin + window.location.pathname;
}

export async function signInWithProvider(provider: Provider): Promise<SocialAuthResult> {
  if (!HAS_SUPABASE || !supabase) {
    return { ok: false, demo: true };
  }

  try {
    const redirectTo = appRedirectUrl();

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
      // Remember the provider, and clear the one-shot recovery guard — this
      // is a fresh user-initiated attempt, so it gets a fresh retry budget.
      try {
        window.localStorage.setItem(PENDING_PROVIDER_KEY, provider);
        window.localStorage.setItem(SIGNED_IN_CELEBRATE_KEY, '1');
        window.sessionStorage.removeItem(RETRY_GUARD_KEY);
      } catch {
        // Storage can throw in private-mode / locked-down browsers — the
        // sign-in still works, only the post-failure recovery is skipped.
      }
      window.location.assign(data.url);
    }

    // The page is navigating away — this resolution is effectively unused.
    return { ok: true, demo: false };
  } catch (e) {
    return { ok: false, demo: false, error: friendlyOAuthError((e as Error).message, provider) };
  }
}

/**
 * Run once on web app load. Supabase reports OAuth failures by redirecting
 * back with `?error=...&error_code=...` in the query string.
 *
 * The case that must self-heal: an anonymous user picked "Continue with
 * Google" but that account is ALREADY a Boulevard user, so linkIdentity
 * fails with `identity_already_exists`. The right outcome is to sign IN to
 * the existing account, so we re-run OAuth as signInWithOAuth (a one-shot
 * guard prevents a redirect loop). Any other error is just stripped from
 * the URL so a refresh does not replay it.
 *
 * Resolves to true once it has kicked off a redirect — the caller should
 * treat the page as navigating away.
 */
export async function recoverFromOAuthRedirect(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get('error_code');
  if (!errorCode) return false;

  const cleanUrl = window.location.origin + window.location.pathname;

  if (errorCode === 'identity_already_exists' && HAS_SUPABASE && supabase) {
    let retried = false;
    let provider: string | null = null;
    try {
      retried = window.sessionStorage.getItem(RETRY_GUARD_KEY) === '1';
      provider = window.localStorage.getItem(PENDING_PROVIDER_KEY);
      window.localStorage.removeItem(PENDING_PROVIDER_KEY);
    } catch {
      // No storage — fall through to URL cleanup below.
    }

    if (!retried && provider) {
      try {
        window.sessionStorage.setItem(RETRY_GUARD_KEY, '1');
      } catch {
        // ignore
      }
      try {
        const { data } = await supabase.auth.signInWithOAuth({
          provider: provider as never,
          options: { redirectTo: cleanUrl },
        });
        if (data?.url) {
          // Keep the confirmation flag alive across this recovery hop so the
          // user still gets the "signed in" checkmark once it completes.
          try { window.localStorage.setItem(SIGNED_IN_CELEBRATE_KEY, '1'); } catch {}
          window.location.assign(data.url);
          return true;
        }
      } catch {
        // fall through to URL cleanup
      }
    }
  }

  // Strip the error params so a refresh does not replay them.
  window.history.replaceState({}, '', cleanUrl);
  return false;
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
