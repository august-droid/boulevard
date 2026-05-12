// QualityFilter — decides whether a freshly-generated song should be promoted
// to the live catalog, queued for human review, or rejected outright.
//
// The thresholds here MUST stay in sync with public.auto_reject_weak_songs()
// in supabase/schema.sql. The DB function exists so a scheduled Edge job can
// scrub the queue periodically; this file handles the decision at ingest
// time. They evaluate to the same outcome.

export interface QualityBreakdown {
  /** 0..1 — how compelling the first 10s is. */
  intro_strength?: number | null;
  /** 0..1 — how memorable the chorus / drop is. */
  hook_quality?: number | null;
  /** 0..1 — vocal clarity / no broken artifacts. */
  vocal_quality?: number | null;
  /** 0..1 — mix balance / no obvious AI artifacts. */
  production_quality?: number | null;
  /** 0..1 — likelihood this gets replayed. */
  replayability_score?: number | null;
}

export type Decision =
  | { verdict: 'approve'; quality_score: number }
  | { verdict: 'review'; quality_score: number; reason: string }
  | { verdict: 'reject'; quality_score: number; reason: RejectionReason };

export type RejectionReason =
  | 'vocals_broken'
  | 'weak_intro'
  | 'weak_chorus'
  | 'ai_artifacts'
  | 'low_replayability'
  | 'low_overall_quality';

// Weights mirror the recommendation engine — replay + hook drive long-term
// engagement, so they carry the most weight in the blended score.
const WEIGHTS = {
  intro_strength: 0.15,
  hook_quality: 0.25,
  vocal_quality: 0.20,
  production_quality: 0.15,
  replayability_score: 0.25,
};

// Hard floors — any single dimension below these triggers an auto-reject
// regardless of how high the others are. Mirror auto_reject_weak_songs().
const HARD_FLOOR = 0.30;

// Combined score thresholds.
const APPROVE_AT = 0.70;
const REVIEW_AT = 0.50;
// Anything below REVIEW_AT is rejected as low_overall_quality.

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

/**
 * Blend per-dimension scores into a single quality_score in [0, 1].
 * Missing dimensions are treated as 0.5 (neutral) so a partial Suno response
 * doesn't accidentally pass-or-fail solely on what was measured.
 */
export function computeQualityScore(b: QualityBreakdown): number {
  const v = {
    intro_strength: b.intro_strength ?? 0.5,
    hook_quality: b.hook_quality ?? 0.5,
    vocal_quality: b.vocal_quality ?? 0.5,
    production_quality: b.production_quality ?? 0.5,
    replayability_score: b.replayability_score ?? 0.5,
  };
  const total =
    WEIGHTS.intro_strength * clamp01(v.intro_strength) +
    WEIGHTS.hook_quality * clamp01(v.hook_quality) +
    WEIGHTS.vocal_quality * clamp01(v.vocal_quality) +
    WEIGHTS.production_quality * clamp01(v.production_quality) +
    WEIGHTS.replayability_score * clamp01(v.replayability_score);
  return clamp01(total);
}

/**
 * Apply the rejection ladder + threshold gates. Decisions:
 *   - reject  → never promote, never re-review
 *   - review  → hold for manual approve/reject
 *   - approve → safe to promote to live
 */
export function evaluate(b: QualityBreakdown): Decision {
  const quality_score = computeQualityScore(b);

  // 1) Hard floors — any single broken dimension = reject.
  if (b.vocal_quality != null && b.vocal_quality < HARD_FLOOR) {
    return { verdict: 'reject', quality_score, reason: 'vocals_broken' };
  }
  if (b.intro_strength != null && b.intro_strength < HARD_FLOOR) {
    return { verdict: 'reject', quality_score, reason: 'weak_intro' };
  }
  if (b.hook_quality != null && b.hook_quality < HARD_FLOOR) {
    return { verdict: 'reject', quality_score, reason: 'weak_chorus' };
  }
  if (b.production_quality != null && b.production_quality < HARD_FLOOR) {
    return { verdict: 'reject', quality_score, reason: 'ai_artifacts' };
  }
  if (b.replayability_score != null && b.replayability_score < HARD_FLOOR) {
    return { verdict: 'reject', quality_score, reason: 'low_replayability' };
  }

  // 2) Blended-score gate.
  if (quality_score >= APPROVE_AT) {
    return { verdict: 'approve', quality_score };
  }
  if (quality_score >= REVIEW_AT) {
    return { verdict: 'review', quality_score, reason: 'borderline_quality' };
  }
  return { verdict: 'reject', quality_score, reason: 'low_overall_quality' };
}

// ---- Heuristic scorer (no ML yet) -------------------------------------
//
// Until we have a trained model, we derive per-dimension scores from a few
// cheap signals: Suno's own confidence metrics + audio duration sanity +
// title sanity. This is intentionally simple — the goal here is to gate
// the obvious failures (silent files, broken titles, off-length results),
// not to be a music critic. Replace this function with a real evaluator
// (audio fingerprinting, hook detection, etc.) when ready.

export interface HeuristicInput {
  duration_seconds?: number | null;
  sunoMetrics?: {
    coherence?: number;
    audio_quality?: number;
    vocal_clarity?: number;
  };
  title?: string | null;
  vocal_gender?: 'male' | 'female' | 'instrumental';
}

export function heuristicQuality(input: HeuristicInput): QualityBreakdown {
  const m = input.sunoMetrics ?? {};
  const isVocal = input.vocal_gender && input.vocal_gender !== 'instrumental';
  const duration = input.duration_seconds ?? 0;

  // Duration sanity — anything under 60s or over 5min is probably broken.
  const durFit = duration >= 90 && duration <= 300 ? 1 : duration > 0 ? 0.4 : 0.1;

  return {
    intro_strength: clamp01(0.55 + (m.coherence ?? 0.5) * 0.35),
    hook_quality: clamp01(0.50 + (m.coherence ?? 0.5) * 0.30 + durFit * 0.15),
    vocal_quality: isVocal
      ? clamp01((m.vocal_clarity ?? 0.5) * 0.85 + 0.10)
      : 1.0, // no vocals = no broken vocals
    production_quality: clamp01((m.audio_quality ?? 0.5) * 0.80 + durFit * 0.15),
    replayability_score: clamp01(0.45 + (m.coherence ?? 0.5) * 0.25 + (m.audio_quality ?? 0.5) * 0.20),
  };
}
