import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import {
  ExperimentEventTracker,
  fetchActiveExperiments,
  persistAssignment,
} from '@/lib/experiments/ExperimentClient';
import { assignVariant, matchesAudience } from '@/lib/experiments/assignment';
import type { AudienceContext } from '@/lib/experiments/assignment';
import type {
  ActiveExperiment,
  ExperimentHandle,
  ExperimentVariant,
  SurfaceKey,
} from '@/lib/experiments/types';

// Runtime experiment provider.
//
// Loads the running + approved experiments once at startup (via the
// get_active_experiments RPC) and hands components a per-surface
// ExperimentHandle through the useExperiment(surfaceKey) hook.
//
// Safety: this provider NEVER blocks rendering. Until experiments load — and
// forever, if there is no backend — every surface sees an inert handle and
// renders its built-in default. A test can only ever ADD behavior.

interface ExperimentContextValue {
  activeExperiments: ActiveExperiment[];
  ready: boolean;
  tracker: ExperimentEventTracker;
  refresh: () => Promise<void>;
}

const ExperimentCtx = createContext<ExperimentContextValue | null>(null);

/** An inert handle — what every surface gets when no test is touching it. */
function inertHandle(): ExperimentHandle {
  return {
    experiment: null,
    variant: null,
    config: {},
    isActive: false,
    value: <T,>(_key: string, fallback: T) => fallback,
    track: () => {},
  };
}

export function ExperimentProvider({ children }: { children: React.ReactNode }) {
  const [activeExperiments, setActiveExperiments] = useState<ActiveExperiment[]>([]);
  const [ready, setReady] = useState(false);
  const trackerRef = useRef<ExperimentEventTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = new ExperimentEventTracker();

  const refresh = useCallback(async () => {
    const list = await fetchActiveExperiments();
    setActiveExperiments(list);
    setReady(true);
  }, []);

  useEffect(() => {
    const tracker = trackerRef.current!;
    tracker.start();
    void refresh();
    return () => {
      tracker.stop();
      void tracker.flush();
    };
  }, [refresh]);

  const value = useMemo<ExperimentContextValue>(
    () => ({
      activeExperiments,
      ready,
      tracker: trackerRef.current!,
      refresh,
    }),
    [activeExperiments, ready, refresh],
  );

  return <ExperimentCtx.Provider value={value}>{children}</ExperimentCtx.Provider>;
}

function platformKey(): AudienceContext['platform'] {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * Resolve the active experiment for a surface for the current subject.
 *
 *   • A `running` test whose audience the subject matches → the subject's
 *     deterministically-assigned variant. isActive = true.
 *   • Otherwise an `approved` test → its human-approved winning variant,
 *     served to everyone as the new default. isActive = false.
 *   • Otherwise → an inert handle; the surface renders its built-in default.
 *
 * Call it from any component: `const popup = useExperiment('premium_popup')`.
 * It is always safe to leave the call in permanently — when no test runs it
 * is a no-op that returns the fallbacks you pass to `value()`.
 */
export function useExperiment(surfaceKey: SurfaceKey): ExperimentHandle {
  const ctx = useContext(ExperimentCtx);
  const auth = useAuth();
  const subjectId = auth.userId;

  const audienceCtx: AudienceContext = useMemo(
    () => ({
      platform: platformKey(),
      isAnonymous: auth.isAnonymous,
      hasSignedUp: auth.hasSignedUp,
      isPremium: auth.isPremium,
      songsHeard: auth.songsHeard,
    }),
    [auth.isAnonymous, auth.hasSignedUp, auth.isPremium, auth.songsHeard],
  );

  const resolved = useMemo(() => {
    if (!ctx || !subjectId) {
      return { experiment: null as ActiveExperiment | null, variant: null as ExperimentVariant | null, isActive: false };
    }
    const forSurface = ctx.activeExperiments.filter((e) => e.surface_key === surfaceKey);
    const running = forSurface.find((e) => e.status === 'running');
    const approved = forSurface.find((e) => e.status === 'approved');

    if (running && matchesAudience(running.audience, audienceCtx)) {
      const variant = assignVariant(running.id, subjectId, running.variants);
      return { experiment: running, variant, isActive: true };
    }
    if (approved && approved.winner_variant_id) {
      const variant =
        approved.variants.find((v) => v.id === approved.winner_variant_id) ?? null;
      if (variant) return { experiment: approved, variant, isActive: false };
    }
    return { experiment: null, variant: null, isActive: false };
  }, [ctx, subjectId, surfaceKey, audienceCtx]);

  // Persist the assignment for a live test (audit + admin analytics). Runs
  // once per surface per mount; the upsert is idempotent so duplicate writes
  // from multiple components are harmless. Deterministic assignment does not
  // depend on this succeeding.
  useEffect(() => {
    if (!resolved.isActive || !resolved.experiment || !resolved.variant || !subjectId) {
      return;
    }
    void persistAssignment({
      experimentId: resolved.experiment.id,
      variantId: resolved.variant.id,
      subjectId,
      subjectKind: auth.isAnonymous ? 'anon' : 'user',
      surfaceKey,
    });
  }, [resolved, subjectId, auth.isAnonymous, surfaceKey]);

  return useMemo<ExperimentHandle>(() => {
    if (!resolved.experiment || !resolved.variant || !ctx || !subjectId) {
      return inertHandle();
    }
    const experiment = resolved.experiment;
    const variant = resolved.variant;
    const config = variant.config ?? {};
    return {
      experiment,
      variant,
      config,
      isActive: resolved.isActive,
      value: <T,>(key: string, fallback: T): T => {
        const v = config[key];
        return v === undefined || v === null ? fallback : (v as T);
      },
      track: (eventType, opts) => {
        ctx.tracker.track({
          experiment_id: experiment.id,
          variant_id: variant.id,
          subject_id: subjectId,
          event_type: eventType,
          value: opts?.value,
          metadata: opts?.metadata,
        });
      },
    };
  }, [resolved, ctx, subjectId]);
}

/** Access the provider directly (used by the admin dashboard to refresh after
 *  approving a winner so the new default takes effect without a reload). */
export function useExperimentContext(): ExperimentContextValue {
  const ctx = useContext(ExperimentCtx);
  if (!ctx) throw new Error('useExperimentContext must be used within ExperimentProvider');
  return ctx;
}
