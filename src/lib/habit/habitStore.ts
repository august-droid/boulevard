import AsyncStorage from '@react-native-async-storage/async-storage';
import { HabitProfile } from '@/lib/habit/HabitProfile';

// Persistence + per-user singleton glue for HabitProfile.
//
// HabitProfile itself is a pure module (no AsyncStorage) so it stays
// unit-testable. This file is the React-Native host side: it owns the
// AsyncStorage key, a debounced write, and a per-user singleton cache so the
// PlayerContext (which records) and the ExploreContext (which reads) share
// one in-memory instance instead of racing two over the same key.

function keyFor(userId: string): string {
  return `boulevard.habit_profile.v1.${userId}`;
}

const cache = new Map<string, HabitProfile>();
/** Pending debounced-persist timers, keyed by userId. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

const PERSIST_DEBOUNCE_MS = 4000;

function schedulePersist(userId: string, profile: HabitProfile): void {
  const existing = persistTimers.get(userId);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    userId,
    setTimeout(() => {
      persistTimers.delete(userId);
      AsyncStorage.setItem(keyFor(userId), profile.serialize()).catch(() => {
        // best-effort — the profile self-heals from future events
      });
    }, PERSIST_DEBOUNCE_MS),
  );
}

/** The shared HabitProfile instance for a user (created on first access). */
export function habitProfileFor(userId: string): HabitProfile {
  let profile = cache.get(userId);
  if (!profile) {
    profile = new HabitProfile();
    profile.setOnChange(() => schedulePersist(userId, profile!));
    cache.set(userId, profile);
  }
  return profile;
}

/**
 * Hydrate the user's habit profile from AsyncStorage once. Idempotent — a
 * second call returns the already-hydrated instance without re-reading.
 */
export async function hydrateHabitProfile(userId: string): Promise<HabitProfile> {
  const profile = habitProfileFor(userId);
  if (profile.isHydrated()) return profile;
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    profile.restoreFrom(raw);
  } catch {
    profile.restoreFrom(null);
  }
  return profile;
}
