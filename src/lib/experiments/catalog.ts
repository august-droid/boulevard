// Static catalog for the experimentation system: the surfaces a test can
// change, the experiment categories, the trackable event types, and the
// metric definitions used to score variants. This is the single source of
// truth shared by the admin dashboard and the runtime experiment service.

import type {
  ExperimentCategory,
  SurfaceKey,
  VariantConfig,
} from '@/lib/experiments/types';

// ---- Surfaces --------------------------------------------------------

export interface SurfaceDef {
  key: SurfaceKey;
  label: string;
  description: string;
  category: ExperimentCategory;
}

/** Every surface a split test can target. One running test per surface. */
export const SURFACES: SurfaceDef[] = [
  {
    key: 'onboarding_flow',
    label: 'Onboarding Flow',
    description: 'Signup screen, onboarding steps, taste questions, listen-before-signup gate.',
    category: 'onboarding',
  },
  {
    key: 'premium_popup',
    label: 'Premium Popup / Paywall',
    description: 'Paywall artwork, headline, CTA, trial copy, timing, modal vs fullscreen.',
    category: 'premium_popup',
  },
  {
    key: 'for_you_algorithm',
    label: 'For You Algorithm',
    description: 'Freshness / popularity / mood / discovery weighting and artist repetition.',
    category: 'algorithm',
  },
  {
    key: 'explore_page',
    label: 'Explore Page',
    description: 'Explore section order, card sizes, trending/new-release positioning.',
    category: 'design',
  },
  {
    key: 'comment_section',
    label: 'Comment Section',
    description: 'Comments visibility, prompts, likes-only vs comments, sort order.',
    category: 'engagement',
  },
  {
    key: 'player_screen',
    label: 'Player Screen',
    description: 'Player layout, CTA placement, artwork size, controls arrangement.',
    category: 'design',
  },
];

export const SURFACE_BY_KEY: Record<SurfaceKey, SurfaceDef> = SURFACES.reduce(
  (acc, s) => {
    acc[s.key] = s;
    return acc;
  },
  {} as Record<SurfaceKey, SurfaceDef>,
);

// ---- Categories ------------------------------------------------------

export interface CategoryDef {
  key: ExperimentCategory;
  label: string;
}

export const EXPERIMENT_CATEGORIES: CategoryDef[] = [
  { key: 'onboarding', label: 'Onboarding / User Creation' },
  { key: 'premium_popup', label: 'Premium Popup / Paywall' },
  { key: 'algorithm', label: 'Algorithm / For You Feed' },
  { key: 'design', label: 'Design / UI' },
  { key: 'engagement', label: 'Comments / Engagement' },
];

// ---- Event types -----------------------------------------------------

/** The trackable experiment event types. event_type is free text in the DB
 *  (so the system stays scalable), but these are the well-known ones the
 *  metric catalog understands. */
export const EXPERIMENT_EVENTS = [
  'impression',
  'click',
  'conversion',
  'dismiss',
  'session_length',
  'songs_played',
  'songs_completed',
  'skip',
  'replay',
  'like',
  'comment',
  'share',
  'premium_popup_view',
  'premium_start',
  'premium_purchase',
  'signup_start',
  'signup_completion',
  'return_session',
  'artist_discovery',
  'engagement',
] as const;

export type ExperimentEventType = (typeof EXPERIMENT_EVENTS)[number];

// ---- Metrics ---------------------------------------------------------

export interface MetricDef {
  key: string;
  label: string;
  /** `rate` = numerator/denominator proportion. `mean` = average of a value. */
  kind: 'rate' | 'mean';
  /** Display unit suffix, e.g. '%', 'min', 'songs'. */
  unit: string;
  /** rate: the event whose distinct-subject count is the numerator. */
  numeratorEvent?: ExperimentEventType;
  /** rate: the event whose distinct-subject count is the denominator.
   *  When omitted the denominator is the enrolled-subject count. */
  denominatorEvent?: ExperimentEventType;
  /** mean: the event whose numeric `value` is averaged. */
  valueEvent?: ExperimentEventType;
  /** mean: multiply the raw value by this for display (e.g. seconds→min). */
  valueScale?: number;
  /** Higher is the winning direction. (All current metrics: true.) */
  higherIsBetter: boolean;
  /** Metric carries a revenue read-out in the report. */
  revenue?: boolean;
  /** Metric carries a retention read-out in the report. */
  retention?: boolean;
}

export const METRICS: MetricDef[] = [
  {
    key: 'premium_conversion_rate',
    label: 'Premium conversion rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'premium_purchase',
    higherIsBetter: true,
    revenue: true,
  },
  {
    key: 'premium_start_rate',
    label: 'Premium trial-start rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'premium_start',
    denominatorEvent: 'premium_popup_view',
    higherIsBetter: true,
    revenue: true,
  },
  {
    key: 'popup_ctr',
    label: 'Popup click-through rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'click',
    denominatorEvent: 'impression',
    higherIsBetter: true,
  },
  {
    key: 'signup_completion_rate',
    label: 'Signup completion rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'signup_completion',
    denominatorEvent: 'signup_start',
    higherIsBetter: true,
  },
  {
    key: 'signup_conversion_rate',
    label: 'Signup conversion rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'signup_completion',
    higherIsBetter: true,
  },
  {
    key: 'avg_session_duration',
    label: 'Average session duration',
    kind: 'mean',
    unit: 'min',
    valueEvent: 'session_length',
    valueScale: 1 / 60,
    higherIsBetter: true,
    retention: true,
  },
  {
    key: 'songs_per_session',
    label: 'Songs played per session',
    kind: 'mean',
    unit: 'songs',
    valueEvent: 'songs_played',
    higherIsBetter: true,
  },
  {
    key: 'songs_completed_per_session',
    label: 'Songs completed per session',
    kind: 'mean',
    unit: 'songs',
    valueEvent: 'songs_completed',
    higherIsBetter: true,
  },
  {
    key: 'comment_rate',
    label: 'Comment rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'comment',
    higherIsBetter: true,
  },
  {
    key: 'engagement_rate',
    label: 'Engagement rate (likes + comments)',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'engagement',
    higherIsBetter: true,
  },
  {
    key: 'd1_retention',
    label: 'Day-1 retention',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'return_session',
    higherIsBetter: true,
    retention: true,
  },
  {
    key: 'discovery_rate',
    label: 'Artist / song discovery rate',
    kind: 'rate',
    unit: '%',
    numeratorEvent: 'artist_discovery',
    higherIsBetter: true,
  },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = METRICS.reduce(
  (acc, m) => {
    acc[m.key] = m;
    return acc;
  },
  {} as Record<string, MetricDef>,
);

/** Metric keys the admin form offers per category, primary first. */
export const METRICS_BY_CATEGORY: Record<ExperimentCategory, string[]> = {
  onboarding: ['signup_completion_rate', 'signup_conversion_rate', 'songs_per_session', 'd1_retention'],
  premium_popup: ['premium_conversion_rate', 'premium_start_rate', 'popup_ctr', 'avg_session_duration'],
  algorithm: ['songs_per_session', 'avg_session_duration', 'songs_completed_per_session', 'discovery_rate', 'd1_retention'],
  design: ['avg_session_duration', 'songs_per_session', 'popup_ctr', 'd1_retention'],
  engagement: ['comment_rate', 'engagement_rate', 'avg_session_duration', 'd1_retention'],
};

// ---- Variant config examples ----------------------------------------

/** Reference config shapes for the admin "Create variant" form. Surfaces
 *  read whichever keys they understand and ignore the rest, so configs are
 *  free-form — these are just sensible starting points. */
export const VARIANT_CONFIG_EXAMPLES: Record<SurfaceKey, VariantConfig> = {
  premium_popup: {
    headline: 'Unlock your personal music universe',
    subheadline: 'Get unlimited songs matched to your mood.',
    cta: 'Start Listening Unlimited',
    artworkType: 'artist_emotional_closeup',
    popupStyle: 'fullscreen',
  },
  for_you_algorithm: {
    freshnessWeight: 0.3,
    moodWeight: 0.4,
    popularityWeight: 0.2,
    discoveryWeight: 0.1,
    maxSameArtistInNext10Songs: 1,
  },
  onboarding_flow: {
    steps: 3,
    askMusicTaste: true,
    askMood: true,
    signupTiming: 'after_listening',
    freeSongsBeforeSignup: 5,
  },
  explore_page: {
    sectionOrder: ['trending', 'new_releases', 'moods', 'for_you'],
    cardSize: 'medium',
  },
  comment_section: {
    visibleByDefault: true,
    prompt: 'What did this song make you feel?',
    sort: 'top',
    mode: 'comments_and_likes',
  },
  player_screen: {
    layout: 'classic',
    artworkSize: 'large',
    ctaPlacement: 'below_controls',
  },
};
