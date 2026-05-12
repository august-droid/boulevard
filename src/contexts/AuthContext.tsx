import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Auth model for Boulevard.
//
// The spec calls for *no long onboarding* — music plays instantly. We achieve
// this by issuing an anonymous local user id on first launch, persisting it in
// AsyncStorage, and only prompting the user to sign in after they've shown
// engagement (likes/saves). When Supabase auth is configured we attach the
// real auth.user.id once they sign in; until then the local id is used.

const ANON_ID_KEY = 'boulevard.anon_user_id';
const SAVE_COUNT_KEY = 'boulevard.engagement_count';
const SONGS_HEARD_KEY = 'boulevard.songs_heard';
const SKIP_COUNT_KEY = 'boulevard.skip_count';
const TRIAL_KEY = 'boulevard.trial_started_at';
const PAYWALL_SHOWN_KEY = 'boulevard.paywall_shown_at';
const SIGNED_UP_KEY = 'boulevard.signed_up_at';
// Set once songsHeard crosses 100 — flips the Library into "AI ready" mode
// and tells the Music Factory cron to start generating personalized drops.
const PERSONALIZATION_UNLOCKED_KEY = 'boulevard.personalization_unlocked_at';

export interface AuthValue {
  userId: string | null;
  isAnonymous: boolean;
  // True once the user completes the email signup flow. Distinct from
  // "isPremium" — a signed-up free user has the same listening cap (20/day)
  // but isn't anonymous anymore.
  hasSignedUp: boolean;
  isPremium: boolean;
  trialStartedAt: string | null;
  engagementCount: number;
  songsHeard: number;
  skipCount: number;
  // Daily song-play counter (free tier: 20/day, resets each calendar day).
  dailyCount: number;
  dailyLimitHit: boolean;
  /**
   * Bumps every time a play is *blocked* by the daily cap. Lets the paywall
   * trigger effect re-fire after the user dismisses it and tries to play
   * again — otherwise the second attempt would fail silently.
   */
  blockedAttempts: number;
  paywallShownAt: string | null;
  /** ISO timestamp when songsHeard first crossed 100. Null until then. */
  personalizationUnlockedAt: string | null;
  bumpEngagement: () => Promise<void>;
  bumpSongsHeard: () => Promise<void>;
  bumpSkipCount: () => Promise<void>;
  bumpBlockedAttempts: () => void;
  setDailyState: (count: number, limitHit: boolean) => void;
  markPaywallShown: () => Promise<void>;
  markSignedUp: () => Promise<void>;
  /** Called once when the user crosses 100 songs heard. */
  markPersonalizationUnlocked: () => Promise<void>;
  startTrial: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [engagementCount, setEngagementCount] = useState(0);
  const [songsHeard, setSongsHeard] = useState(0);
  const [skipCount, setSkipCount] = useState(0);
  const [trialStartedAt, setTrialStartedAt] = useState<string | null>(null);
  const [paywallShownAt, setPaywallShownAt] = useState<string | null>(null);
  const [signedUpAt, setSignedUpAt] = useState<string | null>(null);
  const [personalizationUnlockedAt, setPersonalizationUnlockedAt] = useState<string | null>(null);
  const [dailyCount, setDailyCount] = useState(0);
  const [dailyLimitHit, setDailyLimitHit] = useState(false);
  const [blockedAttempts, setBlockedAttempts] = useState(0);

  useEffect(() => {
    (async () => {
      // 1) If a Supabase session exists, prefer it. Track success via a local
      //    variable — `setUserId` is async and `userId` from the closure will
      //    still be null on the very next line, so we can't read it to decide
      //    whether to fall back to the anonymous id below.
      let resolvedFromSupabase = false;
      if (HAS_SUPABASE && supabase) {
        try {
          const { data } = await supabase.auth.getSession();
          if (data.session?.user?.id) {
            setUserId(data.session.user.id);
            setIsAnonymous(false);
            resolvedFromSupabase = true;
          }
        } catch {
          // Network error — fall through to the anonymous-id path so the app
          // boots regardless of connectivity.
        }
      }

      // 2) Otherwise mint or load a stable local anonymous id.
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

      const signed = await AsyncStorage.getItem(SIGNED_UP_KEY);
      if (signed) setSignedUpAt(signed);

      const unlocked = await AsyncStorage.getItem(PERSONALIZATION_UNLOCKED_KEY);
      if (unlocked) setPersonalizationUnlockedAt(unlocked);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthValue>(() => {
    const trialActive = (() => {
      if (!trialStartedAt) return false;
      const started = new Date(trialStartedAt).getTime();
      const days = (Date.now() - started) / (1000 * 60 * 60 * 24);
      return days <= 3;
    })();
    return {
      userId,
      isAnonymous: isAnonymous && !signedUpAt,
      hasSignedUp: Boolean(signedUpAt),
      isPremium: trialActive, // wire to real entitlement later
      trialStartedAt,
      engagementCount,
      songsHeard,
      skipCount,
      dailyCount,
      dailyLimitHit,
      blockedAttempts,
      paywallShownAt,
      personalizationUnlockedAt,
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
      setDailyState: (count, limitHit) => {
        setDailyCount(count);
        setDailyLimitHit(limitHit);
      },
      bumpBlockedAttempts: () => setBlockedAttempts((c) => c + 1),
      markPaywallShown: async () => {
        const now = new Date().toISOString();
        setPaywallShownAt(now);
        await AsyncStorage.setItem(PAYWALL_SHOWN_KEY, now);
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
        // Best-effort mirror to Supabase — this is the flag the Music Factory
        // cron polls to know which users to generate personalized drops for.
        if (HAS_SUPABASE && supabase && userId) {
          try {
            await supabase
              .from('user_profiles')
              .upsert(
                { user_id: userId, personalization_unlocked_at: now },
                { onConflict: 'user_id' },
              );
          } catch {
            // Best-effort — local flag is authoritative for the UI gate.
          }
        }
      },
      startTrial: async () => {
        const now = new Date().toISOString();
        setTrialStartedAt(now);
        await AsyncStorage.setItem(TRIAL_KEY, now);
      },
      signOut: async () => {
        if (HAS_SUPABASE && supabase) await supabase.auth.signOut();
        await AsyncStorage.multiRemove([
          ANON_ID_KEY, SAVE_COUNT_KEY, SONGS_HEARD_KEY,
          SKIP_COUNT_KEY, TRIAL_KEY, PAYWALL_SHOWN_KEY, SIGNED_UP_KEY,
          PERSONALIZATION_UNLOCKED_KEY,
        ]);
        const id = String(uuid.v4());
        await AsyncStorage.setItem(ANON_ID_KEY, id);
        setUserId(id);
        setIsAnonymous(true);
        setEngagementCount(0);
        setSongsHeard(0);
        setSkipCount(0);
        setTrialStartedAt(null);
        setPaywallShownAt(null);
        setSignedUpAt(null);
        setPersonalizationUnlockedAt(null);
        setDailyCount(0);
        setDailyLimitHit(false);
      },
    };
  }, [
    userId, isAnonymous, engagementCount, songsHeard, skipCount,
    trialStartedAt, paywallShownAt, signedUpAt, personalizationUnlockedAt,
    dailyCount, dailyLimitHit, blockedAttempts,
  ]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
