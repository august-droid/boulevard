import type { Song } from '@/types';

// ============================================================
// Cold-start demographic / cohort prior — an ADDITIVE onboarding layer.
//
// WHAT THIS IS
// ------------
// A lightweight, pure module that turns the few non-sensitive signals we
// already have at signup (coarse region, locale, device, signup time-of-day,
// acquisition source, and — only if the user explicitly and legally gave it —
// an age range) into a SMALL probability boost for the onboarding slate's
// first few songs.
//
// WHAT THIS IS NOT
// ----------------
// • It is NOT truth. A cohort is a weak prior, not a label. The moment real
//   behaviour arrives it must dominate (see registerOutcome → confidence
//   collapse + per-pattern suppression).
// • It does NOT infer sensitive traits. Gender, if explicitly provided, is
//   accepted for record completeness but contributes ZERO scoring weight —
//   "male ⇒ rap / female ⇒ pop" is exactly the inference this module refuses
//   to make.
// • It is NOT shown in the UI and it is NEVER written to the long-term
//   TasteProfile. It lives only inside one OnboardingSlate instance.
// • It does NOT survive onboarding: the boost decays after every interaction
//   and is effectively zero by song ~8-10 regardless of behaviour.
//
// PRIORITY (onboarding): real behaviour ≫ selected mood/intent ≫ session
// context ≫ THIS cohort prior ≫ editorial quality. The caps below keep the
// cohort boost small enough that a single genuine signal out-weighs it.
//
// Pure module — only the Song *type* is imported (erased at compile time).
// No network, no model, no persistence. Built once at onboarding start.
// ============================================================

export type AgeRange =
  | 'under_18'
  | '18_24'
  | '25_34'
  | '35_44'
  | '45_plus'
  | 'unknown';

/** Raw, non-sensitive signals available around signup. Every field optional —
 *  the caller fills only what it actually knows. */
export interface UserContext {
  /** ISO-3166 alpha-2, e.g. 'ES'. Coarse only — never city-precise targeting. */
  country?: string | null;
  region?: string | null;
  city?: string | null;
  /** BCP-47, e.g. 'es-ES'. */
  locale?: string | null;
  language?: string | null;
  /** IANA timezone, e.g. 'Europe/Madrid'. Used for the signup time-of-day. */
  timezone?: string | null;
  deviceType?: 'phone' | 'tablet' | 'desktop' | 'web' | null;
  os?: string | null;
  /** Attribution channel if known: 'tiktok' | 'instagram' | 'organic' | … */
  acquisitionSource?: string | null;
  /** Epoch ms of signup. Defaults to "now" for a brand-new user. */
  signupTime?: number | null;
  /** ONLY when the user explicitly + legally provided it. Absent ⇒ 'unknown'
   *  ⇒ safety mode. Boulevard does not otherwise collect age. */
  ageRange?: AgeRange | null;
  /** ONLY when explicitly provided. Optional, and weighted at ZERO — see note. */
  gender?: string | null;
}

/** A soft bias vector. Every field is small; the caps in scoreFit keep the
 *  combined effect minor relative to behaviour-driven scoring. */
interface CohortBias {
  /** microtag → small positive affinity (typically 0.2–0.6). */
  microtags: Record<string, number>;
  /** song.mood word → small positive affinity. */
  moodWords: Record<string, number>;
  /** Preferred energy 0..1, or null when the pattern has no energy opinion. */
  energyTarget: number | null;
  energyWeight: number;
  /** Prefer an immediately-replayable hook. */
  hookWeight: number;
  /** Prefer broadly-landing songs (mainstream_fit). */
  mainstreamWeight: number;
  /** Prefer fresh / rising / trending songs. */
  freshnessWeight: number;
  /** 0..1 — how much sonic weirdness this cohort tolerates. Low ⇒ a weird
   *  track is mildly penalised (safer first songs). */
  noveltyTolerance: number;
}

/** A named, INDEPENDENTLY SUPPRESSIBLE slice of the cohort. The spec's
 *  "2 skips in the same cohort pattern ⇒ suppress that pattern" operates on
 *  these — each pattern can be killed without touching the others. */
export interface CohortPattern {
  id: string;
  /** Human label, debug only — never surfaced in product UI. */
  label: string;
  /** Relative influence of this pattern, 0..1. */
  weight: number;
  bias: CohortBias;
  /** Goes false after PATTERN_SUPPRESS_SKIPS contradicting skips. */
  live: boolean;
  /** Skips landed on songs that strongly matched this pattern. */
  skipHits: number;
}

/** Minimal view of the onboarding slate the cohort needs — kept tiny so the
 *  module stays decoupled from OnboardingSlate. */
export interface SlateState {
  /** Songs that have ended so far (0 on the very first song). */
  playedCount: number;
}

// ---- tuning -------------------------------------------------------------

const INITIAL_CONFIDENCE = 0.55;
/** Every ended interaction multiplies confidence by this — a steady fade. */
const CONFIDENCE_DECAY = 0.82;
/** A hard skip (<5s) on a cohort-aligned song collapses confidence sharply. */
const HARD_SKIP_COLLAPSE = 0.42;
/** Two contradicting skips kill a single pattern. */
const PATTERN_SUPPRESS_SKIPS = 2;
/** Raw (pre-confidence) cohort fit is clamped here. */
const COHORT_RAW_CAP = 3.0;
/** Final boost (post confidence × slot decay) is clamped here — small, so a
 *  real behavioural signal always out-weighs the prior. */
const COHORT_BOOST_CAP = 2.5;
/** Per-song raw fit above this counts the song as "strongly cohort-aligned"
 *  for the behaviour-override bookkeeping. */
const STRONG_MATCH_THRESHOLD = 0.9;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Strongest on songs 1-3, ~0 by song 9-10 — independent of confidence decay,
 *  so the cohort cannot linger even if every early song was loved. */
function slotFactor(playedCount: number): number {
  return Math.pow(Math.max(0, (9 - playedCount) / 9), 1.25);
}

const emptyBias = (): CohortBias => ({
  microtags: {},
  moodWords: {},
  energyTarget: null,
  energyWeight: 0,
  hookWeight: 0,
  mainstreamWeight: 0,
  freshnessWeight: 0,
  noveltyTolerance: 0.5,
});

// ---- pattern derivation -------------------------------------------------
//
// Each helper turns ONE raw signal into at most one weak pattern. They are
// deliberately conservative: a pattern only nudges broadly-defensible audio
// dimensions (energy, hook, freshness, a handful of production microtags),
// never a genre stereotype tied to a person's identity.

function timeOfDayPattern(ctx: UserContext): CohortPattern | null {
  // No real signup timestamp ⇒ no time pattern. We never fabricate one from a
  // guessed hour — a missing signal must produce no bias, not a fake one.
  if (ctx.signupTime == null) return null;
  const d = new Date(ctx.signupTime);
  const h = d.getHours();
  if (!Number.isFinite(h)) return null;
  const bias = emptyBias();
  let id: string;
  let label: string;
  if (h >= 22 || h < 5) {
    // Late-night signup — the brief's "night signup" cue. Mid-energy,
    // atmospheric, introspective. NOT high-octane.
    id = 'time_night';
    label = 'signed up late night';
    bias.microtags = { reverb_wash: 0.5, synth_lead: 0.45, dreamy_lyrics: 0.4, intimate_vocal: 0.35, mid_energy: 0.3 };
    bias.moodWords = { longing: 0.5, confident: 0.3, tender: 0.3 };
    bias.energyTarget = 0.46;
    bias.energyWeight = 0.7;
    bias.noveltyTolerance = 0.55;
  } else if (h < 11) {
    id = 'time_morning';
    label = 'signed up in the morning';
    bias.microtags = { low_energy: 0.4, piano_loop: 0.4, tape_warmth: 0.35, instrumental_track: 0.3 };
    bias.energyTarget = 0.34;
    bias.energyWeight = 0.65;
    bias.noveltyTolerance = 0.45;
  } else {
    id = 'time_day';
    label = 'signed up during the day';
    bias.microtags = { big_hook: 0.4, high_energy: 0.3, dance_tempo: 0.25 };
    bias.moodWords = { confident: 0.3, euphoric: 0.3, warm: 0.3 };
    bias.energyTarget = 0.62;
    bias.energyWeight = 0.5;
    bias.hookWeight = 0.4;
    bias.noveltyTolerance = 0.5;
  }
  return { id, label, weight: 0.6, bias, live: true, skipHits: 0 };
}

function sourcePattern(ctx: UserContext): CohortPattern | null {
  const src = (ctx.acquisitionSource ?? '').toLowerCase();
  if (!src) return null;
  // Short-form-video channels: the user arrived via a hook-driven feed, so a
  // strong immediate hook + fresh/trending material lands best. This biases
  // FORMAT (hook, freshness), never a genre.
  const shortForm = ['tiktok', 'reels', 'instagram', 'shorts', 'youtube_shorts', 'snap', 'snapchat'];
  if (shortForm.some((s) => src.includes(s))) {
    const bias = emptyBias();
    bias.microtags = { big_hook: 0.5, peak_energy: 0.3, high_energy: 0.3 };
    bias.hookWeight = 0.8;
    bias.freshnessWeight = 0.6;
    bias.mainstreamWeight = 0.4;
    bias.noveltyTolerance = 0.4;
    return { id: 'source_shortform', label: 'short-form-video acquisition', weight: 0.7, bias, live: true, skipHits: 0 };
  }
  // Referral / friend share — a social, mainstream-leaning prior.
  if (src.includes('referral') || src.includes('friend') || src.includes('share')) {
    const bias = emptyBias();
    bias.hookWeight = 0.4;
    bias.mainstreamWeight = 0.6;
    return { id: 'source_referral', label: 'referral acquisition', weight: 0.5, bias, live: true, skipHits: 0 };
  }
  // Organic / search / store browse — no strong prior; let editorial drive.
  return null;
}

function agePattern(ctx: UserContext): CohortPattern | null {
  const age = ctx.ageRange ?? 'unknown';
  const bias = emptyBias();
  switch (age) {
    case '18_24': {
      bias.microtags = { high_energy: 0.35, big_hook: 0.35, peak_energy: 0.25 };
      bias.energyTarget = 0.7;
      bias.energyWeight = 0.45;
      bias.hookWeight = 0.45;
      bias.freshnessWeight = 0.45;
      bias.noveltyTolerance = 0.55;
      return { id: 'age_18_24', label: '18-24 age range', weight: 0.5, bias, live: true, skipHits: 0 };
    }
    case '25_34': {
      bias.energyTarget = 0.55;
      bias.energyWeight = 0.3;
      bias.hookWeight = 0.3;
      bias.mainstreamWeight = 0.3;
      bias.noveltyTolerance = 0.6;
      return { id: 'age_25_34', label: '25-34 age range', weight: 0.4, bias, live: true, skipHits: 0 };
    }
    case '35_44':
    case '45_plus': {
      bias.microtags = { warm_vocal: 0.35, low_energy: 0.25, tape_warmth: 0.25 };
      bias.energyTarget = 0.42;
      bias.energyWeight = 0.4;
      bias.mainstreamWeight = 0.35;
      bias.noveltyTolerance = 0.5;
      return { id: 'age_35_plus', label: '35+ age range', weight: 0.4, bias, live: true, skipHits: 0 };
    }
    case 'under_18':
    case 'unknown':
    default: {
      // Age unknown OR under-18 ⇒ the safest prior: broadly-appealing,
      // strong-hook, low-novelty. This is a FORMAT prior, not a taste label.
      bias.hookWeight = 0.45;
      bias.mainstreamWeight = 0.55;
      bias.energyTarget = 0.55;
      bias.energyWeight = 0.25;
      bias.noveltyTolerance = 0.3; // weird tracks gently penalised
      return { id: 'age_safe_default', label: 'age unknown / under-18 safe default', weight: 0.45, bias, live: true, skipHits: 0 };
    }
  }
}

function regionPattern(ctx: UserContext): CohortPattern | null {
  // Region is intentionally the WEAKEST signal and is NOT mapped to genre.
  // Boulevard's catalog carries no per-song region/language metadata, so the
  // only honest "regionally relevant" nudge available is a small lean toward
  // editorially broad, currently-trending material — i.e. what is landing for
  // new users generally. No stereotyping of any region's taste.
  const hasRegion = !!(ctx.country || ctx.region || ctx.timezone);
  if (!hasRegion) return null;
  const bias = emptyBias();
  bias.mainstreamWeight = 0.3;
  bias.freshnessWeight = 0.25;
  return { id: 'region_general', label: 'region-aware editorial lean', weight: 0.3, bias, live: true, skipHits: 0 };
}

function devicePattern(ctx: UserContext): CohortPattern | null {
  // Device/OS carries almost no taste signal. A tablet/desktop session leans
  // very slightly toward longer-attention, calmer listening. Tiny weight.
  if (ctx.deviceType === 'tablet' || ctx.deviceType === 'desktop') {
    const bias = emptyBias();
    bias.energyTarget = 0.48;
    bias.energyWeight = 0.2;
    return { id: 'device_large', label: 'large-screen device', weight: 0.2, bias, live: true, skipHits: 0 };
  }
  return null;
}

// NOTE on gender: a `gender_record` pattern is deliberately NOT produced.
// Gender is accepted on UserContext only so an explicitly-provided value is
// not silently dropped, but it is given ZERO scoring weight by design.

// ---- the cohort ---------------------------------------------------------

export class ColdStartCohort {
  readonly patterns: CohortPattern[];
  /** True ⇒ strict content gating downstream (age unknown / under-18). */
  readonly safetyMode: boolean;
  private confidence: number;
  private interactions = 0;

  constructor(patterns: CohortPattern[], safetyMode: boolean) {
    this.patterns = patterns;
    this.safetyMode = safetyMode;
    // No usable signals at all ⇒ start near-zero so the cohort is a no-op.
    this.confidence = patterns.length > 0 ? INITIAL_CONFIDENCE : 0;
  }

  /** Live (un-suppressed) patterns. */
  private activePatterns(): CohortPattern[] {
    return this.patterns.filter((p) => p.live);
  }

  /** Raw, pre-confidence per-song fit from one pattern. Roughly [-1, 2.5]. */
  private patternFit(song: Song, p: CohortPattern): number {
    const b = p.bias;
    let fit = 0;
    for (const t of song.microtags ?? []) fit += b.microtags[t] ?? 0;
    if (song.mood && b.moodWords[song.mood] != null) fit += b.moodWords[song.mood];
    if (b.energyTarget != null && b.energyWeight > 0) {
      const close = 1 - Math.min(1, Math.abs(song.energy_score - b.energyTarget) / 0.45);
      fit += (close - 0.4) * b.energyWeight; // centred so a poor match can go slightly negative
    }
    if (b.hookWeight > 0) fit += (song.hook_strength ?? 0) * b.hookWeight;
    if (b.mainstreamWeight > 0) fit += (song.mainstream_fit ?? 0) * b.mainstreamWeight;
    if (b.freshnessWeight > 0) {
      const stage = song.distribution_stage ?? 'new_test';
      const fresh = stage === 'trending' ? 1 : stage === 'rising' ? 0.7 : stage === 'new_test' ? 0.3 : 0;
      fit += fresh * b.freshnessWeight;
    }
    // Weird tracks are mildly penalised when the cohort's novelty tolerance
    // is low — keeps the earliest songs safe.
    const weird = song.weirdness_score ?? 0;
    if (weird > b.noveltyTolerance) fit -= (weird - b.noveltyTolerance) * 1.2;
    return fit;
  }

  /** Weighted-average raw fit across all live patterns. Clamped. */
  private rawFit(song: Song): number {
    const active = this.activePatterns();
    if (active.length === 0) return 0;
    let weighted = 0;
    let wsum = 0;
    for (const p of active) {
      weighted += this.patternFit(song, p) * p.weight;
      wsum += p.weight;
    }
    if (wsum <= 0) return 0;
    return clamp((weighted / wsum) * 1.6, -COHORT_RAW_CAP, COHORT_RAW_CAP);
  }

  /**
   * The small additive score delta for one candidate song. Folds in
   * confidence (decays per interaction, collapses on contradicting skips)
   * and the slot factor (strongest songs 1-3, ~0 by song 10). Returns 0 once
   * the cohort has nothing left to say.
   */
  scoreCohortFit(song: Song, slate: SlateState): number {
    if (this.confidence <= 0.02) return 0;
    const factor = slotFactor(slate.playedCount);
    if (factor <= 0.001) return 0;
    const raw = this.rawFit(song);
    return clamp(raw * this.confidence * factor, -COHORT_BOOST_CAP, COHORT_BOOST_CAP);
  }

  /**
   * Feed back a played song's outcome so behaviour can override the prior.
   *  • every ended interaction decays confidence;
   *  • a hard skip (<5s) on a cohort-aligned song collapses confidence;
   *  • two contradicting skips on songs matching a pattern suppress THAT
   *    pattern; a positive resets that pattern's skip tally (behaviour is
   *    allowed to confirm the prior, but it never re-strengthens it).
   *
   * `ended` mirrors OnboardingSlate.applySignal — true for a finished/skipped
   * song, false for a mid-song signal (like/save/replay/share).
   */
  registerOutcome(song: Song, kinds: string[], ended: boolean): void {
    const hardSkip = kinds.includes('skip_under_5');
    const anySkip = hardSkip || kinds.includes('skip_under_15');
    const positive = kinds.some((k) =>
      k === 'completion_over_70' || k === 'listen_60s' ||
      k === 'replay' || k === 'save' || k === 'like' || k === 'share');

    // Was this song actually leaning on the cohort prior?
    const aligned = this.rawFit(song) >= 0.4;

    if (ended) {
      this.interactions += 1;
      this.confidence *= CONFIDENCE_DECAY;
    }
    if (hardSkip && aligned) {
      // The prior pointed here and the user rejected it instantly — the
      // single clearest "this cohort assumption is wrong" signal.
      this.confidence *= HARD_SKIP_COLLAPSE;
    }

    // Per-pattern bookkeeping — only for patterns this song strongly matched.
    for (const p of this.patterns) {
      if (!p.live) continue;
      const strong = this.patternFit(song, p) >= STRONG_MATCH_THRESHOLD;
      if (!strong) continue;
      if (anySkip) {
        p.skipHits += 1;
        if (p.skipHits >= PATTERN_SUPPRESS_SKIPS) {
          p.live = false; // suppress this cohort pattern for good
        }
      } else if (positive) {
        p.skipHits = 0; // behaviour confirms — clear the tally, do not boost
      }
    }
  }

  // ---- debug (never shown in product UI) --------------------------------

  currentConfidence(): number {
    return this.confidence;
  }

  debugSnapshot() {
    return {
      confidence: Number(this.confidence.toFixed(3)),
      interactions: this.interactions,
      safetyMode: this.safetyMode,
      patterns: this.patterns.map((p) => ({
        id: p.id, label: p.label, weight: p.weight, live: p.live, skipHits: p.skipHits,
      })),
    };
  }
}

/**
 * Build the cold-start cohort from the raw signup signals. Computed ONCE at
 * onboarding start. Patterns with no usable signal are simply absent, so a
 * context with nothing known yields an inert cohort (confidence 0, every
 * score 0) — the onboarding slate then behaves exactly as before this layer.
 */
export function buildColdStartCohort(ctx: UserContext): ColdStartCohort {
  const patterns: CohortPattern[] = [];
  const push = (p: CohortPattern | null) => { if (p) patterns.push(p); };
  push(agePattern(ctx));
  push(timeOfDayPattern(ctx));
  push(sourcePattern(ctx));
  push(regionPattern(ctx));
  push(devicePattern(ctx));
  // Age unknown or explicitly under-18 ⇒ strict downstream content gating.
  const age = ctx.ageRange ?? 'unknown';
  const safetyMode = age === 'unknown' || age === 'under_18';
  return new ColdStartCohort(patterns, safetyMode);
}

/** Function-form wrapper for the cohort fit (mirrors the brief's API). */
export function scoreCohortFit(song: Song, cohort: ColdStartCohort, slate: SlateState): number {
  return cohort.scoreCohortFit(song, slate);
}
