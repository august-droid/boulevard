import type { Song } from '@/types';

// ============================================================
// Habit personalization — an ADDITIVE long-term layer.
//
// WHAT THIS IS
// ------------
// Learns what a user usually reaches for at a given TIME + CONTEXT — e.g.
// "Friday 22:00 → euphoric / high-energy", "weekday morning → calm / focus" —
// and turns that into a SOFT score boost once the user is past cold-start.
//
// WHAT THIS IS NOT
// ----------------
// • It is NOT the lifetime TasteProfile and never mutates it. Taste is "who
//   you are"; habit is "what you usually want, right now".
// • It does NOT override current intent. The ranker caps the habit boost well
//   below the session / explicit-context boosts, and damps it further when an
//   explicit vibe/context is active — so "usually chill at night, but tapped
//   Gym" always resolves to Gym (see RecommendationEngine).
// • It does NOT create repetition: it is a small additive nudge; the 24h
//   ExposureLog and anti-fatigue rules keep running and still suppress repeats.
//
// DESIGN
// ------
// • Time is bucketed into 12 slots: {weekday, weekend} × 6 hour-bands.
// • Every play records one timestamped HabitEvent against the active slot.
// • getHabitContext() recency-weights the events for the CURRENT slot (plus a
//   light spill from band-adjacent slots) into a soft preference snapshot.
// • Habit confidence rises with repeated behaviour across distinct days and
//   decays naturally as old events fall out of the recency window — a habit
//   that stops appearing fades on its own.
//
// Pure module: only the Song *type* is imported. No AsyncStorage, no network,
// no model — persistence is handled by habitStore.ts so this stays trivially
// unit-testable and safe to run outside React Native.
// ============================================================

export type DayType = 'weekday' | 'weekend';
export type HourBand =
  | 'late_night'    // 00:00–05:00
  | 'early_morning' // 05:00–09:00
  | 'morning'       // 09:00–12:00
  | 'afternoon'     // 12:00–17:00
  | 'evening'       // 17:00–21:00
  | 'night';        // 21:00–24:00

export const HOUR_BANDS: HourBand[] = [
  'late_night', 'early_morning', 'morning', 'afternoon', 'evening', 'night',
];

/** One recorded listening outcome, compacted for storage. */
interface HabitEvent {
  /** Slot index 0..11. */
  s: number;
  /** Primary genre. */
  g: string;
  /** Primary mood word. */
  m: string;
  /** Energy band 0..5. */
  eb: number;
  /** BPM band (bpm/12 rounded), or -1 when bpm is unknown. */
  bb: number;
  /** A small sample of the song's microtags. */
  tt: string[];
  /** Signed signal strength: +1.5 strong-positive, +0.7 positive, -1 negative. */
  w: number;
  /** Epoch ms. */
  t: number;
}

/** The soft, time-aware preference snapshot the ranker consumes. */
export interface HabitContext {
  slot: number;
  dayType: DayType;
  hourBand: HourBand;
  /** Recency-weighted signed scores. */
  genreScores: Record<string, number>;
  moodScores: Record<string, number>;
  microtagScores: Record<string, number>;
  /** Preferred energy 0..1 for this slot, or null with no data. */
  energyTarget: number | null;
  /** Preferred bpm for this slot, or null with no data. */
  bpmTarget: number | null;
  /** 0..1 — how strongly a repeated habit exists for this slot. */
  confidence: number;
  /** Number of events that contributed. */
  sampleCount: number;
}

// ---- time bucketing -----------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PRUNE_MS = 60 * DAY_MS;     // events older than 60 days are dropped
const MAX_EVENTS = 800;            // hard storage cap
const SCHEMA_VERSION = 1;

export function hourBandIndex(hour: number): number {
  if (hour < 5) return 0;
  if (hour < 9) return 1;
  if (hour < 12) return 2;
  if (hour < 17) return 3;
  if (hour < 21) return 4;
  return 5;
}

/** Slot 0..11 for a timestamp, using the runtime's local time (the user's
 *  own clock — which is exactly the habit we want to capture). */
export function slotFor(date: Date): number {
  const day = date.getDay(); // 0 Sun … 6 Sat
  const isWeekend = day === 0 || day === 6;
  const band = hourBandIndex(date.getHours());
  return (isWeekend ? 1 : 0) * 6 + band;
}

export function dayTypeOf(slot: number): DayType {
  return slot >= 6 ? 'weekend' : 'weekday';
}
export function hourBandOf(slot: number): HourBand {
  return HOUR_BANDS[slot % 6];
}

/** Band-adjacent slots inside the SAME day-type — a small spill so an empty
 *  slot can still borrow signal from the hour either side of it. */
function adjacentSlots(slot: number): number[] {
  const base = slot < 6 ? 0 : 6;
  const band = slot % 6;
  const out: number[] = [];
  if (band > 0) out.push(base + band - 1);
  if (band < 5) out.push(base + band + 1);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Recency weight — recent behaviour dominates; a habit that stops appearing
 *  fades because its events keep ageing into the discounted tail. */
function recencyWeight(ageMs: number): number {
  if (ageMs <= 0) return 1;
  if (ageMs < WEEK_MS) return 1.0;
  if (ageMs < 4 * WEEK_MS) return 0.55;
  if (ageMs < 8 * WEEK_MS) return 0.25;
  return 0.1;
}

/** Map playback signal kinds to a single signed habit weight. */
function signalWeight(kinds: string[]): number {
  if (kinds.some((k) =>
    k === 'completion_over_70' || k === 'save' || k === 'like' ||
    k === 'replay' || k === 'share')) return 1.5;
  if (kinds.some((k) => k === 'listen_60s' || k === 'listen_30s')) return 0.7;
  if (kinds.some((k) => k === 'skip_under_5' || k === 'skip_under_15')) return -1.0;
  return 0;
}

const energyBand = (e: number) => clamp(Math.round(e * 5), 0, 5);
const bpmBand = (bpm: number | null | undefined) => (bpm == null ? -1 : Math.round(bpm / 12));

// ============================================================

/**
 * In-memory habit model for one user. Persistence (AsyncStorage) is layered
 * on by habitStore.ts via the onChange hook — this class stays pure.
 */
export class HabitProfile {
  private events: HabitEvent[] = [];
  private hydrated = false;
  private onChange: (() => void) | null = null;

  /** habitStore wires this to schedule a debounced persist. */
  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }

  isHydrated(): boolean { return this.hydrated; }
  markHydrated(): void { this.hydrated = true; }

  /**
   * Record one finished play. `kinds` are the same OnboardingSignalKind-style
   * strings the rest of the stack already produces. A no-signal play (e.g.
   * the staged song that was never really heard) is ignored.
   */
  record(song: Song, kinds: string[], now: number = Date.now()): void {
    const w = signalWeight(kinds);
    if (w === 0) return;
    const tags = song.microtags ?? [];
    this.events.push({
      s: slotFor(new Date(now)),
      g: song.genre,
      m: song.mood,
      eb: energyBand(song.energy_score),
      bb: bpmBand(song.bpm),
      tt: tags.slice(0, 8),
      w,
      t: now,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    this.onChange?.();
  }

  /**
   * Build the soft preference snapshot for the slot `now` falls in. Events in
   * the exact slot count fully; band-adjacent slots spill in at 40%.
   */
  getHabitContext(now: number = Date.now()): HabitContext {
    const date = new Date(now);
    const slot = slotFor(date);
    const adj = new Set(adjacentSlots(slot));

    const genreScores: Record<string, number> = {};
    const moodScores: Record<string, number> = {};
    const microtagScores: Record<string, number> = {};
    let energyNum = 0, energyDen = 0;
    let bpmNum = 0, bpmDen = 0;
    let positiveWeight = 0;
    let sampleCount = 0;
    const days = new Set<number>();

    for (const e of this.events) {
      const slotW = e.s === slot ? 1 : adj.has(e.s) ? 0.4 : 0;
      if (slotW === 0) continue;
      const w = e.w * recencyWeight(now - e.t) * slotW;
      if (w === 0) continue;
      sampleCount += 1;
      genreScores[e.g] = (genreScores[e.g] ?? 0) + w;
      moodScores[e.m] = (moodScores[e.m] ?? 0) + w;
      for (const t of e.tt) microtagScores[t] = (microtagScores[t] ?? 0) + w / Math.max(1, e.tt.length);
      // Energy / bpm targets are averaged over POSITIVE events only — the
      // "what they want", not "what they skip".
      if (w > 0) {
        positiveWeight += w;
        days.add(Math.floor(e.t / DAY_MS));
        energyNum += (e.eb / 5) * w;
        energyDen += w;
        if (e.bb >= 0) { bpmNum += e.bb * 12 * w; bpmDen += w; }
      }
    }

    // Confidence needs BOTH enough positive weight AND repetition across
    // distinct days — one long binge is not a habit.
    const confidence =
      clamp(positiveWeight / 8, 0, 1) * clamp(days.size / 3, 0, 1);

    return {
      slot,
      dayType: dayTypeOf(slot),
      hourBand: hourBandOf(slot),
      genreScores,
      moodScores,
      microtagScores,
      energyTarget: energyDen > 0 ? energyNum / energyDen : null,
      bpmTarget: bpmDen > 0 ? bpmNum / bpmDen : null,
      confidence,
      sampleCount,
    };
  }

  // ---- persistence helpers (called by habitStore.ts) --------------------

  serialize(): string {
    return JSON.stringify({ v: SCHEMA_VERSION, events: this.events });
  }

  /** Replace state from a serialized blob. Prunes stale events on load. */
  restoreFrom(raw: string | null | undefined, now: number = Date.now()): void {
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { v?: number; events?: HabitEvent[] };
        if (parsed && Array.isArray(parsed.events)) {
          this.events = parsed.events.filter((e) => now - e.t < PRUNE_MS);
        }
      } catch {
        this.events = [];
      }
    }
    this.hydrated = true;
  }

  debugSnapshot(now: number = Date.now()) {
    const c = this.getHabitContext(now);
    return {
      slot: c.slot, dayType: c.dayType, hourBand: c.hourBand,
      confidence: Number(c.confidence.toFixed(3)),
      sampleCount: c.sampleCount,
      totalEvents: this.events.length,
    };
  }
}

// ---- scoring ------------------------------------------------------------

/** Raw habit caps — small relative to taste/session so habit can never
 *  dominate an explicit choice. */
const HABIT_MICROTAG_CAP = 5;
const HABIT_RAW_CAP = 3.0;

/**
 * Soft, time-aware boost for one candidate song. Returns ~[-3, +3], already
 * folded with habit confidence. The RecommendationEngine / ForYouEngine add
 * this on top of their normal score and damp it when an explicit intent is
 * active. With no habit data the context's confidence is 0 ⇒ this returns 0.
 */
export function scoreHabitFit(song: Song, habit: HabitContext | null | undefined): number {
  if (!habit || habit.confidence <= 0.02) return 0;

  let raw = 0;

  // microtag overlap — the primary, most specific habit signal.
  let mt = 0;
  for (const t of song.microtags ?? []) mt += habit.microtagScores[t] ?? 0;
  raw += clamp(mt, -HABIT_MICROTAG_CAP, HABIT_MICROTAG_CAP);

  // genre + mood-word alignment.
  raw += clamp(habit.genreScores[song.genre] ?? 0, -3, 3) * 0.6;
  if (song.mood) raw += clamp(habit.moodScores[song.mood] ?? 0, -3, 3) * 0.5;

  // energy / bpm proximity to the slot's usual listening.
  if (habit.energyTarget != null) {
    const close = 1 - Math.min(1, Math.abs(song.energy_score - habit.energyTarget) / 0.4);
    raw += (close - 0.4) * 1.2;
  }
  if (habit.bpmTarget != null && song.bpm != null) {
    const close = 1 - Math.min(1, Math.abs(song.bpm - habit.bpmTarget) / 30);
    raw += (close - 0.4) * 0.8;
  }

  raw = clamp(raw, -HABIT_RAW_CAP, HABIT_RAW_CAP);
  return raw * habit.confidence;
}
