import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { SIGNED_IN_CELEBRATE_KEY } from '@/lib/auth/socialAuth';
import { registerPushTokenForUser } from '@/lib/push/registerPushToken';
import { setAppsFlyerCustomerUserId } from '@/lib/attribution/AppsFlyer';
import { trackSignUp } from '@/lib/attribution/TikTokPixel';
import {
  configureBilling,
  onCustomerInfo,
  isPremium as customerIsPremium,
  getCustomerInfo,
  HAS_BILLING,
} from '@/lib/billing/Billing';

// Auth model for Boulevard.
//
// The spec calls for no long onboarding. Music plays instantly. We achieve
// this by signing the user in anonymously on first launch (a real Supabase
// auth.users row with a stable auth.uid), and only prompting them to attach
// a real identity after they've completed five full songs.
//
// Anonymous-to-real upgrades happen via supabase.auth.updateUser (email)
// or supabase.auth.linkIdentity (social). Both keep the same auth.uid, so
// likes, saves, taste, playlists, push tokens, and the RevenueCat
// subscription state all follow the user across the upgrade with no
// migration step.
//
// The free-tier cap is "10 full listens" (any song heard to >=90%). The
// limiter that enforces it lives in PlayerContext; this context just
// mirrors its state so screens can subscribe.

const ANON_ID_KEY = 'boulevard.anon_user_id';
const SAVE_COUNT_KEY = 'boulevard.engagement_count';
const SONGS_HEARD_KEY = 'boulevard.songs_heard';
const SKIP_COUNT_KEY = 'boulevard.skip_count';
const TRIAL_KEY = 'boulevard.trial_started_at';
const PAYWALL_SHOWN_KEY = 'boulevard.paywall_shown_at';
const SIGNED_UP_KEY = 'boulevard.signed_up_at';
const SIGNUP_PROMPT_SHOWN_KEY = 'boulevard.signup_prompt_shown_at';
// Set once songsHeard crosses 20 — flips the Library into "AI ready" mode
// and tells the Music Factory cron to start generating personalized drops.
const PERSONALIZATION_UNLOCKED_KEY = 'boulevard.personalization_unlocked_at';

export interface AuthValue {
  userId: string | null;
  isAnonymous: boolean;
  /**
   * True once the user has attached a real identity (email or social) OR
   * the legacy local "signed up" flag is set. Derived from the live
   * Supabase session so an in-place anonymous upgrade flips this without
   * a refresh.
   */
  hasSignedUp: boolean;
  /** Signed-in user's email address; null while anonymous. */
  email: string | null;
  /** Display name from the social provider (e.g. Google full name); null if unknown. */
  displayName: string | null;
  /** Social-provider profile photo URL (e.g. Google); null if none. */
  avatarUrl: string | null;
  /**
   * Briefly true right after the user attaches a real identity (social or
   * email). Drives the one-time "you're signed in" confirmation animation.
   */
  justSignedIn: boolean;
  /** Clear `justSignedIn` once the confirmation animation has played. */
  acknowledgeSignIn: () => void;
  isPremium: boolean;
  trialStartedAt: string | null;
  engagementCount: number;
  songsHeard: number;
  skipCount: number;
  /** Unique songs heard to >=90% completion. Lifetime, persisted. */
  completedCount: number;
  /** True when completedCount >= FREE_COMPLETED_LIMIT. */
  completedLimitHit: boolean;
  /**
   * Bumps every time a play is blocked by the completion cap. Lets the
   * paywall trigger effect re-fire after the user dismisses it and tries
   * to play again — otherwise the second attempt would fail silently.
   */
  blockedAttempts: number;
  paywallShownAt: string | null;
  signupPromptShownAt: string | null;
  /** ISO timestamp when songsHeard first crossed the personalization threshold. */
  personalizationUnlockedAt: string | null;
  /**
   * Web only: true once an anonymous listener has used their 5 free plays
   * and must sign in to continue. Always false on native — native gates on
   * completions (signup prompt at 5, paywall at 10) instead.
   */
  webLoginRequired: boolean;
  bumpEngagement: () => Promise<void>;
  bumpSongsHeard: () => Promise<void>;
  bumpSkipCount: () => Promise<void>;
  bumpBlockedAttempts: () => void;
  /** Push live completion-cap state up from PlayerContext's limiter. */
  setCompletionState: (count: number, limitHit: boolean) => void;
  markPaywallShown: () => Promise<void>;
  /**
   * Set the local "we showed the SignupSheet at least once" flag. Mirrored
   * to user_profiles so the sheet does not re-fire on a second device.
   */
  markSignupPromptShown: () => Promise<void>;
  markSignedUp: () => Promise<void>;
  /** Called once when the user crosses the personalization unlock threshold. */
  markPersonalizationUnlocked: () => Promise<void>;
  startTrial: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * True while the post-signup verification is in flight. The window
   * between "Supabase reports !is_anonymous" and "user_profiles.has_signed_up
   * is confirmed true at the DB" is short but non-zero, and during it
   * comment-write RLS will refuse the insert. Surfaces in the UI as a
   * brief "Finishing sign-in..." state on gated composers so the user
   * never types into a window that's about to bounce.
   */
  signupConfirming: boolean;
}

const AuthCtx = createContext<AuthValue | null>(null);

/**
 * After an anonymous user upgrades (email signup, OAuth link), the DB
 * RLS policies on song_comments + song_comment_likes refuse inserts
 * until user_profiles.has_signed_up = true is visible. The upsert is
 * normally fire-and-forget, which means the FIRST comment posted right
 * after signup can race the write and get bounced.
 *
 * This helper makes the upgrade transition safe:
 *   1. Eagerly upsert has_signed_up = true onto the profile.
 *   2. SELECT the row back and only resolve when the flag is true.
 *   3. Bounded retry loop (small delay) in case of replica routing.
 *
 * The caller flips a UI "Finishing sign-in..." state while this is in
 * flight, then re-ungates the composer.
 */
async function confirmHasSignedUp(uid: string): Promise<boolean> {
  if (!HAS_SUPABASE || !supabase) return false;
  try {
    await supabase
      .from('user_profiles')
      .upsert({ user_id: uid, has_signed_up: true }, { onConflict: 'user_id' });
  } catch {
    // Even if the upsert errors (rare), the row may already exist with
    // the flag set from a previous device. Fall through to the SELECT
    // path which is the authoritative check.
  }
  // Up to ~2.5 s total (10 × 250ms) — covers normal write propagation
  // plus a worst-case replica-routing hiccup. Past that we give up
  // and let the user try again rather than hanging the UI forever.
  for (let i = 0; i < 10; i++) {
    try {
      const { data } = await supabase
        .from('user_profiles')
        .select('has_signed_up')
        .eq('user_id', uid)
        .maybeSingle();
      if (data && (data as { has_signed_up?: boolean }).has_signed_up === true) {
        return true;
      }
    } catch {
      // Network blip — keep retrying within the budget.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Pull the human-facing identity (email + display name) off a Supabase auth
// user. Anonymous users have neither, so this yields nulls for them.
function identityFromUser(
  user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined,
): { email: string | null; displayName: string | null; avatarUrl: string | null } {
  if (!user) return { email: null, displayName: null, avatarUrl: null };
  const meta = user.user_metadata ?? {};
  const rawName = meta.full_name ?? meta.name;
  const displayName =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
  // Anonymous users carry `email: ''` (an empty string, not null), so it must
  // be normalized to null — otherwise `email ?? fallback` keeps the blank.
  const rawEmail = user.email;
  const email =
    typeof rawEmail === 'string' && rawEmail.trim().length > 0 ? rawEmail : null;
  // Google returns the profile photo as `avatar_url`; some providers use `picture`.
  const rawAvatar = meta.avatar_url ?? meta.picture;
  const avatarUrl =
    typeof rawAvatar === 'string' && rawAvatar.trim().length > 0 ? rawAvatar.trim() : null;
  return { email, displayName, avatarUrl };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [justSignedIn, setJustSignedIn] = useState(false);
  const [engagementCount, setEngagementCount] = useState(0);
  const [songsHeard, setSongsHeard] = useState(0);
  const [skipCount, setSkipCount] = useState(0);
  const [trialStartedAt, setTrialStartedAt] = useState<string | null>(null);
  const [paywallShownAt, setPaywallShownAt] = useState<string | null>(null);
  const [signupPromptShownAt, setSignupPromptShownAt] = useState<string | null>(null);
  const [signedUpAt, setSignedUpAt] = useState<string | null>(null);
  const [personalizationUnlockedAt, setPersonalizationUnlockedAt] = useState<string | null>(null);
  // True when the user has an active premium entitlement in RevenueCat.
  // Updates live via the customer-info listener wired below.
  const [billingPremium, setBillingPremium] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [completedLimitHit, setCompletedLimitHit] = useState(false);
  const [blockedAttempts, setBlockedAttempts] = useState(0);
  const [signupConfirming, setSignupConfirming] = useState(false);
  // Track which user ids we've already confirmed has_signed_up=true for,
  // so we don't re-run the verify loop on every token refresh / USER_UPDATED
  // event. A ref instead of state so this lookup never causes a render.
  const confirmedRef = useRef<Set<string>>(new Set());
  // Previous anonymity state — lets onAuthStateChange spot the anonymous→real
  // transition (an in-place sign-in) and fire the justSignedIn confirmation.
  const prevAnonRef = useRef<boolean | null>(null);

  useEffect(() => {
    (async () => {
      // 1) If a Supabase session exists, prefer it.
      let resolvedFromSupabase = false;
      if (HAS_SUPABASE && supabase) {
        try {
          const { data } = await supabase.auth.getSession();
          if (data.session?.user?.id) {
            const uid = data.session.user.id;
            const anon = data.session.user.is_anonymous === true;
            setUserId(uid);
            setIsAnonymous(anon);
            const ident = identityFromUser(data.session.user);
            setEmail(ident.email);
            setDisplayName(ident.displayName);
            setAvatarUrl(ident.avatarUrl);
            // Web OAuth is a full-page redirect — the sign-in lands as a
            // fresh load. socialAuth.web.ts drops a flag before redirecting;
            // if it survived to here and the session is real, the user just
            // signed in, so fire the confirmation. Read-once.
            if (Platform.OS === 'web') {
              try {
                if (window.localStorage.getItem(SIGNED_IN_CELEBRATE_KEY)) {
                  window.localStorage.removeItem(SIGNED_IN_CELEBRATE_KEY);
                  if (!anon) {
                    setJustSignedIn(true);
                    // The celebrate flag is only ever set right before an
                    // OAuth redirect kicked off from the SignupSheet (web =
                    // Google). Landing back here non-anonymous means that
                    // sign-up completed — fire the TikTok conversion event.
                    trackSignUp('google');
                  }
                }
              } catch {
                // storage unavailable — skip the confirmation
              }
            }
            // Cold-start verify: a non-anonymous session whose has_signed_up
            // flag never got written (crash mid-upgrade, anon-link that
            // didn't reach the upsert) would otherwise leave the user
            // unable to comment forever. Re-run the verify loop the
            // first time we see this uid in the !anon state.
            if (!anon && !confirmedRef.current.has(uid)) {
              confirmedRef.current.add(uid);
              setSignupConfirming(true);
              void confirmHasSignedUp(uid).finally(() => setSignupConfirming(false));
            }
            resolvedFromSupabase = true;
          }
        } catch {
          // Network error — fall through to the anonymous-id path so the
          // app boots regardless of connectivity.
        }
      }

      // 2) No session yet — sign in anonymously so the user gets a real
      //    auth.users row + JWT. Without this, every RLS-gated write
      //    (comments, likes, playlists, etc.) silently fails because
      //    auth.uid() is null. The local-UUID fallback only kicks in if
      //    anonymous auth is disabled at the project level or we're offline.
      if (!resolvedFromSupabase && HAS_SUPABASE && supabase) {
        try {
          const { data, error } = await supabase.auth.signInAnonymously();
          if (!error && data.session?.user?.id) {
            setUserId(data.session.user.id);
            setIsAnonymous(true);
            resolvedFromSupabase = true;
          }
        } catch {
          // fall through to local UUID
        }
      }

      // 3) Last resort: stable local UUID. RLS-gated features won't work
      //    in this mode, but the rest of the app boots and plays music.
      if (!resolvedFromSupabase) {
        let id = await AsyncStorage.getItem(ANON_ID_KEY);
        if (!id) {
          id = String(uuid.v4());
          await AsyncStorage.setItem(ANON_ID_KEY, id);
        }
        setUserId(id);
        setIsAnonymous(true);
      }

      const eng = await AsyncStorage.getItem(SAVE_COUNT_KEY);
      if (eng) setEngagementCount(parseInt(eng, 10) || 0);

      const heard = await AsyncStorage.getItem(SONGS_HEARD_KEY);
      if (heard) setSongsHeard(parseInt(heard, 10) || 0);

      const skips = await AsyncStorage.getItem(SKIP_COUNT_KEY);
      if (skips) setSkipCount(parseInt(skips, 10) || 0);

      const trial = await AsyncStorage.getItem(TRIAL_KEY);
      if (trial) setTrialStartedAt(trial);

      const shown = await AsyncStorage.getItem(PAYWALL_SHOWN_KEY);
      if (shown) setPaywallShownAt(shown);

      const signupShown = await AsyncStorage.getItem(SIGNUP_PROMPT_SHOWN_KEY);
      if (signupShown) setSignupPromptShownAt(signupShown);

      const signed = await AsyncStorage.getItem(SIGNED_UP_KEY);
      if (signed) setSignedUpAt(signed);

      const unlocked = await AsyncStorage.getItem(PERSONALIZATION_UNLOCKED_KEY);
      if (unlocked) setPersonalizationUnlockedAt(unlocked);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for live session changes so an in-place anonymous upgrade flips
  // isAnonymous / hasSignedUp without needing the user to refresh the app.
  // Fires for sign-in, sign-out, token refresh, identity-link, and
  // updateUser (the path that converts an anonymous user into an email
  // user without changing auth.uid).
  //
  // When the session transitions to non-anonymous, we mirror that into
  // user_profiles.has_signed_up=true AND then verify the flag is visible
  // via a SELECT before flipping signupConfirming to false. The window
  // between "auth says you're signed up" and "RLS-protected comment
  // inserts succeed" is short but real — without the verify step the
  // first comment after signup races the upsert and gets bounced.
  useEffect(() => {
    if (!HAS_SUPABASE || !supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      if (u?.id) {
        setUserId(u.id);
        const nowAnon = u.is_anonymous === true;
        setIsAnonymous(nowAnon);
        const ident = identityFromUser(u);
        setEmail(ident.email);
        setDisplayName(ident.displayName);
        setAvatarUrl(ident.avatarUrl);
        // Anonymous→real inside a live session is an in-place sign-in (email
        // upgrade, or native OAuth) — fire the confirmation. Web OAuth comes
        // back as a fresh load instead and is handled by the flag above.
        if (prevAnonRef.current === true && !nowAnon) {
          setJustSignedIn(true);
        }
        prevAnonRef.current = nowAnon;
        if (!nowAnon && !confirmedRef.current.has(u.id)) {
          confirmedRef.current.add(u.id);
          setSignupConfirming(true);
          void confirmHasSignedUp(u.id).finally(() => setSignupConfirming(false));
        }
      } else {
        // Signed out — fall back to a fresh anonymous session if we have
        // Supabase, otherwise a local UUID. We don't proactively wipe
        // engagement counters; signOut() handles that path explicitly.
      }
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  // Register the Expo push token for this user once auth resolves, and tie
  // the AppsFlyer attribution profile to the same app user id. The user id
  // is stable across the anonymous-to-real upgrade, so attribution follows
  // the user through sign-up with no extra work. setAppsFlyerCustomerUserId
  // no-ops when AppsFlyer is unconfigured and never throws.
  useEffect(() => {
    if (!userId) return;
    void registerPushTokenForUser(userId);
    setAppsFlyerCustomerUserId(userId);
  }, [userId]);

  // Wire RevenueCat: configure once the user id resolves, then mirror the
  // active-entitlement state into local `billingPremium`. The listener
  // fires on every server-side change (renewal, refund, expire), so the
  // app reacts in real time without needing to poll. Because the user id
  // is stable across the anonymous-to-real upgrade, the same RevenueCat
  // customer persists; subscriptions survive sign-up with no extra work.
  useEffect(() => {
    if (!HAS_BILLING) return;
    if (!userId) return;
    let cancelled = false;
    configureBilling(userId).then(async () => {
      if (cancelled) return;
      const info = await getCustomerInfo();
      if (info) setBillingPremium(customerIsPremium(info));
    });
    const off = onCustomerInfo((info) => {
      setBillingPremium(customerIsPremium(info));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [userId]);

  // Mirror premium status into user_profiles for the admin analytics
  // dashboard. Premium lives in RevenueCat (and the legacy local trial flag),
  // so the database has no other way to read free→premium conversion.
  // Fire-and-forget, best-effort — exactly like the personalization-unlock
  // and signup-prompt mirrors above; it never blocks or breaks anything.
  useEffect(() => {
    if (!HAS_SUPABASE || !supabase || !userId) return;
    const trialActive = trialStartedAt
      ? (Date.now() - new Date(trialStartedAt).getTime()) / (1000 * 60 * 60 * 24) <= 3
      : false;
    if (!(billingPremium || trialActive)) return;
    void (async () => {
      try {
        await supabase!
          .from('user_profiles')
          .upsert({ user_id: userId, is_premium: true }, { onConflict: 'user_id' });
        // Stamp the conversion moment once — only when not already set.
        await supabase!
          .from('user_profiles')
          .update({ premium_since: new Date().toISOString() })
          .eq('user_id', userId)
          .is('premium_since', null);
      } catch {
        // Best-effort — analytics tolerate a missed mirror.
      }
    })();
  }, [userId, billingPremium, trialStartedAt]);

  // Mirror the signed-in user's social identity (display name + photo) into
  // user_profiles so it shows on their comments instead of a generated
  // handle. Fire-and-forget, best-effort; the upsert is idempotent.
  useEffect(() => {
    if (!HAS_SUPABASE || !supabase || !userId) return;
    if (isAnonymous) return;
    if (!displayName && !avatarUrl) return;
    void (async () => {
      try {
        const patch: Record<string, unknown> = { user_id: userId };
        if (displayName) patch.display_name = displayName;
        if (avatarUrl) patch.avatar_url = avatarUrl;
        await supabase!.from('user_profiles').upsert(patch, { onConflict: 'user_id' });
      } catch {
        // Best-effort — comments tolerate a missed mirror.
      }
    })();
  }, [userId, isAnonymous, displayName, avatarUrl]);

  const value = useMemo<AuthValue>(() => {
    const trialActive = (() => {
      if (!trialStartedAt) return false;
      const started = new Date(trialStartedAt).getTime();
      const days = (Date.now() - started) / (1000 * 60 * 60 * 24);
      return days <= 3;
    })();
    return {
      userId,
      isAnonymous,
      // hasSignedUp reflects either a real Supabase identity OR the legacy
      // local marker. Once supabase reports !is_anonymous the user is
      // permanently signed up regardless of the local flag.
      hasSignedUp: !isAnonymous || Boolean(signedUpAt),
      email,
      displayName,
      avatarUrl,
      justSignedIn,
      acknowledgeSignIn: () => setJustSignedIn(false),
      // Premium is whichever signal says so:
      //   • billingPremium: live RevenueCat entitlement (the real source of truth)
      //   • trialActive:    legacy 3-day local flag, used until billing lands
      // Either being true unblocks the listening cap.
      isPremium: billingPremium || trialActive,
      trialStartedAt,
      engagementCount,
      songsHeard,
      skipCount,
      completedCount,
      completedLimitHit,
      blockedAttempts,
      signupConfirming,
      paywallShownAt,
      signupPromptShownAt,
      personalizationUnlockedAt,
      // Web login gate. Fires once an anonymous web listener has heard 10
      // songs to >=70% each (completedLimitHit, tracked by CompletionLimiter
      // and persisted + server-reconciled). Signing in flips `isAnonymous`
      // false and lifts the gate.
      webLoginRequired:
        Platform.OS === 'web' && isAnonymous && completedLimitHit,
      bumpEngagement: async () => {
        const next = engagementCount + 1;
        setEngagementCount(next);
        await AsyncStorage.setItem(SAVE_COUNT_KEY, String(next));
      },
      bumpSongsHeard: async () => {
        const next = songsHeard + 1;
        setSongsHeard(next);
        await AsyncStorage.setItem(SONGS_HEARD_KEY, String(next));
      },
      bumpSkipCount: async () => {
        const next = skipCount + 1;
        setSkipCount(next);
        await AsyncStorage.setItem(SKIP_COUNT_KEY, String(next));
      },
      setCompletionState: (count, limitHit) => {
        setCompletedCount(count);
        setCompletedLimitHit(limitHit);
      },
      bumpBlockedAttempts: () => setBlockedAttempts((c) => c + 1),
      markPaywallShown: async () => {
        const now = new Date().toISOString();
        setPaywallShownAt(now);
        await AsyncStorage.setItem(PAYWALL_SHOWN_KEY, now);
      },
      markSignupPromptShown: async () => {
        if (signupPromptShownAt) return;
        const now = new Date().toISOString();
        setSignupPromptShownAt(now);
        await AsyncStorage.setItem(SIGNUP_PROMPT_SHOWN_KEY, now);
        if (HAS_SUPABASE && supabase && userId) {
          try {
            await supabase
              .from('user_profiles')
              .upsert(
                { user_id: userId, signup_prompt_shown_at: now },
                { onConflict: 'user_id' },
              );
          } catch {
            // best-effort
          }
        }
      },
      markSignedUp: async () => {
        const now = new Date().toISOString();
        setSignedUpAt(now);
        await AsyncStorage.setItem(SIGNED_UP_KEY, now);
      },
      markPersonalizationUnlocked: async () => {
        if (personalizationUnlockedAt) return;
        const now = new Date().toISOString();
        setPersonalizationUnlockedAt(now);
        await AsyncStorage.setItem(PERSONALIZATION_UNLOCKED_KEY, now);
        if (HAS_SUPABASE && supabase && userId) {
          try {
            await supabase
              .from('user_profiles')
              .upsert(
                { user_id: userId, personalization_unlocked_at: now },
                { onConflict: 'user_id' },
              );
          } catch {
            // Best-effort.
          }
        }
      },
      startTrial: async () => {
        const now = new Date().toISOString();
        setTrialStartedAt(now);
        await AsyncStorage.setItem(TRIAL_KEY, now);
      },
      signOut: async () => {
        // First clear local engagement state. We do this before kicking
        // Supabase so the UI flips to "fresh start" immediately.
        await AsyncStorage.multiRemove([
          SAVE_COUNT_KEY, SONGS_HEARD_KEY, SKIP_COUNT_KEY, TRIAL_KEY,
          PAYWALL_SHOWN_KEY, SIGNED_UP_KEY, SIGNUP_PROMPT_SHOWN_KEY,
          PERSONALIZATION_UNLOCKED_KEY,
        ]);
        // Wipe ALL completed-song-id keys (both legacy and per-user
        // scoped) so the next session genuinely starts at zero free
        // listens.
        try {
          const keys = await AsyncStorage.getAllKeys();
          const completionKeys = keys.filter((k) =>
            k === 'boulevard.completed_song_ids' ||
            k.startsWith('boulevard.completed_song_ids.'),
          );
          if (completionKeys.length > 0) {
            await AsyncStorage.multiRemove(completionKeys);
          }
        } catch {
          // best-effort
        }

        // End the Supabase session, then immediately start a NEW
        // anonymous one. Without the re-anonymize step the client would
        // sit in local-UUID limbo with auth.uid() = null, and every
        // RLS-gated write (likes, saves, comments, playlists) would
        // silently fail until the next cold start.
        let newAnonId: string | null = null;
        if (HAS_SUPABASE && supabase) {
          try { await supabase.auth.signOut(); } catch { /* ignore */ }
          try {
            const { data, error } = await supabase.auth.signInAnonymously();
            if (!error && data.session?.user?.id) {
              newAnonId = data.session.user.id;
            }
          } catch { /* ignore */ }
        }

        // Fall back to a local UUID if Supabase couldn't issue a fresh
        // anonymous session (no network / anon auth disabled). RLS
        // writes won't work in that mode but the app still boots.
        if (!newAnonId) {
          newAnonId = String(uuid.v4());
          await AsyncStorage.setItem(ANON_ID_KEY, newAnonId);
        } else {
          // Supabase issued a fresh anon user — drop the local-UUID
          // fallback so a future offline boot doesn't accidentally
          // resurrect it.
          await AsyncStorage.removeItem(ANON_ID_KEY);
        }

        setUserId(newAnonId);
        setIsAnonymous(true);
        setEmail(null);
        setDisplayName(null);
        setAvatarUrl(null);
        setJustSignedIn(false);
        setEngagementCount(0);
        setSongsHeard(0);
        setSkipCount(0);
        setTrialStartedAt(null);
        setPaywallShownAt(null);
        setSignupPromptShownAt(null);
        setSignedUpAt(null);
        setPersonalizationUnlockedAt(null);
        setCompletedCount(0);
        setCompletedLimitHit(false);
      },
    };
  }, [
    userId, isAnonymous, email, displayName, avatarUrl, justSignedIn, engagementCount, songsHeard, skipCount,
    trialStartedAt, paywallShownAt, signupPromptShownAt, signedUpAt,
    personalizationUnlockedAt, billingPremium,
    completedCount, completedLimitHit, blockedAttempts, signupConfirming,
  ]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
