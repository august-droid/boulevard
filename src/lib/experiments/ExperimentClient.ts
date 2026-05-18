// Runtime experiment service — the read/write path normal users hit.
//
//   • fetchActiveExperiments(): the running + approved tests, via the
//     SECURITY DEFINER get_active_experiments() RPC (the experiments table
//     itself is admin-only under RLS).
//   • persistAssignment(): records a subject's deterministic variant in
//     experiment_assignments (idempotent — audit/analytics only).
//   • ExperimentEventTracker: a batched, non-blocking writer for
//     experiment_events, mirroring the EventTracker pattern.
//
// Everything here fails soft: with no Supabase backend, or on any network
// error, the app keeps working with default (no-test) behavior.

import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import type {
  ActiveExperiment,
  ExperimentEventInput,
  ExperimentVariant,
} from '@/lib/experiments/types';

/** Fetch all running + approved experiments with their variants. */
export async function fetchActiveExperiments(): Promise<ActiveExperiment[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  try {
    const { data, error } = await supabase.rpc('get_active_experiments');
    if (error || !data) return [];
    return (data as RawActiveExperiment[]).map(normalizeActiveExperiment);
  } catch {
    return [];
  }
}

interface RawActiveExperiment {
  id: string;
  surface_key: string;
  category: string;
  status: string;
  goal_metric: string | null;
  audience: unknown;
  winner_variant_id: string | null;
  variants: unknown;
}

function normalizeActiveExperiment(raw: RawActiveExperiment): ActiveExperiment {
  const variants: ExperimentVariant[] = Array.isArray(raw.variants)
    ? (raw.variants as ExperimentVariant[]).map((v) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        is_control: Boolean(v.is_control),
        config: (v.config as Record<string, unknown>) ?? {},
        traffic_weight: typeof v.traffic_weight === 'number' ? v.traffic_weight : 1,
        sort_order: typeof v.sort_order === 'number' ? v.sort_order : 0,
      }))
    : [];
  return {
    id: raw.id,
    surface_key: raw.surface_key as ActiveExperiment['surface_key'],
    category: raw.category as ActiveExperiment['category'],
    status: raw.status === 'approved' ? 'approved' : 'running',
    goal_metric: raw.goal_metric,
    audience: (raw.audience as ActiveExperiment['audience']) ?? {},
    winner_variant_id: raw.winner_variant_id,
    variants,
  };
}

/**
 * Record a subject's variant assignment. Idempotent — the unique
 * (experiment_id, subject_id) constraint means a repeat insert is a harmless
 * no-op. Fire-and-forget; assignment is deterministic so a failed write never
 * changes what the user sees.
 */
export async function persistAssignment(opts: {
  experimentId: string;
  variantId: string;
  subjectId: string;
  subjectKind: 'user' | 'anon';
  surfaceKey: string;
}): Promise<void> {
  if (!HAS_SUPABASE || !supabase) return;
  try {
    await supabase
      .from('experiment_assignments')
      .upsert(
        {
          experiment_id: opts.experimentId,
          variant_id: opts.variantId,
          subject_id: opts.subjectId,
          subject_kind: opts.subjectKind,
          surface_key: opts.surfaceKey,
        },
        { onConflict: 'experiment_id,subject_id', ignoreDuplicates: true },
      );
  } catch {
    // Best-effort — deterministic assignment does not depend on this row.
  }
}

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER = 40;

/**
 * Batched, non-blocking writer for experiment_events. One instance lives in
 * ExperimentContext for the app lifetime. Never throws, never blocks the UI.
 */
export class ExperimentEventTracker {
  private buffer: ExperimentEventInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  track(event: ExperimentEventInput) {
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BUFFER) {
      this.flush().catch(() => {});
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    if (!HAS_SUPABASE || !supabase) {
      this.buffer = [];
      return;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    const rows = batch.map((e) => ({
      experiment_id: e.experiment_id,
      variant_id: e.variant_id,
      subject_id: e.subject_id,
      event_type: e.event_type,
      value: e.value ?? null,
      metadata: e.metadata ?? {},
    }));
    const { error } = await supabase.from('experiment_events').insert(rows);
    if (error) {
      // Re-queue on failure, capped so memory cannot grow unbounded.
      this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFER * 2);
    }
  }
}
