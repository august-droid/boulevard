// TikTok Pixel conversion events — web build.
//
// The base pixel and the initial ttq.page() call are injected directly in
// public/index.html (and the deployed listen/index.html). This module fires
// the CompleteRegistration conversion when a listener creates an account.
//
// CompleteRegistration is sent on TWO channels, both carrying the same
// `event_id` so TikTok deduplicates them into a single conversion:
//   1. Browser pixel — ttq.track(). Best-effort: ad-blockers and Safari ITP
//      drop a large share of these.
//   2. Events API — a server-to-server send via the /api/tiktok-event
//      Netlify function, which nothing in the browser can block. The server
//      side is idempotent per user, so it is the reliable source of truth.
//
// Why a code-fired event instead of TikTok's URL/click tracking: the web app
// is a single-page app served at /listen with no per-screen URLs and the
// sign-up button is a react-native-web <Pressable> with no stable selector.
// TikTok cannot infer a sign-up on its own — the event must be fired from
// code at the moment sign-up succeeds.

import { supabase } from '@/lib/supabase';

export type SignUpMethod = 'email' | 'google' | 'apple';

interface Ttq {
  track: (
    event: string,
    params?: Record<string, unknown>,
    options?: { event_id?: string },
  ) => void;
  // Re-evaluates the current URL against the pixel's configured event rules
  // (e.g. an Events Manager "URL contains" rule). The base snippet calls it
  // once on load; a SPA must call it again whenever the URL changes.
  page?: () => void;
}

// A TikTok ad click lands with a ?ttclid= query param. We persist it the
// moment the app loads because a Google OAuth sign-up is a full-page redirect
// that would otherwise drop the param before the user finishes registering.
const TTCLID_KEY = 'boulevard.ttclid';

(function captureTtclid() {
  if (typeof window === 'undefined') return;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('ttclid');
    if (fromUrl) window.localStorage.setItem(TTCLID_KEY, fromUrl);
  } catch {
    // storage unavailable (private mode) — ttclid attribution is skipped
  }
})();

function getTtq(): Ttq | null {
  if (typeof window === 'undefined') return null;
  const ttq = (window as unknown as { ttq?: Ttq }).ttq;
  // The inline pixel snippet defines ttq.track as a deferred stub before
  // events.js loads, so this is safe to call at any point after page load.
  return ttq && typeof ttq.track === 'function' ? ttq : null;
}

// One id shared by the browser event and the server event so TikTok merges
// them. crypto.randomUUID needs a secure context (true on the production
// https origin); the fallback covers anything older.
function newEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual id
  }
  return `reg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getTtclid(): string | null {
  try {
    return (
      window.localStorage.getItem(TTCLID_KEY) ||
      new URLSearchParams(window.location.search).get('ttclid')
    );
  } catch {
    return null;
  }
}

// The TikTok pixel writes a `_ttp` first-party cookie used for match quality.
function getTtp(): string | null {
  try {
    const m = document.cookie.match(/(?:^|;\s*)_ttp=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// Relay the conversion to TikTok's Events API via our own Netlify function.
// The function verifies the Supabase JWT, enforces once-per-user idempotency,
// and holds the TikTok access token — none of which can live in the browser.
async function sendServerEvent(method: SignUpMethod, eventId: string): Promise<void> {
  try {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return; // no authenticated session — nothing to attribute

    await fetch('/api/tiktok-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        event_id: eventId,
        method,
        event_time: Math.floor(Date.now() / 1000),
        url: window.location.href,
        ttclid: getTtclid(),
        ttp: getTtp(),
      }),
    });
  } catch {
    // Offline, blocked, or running off-production (local dev has no Netlify
    // function): swallow it. The browser pixel is the fallback signal, and a
    // sign-up must never be affected by analytics.
  }
}

// After a successful sign-up, briefly add ?registration=complete to the URL
// and re-fire the pixel pageview. A TikTok "URL contains" event rule set up
// in Events Manager will then register a CompleteRegistration off the URL —
// no code-fired track() needed on that channel. The marker is transient: it
// is stripped again after a couple of seconds so a later page reload (which
// re-runs the base snippet's ttq.page()) cannot replay the event. Any other
// query params already present — notably ttclid — are preserved.
const URL_MARKER = 'registration';
const URL_MARKER_VALUE = 'complete';

function markSignupInUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const marked = new URL(window.location.href);
    marked.searchParams.set(URL_MARKER, URL_MARKER_VALUE);
    window.history.replaceState(null, '', marked.toString());

    // events.js reads location.href synchronously when page() runs, so the
    // marker must be in place for this call.
    getTtq()?.page?.();

    // Remove the marker once TikTok has read it.
    window.setTimeout(() => {
      try {
        const clean = new URL(window.location.href);
        clean.searchParams.delete(URL_MARKER);
        window.history.replaceState(null, '', clean.toString());
      } catch {
        // history unavailable — leave the URL as-is
      }
    }, 2000);
  } catch {
    // URL / history API unavailable — skip the marker silently
  }
}

/**
 * Fire TikTok's standard CompleteRegistration event for a new account.
 * Three channels, all keyed to the same real sign-up:
 *   1. Browser pixel ttq.track() — best-effort.
 *   2. Server-side Events API — robust, deduplicated against (1) via event_id.
 *   3. A transient ?registration=complete URL marker — lets a TikTok
 *      "URL contains" event rule fire the event too.
 * Fully fire-and-forget — never throws, never blocks the sign-up flow.
 */
export function trackSignUp(method: SignUpMethod): void {
  const eventId = newEventId();
  // 1) Browser pixel — best-effort.
  getTtq()?.track('CompleteRegistration', { method }, { event_id: eventId });
  // 2) Server-side Events API — robust, deduplicated against (1).
  void sendServerEvent(method, eventId);
  // 3) URL marker — lets an Events Manager "URL contains" rule fire it too.
  markSignupInUrl();
}
