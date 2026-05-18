// Domain types for the Boulevard experimentation / split-testing system.
//
// These mirror the SQL tables in sql/2026-05-17_experiments.sql. The client
// never hardcodes a test inside a component — it reads an active experiment
// for a surface_key and renders the assigned variant's `config`.

export type ExperimentStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'completed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'archived';

export type ExperimentCategory =
  | 'onboarding'
  | 'premium_popup'
  | 'algorithm'
  | 'design'
  | 'engagement';

/** A surface is a single place in the app a test can change. Only ONE
 *  experiment may be `running` per surface_key at a time (conflict guard). */
export type SurfaceKey =
  | 'onboarding_flow'
  | 'premium_popup'
  | 'for_you_algorithm'
  | 'explore_page'
  | 'comment_section'
  | 'player_screen';

/** Free-form JSON config a variant carries. The surface decides which keys
 *  it reads — see VARIANT_CONFIG_EXAMPLES in catalog.ts. */
export type VariantConfig = Record<string, unknown>;

export interface ExperimentVariant {
  id: string;
  experiment_id?: string;
  key: string;
  name: string;
  is_control: boolean;
  config: VariantConfig;
  traffic_weight: number;
  sort_order: number;
}

/** Audience targeting rules. Empty object = everyone. */
export interface AudienceRules {
  platform?: 'web' | 'ios' | 'android';
  anonymous_only?: boolean;
  signed_up_only?: boolean;
  premium?: boolean;
  min_songs_heard?: number;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string | null;
  surface_key: SurfaceKey;
  category: ExperimentCategory;
  status: ExperimentStatus;
  goal_metric: string | null;
  secondary_metrics: string[];
  success_criteria: string | null;
  audience: AudienceRules;
  min_sample_size: number;
  min_runtime_hours: number;
  confidence_threshold: number;
  start_date: string | null;
  end_date: string | null;
  recommended_variant_id: string | null;
  winner_variant_id: string | null;
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  variants?: ExperimentVariant[];
}

/** The slim shape get_active_experiments() returns to normal clients. */
export interface ActiveExperiment {
  id: string;
  surface_key: SurfaceKey;
  category: ExperimentCategory;
  status: 'running' | 'approved';
  goal_metric: string | null;
  audience: AudienceRules;
  winner_variant_id: string | null;
  variants: ExperimentVariant[];
}

/** What useExperiment(surfaceKey) hands a component. */
export interface ExperimentHandle {
  /** The active experiment for this surface, or null when no test runs. */
  experiment: ActiveExperiment | null;
  /** The variant this subject is assigned to, or null. */
  variant: ExperimentVariant | null;
  /** Shorthand for variant?.config — always an object, {} when no test. */
  config: VariantConfig;
  /** True when a live test is changing this surface. */
  isActive: boolean;
  /** Read a config value with a typed default. Falls back to `fallback`
   *  whenever no test is active or the key is missing. */
  value: <T>(key: string, fallback: T) => T;
  /** Log an experiment event for this surface's active test. No-op when no
   *  test is active, so call sites are safe to leave in permanently. */
  track: (eventType: string, opts?: { value?: number; metadata?: Record<string, unknown> }) => void;
}

export interface ExperimentEventInput {
  experiment_id: string;
  variant_id: string;
  subject_id: string;
  event_type: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

// ---- Reporting -------------------------------------------------------

/** Per-variant aggregated stats used by live results + reports. */
export interface VariantStats {
  variant_id: string;
  key: string;
  name: string;
  is_control: boolean;
  /** Enrolled subjects (assignment count). */
  subjects: number;
  /** Raw event counts keyed by event_type. */
  eventCounts: Record<string, number>;
  /** Distinct subjects who fired each event_type. */
  eventSubjects: Record<string, number>;
  /** Summed numeric `value` per event_type. */
  eventValueSums: Record<string, number>;
  /** Summed squared `value` per event_type (for variance / t-tests). */
  eventValueSqSums: Record<string, number>;
  /** The primary metric value for this variant (rate 0..1 or a mean). */
  primaryValue: number;
  /** Human-readable primary metric (e.g. "6.8%" or "4.2 min"). */
  primaryDisplay: string;
  /** Relative lift vs the control variant, e.g. +0.619 = +61.9%. Null for
   *  the control row itself. */
  liftVsControl: number | null;
  /** Secondary metric read-outs keyed by metric key. */
  secondary: Record<string, { value: number; display: string }>;
}

export interface ExperimentReport {
  experiment_id: string;
  experiment_name: string;
  hypothesis: string | null;
  surface_key: SurfaceKey;
  category: ExperimentCategory;
  primary_metric: { key: string; label: string; unit: string };
  secondary_metrics: string[];
  variants: VariantStats[];
  /** Recommended winner — null when no variant beats control with confidence. */
  winner: { variant_id: string; key: string; name: string } | null;
  /** Statistical confidence the winner beats control (0..1). */
  confidence: number;
  sample_size: number;
  duration_hours: number;
  start_date: string | null;
  end_date: string | null;
  recommendation: string;
  risks: string;
  implementation_notes: string;
  revenue_impact: string | null;
  retention_impact: string | null;
  generated_at: string;
}

export interface ExperimentApproval {
  id: string;
  experiment_id: string;
  report_id: string | null;
  decision: 'approved' | 'rejected' | 'continued' | 'manual';
  chosen_variant_id: string | null;
  notes: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface ExperimentSuggestion {
  id?: string;
  suggestion_key: string;
  title: string;
  hypothesis: string;
  surface_key: SurfaceKey;
  category: ExperimentCategory;
  goal_metric: string;
  variants: { key: string; name: string; is_control: boolean; config: VariantConfig }[];
  rationale: string;
  status?: 'open' | 'accepted' | 'dismissed';
  created_experiment_id?: string | null;
}
