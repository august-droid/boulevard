// Admin-side experiment API. Every function here is gated by the admin-only
// RLS policies in sql/2026-05-17_experiments.sql (and the SECURITY DEFINER
// RPCs re-check is_admin()), so a non-admin calling these gets empty results
// or a permission error — never a silent privilege escalation.

import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { buildReport, evaluateAutopilot } from '@/lib/experiments/evaluation';
import type { RollupRow, AssignmentCountRow } from '@/lib/experiments/evaluation';
import type {
  AudienceRules,
  Experiment,
  ExperimentApproval,
  ExperimentCategory,
  ExperimentReport,
  ExperimentStatus,
  ExperimentVariant,
  SurfaceKey,
  VariantConfig,
} from '@/lib/experiments/types';

function client() {
  if (!HAS_SUPABASE || !supabase) throw new Error('Supabase is not configured');
  return supabase;
}

// ---- Row normalization ----------------------------------------------

function normalizeExperiment(row: any): Experiment {
  const variants: ExperimentVariant[] = Array.isArray(row.experiment_variants)
    ? row.experiment_variants
        .map((v: any) => ({
          id: v.id,
          experiment_id: v.experiment_id,
          key: v.key,
          name: v.name,
          is_control: Boolean(v.is_control),
          config: v.config ?? {},
          traffic_weight: v.traffic_weight ?? 1,
          sort_order: v.sort_order ?? 0,
        }))
        .sort((a: ExperimentVariant, b: ExperimentVariant) => a.sort_order - b.sort_order)
    : [];
  return {
    id: row.id,
    name: row.name,
    hypothesis: row.hypothesis ?? null,
    surface_key: row.surface_key,
    category: row.category,
    status: row.status,
    goal_metric: row.goal_metric ?? null,
    secondary_metrics: row.secondary_metrics ?? [],
    success_criteria: row.success_criteria ?? null,
    audience: row.audience ?? {},
    min_sample_size: row.min_sample_size ?? 0,
    min_runtime_hours: row.min_runtime_hours ?? 0,
    confidence_threshold: row.confidence_threshold ?? 0.95,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    recommended_variant_id: row.recommended_variant_id ?? null,
    winner_variant_id: row.winner_variant_id ?? null,
    created_by: row.created_by ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    variants,
  };
}

// ---- Reads -----------------------------------------------------------

/** All experiments (newest first), with their variants. */
export async function listExperiments(): Promise<Experiment[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  const { data, error } = await supabase
    .from('experiments')
    .select('*, experiment_variants(*)')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map(normalizeExperiment);
}

export async function getExperiment(id: string): Promise<Experiment | null> {
  if (!HAS_SUPABASE || !supabase) return null;
  const { data, error } = await supabase
    .from('experiments')
    .select('*, experiment_variants(*)')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeExperiment(data);
}

export async function fetchRollup(experimentId: string): Promise<RollupRow[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  const { data, error } = await supabase.rpc('experiment_event_rollup', {
    p_experiment_id: experimentId,
  });
  if (error || !data) return [];
  return (data as any[]).map((r) => ({
    variant_id: r.variant_id,
    event_type: r.event_type,
    n_events: Number(r.n_events) || 0,
    n_subjects: Number(r.n_subjects) || 0,
    value_sum: Number(r.value_sum) || 0,
    value_sq_sum: Number(r.value_sq_sum) || 0,
  }));
}

export async function fetchAssignmentCounts(
  experimentId: string,
): Promise<AssignmentCountRow[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  const { data, error } = await supabase.rpc('experiment_assignment_counts', {
    p_experiment_id: experimentId,
  });
  if (error || !data) return [];
  return (data as any[]).map((r) => ({
    variant_id: r.variant_id,
    subjects: Number(r.subjects) || 0,
  }));
}

export async function fetchReports(experimentId: string): Promise<
  { id: string; generated_at: string; body: ExperimentReport }[]
> {
  if (!HAS_SUPABASE || !supabase) return [];
  const { data, error } = await supabase
    .from('experiment_reports')
    .select('id, generated_at, body')
    .eq('experiment_id', experimentId)
    .order('generated_at', { ascending: false });
  if (error || !data) return [];
  return data as any;
}

export async function fetchApprovals(
  experimentId: string,
): Promise<ExperimentApproval[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  const { data, error } = await supabase
    .from('experiment_approvals')
    .select('*')
    .eq('experiment_id', experimentId)
    .order('decided_at', { ascending: false });
  if (error || !data) return [];
  return data as ExperimentApproval[];
}

/** Live results for a running experiment — a freshly computed report that is
 *  NOT persisted (used to render the live dashboard view). */
export async function computeLiveReport(
  experiment: Experiment,
): Promise<ExperimentReport | null> {
  if (!experiment.variants?.length) return null;
  const [rollup, counts] = await Promise.all([
    fetchRollup(experiment.id),
    fetchAssignmentCounts(experiment.id),
  ]);
  return buildReport(experiment, experiment.variants, rollup, counts);
}

// ---- Writes ----------------------------------------------------------

export interface VariantInput {
  key: string;
  name: string;
  is_control: boolean;
  config: VariantConfig;
  traffic_weight: number;
  sort_order: number;
}

export interface ExperimentInput {
  name: string;
  hypothesis: string;
  surface_key: SurfaceKey;
  category: ExperimentCategory;
  goal_metric: string;
  secondary_metrics: string[];
  success_criteria: string;
  audience: AudienceRules;
  min_sample_size: number;
  min_runtime_hours: number;
  confidence_threshold: number;
  variants: VariantInput[];
}

/** Create a draft experiment with its variants. */
export async function createExperiment(input: ExperimentInput): Promise<string> {
  const sb = client();
  const { data: me } = await sb.auth.getUser();
  const { data, error } = await sb
    .from('experiments')
    .insert({
      name: input.name,
      hypothesis: input.hypothesis,
      surface_key: input.surface_key,
      category: input.category,
      status: 'draft',
      goal_metric: input.goal_metric,
      secondary_metrics: input.secondary_metrics,
      success_criteria: input.success_criteria,
      audience: input.audience,
      min_sample_size: input.min_sample_size,
      min_runtime_hours: input.min_runtime_hours,
      confidence_threshold: input.confidence_threshold,
      created_by: me?.user?.id ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'create failed');
  const experimentId = data.id as string;

  if (input.variants.length) {
    const { error: vErr } = await sb.from('experiment_variants').insert(
      input.variants.map((v) => ({
        experiment_id: experimentId,
        key: v.key,
        name: v.name,
        is_control: v.is_control,
        config: v.config,
        traffic_weight: v.traffic_weight,
        sort_order: v.sort_order,
      })),
    );
    if (vErr) throw new Error(vErr.message);
  }
  return experimentId;
}

/**
 * Full edit of a draft experiment: update the experiment row and replace its
 * variant set. Variant ids change — only safe before a test has run, which is
 * why the dashboard only exposes Edit on drafts.
 */
export async function updateExperimentFull(
  id: string,
  input: ExperimentInput,
): Promise<void> {
  const sb = client();
  const { error } = await sb
    .from('experiments')
    .update({
      name: input.name,
      hypothesis: input.hypothesis,
      surface_key: input.surface_key,
      category: input.category,
      goal_metric: input.goal_metric,
      secondary_metrics: input.secondary_metrics,
      success_criteria: input.success_criteria,
      audience: input.audience,
      min_sample_size: input.min_sample_size,
      min_runtime_hours: input.min_runtime_hours,
      confidence_threshold: input.confidence_threshold,
    })
    .eq('id', id);
  if (error) throw new Error(error.message);

  const { error: delErr } = await sb
    .from('experiment_variants')
    .delete()
    .eq('experiment_id', id);
  if (delErr) throw new Error(delErr.message);

  if (input.variants.length) {
    const { error: insErr } = await sb.from('experiment_variants').insert(
      input.variants.map((v) => ({
        experiment_id: id,
        key: v.key,
        name: v.name,
        is_control: v.is_control,
        config: v.config,
        traffic_weight: v.traffic_weight,
        sort_order: v.sort_order,
      })),
    );
    if (insErr) throw new Error(insErr.message);
  }
}

/**
 * Change an experiment's status. The DB activation trigger refuses to move a
 * test into `running` unless it has a hypothesis, primary metric, success
 * criteria, a sample/runtime bar, ≥2 variants, and no surface conflict — so a
 * thrown error here is a real validation failure to surface to the admin.
 */
export async function setStatus(
  id: string,
  status: ExperimentStatus,
): Promise<void> {
  const sb = client();
  const patch: Record<string, unknown> = { status };
  if (status === 'archived') patch.archived_at = new Date().toISOString();
  const { error } = await sb.from('experiments').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Duplicate an experiment (and its variants) as a fresh draft. */
export async function duplicateExperiment(id: string): Promise<string> {
  const src = await getExperiment(id);
  if (!src) throw new Error('experiment not found');
  return createExperiment({
    name: `${src.name} (copy)`,
    hypothesis: src.hypothesis ?? '',
    surface_key: src.surface_key,
    category: src.category,
    goal_metric: src.goal_metric ?? '',
    secondary_metrics: src.secondary_metrics,
    success_criteria: src.success_criteria ?? '',
    audience: src.audience,
    min_sample_size: src.min_sample_size,
    min_runtime_hours: src.min_runtime_hours,
    confidence_threshold: src.confidence_threshold,
    variants: (src.variants ?? []).map((v, i) => ({
      key: v.key,
      name: v.name,
      is_control: v.is_control,
      config: v.config,
      traffic_weight: v.traffic_weight,
      sort_order: v.sort_order ?? i,
    })),
  });
}

/** Persist a report and move the experiment to `awaiting_approval`. */
export async function submitReport(
  experimentId: string,
  report: ExperimentReport,
): Promise<string> {
  const sb = client();
  const { data, error } = await sb.rpc('submit_experiment_report', {
    p_experiment_id: experimentId,
    p_report: report,
    p_winner_variant_id: report.winner?.variant_id ?? null,
    p_confidence: report.confidence,
    p_sample_size: report.sample_size,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'continued' | 'manual';

/** Record a human approval decision. Only `approved`/`manual` change the live
 *  default; `rejected` and `continued` leave the current experience intact. */
export async function approveExperiment(opts: {
  experimentId: string;
  reportId: string | null;
  decision: ApprovalDecision;
  chosenVariantId?: string | null;
  notes?: string;
}): Promise<void> {
  const sb = client();
  const { error } = await sb.rpc('approve_experiment', {
    p_experiment_id: opts.experimentId,
    p_report_id: opts.reportId,
    p_decision: opts.decision,
    p_chosen_variant_id: opts.chosenVariantId ?? null,
    p_notes: opts.notes ?? null,
  });
  if (error) throw new Error(error.message);
}

// ---- Autopilot -------------------------------------------------------

export interface AutopilotOutcome {
  experimentId: string;
  name: string;
  completed: boolean;
  reasons: string[];
}

/**
 * Sweep every running experiment: compute a fresh report, and if the
 * autopilot says it is done, persist the report and move it to
 * `awaiting_approval` for human sign-off. Returns one outcome per experiment.
 *
 * Triggered when the admin opens the dashboard. It can also be wired to a
 * Supabase cron for fully hands-off monitoring (see migration header).
 */
export async function autopilotSweep(
  experiments: Experiment[],
): Promise<AutopilotOutcome[]> {
  const running = experiments.filter((e) => e.status === 'running');
  const outcomes: AutopilotOutcome[] = [];
  for (const exp of running) {
    if (!exp.variants?.length) continue;
    try {
      const [rollup, counts] = await Promise.all([
        fetchRollup(exp.id),
        fetchAssignmentCounts(exp.id),
      ]);
      const report = buildReport(exp, exp.variants, rollup, counts);
      const decision = evaluateAutopilot(exp, report);
      if (decision.shouldComplete) {
        await submitReport(exp.id, report);
      }
      outcomes.push({
        experimentId: exp.id,
        name: exp.name,
        completed: decision.shouldComplete,
        reasons: decision.reasons,
      });
    } catch {
      // Skip this experiment on error — the sweep is best-effort.
    }
  }
  return outcomes;
}
