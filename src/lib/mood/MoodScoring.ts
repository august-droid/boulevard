import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChipMoodId, DEFAULT_MOOD_ORDER } from '@/lib/mood/moodCatalog';

// Dynamic mood ordering (spec PART 2).
//
// Every mood interaction is stored as a timestamped event. A mood's score is
// the recency-weighted sum of its events, so recent behavior dominates and one
// old burst of activity cannot pin a mood to the top forever.
//
//   mood_score(mood) = Σ events  base_weight(kind) * recency_weight(age)
//
// Persisted to AsyncStorage, scoped per user. Events older than 30 days are
// pruned on hydrate so the record stays compact.

export type MoodEventKind = 'click' | 'start' | 'completion' | 'replay' | 'save_like' | 'skip';

// Spec PART 2 base weights.
const BASE_WEIGHT: Record<MoodEventKind, number> = {
  click: 1,
  start: 2,
  completion: 5,
  replay: 7,
  save_like: 9,
  skip: -5,
};

interface MoodEvent {
  m: ChipMoodId;
  k: MoodEventKind;
  t: number; // epoch ms
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PRUNE_MS = 30 * DAY_MS;
const SESSION_MS = 30 * 60 * 1000;
const MAX_EVENTS = 600; // hard cap so storage stays small

function keyFor(userId: string): string {
  return `boulevard.mood_events.v1.${userId}`;
}

// Recency boost: last 24h counts in full, the last 7 days counts moderately,
// older activity is heavily discounted so a stale mood cannot dominate.
function recencyWeight(ageMs: number): number {
  if (ageMs <= 0) return 1;
  if (ageMs < DAY_MS) return 1.0;
  if (ageMs < WEEK_MS) return 0.5;
  return 0.18;
}

export class MoodStore {
  private userId: string;
  private events: MoodEvent[] = [];
  private hydrated = false;

  constructor(userId: string) {
    this.userId = userId;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(keyFor(this.userId));
      if (raw) {
        const parsed = JSON.parse(raw) as MoodEvent[];
        if (Array.isArray(parsed)) this.events = parsed;
      }
    } catch {
      this.events = [];
    }
    this.prune();
    this.hydrated = true;
  }

  /** Record one mood interaction. Persists in the background. */
  record(moodId: ChipMoodId, kind: MoodEventKind, now: number = Date.now()): void {
    this.events.push({ m: moodId, k: kind, t: now });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    void this.persist();
  }

  /** Recency-weighted score for every mood. Moods with no events score 0. */
  scores(now: number = Date.now()): Record<ChipMoodId, number> {
    const out = {} as Record<ChipMoodId, number>;
    for (const id of DEFAULT_MOOD_ORDER) out[id] = 0;
    for (const e of this.events) {
      const base = BASE_WEIGHT[e.k] ?? 0;
      out[e.m] = (out[e.m] ?? 0) + base * recencyWeight(now - e.t);
      // Small extra nudge for current-session activity so a mood the user is
      // engaging with right now visibly climbs the row.
      if (now - e.t < SESSION_MS && base > 0) out[e.m] += 1.5;
    }
    return out;
  }

  /** Mood ids sorted by score, highest first. New users get the default
   *  order; ties resolve to the default order so the row stays stable. */
  orderedMoodIds(now: number = Date.now()): ChipMoodId[] {
    const s = this.scores(now);
    const defaultRank = new Map(DEFAULT_MOOD_ORDER.map((id, i) => [id, i] as const));
    return [...DEFAULT_MOOD_ORDER].sort((a, b) => {
      const d = (s[b] ?? 0) - (s[a] ?? 0);
      if (Math.abs(d) > 0.0001) return d;
      return (defaultRank.get(a) ?? 0) - (defaultRank.get(b) ?? 0);
    });
  }

  /** Top N moods by score. Drives the For You core-taste lane. */
  topMoods(n: number, now: number = Date.now()): ChipMoodId[] {
    return this.orderedMoodIds(now).slice(0, Math.max(0, n));
  }

  /** True once any mood has accumulated real signal (not a brand-new user). */
  hasSignal(now: number = Date.now()): boolean {
    const s = this.scores(now);
    return DEFAULT_MOOD_ORDER.some((id) => Math.abs(s[id] ?? 0) > 0.0001);
  }

  private prune(now: number = Date.now()): void {
    this.events = this.events.filter((e) => now - e.t < PRUNE_MS);
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(keyFor(this.userId), JSON.stringify(this.events));
    } catch {
      // best-effort — mood ordering self-heals from future events
    }
  }
}

// Per-user singleton accessor so the Explore UI and (Phase C) playback share
// one in-memory instance instead of racing two over the same storage key.
const moodStoreCache = new Map<string, MoodStore>();

export function moodStoreFor(userId: string): MoodStore {
  let store = moodStoreCache.get(userId);
  if (!store) {
    store = new MoodStore(userId);
    moodStoreCache.set(userId, store);
  }
  return store;
}
