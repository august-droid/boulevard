import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// DailyLimiter — enforces the free-tier 20-songs-per-day cap.
//
// AsyncStorage is the authoritative source for limit enforcement (we never
// want the user to skip past the cap because a network call was slow).
// Supabase is updated best-effort for cross-device sync and analytics.
//
// "Day" is computed in the user's local timezone so the reset feels natural —
// "you get 20 a day, resets at midnight."

const COUNT_KEY = 'boulevard.daily_listens.count';
const DAY_KEY = 'boulevard.daily_listens.day';

export const FREE_DAILY_LIMIT = 30;

function todayKey(date = new Date()): string {
  // YYYY-MM-DD in local time.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DailyState {
  count: number;
  day: string;
  remaining: number;
  limitHit: boolean;
}

export class DailyLimiter {
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  setUser(userId: string) { this.userId = userId; }

  /** Read the current local count, rolling over if the day has changed. */
  async read(): Promise<DailyState> {
    const day = todayKey();
    const storedDay = await AsyncStorage.getItem(DAY_KEY);
    let count = 0;
    if (storedDay === day) {
      const raw = await AsyncStorage.getItem(COUNT_KEY);
      count = raw ? parseInt(raw, 10) || 0 : 0;
    } else {
      // Day flipped — reset.
      await AsyncStorage.multiSet([[DAY_KEY, day], [COUNT_KEY, '0']]);
    }
    const remaining = Math.max(0, FREE_DAILY_LIMIT - count);
    return { count, day, remaining, limitHit: count >= FREE_DAILY_LIMIT };
  }

  /**
   * Reconcile the local count with Supabase. We take the MAX of the two
   * sources so a user can't reset their count by wiping AsyncStorage on a
   * jailbroken device. Supabase is the source of truth for enforcement;
   * AsyncStorage is the source of truth for speed.
   *
   * Call this once on app start. It's a single round-trip and the result
   * gets pushed back to AsyncStorage so subsequent peeks stay fast.
   */
  async reconcileWithServer(): Promise<DailyState> {
    const local = await this.read();
    if (!HAS_SUPABASE || !supabase || !this.userId) return local;

    try {
      const { data, error } = await supabase
        .from('user_daily_listens')
        .select('count')
        .eq('user_id', this.userId)
        .eq('day', local.day)
        .maybeSingle();

      if (error || !data) return local;
      const serverCount = Math.max(0, data.count ?? 0);
      const merged = Math.max(local.count, serverCount);
      if (merged !== local.count) {
        await AsyncStorage.setItem(COUNT_KEY, String(merged));
      }
      // If only the server was higher, push the merged value back too so
      // both sides agree on the new floor.
      if (merged > serverCount) {
        this.mirror(local.day, merged).catch(() => {});
      }
      const remaining = Math.max(0, FREE_DAILY_LIMIT - merged);
      return { count: merged, day: local.day, remaining, limitHit: merged >= FREE_DAILY_LIMIT };
    } catch {
      return local;
    }
  }

  /**
   * Atomically bump the count by 1 and return the new state.
   * Caller decides what to do when limitHit is true (e.g. show paywall).
   */
  async bump(): Promise<DailyState> {
    const day = todayKey();
    const storedDay = await AsyncStorage.getItem(DAY_KEY);
    let count = 0;
    if (storedDay === day) {
      const raw = await AsyncStorage.getItem(COUNT_KEY);
      count = raw ? parseInt(raw, 10) || 0 : 0;
    }
    count += 1;
    await AsyncStorage.multiSet([[DAY_KEY, day], [COUNT_KEY, String(count)]]);
    this.mirror(day, count).catch(() => {});
    const remaining = Math.max(0, FREE_DAILY_LIMIT - count);
    return { count, day, remaining, limitHit: count >= FREE_DAILY_LIMIT };
  }

  /** Mirror the local count to Supabase. Best-effort; never blocks the UI. */
  private async mirror(day: string, count: number) {
    if (!HAS_SUPABASE || !supabase || !this.userId) return;
    try {
      await supabase
        .from('user_daily_listens')
        .upsert(
          { user_id: this.userId, day, count, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,day' },
        );
    } catch {
      // Local count is authoritative; ignore.
    }
  }
}
