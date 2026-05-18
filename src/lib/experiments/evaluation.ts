// Experiment evaluation — turns raw event rollups into per-variant stats, a
// statistical winner, and a full report. Also runs the autopilot completion
// check. This is pure: it never writes anything. The admin dashboard uses it
// for live results; the autopilot uses it to decide when a test is done.

import {
  METRIC_BY_KEY,
  type MetricDef,
} from '@/lib/experiments/catalog';
import {
  meanConfidence,
  proportionConfidence,
  varianceFromSums,
} from '@/lib/experiments/stats';
import type {
  Experiment,
  ExperimentReport,
  ExperimentVariant,
  VariantStats,
} from '@/lib/experiments/types';

/** A row from the experiment_event_rollup RPC. */
export interface RollupRow {
  variant_id: string;
  event_type: string;
  n_events: number;
  n_subjects: number;
  value_sum: number;
  value_sq_sum: number;
}

/** A row from the experiment_assignment_counts RPC. */
export interface AssignmentCountRow {
  variant_id: string;
  subjects: number;
}

// ---- Metric maths ----------------------------------------------------

/** numerator / denominator counts for a rate metric on one variant. */
function rateParts(
  stats: VariantStats,
  metric: MetricDef,
): { numerator: number; denominator: number } {
  const numerator = metric.numeratorEvent
    ? stats.eventSubjects[metric.numeratorEvent] ?? 0
    : 0;
  const denominator = metric.denominatorEvent
    ? stats.eventSubjects[metric.denominatorEvent] ?? 0
    : stats.subjects;
  return { numerator, denominator };
}

/** mean of a value-event on one variant (already display-scaled). */
function meanParts(
  stats: VariantStats,
  metric: MetricDef,
): { mean: number; variance: number; n: number } {
  const ev = metric.valueEvent;
  if (!ev) return { mean: 0, variance: 0, n: 0 };
  const n = stats.eventCounts[ev] ?? 0;
  const sum = stats.eventValueSums[ev] ?? 0;
  const sqSum = stats.eventValueSqSums[ev] ?? 0;
  return {
    mean: n > 0 ? sum / n : 0,
    variance: varianceFromSums(sum, sqSum, n),
    n,
  };
}

/** Raw primary-metric value for a variant (rate 0..1, or an unscaled mean). */
export function metricValue(stats: VariantStats, metric: MetricDef): number {
  if (metric.kind === 'rate') {
    const { numerator, denominator } = rateParts(stats, metric);
    return denominator > 0 ? numerator / denominator : 0;
  }
  return meanParts(stats, metric).mean;
}

/** Human-readable metric value. */
export function formatMetric(value: number, metric: MetricDef): string {
  if (metric.kind === 'rate') {
    return `${(value * 100).toFixed(1)}%`;
  }
  const scaled = value * (metric.valueScale ?? 1);
  return `${scaled.toFixed(1)} ${metric.unit}`;
}

// ---- Variant aggregation --------------------------------------------

function emptyStats(v: ExperimentVariant, subjects: number): VariantStats {
  return {
    variant_id: v.id,
    key: v.key,
    name: v.name,
    is_control: v.is_control,
    subjects,
    eventCounts: {},
    eventSubjects: {},
    eventValueSums: {},
    eventValueSqSums: {},
    primaryValue: 0,
    primaryDisplay: '—',
    liftVsControl: null,
    secondary: {},
  };
}

/**
 * Build per-variant stats from the rollup. Computes the primary metric, all
 * secondary metrics, and the relative lift of each variant vs the control.
 */
export function buildVariantStats(
  experiment: Experiment,
  variants: ExperimentVariant[],
  rollup: RollupRow[],
  assignmentCounts: AssignmentCountRow[],
): VariantStats[] {
  const subjectsByVariant = new Map<string, number>();
  for (const a of assignmentCounts) subjectsByVariant.set(a.variant_id, a.subjects);

  const statsByVariant = new Map<string, VariantStats>();
  for (const v of variants) {
    statsByVariant.set(v.id, emptyStats(v, subjectsByVariant.get(v.id) ?? 0));
  }

  for (const row of rollup) {
    const s = statsByVariant.get(row.variant_id);
    if (!s) continue;
    s.eventCounts[row.event_type] = row.n_events;
    s.eventSubjects[row.event_type] = row.n_subjects;
    s.eventValueSums[row.event_type] = row.value_sum;
    s.eventValueSqSums[row.event_type] = row.value_sq_sum;
  }

  const primaryMetric = experiment.goal_metric
    ? METRIC_BY_KEY[experiment.goal_metric]
    : undefined;

  const ordered = variants
    .map((v) => statsByVariant.get(v.id)!)
    .sort((a, b) => a.key.localeCompare(b.key));

  // Primary metric per variant.
  for (const s of ordered) {
    if (primaryMetric) {
      s.primaryValue = metricValue(s, primaryMetric);
      s.primaryDisplay = formatMetric(s.primaryValue, primaryMetric);
    }
    // Secondary metrics.
    for (const key of experiment.secondary_metrics) {
      const m = METRIC_BY_KEY[key];
      if (!m) continue;
      const val = metricValue(s, m);
      s.secondary[key] = { value: val, display: formatMetric(val, m) };
    }
  }

  // Lift vs control.
  const control = ordered.find((s) => s.is_control) ?? ordered[0];
  if (control) {
    for (const s of ordered) {
      if (s.variant_id === control.variant_id) {
        s.liftVsControl = null;
      } else if (control.primaryValue > 0) {
        s.liftVsControl = (s.primaryValue - control.primaryValue) / control.primaryValue;
      } else {
        s.liftVsControl = s.primaryValue > 0 ? 1 : 0;
      }
    }
  }

  return ordered;
}

// ---- Winner + confidence --------------------------------------------

export interface WinnerResult {
  /** The variant with the best primary metric (may be the control). */
  leader: VariantStats | null;
  control: VariantStats | null;
  /** Confidence the leader beats the control (one-sided, 0..1). */
  confidence: number;
}

export function pickWinner(
  variantStats: VariantStats[],
  metric: MetricDef | undefined,
): WinnerResult {
  if (!variantStats.length || !metric) {
    return { leader: null, control: null, confidence: 0 };
  }
  const control = variantStats.find((s) => s.is_control) ?? variantStats[0];
  let leader = control;
  for (const s of variantStats) {
    if (s.primaryValue > leader.primaryValue) leader = s;
  }
  if (leader.variant_id === control.variant_id) {
    return { leader, control, confidence: 0 };
  }

  let confidence = 0;
  if (metric.kind === 'rate') {
    const c = rateParts(control, metric);
    const l = rateParts(leader, metric);
    confidence = proportionConfidence(c.numerator, c.denominator, l.numerator, l.denominator);
  } else {
    confidence = meanConfidence(meanParts(control, metric), meanParts(leader, metric));
  }
  return { leader, control, confidence };
}

// ---- Report builder --------------------------------------------------

function hoursBetween(from: string | null, to: number): number {
  if (!from) return 0;
  return Math.max(0, (to - new Date(from).getTime()) / 3_600_000);
}

/** Build the full report for an experiment from its current data. */
export function buildReport(
  experiment: Experiment,
  variants: ExperimentVariant[],
  rollup: RollupRow[],
  assignmentCounts: AssignmentCountRow[],
  now: number = Date.now(),
): ExperimentReport {
  const metric = experiment.goal_metric
    ? METRIC_BY_KEY[experiment.goal_metric]
    : undefined;
  const variantStats = buildVariantStats(experiment, variants, rollup, assignmentCounts);
  const { leader, control, confidence } = pickWinner(variantStats, metric);
  const sampleSize = variantStats.reduce((sum, s) => sum + s.subjects, 0);
  const durationHours = hoursBetween(experiment.start_date, now);

  const confident = confidence >= experiment.confidence_threshold;
  const hasWinner = Boolean(leader && control && leader.variant_id !== control.variant_id && confident);
  const winner = hasWinner && leader
    ? { variant_id: leader.variant_id, key: leader.key, name: leader.name }
    : null;

  // Recommendation text — numbers-focused.
  let recommendation: string;
  if (winner && leader && control) {
    const liftPct = leader.liftVsControl != null ? (leader.liftVsControl * 100).toFixed(1) : '0.0';
    recommendation =
      `Approve ${leader.name} (${leader.key}) as the new default for ` +
      `${experiment.surface_key}. It beat the control by ${liftPct}% on ` +
      `${metric?.label ?? 'the primary metric'} ` +
      `(${leader.primaryDisplay} vs ${control.primaryDisplay}) ` +
      `at ${(confidence * 100).toFixed(1)}% confidence.`;
  } else if (leader && control && leader.variant_id !== control.variant_id) {
    recommendation =
      `Inconclusive. ${leader.name} leads (${leader.primaryDisplay} vs ` +
      `${control.primaryDisplay}) but confidence is only ` +
      `${(confidence * 100).toFixed(1)}%, below the ` +
      `${(experiment.confidence_threshold * 100).toFixed(0)}% bar. ` +
      `Continue the test or retest with more traffic.`;
  } else {
    recommendation =
      `Inconclusive. No variant outperformed the control. ` +
      `Reject the result or duplicate and retest a different idea.`;
  }

  // Risks / caveats.
  const risks: string[] = [];
  if (!confident) {
    risks.push(`Result has not cleared the ${(experiment.confidence_threshold * 100).toFixed(0)}% confidence bar.`);
  }
  if (experiment.min_sample_size > 0 && sampleSize < experiment.min_sample_size) {
    risks.push(`Sample (${sampleSize}) is below the ${experiment.min_sample_size} target — the effect may regress.`);
  }
  if (sampleSize < 100) {
    risks.push('Very small sample — treat the read as directional only.');
  }
  if (risks.length === 0) {
    risks.push('No major caveats — sample and confidence both cleared their bars.');
  }

  // Revenue / retention read-outs.
  let revenueImpact: string | null = null;
  if (metric?.revenue && winner && leader && control && leader.liftVsControl != null) {
    revenueImpact =
      `Premium conversions on this surface would rise ~${(leader.liftVsControl * 100).toFixed(1)}% ` +
      `if ${leader.name} is rolled out (${leader.primaryDisplay} vs ${control.primaryDisplay}).`;
  }
  let retentionImpact: string | null = null;
  if (leader && control) {
    const lRet = leader.secondary['d1_retention']?.value ?? 0;
    const cRet = control.secondary['d1_retention']?.value ?? 0;
    if (cRet > 0 && leader.variant_id !== control.variant_id) {
      const retLift = ((lRet - cRet) / cRet) * 100;
      retentionImpact =
        `Day-1 retention for ${leader.name}: ${(lRet * 100).toFixed(1)}% ` +
        `vs ${(cRet * 100).toFixed(1)}% control (${retLift >= 0 ? '+' : ''}${retLift.toFixed(1)}%).`;
    } else if (metric?.retention && winner) {
      retentionImpact = `${metric.label} is the primary metric — see the variant table for the retention read.`;
    }
  }

  const implementationNotes =
    winner && leader
      ? `Approving sets ${leader.name} (${leader.key}) as the live default for ` +
        `the "${experiment.surface_key}" surface. The experiment service serves ` +
        `its config to all users automatically — no code change or redeploy needed.`
      : `No change to the live experience. The "${experiment.surface_key}" surface ` +
        `keeps its current default until a conclusive test is approved.`;

  return {
    experiment_id: experiment.id,
    experiment_name: experiment.name,
    hypothesis: experiment.hypothesis,
    surface_key: experiment.surface_key,
    category: experiment.category,
    primary_metric: {
      key: metric?.key ?? experiment.goal_metric ?? 'unknown',
      label: metric?.label ?? experiment.goal_metric ?? 'Unknown metric',
      unit: metric?.unit ?? '',
    },
    secondary_metrics: experiment.secondary_metrics,
    variants: variantStats,
    winner,
    confidence,
    sample_size: sampleSize,
    duration_hours: durationHours,
    start_date: experiment.start_date,
    end_date: experiment.end_date,
    recommendation,
    risks: risks.join(' '),
    implementation_notes: implementationNotes,
    revenue_impact: revenueImpact,
    retention_impact: retentionImpact,
    generated_at: new Date(now).toISOString(),
  };
}

// ---- Autopilot -------------------------------------------------------

export interface AutopilotDecision {
  shouldComplete: boolean;
  reasons: string[];
}

/**
 * Decide whether a running experiment should auto-complete. A test completes
 * once it has collected enough data (sample size AND/OR runtime bars met), or
 * early if it is already statistically conclusive on a non-trivial sample.
 */
export function evaluateAutopilot(
  experiment: Experiment,
  report: ExperimentReport,
  now: number = Date.now(),
): AutopilotDecision {
  const reasons: string[] = [];
  const sampleSize = report.sample_size;
  const hoursElapsed = report.duration_hours;

  const sampleMet =
    experiment.min_sample_size <= 0 || sampleSize >= experiment.min_sample_size;
  const runtimeMet =
    experiment.min_runtime_hours <= 0 || hoursElapsed >= experiment.min_runtime_hours;
  const confidenceMet = report.confidence >= experiment.confidence_threshold;

  // Early stop: conclusive on a sample big enough to trust.
  const sanityFloor = Math.max(experiment.min_sample_size * 0.5, 100);
  if (confidenceMet && sampleSize >= sanityFloor) {
    reasons.push(
      `Statistical confidence ${(report.confidence * 100).toFixed(1)}% cleared the ` +
        `${(experiment.confidence_threshold * 100).toFixed(0)}% threshold on ${sampleSize} subjects.`,
    );
    return { shouldComplete: true, reasons };
  }

  if (sampleMet && runtimeMet) {
    if (experiment.min_sample_size > 0) {
      reasons.push(`Minimum sample size reached (${sampleSize} / ${experiment.min_sample_size}).`);
    }
    if (experiment.min_runtime_hours > 0) {
      reasons.push(
        `Minimum runtime reached (${hoursElapsed.toFixed(0)}h / ${experiment.min_runtime_hours}h).`,
      );
    }
    return { shouldComplete: true, reasons };
  }

  if (!sampleMet) {
    reasons.push(`Sample ${sampleSize} / ${experiment.min_sample_size} — still collecting.`);
  }
  if (!runtimeMet) {
    reasons.push(
      `Runtime ${hoursElapsed.toFixed(0)}h / ${experiment.min_runtime_hours}h — still running.`,
    );
  }
  return { shouldComplete: false, reasons };
}
