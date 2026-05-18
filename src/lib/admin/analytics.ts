import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// Admin analytics data layer — typed wrappers over the SECURITY DEFINER RPCs
// in sql/2026-05-17_analytics.sql. Every call is admin-gated server-side; a
// non-admin receives an error and these helpers resolve to empty/null.

export type AnalyticsPeriod = 'day' | 'week' | 'month';

/** Every headline KPI for one time window. Mirrors analytics_window_metrics. */
export interface WindowMetrics {
  window_days: number;
  plays: number;
  streams: number;
  active_users: number;
  sessions: number;
  app_opens_per_day: number;
  new_users: number;
  signups: number;
  signup_conversion_rate: number;
  new_premium: number;
  premium_conversion_rate: number;
  premium_active_rate: number;
  avg_session_seconds: number;
  avg_listen_pct: number;
  drop_off_rate: number;
  hook_rate: number;
}

export interface AnalyticsOverview {
  period: AnalyticsPeriod;
  current_start: string;
  previous_start: string;
  current: WindowMetrics;
  previous: WindowMetrics;
}

export interface TimeseriesBucket {
  bucket_start: string;
  metrics: WindowMetrics;
}

export type TopContentKind =
  | 'genres'
  | 'moods'
  | 'artists'
  | 'songs'
  | 'replay_songs'
  | 'retention_songs'
  | 'worlds'
  | 'onboarding_songs'
  | 'onboarding_clusters'
  | 'clusters';

export interface TopRow {
  label: string;
  sub: string | null;
  value: number;
  /** 'plays' | 'replays' | 'retention' | 'hit_rate' | 'avg_completion' — drives
   *  how the screen formats `value` (count vs 0..1 rate). */
  unit: string;
}

export interface QualityBucket {
  bucket: number;
  count: number;
}

export interface DistributionData {
  stage_counts: {
    new_test: number;
    rising: number;
    trending: number;
    suppressed: number;
  };
  staged_total: number;
  new_test_survival_rate: number;
  rising_to_trending_rate: number;
  suppression_rate: number;
  quality_histogram: QualityBucket[];
}

const EMPTY_METRICS: WindowMetrics = {
  window_days: 1,
  plays: 0,
  streams: 0,
  active_users: 0,
  sessions: 0,
  app_opens_per_day: 0,
  new_users: 0,
  signups: 0,
  signup_conversion_rate: 0,
  new_premium: 0,
  premium_conversion_rate: 0,
  premium_active_rate: 0,
  avg_session_seconds: 0,
  avg_listen_pct: 0,
  drop_off_rate: 0,
  hook_rate: 0,
};

function numify(raw: any): WindowMetrics {
  const m = raw ?? {};
  const out = { ...EMPTY_METRICS };
  for (const key of Object.keys(out) as (keyof WindowMetrics)[]) {
    const v = Number(m[key]);
    out[key] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Current + previous period KPIs for the dashboard header. */
export async function fetchOverview(
  period: AnalyticsPeriod,
): Promise<AnalyticsOverview | null> {
  if (!HAS_SUPABASE || !supabase) return null;
  try {
    const { data, error } = await supabase.rpc('analytics_overview', {
      p_period: period,
    });
    if (error || !data) return null;
    const d = data as any;
    return {
      period,
      current_start: d.current_start,
      previous_start: d.previous_start,
      current: numify(d.current),
      previous: numify(d.previous),
    };
  } catch {
    return null;
  }
}

/** The last `buckets` periods, oldest first — for trend sparklines. */
export async function fetchTimeseries(
  period: AnalyticsPeriod,
  buckets: number,
): Promise<TimeseriesBucket[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  try {
    const { data, error } = await supabase.rpc('analytics_timeseries', {
      p_period: period,
      p_buckets: buckets,
    });
    if (error || !data) return [];
    return (data as any[]).map((r) => ({
      bucket_start: r.bucket_start,
      metrics: numify(r.metrics),
    }));
  } catch {
    return [];
  }
}

/** A ranked content list (top genres, artists, songs, clusters, …). */
export async function fetchTopContent(
  kind: TopContentKind,
  period: AnalyticsPeriod,
  offset = 0,
  limit = 10,
): Promise<TopRow[]> {
  if (!HAS_SUPABASE || !supabase) return [];
  try {
    const { data, error } = await supabase.rpc('analytics_top_content', {
      p_kind: kind,
      p_period: period,
      p_offset: offset,
      p_limit: limit,
    });
    if (error || !data) return [];
    return (data as any[]).map((r) => ({
      label: String(r.label ?? '—'),
      sub: r.sub != null ? String(r.sub) : null,
      value: Number(r.value) || 0,
      unit: String(r.unit ?? ''),
    }));
  } catch {
    return [];
  }
}

/** Algorithm / staged-distribution health snapshot. */
export async function fetchDistribution(): Promise<DistributionData | null> {
  if (!HAS_SUPABASE || !supabase) return null;
  try {
    const { data, error } = await supabase.rpc('analytics_distribution');
    if (error || !data) return null;
    const d = data as any;
    return {
      stage_counts: {
        new_test: Number(d.stage_counts?.new_test) || 0,
        rising: Number(d.stage_counts?.rising) || 0,
        trending: Number(d.stage_counts?.trending) || 0,
        suppressed: Number(d.stage_counts?.suppressed) || 0,
      },
      staged_total: Number(d.staged_total) || 0,
      new_test_survival_rate: Number(d.new_test_survival_rate) || 0,
      rising_to_trending_rate: Number(d.rising_to_trending_rate) || 0,
      suppression_rate: Number(d.suppression_rate) || 0,
      quality_histogram: Array.isArray(d.quality_histogram)
        ? d.quality_histogram.map((b: any) => ({
            bucket: Number(b.bucket) || 0,
            count: Number(b.count) || 0,
          }))
        : [],
    };
  } catch {
    return null;
  }
}

// ---- Formatting helpers ---------------------------------------------

/** Percent-change of `cur` vs `prev`. null when there is no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!Number.isFinite(prev) || prev === 0) return cur > 0 ? null : 0;
  return (cur - prev) / prev;
}

export function formatRate(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
