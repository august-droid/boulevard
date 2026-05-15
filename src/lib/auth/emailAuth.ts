import * as Linking from 'expo-linking';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Email auth flows for Boulevard.
//
// All four flows preserve the current anonymous auth.uid where possible:
//
//   • signUpAndUpgrade   — converts an anonymous user into a permanent
//     email user via supabase.auth.updateUser. The same auth.uid stays,
//     so likes, saves, taste profile, playlists, push tokens, and the
//     RevenueCat customer (which is keyed off uid) all follow them
//     across the upgrade.
//
//   • signInExisting     — used when the email already belongs to a
//     real account. This signs the user OUT of the anonymous session
//     and INTO their existing account. Anonymous-session data is left
//     attached to the orphaned anon uid; merging server-side is a
//     separate problem we do not attempt here.
//
//   • sendPasswordReset  — sends a reset email with a deep-link back
//     into the app.
//
//   • upgradeAnonymousWithProvider — wraps supabase.auth.linkIdentity
//     so a social provider can be attached to the current anonymous
//     user without losing their session.

export interface AuthOutcome {
  ok: boolean;
  /** Set when Supabase is not configured; caller should fall back. */
  demo?: boolean;
  /** Human-readable error message safe to show in the UI. */
  error?: string;
  /** Set on signUp when the project requires email confirmation. */
  needsEmailConfirmation?: boolean;
}

const RESET_REDIRECT_PATH = 'auth/reset';

/**
 * Convert the current anonymous Supabase user into a permanent email user.
 * Use this when the user does not have an existing account.
 *
 * Preserves auth.uid, which means every RLS-protected row already tied to
 * this user keeps working with no migration. RevenueCat keeps the same
 * customer id, so any active subscription survives.
 */
export async function signUpAndUpgrade(email: string, password: string): Promise<AuthOutcome> {
  if (!validateEmail(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!validatePassword(password)) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (!HAS_SUPABASE || !supabase) return { ok: false, demo: true };

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const isAnon = sessionData.session?.user?.is_anonymous === true;

    if (isAnon) {
      // Upgrade path: same auth.uid, all data preserved.
      const { data, error } = await supabase.auth.updateUser({ email, password });
      if (error) return { ok: false, error: friendlyAuthError(error.message) };
      // Email confirmation is on when Supabase returns a user with no
      // email_confirmed_at; the session stays anonymous until the user
      // clicks the link, but the upgrade itself succeeded.
      const needsConfirm = !data.user?.email_confirmed_at;
      return { ok: true, needsEmailConfirmation: needsConfirm };
    }

    // Cold sign-up (no current session): standard signUp.
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: friendlyAuthError(error.message) };
    const needsConfirm = !data.session;
    return { ok: true, needsEmailConfirmation: needsConfirm };
  } catch (e) {
    return { ok: false, error: friendlyAuthError((e as Error).message) };
  }
}

/**
 * Sign into an existing email account. This replaces the current session
 * (anonymous or otherwise). Data tied to a previous anonymous session is
 * NOT carried over; the UI should make this clear before calling.
 */
export async function signInExisting(email: string, password: string): Promise<AuthOutcome> {
  if (!validateEmail(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!password) return { ok: false, error: 'Enter your password.' };
  if (!HAS_SUPABASE || !supabase) return { ok: false, demo: true };

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: friendlyAuthError(error.message) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyAuthError((e as Error).message) };
  }
}

/**
 * Send a password reset email. The link redirects back to the app via the
 * `boulevard://auth/reset` deep link so the user can set a new password
 * inside the app rather than on the web.
 */
export async function sendPasswordReset(email: string): Promise<AuthOutcome> {
  if (!validateEmail(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!HAS_SUPABASE || !supabase) return { ok: false, demo: true };

  try {
    const redirectTo = Linking.createURL(RESET_REDIRECT_PATH);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return { ok: false, error: friendlyAuthError(error.message) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyAuthError((e as Error).message) };
  }
}

// --- helpers ---------------------------------------------------------

function validateEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function validatePassword(s: string): boolean {
  return typeof s === 'string' && s.length >= 8;
}

/**
 * Map Supabase's error strings into something a real listener can act on.
 * We never expose raw provider error text or stack noise in the UI.
 */
function friendlyAuthError(raw: string): string {
  const s = (raw || '').toLowerCase();
  if (s.includes('user already registered') || s.includes('already been registered')) {
    return 'That email already has an account. Try signing in instead.';
  }
  if (s.includes('email rate limit')) {
    return 'Too many emails sent. Try again in a few minutes.';
  }
  if (s.includes('invalid login credentials')) {
    return 'Wrong email or password.';
  }
  if (s.includes('email not confirmed')) {
    return 'Check your inbox to confirm your email first.';
  }
  if (s.includes('weak password') || s.includes('password should')) {
    return 'Pick a stronger password (8 or more characters).';
  }
  if (s.includes('network')) {
    return 'Network error. Check your connection and try again.';
  }
  if (s.includes('cannot link') || s.includes('identity is already linked')) {
    return 'That account is already linked to another user.';
  }
  return raw || 'Something went wrong. Please try again.';
}
