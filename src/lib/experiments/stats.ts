// Lightweight statistics for experiment evaluation.
//
// All confidence values are ONE-SIDED: "confidence that the variant beats the
// control" — the direction the autopilot cares about when recommending a
// winner. Large-sample normal approximations are used (z-test for
// proportions, Welch's test for means); experiments only autocomplete once a
// minimum sample size is reached, so the approximation holds well.

/** Standard normal CDF — Abramowitz & Stegun 7.1.26 approximation. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * One-sided confidence that a variant's success RATE exceeds the control's,
 * via a two-proportion z-test (pooled standard error).
 * Returns 0 when there isn't enough data to say anything.
 */
export function proportionConfidence(
  controlSuccess: number,
  controlN: number,
  variantSuccess: number,
  variantN: number,
): number {
  if (controlN <= 0 || variantN <= 0) return 0;
  const pC = controlSuccess / controlN;
  const pV = variantSuccess / variantN;
  const pPool = (controlSuccess + variantSuccess) / (controlN + variantN);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / controlN + 1 / variantN));
  if (se === 0) return pV > pC ? 1 : 0;
  const z = (pV - pC) / se;
  return clamp01(normalCdf(z));
}

/**
 * One-sided confidence that a variant's MEAN exceeds the control's, via
 * Welch's t-test using a normal approximation (valid for the large samples
 * an autocompleting experiment will have).
 */
export function meanConfidence(
  control: { mean: number; variance: number; n: number },
  variant: { mean: number; variance: number; n: number },
): number {
  if (control.n < 2 || variant.n < 2) return 0;
  const se = Math.sqrt(
    control.variance / control.n + variant.variance / variant.n,
  );
  if (se === 0) return variant.mean > control.mean ? 1 : 0;
  const z = (variant.mean - control.mean) / se;
  return clamp01(normalCdf(z));
}

/** Sample variance from a running sum + sum-of-squares. */
export function varianceFromSums(sum: number, sqSum: number, n: number): number {
  if (n < 2) return 0;
  const mean = sum / n;
  const v = (sqSum - n * mean * mean) / (n - 1);
  return v > 0 ? v : 0;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
