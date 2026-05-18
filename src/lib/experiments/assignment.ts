// Deterministic variant assignment.
//
// A subject (user_id, or anonymous/device id) is always assigned to the same
// variant for a given experiment — assignment is a pure function of
// (experiment_id, subject_id), so it needs no storage to be stable and is
// identical on every device and platform. The DB rows in
// experiment_assignments are an audit/analytics record, not the source of
// truth.

import type { ExperimentVariant, AudienceRules } from '@/lib/experiments/types';

/** FNV-1a 32-bit hash → stable, fast, no dependencies. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Map (experiment, subject) → a stable fraction in [0, 1). */
export function bucketFraction(experimentId: string, subjectId: string): number {
  const h = fnv1a(`${experimentId}::${subjectId}`);
  return h / 0x100000000;
}

/**
 * Pick the variant a subject belongs to. Variants are laid end-to-end on the
 * [0,1) line, each occupying a slice proportional to its traffic_weight; the
 * subject's bucket fraction selects the slice. Returns null only when there
 * are no variants or all weights are zero.
 */
export function assignVariant(
  experimentId: string,
  subjectId: string,
  variants: ExperimentVariant[],
): ExperimentVariant | null {
  if (!variants.length) return null;
  const ordered = [...variants].sort(
    (a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key),
  );
  const totalWeight = ordered.reduce(
    (sum, v) => sum + Math.max(0, v.traffic_weight),
    0,
  );
  if (totalWeight <= 0) return ordered[0];

  const target = bucketFraction(experimentId, subjectId) * totalWeight;
  let cursor = 0;
  for (const v of ordered) {
    cursor += Math.max(0, v.traffic_weight);
    if (target < cursor) return v;
  }
  return ordered[ordered.length - 1];
}

/** The runtime context an audience rule is evaluated against. */
export interface AudienceContext {
  platform: 'web' | 'ios' | 'android';
  isAnonymous: boolean;
  hasSignedUp: boolean;
  isPremium: boolean;
  songsHeard: number;
}

/** True when the subject matches the experiment's audience rules. An empty
 *  rule set ({}) matches everyone. */
export function matchesAudience(
  audience: AudienceRules | null | undefined,
  ctx: AudienceContext,
): boolean {
  if (!audience) return true;
  if (audience.platform && audience.platform !== ctx.platform) return false;
  if (audience.anonymous_only && !ctx.isAnonymous) return false;
  if (audience.signed_up_only && !ctx.hasSignedUp) return false;
  if (typeof audience.premium === 'boolean' && audience.premium !== ctx.isPremium) {
    return false;
  }
  if (
    typeof audience.min_songs_heard === 'number' &&
    ctx.songsHeard < audience.min_songs_heard
  ) {
    return false;
  }
  return true;
}
