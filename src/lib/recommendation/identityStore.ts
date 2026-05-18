import AsyncStorage from '@react-native-async-storage/async-storage';
import { TasteIdentityProfile } from '@/lib/recommendation/TasteIdentityProfile';

// Persistence + per-user singleton glue for TasteIdentityProfile.
//
// TasteIdentityProfile itself is a pure module (no AsyncStorage) so it stays
// unit-testable. This file is the React-Native host side: it owns the storage
// key, a debounced write, and a per-user singleton cache so the PlayerContext
// (which records + reads), the OnboardingSlate (which reads) and the
// ExploreContext (which reads) all share ONE in-memory instance.

function keyFor(userId: string): string {
  return `boulevard.taste_identity.v1.${userId}`;
}

const cache = new Map<string, TasteIdentityProfile>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 4000;

function schedulePersist(userId: string, profile: TasteIdentityProfile): void {
  const existing = persistTimers.get(userId);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    userId,
    setTimeout(() => {
      persistTimers.delete(userId);
      AsyncStorage.setItem(keyFor(userId), profile.serialize()).catch(() => {
        // best-effort — the profile self-heals from future behaviour
      });
    }, PERSIST_DEBOUNCE_MS),
  );
}

/** The shared identity profile for a user (created on first access). */
export function identityProfileFor(userId: string): TasteIdentityProfile {
  let profile = cache.get(userId);
  if (!profile) {
    profile = new TasteIdentityProfile();
    profile.setOnChange(() => schedulePersist(userId, profile!));
    cache.set(userId, profile);
  }
  return profile;
}

/** Hydrate the user's identity profile from AsyncStorage once. Idempotent. */
export async function hydrateIdentityProfile(userId: string): Promise<TasteIdentityProfile> {
  const profile = identityProfileFor(userId);
  if (profile.isHydrated()) return profile;
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    profile.restoreFrom(raw);
  } catch {
    profile.restoreFrom(null);
  }
  return profile;
}
