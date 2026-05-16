import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Song, SongStats } from '@/types';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAuth } from '@/contexts/AuthContext';
import { ChipMoodId, DEFAULT_MOOD_ORDER } from '@/lib/mood/moodCatalog';
import { MoodStore, moodStoreFor, MoodEventKind } from '@/lib/mood/MoodScoring';
import { ExposureLog, exposureLogFor } from '@/lib/recommendation/ExposureLog';
import { buildForYou } from '@/lib/recommendation/ForYouEngine';
import { fetchTodayStats } from '@/lib/stats/SongStats';

// ExploreContext owns the Explore-specific recommendation state: dynamic mood
// ordering and the For You pool plus its refresh orchestration. It reads the
// catalog / taste / session from PlayerContext and never drives playback
// itself — screens call player methods for that.

const FOR_YOU_REFRESH_MS = 30 * 60 * 1000;     // refresh after 30 min idle
const FOR_YOU_CONSUMED_TRIGGER = 5;            // refresh after 5 songs consumed
const FOR_YOU_LIMIT = 28;

interface ExploreValue {
  /** True once the per-user stores have hydrated. */
  ready: boolean;
  /** Mood ids ordered by behavior score (highest first). */
  moodOrder: ChipMoodId[];
  /** The mood chip the user has currently selected, if any. */
  sessionMoodId: ChipMoodId | null;
  /** The current For You pool (20-30 songs). */
  forYou: Song[];
  /** Record a mood interaction (also re-sorts the chip row). */
  recordMoodEvent: (moodId: ChipMoodId, kind: MoodEventKind) => void;
  /** Select / clear the active mood chip; rebuilds For You toward it. */
  selectMood: (moodId: ChipMoodId | null) => void;
  /** Force a For You rebuild. */
  refreshForYou: () => void;
  /** Shared per-user stores — Phase C playback wiring records outcomes here. */
  exposureLog: ExposureLog | null;
  moodStore: MoodStore | null;
}

const FALLBACK: ExploreValue = {
  ready: false,
  moodOrder: DEFAULT_MOOD_ORDER,
  sessionMoodId: null,
  forYou: [],
  recordMoodEvent: () => {},
  selectMood: () => {},
  refreshForYou: () => {},
  exposureLog: null,
  moodStore: null,
};

const Ctx = createContext<ExploreValue | null>(null);

export function ExploreProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const player = usePlayer();
  const userId = auth.userId;

  const moodStore = useMemo(() => (userId ? moodStoreFor(userId) : null), [userId]);
  const exposureLog = useMemo(() => (userId ? exposureLogFor(userId) : null), [userId]);

  const [ready, setReady] = useState(false);
  const [moodOrder, setMoodOrder] = useState<ChipMoodId[]>(DEFAULT_MOOD_ORDER);
  const [sessionMoodId, setSessionMoodId] = useState<ChipMoodId | null>(null);
  const [forYou, setForYou] = useState<Song[]>([]);
  const [serverStats, setServerStats] = useState<Map<string, SongStats>>(new Map());

  const lastRefreshRef = useRef(0);
  const forYouIdsRef = useRef<Set<string>>(new Set());
  // The catalog array For You was last built from. Comparing by reference
  // (not length) catches same-size catalog swaps from hydration too.
  const lastBuiltCatalogRef = useRef<Song[] | null>(null);

  // Hydrate the per-user stores once.
  useEffect(() => {
    if (!moodStore || !exposureLog) return;
    let cancelled = false;
    void (async () => {
      await Promise.all([moodStore.hydrate(), exposureLog.hydrate()]);
      if (cancelled) return;
      setMoodOrder(moodStore.orderedMoodIds());
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [moodStore, exposureLog]);

  // Today's per-song stats — improves For You quality, optional.
  useEffect(() => {
    let cancelled = false;
    fetchTodayStats()
      .then((m) => { if (!cancelled) setServerStats(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Build (or rebuild) the For You pool. `moodOverride === undefined` keeps
  // the current session mood; pass `null` to clear it.
  const build = useCallback((moodOverride?: ChipMoodId | null) => {
    if (!moodStore || !exposureLog) return;
    const catalog = player.catalog;
    if (catalog.length === 0) return;
    const result = buildForYou({
      catalog,
      taste: player.taste,
      session: player.getSession(),
      topMoodIds: moodStore.topMoods(3),
      sessionMoodId: moodOverride !== undefined ? moodOverride : sessionMoodId,
      suppressedIds: exposureLog.suppressedIds(),
      recentSkippedIds: exposureLog.recentSkippedIds(),
      stats: serverStats,
      interactionCount: auth.songsHeard,
      limit: FOR_YOU_LIMIT,
    });
    setForYou(result.songs);
    forYouIdsRef.current = new Set(result.songs.map((s) => s.id));
    lastRefreshRef.current = Date.now();
    lastBuiltCatalogRef.current = catalog;
    // Mark the pool as shown so the 24h anti-repeat starts its clock.
    exposureLog.recordShown(result.songs.map((s) => s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodStore, exposureLog, player.catalog, player.taste, sessionMoodId, serverStats, auth.songsHeard]);

  const refreshForYou = useCallback(() => build(), [build]);

  // First build, and rebuild when the catalog grows (new songs available).
  useEffect(() => {
    if (!ready || player.catalog.length === 0) return;
    if (forYou.length === 0 || player.catalog !== lastBuiltCatalogRef.current) {
      build();
    }
  }, [ready, player.catalog, forYou.length, build]);

  // Checked whenever the current song changes: keep the mood chip order live
  // as playback drives mood scores, then apply the For You refresh triggers
  // (30-min idle window, or 5 songs consumed from the current For You list).
  useEffect(() => {
    if (!ready) return;
    if (moodStore) setMoodOrder(moodStore.orderedMoodIds());
    if (!exposureLog || forYou.length === 0) return;
    const now = Date.now();
    if (now - lastRefreshRef.current > FOR_YOU_REFRESH_MS) { build(); return; }
    const o = exposureLog.outcomesSince(lastRefreshRef.current, forYouIdsRef.current);
    if (o.played + o.skipped + o.completed >= FOR_YOU_CONSUMED_TRIGGER) build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.current?.id]);

  const recordMoodEvent = useCallback((moodId: ChipMoodId, kind: MoodEventKind) => {
    if (!moodStore) return;
    moodStore.record(moodId, kind);
    setMoodOrder(moodStore.orderedMoodIds());
  }, [moodStore]);

  const selectMood = useCallback((moodId: ChipMoodId | null) => {
    setSessionMoodId(moodId);
    if (moodId && moodStore) {
      moodStore.record(moodId, 'click');
      setMoodOrder(moodStore.orderedMoodIds());
    }
    // Rebuild For You with the new mood weighting (spec PART 4).
    build(moodId);
  }, [moodStore, build]);

  const value = useMemo<ExploreValue>(() => ({
    ready,
    moodOrder,
    sessionMoodId,
    forYou,
    recordMoodEvent,
    selectMood,
    refreshForYou,
    exposureLog,
    moodStore,
  }), [ready, moodOrder, sessionMoodId, forYou, recordMoodEvent, selectMood, refreshForYou, exposureLog, moodStore]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useExplore(): ExploreValue {
  return useContext(Ctx) ?? FALLBACK;
}
