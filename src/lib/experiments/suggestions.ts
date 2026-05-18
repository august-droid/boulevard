// AI-recommended split tests.
//
// The recommender proposes high-value experiments the admin can approve into
// a draft (one tap) or dismiss. It is a curated, rule-based generator: a
// library of proven experiment templates, filtered to surfaces that are not
// already under test, and ranked by expected impact. Each template has a
// stable suggestion_key so a dismissed idea never resurfaces.

import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { createExperiment } from '@/lib/experiments/adminExperiments';
import type {
  Experiment,
  ExperimentSuggestion,
  SurfaceKey,
} from '@/lib/experiments/types';

// ---- Template library -----------------------------------------------

const TEMPLATES: ExperimentSuggestion[] = [
  {
    suggestion_key: 'tmpl_premium_emotional_artwork_v1',
    title: 'Emotional artist artwork in the premium popup',
    surface_key: 'premium_popup',
    category: 'premium_popup',
    goal_metric: 'premium_conversion_rate',
    hypothesis:
      'Changing the premium popup artwork from generic artwork to emotional ' +
      'artist-focused artwork will increase premium signup conversion because ' +
      'users will feel more emotionally connected to the music experience.',
    rationale:
      'Artwork is the highest-salience element of the paywall. Artist-focused ' +
      'imagery typically lifts conversion 20-60% in music apps.',
    variants: [
      {
        key: 'A',
        name: 'Current generic popup',
        is_control: true,
        config: { artworkType: 'generic', popupStyle: 'fullscreen' },
      },
      {
        key: 'B',
        name: 'Emotional artist close-up',
        is_control: false,
        config: { artworkType: 'artist_emotional_closeup', popupStyle: 'fullscreen' },
      },
      {
        key: 'C',
        name: 'Abstract album-art style',
        is_control: false,
        config: { artworkType: 'abstract_album', popupStyle: 'fullscreen' },
      },
    ],
  },
  {
    suggestion_key: 'tmpl_premium_copy_emotional_v1',
    title: 'Emotional vs benefit-driven paywall copy',
    surface_key: 'premium_popup',
    category: 'premium_popup',
    goal_metric: 'premium_start_rate',
    hypothesis:
      'Emotional headline copy will increase trial starts over benefit-driven ' +
      'copy because it speaks to why people listen rather than what they get.',
    rationale:
      'Copy is cheap to test and the headline is read by every viewer. ' +
      'Emotional framing usually wins on first-time conversion.',
    variants: [
      {
        key: 'A',
        name: 'Benefit-driven',
        is_control: true,
        config: {
          headline: 'Unlimited songs, no interruptions',
          cta: 'Start Free Trial',
        },
      },
      {
        key: 'B',
        name: 'Emotional',
        is_control: false,
        config: {
          headline: 'Unlock your personal music universe',
          cta: 'Start Listening Unlimited',
        },
      },
    ],
  },
  {
    suggestion_key: 'tmpl_onboarding_fewer_steps_v1',
    title: 'Shorter onboarding (1 step vs 3 steps)',
    surface_key: 'onboarding_flow',
    category: 'onboarding',
    goal_metric: 'signup_completion_rate',
    hypothesis:
      'Reducing onboarding from 3 steps to 1 step will increase signup ' +
      'completion because every extra step is a drop-off opportunity.',
    rationale:
      'Onboarding length is the single biggest lever on signup completion. ' +
      'Worth confirming the taste questions earn their friction.',
    variants: [
      { key: 'A', name: '3-step onboarding', is_control: true, config: { steps: 3 } },
      { key: 'B', name: '1-step onboarding', is_control: false, config: { steps: 1 } },
    ],
  },
  {
    suggestion_key: 'tmpl_onboarding_listen_first_v1',
    title: 'Listen before signup (3 vs 5 vs 10 songs)',
    surface_key: 'onboarding_flow',
    category: 'onboarding',
    goal_metric: 'signup_conversion_rate',
    hypothesis:
      'Letting users hear more songs before asking them to create an account ' +
      'will increase signup conversion because they sign up already invested.',
    rationale:
      'The free-listen count before the gate trades reach for intent. ' +
      'Finding the sweet spot directly moves signup conversion.',
    variants: [
      { key: 'A', name: '3 songs then signup', is_control: true, config: { freeSongsBeforeSignup: 3 } },
      { key: 'B', name: '5 songs then signup', is_control: false, config: { freeSongsBeforeSignup: 5 } },
      { key: 'C', name: '10 songs then signup', is_control: false, config: { freeSongsBeforeSignup: 10 } },
    ],
  },
  {
    suggestion_key: 'tmpl_algo_discovery_weight_v1',
    title: 'More new-artist discovery in For You',
    surface_key: 'for_you_algorithm',
    category: 'algorithm',
    goal_metric: 'discovery_rate',
    hypothesis:
      'Raising the new-artist discovery weight in the For You feed will ' +
      'increase artist discovery without hurting session length.',
    rationale:
      'Discovery drives catalog breadth and long-term retention. Test it ' +
      'against session length so it does not trade away engagement.',
    variants: [
      {
        key: 'A',
        name: 'Current discovery weight',
        is_control: true,
        config: { discoveryWeight: 0.1, freshnessWeight: 0.3, moodWeight: 0.4, popularityWeight: 0.2 },
      },
      {
        key: 'B',
        name: 'Higher discovery weight',
        is_control: false,
        config: { discoveryWeight: 0.25, freshnessWeight: 0.3, moodWeight: 0.35, popularityWeight: 0.1 },
      },
    ],
  },
  {
    suggestion_key: 'tmpl_algo_artist_repetition_v1',
    title: 'Tighter artist repetition limit',
    surface_key: 'for_you_algorithm',
    category: 'algorithm',
    goal_metric: 'songs_per_session',
    hypothesis:
      'Limiting the same artist to once per 10 songs will increase songs ' +
      'played per session because the feed feels more varied.',
    rationale:
      'Repetition fatigue is a common cause of early session exits. A ' +
      'stricter spacing rule is a low-risk config change.',
    variants: [
      { key: 'A', name: 'Up to 2 per 10 songs', is_control: true, config: { maxSameArtistInNext10Songs: 2 } },
      { key: 'B', name: 'Max 1 per 10 songs', is_control: false, config: { maxSameArtistInNext10Songs: 1 } },
    ],
  },
  {
    suggestion_key: 'tmpl_comments_visible_default_v1',
    title: 'Show the comment section by default',
    surface_key: 'comment_section',
    category: 'engagement',
    goal_metric: 'comment_rate',
    hypothesis:
      'Showing comments by default instead of hidden will increase the ' +
      'comment rate because social proof invites participation.',
    rationale:
      'Visible social context is the strongest driver of first comments. ' +
      'Check session length stays flat as a guardrail.',
    variants: [
      { key: 'A', name: 'Comments hidden by default', is_control: true, config: { visibleByDefault: false } },
      { key: 'B', name: 'Comments shown by default', is_control: false, config: { visibleByDefault: true } },
    ],
  },
  {
    suggestion_key: 'tmpl_comments_emotional_prompt_v1',
    title: 'Emotional discussion prompt on songs',
    surface_key: 'comment_section',
    category: 'engagement',
    goal_metric: 'engagement_rate',
    hypothesis:
      'Adding a "What did this song make you feel?" prompt will increase ' +
      'engagement because an open question lowers the bar to participate.',
    rationale:
      'A specific, feeling-led prompt converts lurkers to contributors far ' +
      'better than an empty comment box.',
    variants: [
      { key: 'A', name: 'No prompt', is_control: true, config: { prompt: '' } },
      {
        key: 'B',
        name: 'Feeling prompt',
        is_control: false,
        config: { prompt: 'What did this song make you feel?' },
      },
    ],
  },
  {
    suggestion_key: 'tmpl_explore_trending_first_v1',
    title: 'Trending above new releases on Explore',
    surface_key: 'explore_page',
    category: 'design',
    goal_metric: 'avg_session_duration',
    hypothesis:
      'Placing the trending section above new releases will increase session ' +
      'duration because socially validated songs hook users faster.',
    rationale:
      'Section order is a pure layout change with no engineering risk and a ' +
      'direct line to session length.',
    variants: [
      {
        key: 'A',
        name: 'New releases first',
        is_control: true,
        config: { sectionOrder: ['new_releases', 'trending', 'moods', 'for_you'] },
      },
      {
        key: 'B',
        name: 'Trending first',
        is_control: false,
        config: { sectionOrder: ['trending', 'new_releases', 'moods', 'for_you'] },
      },
    ],
  },
  {
    suggestion_key: 'tmpl_player_artwork_size_v1',
    title: 'Larger artwork on the player screen',
    surface_key: 'player_screen',
    category: 'design',
    goal_metric: 'avg_session_duration',
    hypothesis:
      'A larger artwork on the player screen will increase session duration ' +
      'because immersive visuals deepen the listening experience.',
    rationale:
      'Player visual weight affects perceived quality. A safe layout test ' +
      'with session length as the read.',
    variants: [
      { key: 'A', name: 'Medium artwork', is_control: true, config: { artworkSize: 'medium' } },
      { key: 'B', name: 'Large artwork', is_control: false, config: { artworkSize: 'large' } },
    ],
  },
];

// ---- Generation + persistence ---------------------------------------

/** Surfaces with a test that already occupies them — a suggestion there
 *  would conflict, so it is held back until the surface is free. */
function occupiedSurfaces(experiments: Experiment[]): Set<SurfaceKey> {
  const busy = new Set<SurfaceKey>();
  for (const e of experiments) {
    if (e.status === 'running' || e.status === 'awaiting_approval') {
      busy.add(e.surface_key);
    }
  }
  return busy;
}

/** Templates whose surface is currently free to test. */
export function generateSuggestions(experiments: Experiment[]): ExperimentSuggestion[] {
  const busy = occupiedSurfaces(experiments);
  return TEMPLATES.filter((t) => !busy.has(t.surface_key));
}

/**
 * Upsert the current generated pool into experiment_suggestions (keeping any
 * existing accepted/dismissed status), then return the OPEN ones not blocked
 * by a busy surface — i.e. what the admin should see to act on.
 */
export async function syncAndFetchSuggestions(
  experiments: Experiment[],
): Promise<ExperimentSuggestion[]> {
  if (!HAS_SUPABASE || !supabase) return generateSuggestions(experiments);
  const pool = generateSuggestions(experiments);

  // Insert any new templates as `open`; ignore ones already on record so a
  // prior dismiss/accept decision is preserved.
  try {
    await supabase.from('experiment_suggestions').upsert(
      pool.map((s) => ({
        suggestion_key: s.suggestion_key,
        title: s.title,
        hypothesis: s.hypothesis,
        surface_key: s.surface_key,
        category: s.category,
        goal_metric: s.goal_metric,
        variants: s.variants,
        rationale: s.rationale,
        status: 'open',
      })),
      { onConflict: 'suggestion_key', ignoreDuplicates: true },
    );
  } catch {
    // Best-effort — fall back to the in-memory pool below on read failure.
  }

  try {
    const poolKeys = pool.map((s) => s.suggestion_key);
    const { data } = await supabase
      .from('experiment_suggestions')
      .select('*')
      .eq('status', 'open')
      .in('suggestion_key', poolKeys);
    if (data) return data as ExperimentSuggestion[];
  } catch {
    // ignore
  }
  return pool;
}

/** Approve a suggestion: create a draft experiment from it and mark accepted. */
export async function acceptSuggestion(
  suggestion: ExperimentSuggestion,
): Promise<string> {
  const experimentId = await createExperiment({
    name: suggestion.title,
    hypothesis: suggestion.hypothesis,
    surface_key: suggestion.surface_key,
    category: suggestion.category,
    goal_metric: suggestion.goal_metric,
    secondary_metrics: [],
    success_criteria:
      'Primary metric beats control with >= 95% confidence on the planned sample.',
    audience: {},
    min_sample_size: 1000,
    min_runtime_hours: 168,
    confidence_threshold: 0.95,
    variants: suggestion.variants.map((v, i) => ({
      key: v.key,
      name: v.name,
      is_control: v.is_control,
      config: v.config,
      traffic_weight: 1,
      sort_order: i,
    })),
  });
  if (HAS_SUPABASE && supabase) {
    const { data: me } = await supabase.auth.getUser();
    await supabase
      .from('experiment_suggestions')
      .update({
        status: 'accepted',
        created_experiment_id: experimentId,
        decided_by: me?.user?.id ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq('suggestion_key', suggestion.suggestion_key);
  }
  return experimentId;
}

/** Dismiss a suggestion so it never resurfaces. */
export async function dismissSuggestion(suggestionKey: string): Promise<void> {
  if (!HAS_SUPABASE || !supabase) return;
  const { data: me } = await supabase.auth.getUser();
  await supabase
    .from('experiment_suggestions')
    .update({
      status: 'dismissed',
      decided_by: me?.user?.id ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq('suggestion_key', suggestionKey);
}
