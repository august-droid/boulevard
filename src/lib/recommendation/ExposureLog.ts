import AsyncStorage from '@react-native-async-storage/async-storage';

// 24-hour anti-repeat exposure log (spec PART 3).
//
// Records every song that was shown in a discovery surface, played, skipped,
// or completed, with timestamps. Algorithmic discovery (For You, mood shelves,
// Explore recommendations, queue extension) suppresses any song touched within
// the last 24h so the user does not keep seeing the same tracks.
//
// Manual playback (search, library, saved, playlists, artist page, direct
// replay) is NEVER routed through this filter — the caller simply does not
// consult isSuppressed() for those surfaces.
//
// Persisted to AsyncStorage, scoped per user. Records whose timestamps are all
// older than 7 days are pruned on hydrate.

type ExposureField = 'e' | 'p' | 's' | 'c'; // exposed / played / skipped / completed

interface ExposureRec {
  e?: number; // last shown in an algorithmic discovery surface
  p?: number; // last played
  s?: number; // last skipped
  c?: number; // last completed
}

const SUPPRESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SKIP_WINDOW_MS = 90 * 60 * 1000;

function keyFor(userId: string): string {
  return `boulevard.exposure.v1.${userId}`;
}

function within(ts: number | undefined, now: number): boolean {
  return ts != null && now - ts < SUPPRESS_WINDOW_MS;
}

export interface ExposureOutcomes {
  played: number;
  skipped: number;
  completed: number;
}

export class ExposureLog {
  private userId: string;
  private map = new Map<string, ExposureRec>();
  private hydrated = false;

  constructor(userId: string) {
    this.userId = userId;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(keyFor(this.userId));
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ExposureRec>;
        if (parsed && typeof parsed === 'object') {
          for (const [id, rec] of Object.entries(parsed)) this.map.set(id, rec);
        }
      }
    } catch {
      this.map = new Map();
    }
    this.prune();
    this.hydrated = true;
  }

  private stamp(id: string, field: ExposureField, now: number): void {
    const rec = this.map.get(id) ?? {};
    rec[field] = now;
    this.map.set(id, rec);
  }

  /** Mark songs as shown in an algorithmic discovery surface. */
  recordShown(ids: string[], now: number = Date.now()): void {
    for (const id of ids) this.stamp(id, 'e', now);
    void this.persist();
  }

  recordPlayed(id: string, now: number = Date.now()): void {
    this.stamp(id, 'p', now);
    void this.persist();
  }

  recordSkipped(id: string, now: number = Date.now()): void {
    this.stamp(id, 's', now);
    void this.persist();
  }

  recordCompleted(id: string, now: number = Date.now()): void {
    this.stamp(id, 'c', now);
    void this.persist();
  }

  /** True if the song was shown / played / skipped / completed in the last 24h. */
  isSuppressed(id: string, now: number = Date.now()): boolean {
    const rec = this.map.get(id);
    if (!rec) return false;
    return within(rec.e, now) || within(rec.p, now) || within(rec.s, now) || within(rec.c, now);
  }

  /** Every song id currently inside the 24h suppression window. */
  suppressedIds(now: number = Date.now()): Set<string> {
    const out = new Set<string>();
    for (const [id, rec] of this.map) {
      if (within(rec.e, now) || within(rec.p, now) || within(rec.s, now) || within(rec.c, now)) {
        out.add(id);
      }
    }
    return out;
  }

  /** Song ids skipped within `windowMs` (default 90 min) — feeds the
   *  skip-similarity penalty in the recommender. */
  recentSkippedIds(windowMs: number = DEFAULT_SKIP_WINDOW_MS, now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const [id, rec] of this.map) {
      if (rec.s != null && now - rec.s < windowMs) out.push(id);
    }
    return out;
  }

  /** Count play / skip / completion outcomes since `sinceTs`, restricted to
   *  `ids` — drives the "5 songs consumed from the current For You list"
   *  refresh trigger (spec PART 3). */
  outcomesSince(sinceTs: number, ids: Set<string>): ExposureOutcomes {
    let played = 0;
    let skipped = 0;
    let completed = 0;
    for (const id of ids) {
      const rec = this.map.get(id);
      if (!rec) continue;
      if (rec.p != null && rec.p >= sinceTs) played++;
      if (rec.s != null && rec.s >= sinceTs) skipped++;
      if (rec.c != null && rec.c >= sinceTs) completed++;
    }
    return { played, skipped, completed };
  }

  private prune(now: number = Date.now()): void {
    for (const [id, rec] of this.map) {
      const newest = Math.max(rec.e ?? 0, rec.p ?? 0, rec.s ?? 0, rec.c ?? 0);
      if (now - newest > PRUNE_MS) this.map.delete(id);
    }
  }

  private async persist(): Promise<void> {
    try {
      const obj: Record<string, ExposureRec> = {};
      for (const [id, rec] of this.map) obj[id] = rec;
      await AsyncStorage.setItem(keyFor(this.userId), JSON.stringify(obj));
    } catch {
      // best-effort
    }
  }
}

// Per-user singleton accessor so the Explore UI and (Phase C) playback share
// one in-memory instance instead of racing two over the same storage key.
const exposureLogCache = new Map<string, ExposureLog>();

export function exposureLogFor(userId: string): ExposureLog {
  let log = exposureLogCache.get(userId);
  if (!log) {
    log = new ExposureLog(userId);
    exposureLogCache.set(userId, log);
  }
  return log;
}
