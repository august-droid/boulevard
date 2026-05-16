import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// CompletionLimiter enforces Boulevard's free-tier listening cap.
//
// The cap is no longer "N plays per day." A free user gets 10 full listens,
// total, ever. A "full listen" means the user reached at least 90% of a
// song's audio playback (not wall-clock time). Skipping a song before 90%
// does not count. Each unique song id only counts once, so replaying a
// song you already finished does not burn through the cap.
//
// AsyncStorage is authoritative for enforcement so the gate never lags
// behind a slow network. Supabase is the cross-device truth and we always
// take the union of the two sets at boot, so wiping AsyncStorage on a
// jailbroken device cannot regrant a fresh ten plays.
//
// The AsyncStorage key is SCOPED BY USER ID. If we did not scope it,
// switching users on the same device (anonymous → Google, or sign-out →
// new anonymous) would let one user inherit the other's count via the
// "union with local" reconciliation.

const COMPLETED_IDS_KEY_PREFIX = 'boulevard.completed_song_ids.';

/** Resolved storage key for the active user. */
function keyFor(userId: string): string {
  return `${COMPLETED_IDS_KEY_PREFIX}${userId}`;
}

/**
 * Best-effort migration of the legacy single-user key. Old installs wrote
 * to `boulevard.completed_song_ids`. The first time a CompletionLimiter
 * boots for any user, we move that data under their userId-scoped key
 * (so we don't lose the count) and delete the legacy key. After the
 * first migration this is a no-op forever.
 */
const LEGACY_KEY = 'boulevard.completed_song_ids';
async function migrateLegacyKeyOnce(targetUserId: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const existing = await AsyncStorage.getItem(keyFor(targetUserId));
    if (!existing) {
      // Only migrate when the user's own key is empty; otherwise leave
      // the user's data in place.
      await AsyncStorage.setItem(keyFor(targetUserId), raw);
    }
    await AsyncStorage.removeItem(LEGACY_KEY);
  } catch {
    // best-effort
  }
}

export const FREE_COMPLETED_LIMIT = 10;

/**
 * Threshold (0..1) at which a play counts as a full listen.
 *
 * Native: 0.9 — a song heard to 90% counts toward the 10-listen free cap.
 * Web:    0.7 — the web app gates on "10 songs heard to at least 70% each",
 *               after which sign-in is required (no paywall on web).
 *
 * Platform-branched so native enforcement is byte-for-byte unchanged.
 */
export const COMPLETION_THRESHOLD = Platform.OS === 'web' ? 0.7 : 0.9;

export interface CompletionState {
  count: number;
  remaining: number;
  limitHit: boolean;
}

export class CompletionLimiter {
  private userId: string;
  /** In-memory mirror of the persisted set so checks are sync once loaded. */
  private completed: Set<string> = new Set();
  /** Resolves the first time we've loaded the set from AsyncStorage. */
  private readonly loaded: Promise<void>;

  constructor(userId: string) {
    this.userId = userId;
    this.loaded = this.hydrate();
  }

  setUser(userId: string) {
    this.userId = userId;
    this.completed = new Set();
    void this.hydrate();
  }

  private async hydrate(): Promise<void> {
    try {
      await migrateLegacyKeyOnce(this.userId);
      const raw = await AsyncStorage.getItem(keyFor(this.userId));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.completed = new Set(arr.filter((x): x is string => typeof x === 'string'));
        }
      }
    } catch {
      // Corrupt key — leave the set empty.
    }
  }

  /** Snapshot of the current state. Safe before hydration; returns zeros. */
  read(): CompletionState {
    const count = this.completed.size;
    return {
      count,
      remaining: Math.max(0, FREE_COMPLETED_LIMIT - count),
      limitHit: count >= FREE_COMPLETED_LIMIT,
    };
  }

  /**
   * True when the user has already used all of their free listens. Callers
   * should refuse to start a NEW song; the currently-playing song should be
   * allowed to finish so the user is not yanked out of a track mid-listen.
   */
  isLimitHit(): boolean {
    return this.completed.size >= FREE_COMPLETED_LIMIT;
  }

  /**
   * Reconcile local state with Supabase. We take the UNION of the two sets
   * so neither side can erase a completion the other already knows about.
   * Call this once on app start after construction. Resolves with the
   * post-merge snapshot.
   */
  async reconcileWithServer(): Promise<CompletionState> {
    await this.loaded;
    if (!HAS_SUPABASE || !supabase || !this.userId) return this.read();

    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('completed_song_ids')
        .eq('user_id', this.userId)
        .maybeSingle();

      if (error || !data) return this.read();
      const serverIds = Array.isArray(data.completed_song_ids)
        ? (data.completed_song_ids as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      const before = this.completed.size;
      for (const id of serverIds) this.completed.add(id);
      const after = this.completed.size;

      if (after !== before) {
        await AsyncStorage.setItem(keyFor(this.userId), JSON.stringify([...this.completed]));
      }
      // Mirror the merged set back so the server matches the union too.
      if (after > serverIds.length) {
        void this.mirror();
      }
    } catch {
      // Network blip — local set is still authoritative.
    }
    return this.read();
  }

  /**
   * Register that `songId` was heard to at least 90% completion. Idempotent:
   * the same song id only counts once. Returns the new state so the caller
   * can react if this completion is the one that crossed the cap.
   */
  async registerCompletion(songId: string): Promise<CompletionState> {
    await this.loaded;
    if (!songId) return this.read();
    if (this.completed.has(songId)) return this.read();

    this.completed.add(songId);
    try {
      await AsyncStorage.setItem(keyFor(this.userId), JSON.stringify([...this.completed]));
    } catch {
      // AsyncStorage shouldn't fail in practice; in-memory state still gates.
    }
    void this.mirror();
    return this.read();
  }

  /** Best-effort write of the current set to Supabase. */
  private async mirror(): Promise<void> {
    if (!HAS_SUPABASE || !supabase || !this.userId) return;
    try {
      await supabase
        .from('user_profiles')
        .upsert(
          {
            user_id: this.userId,
            completed_song_ids: [...this.completed],
            completed_song_count: this.completed.size,
          },
          { onConflict: 'user_id' },
        );
    } catch {
      // Best-effort; local set continues to gate.
    }
  }
}
