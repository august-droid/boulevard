import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import { Song, Activity, TasteProfile, SongStats } from '@/types';
import { AudioPlayer, PlaybackTickPayload } from '@/lib/audio/AudioPlayer';
import { Preloader } from '@/lib/audio/Preloader';
import { QueueManager } from '@/lib/queue/QueueManager';
import { rankCandidates } from '@/lib/recommendation/RecommendationEngine';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { applySessionSignal, applySignal, emptyProfile, emptySession, signalsFromPlayback } from '@/lib/taste/TasteProfile';
import type { SessionProfile } from '@/types';
import { EventTracker } from '@/lib/events/EventTracker';
import { SEED_SONGS } from '@/lib/seed/songs';
import { loadCatalog } from '@/lib/catalog/loadCatalog';
import { catalogHydrator } from '@/lib/catalog/catalogHydration';
import { buildMoodPlaylist, Mood } from '@/lib/mood/MoodPlaylist';
import { LibraryStore } from '@/lib/library/LibraryStore';
import { CompletionLimiter, COMPLETION_THRESHOLD } from '@/lib/limits/CompletionLimiter';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// PlayerContext is the single source of truth for playback state.
// Screens subscribe via the `usePlayer` hook; they never touch audio/queue
// internals directly.

interface PlayerState {
  current: Song | null;
  isPlaying: boolean;
  position: number; // ms
  duration: number; // ms
  vibe: Activity | null;
  saved: boolean;
  /** TikTok-style heart — distinct from `saved`. Persisted to user_song_likes
   *  and feeds a strong positive signal into TasteProfile + SessionProfile. */
  liked: boolean;
  catalog: Song[];
  taste: TasteProfile | null;
  library: LibraryStore | null;
  libraryVersion: number;
  /** When true, the producer ignores ranking and serves random songs. */
  isShuffling: boolean;
}

interface PlayerActions {
  togglePlay: () => Promise<void>;
  skip: () => Promise<void>;
  /** Flip shuffle. When turning on, the queue is reshuffled immediately so
   *  the very next track is random, not the previously-ranked next. */
  toggleShuffle: () => Promise<void>;
  /**
   * Spotify-style previous:
   *  • If current position > 3 s, seek back to 0 (replay current).
   *  • Otherwise pop the back-stack and play the previously-played song.
   *  • If there's no back-stack, just seek to 0.
   */
  previous: () => Promise<void>;
  replay: () => Promise<void>;
  save: () => Promise<void>;
  /** Toggle the like state on the current song. Persists to
   *  user_song_likes + fires a 'like'/'unlike' signal into the taste profile. */
  like: () => Promise<void>;
  /** Read the current short-window session profile. Imperative — consumers
   *  call this on render (which fires when taste changes). Returns a live
   *  reference; do not mutate. */
  getSession: () => SessionProfile;
  /** Track a successful native share and apply the +5 share signal. */
  recordShare: () => Promise<void>;
  /** Seek to an absolute position within the current song (in ms). */
  seek: (positionMillis: number) => Promise<void>;
  setVibe: (v: Activity | null) => Promise<void>;
  playSpecific: (song: Song) => Promise<void>;
  /** Play a curated list of songs in order. First song plays, rest queue. */
  playPlaylist: (songs: Song[]) => Promise<void>;
  /** Play the top 30 most-popular songs nationwide. Ranks by server-side
   *  trending score when available, falls back to launch_score. */
  playPopular: () => Promise<void>;
  /**
   * Hint to the audio preloader that these songs may be tapped soon — used
   * by screens like Explore to prefetch likely targets so tap-to-play is
   * effectively instant. Fire and forget; safe to call repeatedly.
   */
  warmSongs: (songs: Song[]) => void;
  /**
   * Build a personalized playlist for a mood. Reads the player's own
   * recently-played list + interaction count (snapshot at call time)
   * and hands them to the mood ranker so two users tapping the same
   * mood get different songs. Returns the full ordered list — caller
   * decides whether to `playPlaylist` immediately or stash it.
   */
  buildMoodList: (mood: Mood, limit?: number) => Song[];
}

type PlayerValue = PlayerState & PlayerActions;

const PlayerCtx = createContext<PlayerValue | null>(null);

// Last song the user heard, persisted so the player surface is pre-staged
// on cold start. Spotify-style — the user sees their last track, doesn't
// have to find it again.
const LAST_SONG_KEY = 'boulevard.last_song_id';

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const {
    userId, isPremium, songsHeard,
    bumpEngagement, bumpSongsHeard, bumpSkipCount,
    setCompletionState, bumpBlockedAttempts,
  } = auth;

  // Long-lived singletons. Created lazily; do not recreate on rerender.
  const audioRef = useRef<AudioPlayer | null>(null);
  const preloaderRef = useRef<Preloader | null>(null);
  const queueRef = useRef<QueueManager | null>(null);
  const trackerRef = useRef<EventTracker | null>(null);
  const libraryRef = useRef<LibraryStore | null>(null);
  const limiterRef = useRef<CompletionLimiter | null>(null);
  const isPremiumRef = useRef(false);
  useEffect(() => { isPremiumRef.current = isPremium; }, [isPremium]);

  // Mirrors used by the producer closure so it always sees fresh values
  // without needing to re-bind the QueueManager.
  const interactionCountRef = useRef(0);
  useEffect(() => { interactionCountRef.current = songsHeard; }, [songsHeard]);
  const statsRef = useRef<Map<string, SongStats>>(new Map());
  // Short-window "right now" profile. In-memory only, never persisted —
  // a cold start naturally clears it, and the 30-min idle reset prevents
  // yesterday's mood from biasing today's queue.
  const sessionRef = useRef<SessionProfile>(emptySession());
  // Liked song ids — loaded from user_song_likes on init, kept in sync by
  // like(). Used to compute `liked` whenever the current song changes.
  const likedIdsRef = useRef<Set<string>>(new Set());

  // Per-song timing.
  //
  // songStartedAtRef tracks WALL-CLOCK time the song started. It is still
  // used by taste signals (where "user spent N seconds" is a reasonable
  // proxy for "interest") but no longer used for the free-tier cap.
  //
  // The free-tier cap uses ACTUAL audio playback progress (last position
  // reported by onTick / duration). Without this distinction, a paused
  // song accrues wall-clock seconds, so leaving the app paused for five
  // minutes would falsely register every short tap as a full listen.
  const songStartedAtRef = useRef<number>(0);
  // True once the current song has crossed the 90% playback threshold and
  // had its completion registered. Reset to false on every new song so
  // the next track is eligible to count again.
  const currentCompletedRef = useRef(false);

  // Recent songs window for the recommender (penalize repetition).
  const recentIdsRef = useRef<string[]>([]);
  const RECENT_WINDOW = 8;

  const [state, setState] = useState<PlayerState>({
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    vibe: null,
    saved: false,
    liked: false,
    catalog: SEED_SONGS,
    taste: null,
    library: null,
    libraryVersion: 0,
    isShuffling: false,
  });

  // Mirrored ref so the long-lived producer closure sees the current shuffle
  // setting without needing to rebind the QueueManager each toggle.
  const isShufflingRef = useRef(false);

  // Mirror state into a ref so async callbacks and long-lived closures
  // (producer, tick listener, etc.) can read the latest snapshot without
  // depending on React's render cycle.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Vibe is read by the recommendation producer in QueueManager.reset() right
  // after setVibe() is called. setState is batched/async, so stateRef trails
  // by one tick. vibeRef is updated synchronously inside setVibe so the
  // producer sees the new vibe on the very first refill.
  const vibeRef = useRef<Activity | null>(null);

  // ---- Long-lived: build the player stack exactly once per user. ----
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const setup = async () => {
      await AudioPlayer.configureSession();

      const audio = new AudioPlayer();
      const preloader = new Preloader();
      const library = new LibraryStore(userId);
      await library.hydrate();

      const limiter = new CompletionLimiter(userId);
      // Reconcile with Supabase up-front so a wiped AsyncStorage cannot
      // regrant a fresh ten free listens. Falls back to local-only when
      // offline.
      const initialCompletion = await limiter.reconcileWithServer();
      setCompletionState(initialCompletion.count, initialCompletion.limitHit);

      audioRef.current = audio;
      preloaderRef.current = preloader;
      libraryRef.current = library;
      limiterRef.current = limiter;

      // Subscribe to library changes exactly once.
      const offLib = library.onChange(() => {
        setState((s) => ({ ...s, libraryVersion: s.libraryVersion + 1 }));
      });

      // Subscribe to playback ticks/end exactly once. The Sound under
      // AudioPlayer is replaced on each song, but our listener set persists.
      //
      // The tick handler also registers free-tier completion the moment
      // audio progress crosses 90%. This is more robust than waiting for
      // the natural end-of-song event: if the user listens to 95% then
      // force-quits, audio.onEnd may never fire, but the >=90% threshold
      // already triggered here and the completion is persisted.
      const offTick = audio.onTick((p: PlaybackTickPayload) => {
        setState((s) => ({
          ...s,
          position: p.positionMillis,
          duration: p.durationMillis || s.duration,
          isPlaying: p.isPlaying,
        }));
        if (
          !currentCompletedRef.current &&
          limiterRef.current &&
          !isPremiumRef.current &&
          p.durationMillis > 0 &&
          p.positionMillis / p.durationMillis >= COMPLETION_THRESHOLD
        ) {
          const cur = stateRef.current.current;
          if (cur) {
            currentCompletedRef.current = true;
            limiterRef.current
              .registerCompletion(cur.id)
              .then((res) => setCompletionState(res.count, res.limitHit))
              .catch(() => {});
          }
        }
      });
      const offEnd = audio.onEnd(() => {
        // Auto-advance when a song finishes naturally.
        handleAdvanceRef.current?.(false).catch(() => {});
      });
      // Auto-skip on a broken row (bad CDN URL, network timeout, codec, etc.).
      // The next preloaded song plays instantly so the user barely notices.
      const offFail = audio.onLoadFailed(() => {
        handleAdvanceRef.current?.(true).catch(() => {});
      });

      trackerRef.current = new EventTracker(String(uuid.v4()));
      trackerRef.current.start();

      // Supabase → local JSON catalog → empty (see loadCatalog).
      const { songs: catalog } = await loadCatalog();

      // Load existing taste profile if any.
      let taste: TasteProfile = emptyProfile(userId);
      if (HAS_SUPABASE && supabase) {
        try {
          const { data } = await supabase
            .from('user_taste_profiles')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
          if (data) {
            taste = data as TasteProfile;
            // Back-compat: profiles created before the microtag upgrade lack
            // this field. Initialize to {} so the ranker treats them as
            // "no microtag preference learned yet" rather than crashing.
            if (!taste.microtag_scores) taste.microtag_scores = {};
          }
        } catch {
          // ignore
        }
      }

      // Hydrate the user's like-set in one round-trip so the heart shows
      // the correct fill state the first time they tap into any song.
      if (HAS_SUPABASE && supabase) {
        try {
          const { data: likes } = await supabase
            .from('user_song_likes')
            .select('song_id')
            .eq('user_id', userId);
          likedIdsRef.current = new Set((likes ?? []).map((r) => (r as { song_id: string }).song_id));
        } catch {
          // best-effort — if it fails, hearts start empty and like() will re-sync
        }
      }

      // Kick off a stats fetch in the background — first refill won't have it
      // yet, but subsequent refills will use the real per-song aggregates.
      fetchTodayStats()
        .then((m) => { statsRef.current = m; })
        .catch(() => {});

      // The producer reads the latest taste via stateRef and the latest vibe
      // via vibeRef (which setVibe writes synchronously so it's never stale).
      // When shuffle is on, we bypass ranking entirely and serve a random
      // sample so the next song is unpredictable.
      const producer = async (avoidIds: string[], count: number) => {
        let picks: Song[];
        if (isShufflingRef.current) {
          const avoid = new Set(avoidIds);
          const pool = stateRef.current.catalog.filter((s) => !avoid.has(s.id));
          // Fisher-Yates partial shuffle — enough randomness for `count` picks
          // without rearranging the entire catalog every refill.
          for (let i = 0; i < Math.min(count, pool.length); i++) {
            const j = i + Math.floor(Math.random() * (pool.length - i));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          picks = pool.slice(0, count);
        } else {
          // rankCandidates owns its own quality fallback when the main path
          // returns empty — we trust whatever it hands back.
          picks = rankCandidates(
            catalog,
            {
              taste: stateRef.current.taste ?? taste,
              session: sessionRef.current,
              vibe: vibeRef.current,
              recentSongIds: recentIdsRef.current,
              interactionCount: interactionCountRef.current,
              stats: statsRef.current,
            },
            avoidIds,
            count,
          );
        }

        // Log a song_impressed event for each newly served song. This is the
        // "served, may or may not play" signal that drives stage transitions
        // (impressions != plays). EventTracker batches these so we don't
        // flood the network during refills.
        if (userId) {
          for (const s of picks) {
            trackerRef.current?.track({
              user_id: userId,
              song_id: s.id,
              event_type: 'song_impressed',
              vibe_context: vibeRef.current,
            });
          }
        }
        return picks;
      };

      const queue = new QueueManager(producer, preloader);
      queueRef.current = queue;

      if (cancelled) return;

      // Spotify-style cold start: stage the last song the user heard so it
      // shows on the Home / mini player surface, but DO NOT auto-play.
      // The user taps play themselves when they're ready.
      //
      // Skip suppressed songs — staging one would put a known-bad track in
      // front of the user's face on every cold start until they manually
      // skipped. Producer falls through to its quality fallback instead.
      const lastId = await AsyncStorage.getItem(LAST_SONG_KEY);
      const lastCandidate = lastId ? catalog.find((s) => s.id === lastId) ?? null : null;
      const lastSong = lastCandidate && lastCandidate.distribution_stage !== 'suppressed'
        ? lastCandidate
        : null;

      // Seed the queue with the last song at position 0 (or let the producer
      // pick one if no history). Refill preloads positions 1..5 so the next
      // skip is instant — we *also* kick a preload of position 0 separately
      // so the first play tap is instant too.
      await queue.reset(lastSong ?? undefined);
      const first = lastSong ?? queue.current();

      setState((s) => ({
        ...s,
        catalog,
        taste,
        library,
        current: first,
        duration: first ? first.duration_seconds * 1000 : 0,
        position: 0,
        isPlaying: false,
        saved: first ? library.isSaved(first.id) : false,
        liked: first ? likedIdsRef.current.has(first.id) : false,
      }));

      if (first && preloaderRef.current) {
        // Warm the audio for the song the user is most likely to tap first.
        preloaderRef.current.preload(first).catch(() => {});
      }

      // Background catalog hydration: as soon as Suno-generated songs land
      // in Supabase, the hydrator pulls a fresh snapshot and we merge it
      // silently into the in-memory catalog. New IDs become eligible for
      // recommendation on the very next queue refill.
      catalogHydrator.seed(catalog);
      catalogHydrator.start();
      const offHydration = catalogHydrator.onSnapshot((next) => {
        setState((s) => ({ ...s, catalog: next }));
      });

      cleanupRef.current = () => {
        offLib();
        offTick();
        offEnd();
        offFail();
        offHydration();
        catalogHydrator.stop();
      };
    };

    setup().catch(() => {
      // The stack is best-effort; failures shouldn't crash render.
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      trackerRef.current?.stop();
      trackerRef.current?.flush().catch(() => {});
      audioRef.current?.stop().catch(() => {});
      preloaderRef.current?.clear();
    };
  }, [userId]);

  // Refs used so the long-lived useEffect above can reach into callbacks
  // defined further down without dependency-array gymnastics.
  const cleanupRef = useRef<(() => void) | null>(null);
  const playInternalRef = useRef<((song: Song) => Promise<void>) | null>(null);
  const handleAdvanceRef = useRef<((skipped: boolean) => Promise<void>) | null>(null);

  // ---- Playback ----

  // Shared completion-cap gate. Returns `true` when blocked. Callers
  // should bail without disrupting the currently-playing song so the user
  // is never yanked out of a track mid-listen.
  const checkDailyLimit = useCallback(async (): Promise<boolean> => {
    if (!limiterRef.current || isPremiumRef.current) return false;
    const peek = limiterRef.current.read();
    if (peek.limitHit) {
      setCompletionState(peek.count, true);
      // Re-fires the paywall trigger effect even if completedLimitHit was
      // already true (e.g. user dismissed it then tried to play again).
      bumpBlockedAttempts();
      return true;
    }
    return false;
  }, [setCompletionState, bumpBlockedAttempts]);

  const playInternal = useCallback(async (song: Song) => {
    if (!audioRef.current || !preloaderRef.current || !userId) return;

    // Completion cap PEEK — has to run before we promise the user anything
    // visual. Sync read against the in-memory set, no I/O.
    if (limiterRef.current && !isPremiumRef.current) {
      const peek = limiterRef.current.read();
      if (peek.limitHit) {
        setCompletionState(peek.count, true);
        bumpBlockedAttempts();
        return;
      }
    }

    // ============================================================
    // OPTIMISTIC UI UPDATE — runs BEFORE the audio load.
    //
    // This is the single biggest perceived-latency win. We commit the new
    // song to state immediately so the player title, cover, progress bar,
    // and mini-player update on the same frame as the user's tap. Audio
    // starts ~50 ms later (preloaded) or ~500 ms later (cold), but visually
    // the song has "switched" before the user can even notice.
    // ============================================================
    songStartedAtRef.current = Date.now();
    // New song = new completion-eligibility. The onTick handler will set
    // this back to true the first time audio progress crosses 90%.
    currentCompletedRef.current = false;
    recentIdsRef.current = [
      song.id,
      ...recentIdsRef.current.filter((id) => id !== song.id),
    ].slice(0, RECENT_WINDOW);

    setState((s) => ({
      ...s,
      current: song,
      position: 0,
      duration: song.duration_seconds * 1000,
      isPlaying: true,
      saved: libraryRef.current?.isSaved(song.id) ?? false,
      liked: likedIdsRef.current.has(song.id),
    }));

    // Side-effects that don't need to block the user's first frame —
    // fire-and-forget so they run in parallel with the audio load.
    libraryRef.current?.addRecent(song).catch(() => {});
    AsyncStorage.setItem(LAST_SONG_KEY, song.id).catch(() => {});

    // ============================================================
    // Load + play. Preloaded path is ~10-50 ms; cold path is ~500-1500 ms
    // depending on CDN. Either way the UI is already showing the new song.
    // ============================================================
    const preloaded = await preloaderRef.current.take(song.id);
    await audioRef.current.play(song, preloaded ?? undefined);

    trackerRef.current?.track({
      user_id: userId,
      song_id: song.id,
      event_type: 'song_started',
      vibe_context: stateRef.current.vibe ?? null,
    });

    void bumpSongsHeard();
  }, [userId, bumpSongsHeard, setCompletionState, bumpBlockedAttempts]);

  useEffect(() => { playInternalRef.current = playInternal; }, [playInternal]);

  const recordEndOfSong = useCallback((skipped: boolean) => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return;
    const durationSec = cur.duration_seconds;
    // Audio-position-based listen seconds. Survives pause + resume
    // correctly; never overestimates the way wall-clock did.
    const positionMs = stateRef.current.position;
    const listenSec = positionMs > 0 ? positionMs / 1000 : 0;
    const completion = durationSec > 0 ? Math.min(1, listenSec / durationSec) : 0;

    if (skipped) {
      trackerRef.current?.track({
        user_id: userId,
        song_id: cur.id,
        event_type: 'song_skipped',
        skip_time_seconds: listenSec,
        listen_duration_seconds: listenSec,
        completion_percentage: completion,
        vibe_context: stateRef.current.vibe ?? null,
      });
    } else {
      trackerRef.current?.track({
        user_id: userId,
        song_id: cur.id,
        event_type: 'song_completed',
        listen_duration_seconds: listenSec,
        completion_percentage: completion,
        vibe_context: stateRef.current.vibe ?? null,
      });
    }

    // Free-tier accounting: a play counts toward the cap ONLY if it
    // reached >=90% of actual audio playback. Skips before 90% do not
    // count. The onTick handler usually fires first (the moment audio
    // progress crosses 90%), but we register here too as a safety net
    // for cases where the song ended faster than the next tick could
    // fire. Limiter dedupes by song id so the double-call is a no-op.
    // Premium users are exempt.
    if (
      !currentCompletedRef.current &&
      limiterRef.current &&
      !isPremiumRef.current &&
      completion >= COMPLETION_THRESHOLD
    ) {
      currentCompletedRef.current = true;
      limiterRef.current
        .registerCompletion(cur.id)
        .then((s) => setCompletionState(s.count, s.limitHit))
        .catch(() => {});
    }

    const signals = signalsFromPlayback({
      listenSeconds: listenSec,
      durationSeconds: durationSec,
      skipped,
    });
    if (signals.length > 0) {
      // Mirror every playback signal into the session profile so the ranker
      // can pick up "right now" mood within 3–5 plays.
      for (const sig of signals) {
        sessionRef.current = applySessionSignal(sessionRef.current, cur, sig);
      }
      setState((s) => {
        if (!s.taste) return s;
        let next = s.taste;
        for (const sig of signals) next = applySignal(next, cur, sig);
        void persistTaste(next);
        return { ...s, taste: next };
      });
    }
  }, [userId, setCompletionState]);

  const handleAdvance = useCallback(async (skipped: boolean) => {
    if (!queueRef.current) return;
    recordEndOfSong(skipped);
    const next = await queueRef.current.advance();
    if (next) await playInternal(next);
  }, [playInternal, recordEndOfSong]);

  useEffect(() => { handleAdvanceRef.current = handleAdvance; }, [handleAdvance]);

  const togglePlay = useCallback(async () => {
    if (!audioRef.current) return;
    // If the user lands on the staged "last song" and taps play, there's no
    // sound loaded yet — toggle() would no-op. Detect that and start the
    // current song instead. Subsequent taps go through the normal toggle.
    if (audioRef.current.getCurrentSongId() == null) {
      const cur = stateRef.current.current;
      if (cur) await playInternal(cur);
      return;
    }
    await audioRef.current.toggle();
  }, [playInternal]);

  const skip = useCallback(async () => {
    // Daily-limit gate first — never disrupt the current song if we can't play
    // anything new anyway.
    if (await checkDailyLimit()) return;
    void bumpSkipCount();
    // Detach the outgoing song's status listener synchronously so its
    // `didJustFinish` can't fire an auto-advance that races this manual skip.
    audioRef.current?.suspendCurrent();
    await handleAdvance(true);
  }, [handleAdvance, bumpSkipCount, checkDailyLimit]);

  const replay = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return;
    await audioRef.current?.seekTo(0);
    await audioRef.current?.resume();
    songStartedAtRef.current = Date.now();
    trackerRef.current?.track({
      user_id: userId,
      song_id: cur.id,
      event_type: 'replayed',
      vibe_context: stateRef.current.vibe ?? null,
    });
    sessionRef.current = applySessionSignal(sessionRef.current, cur, { kind: 'replay' });
    setState((s) => s.taste ? { ...s, taste: applySignal(s.taste, cur, { kind: 'replay' }) } : s);
  }, [userId]);

  // Previous-track button. Matches Spotify/Apple Music behaviour:
  //   • > 3 s into the current song → seek to 0 (replay current)
  //   • otherwise → play the song before this one from the recent history
  //   • no history → seek to 0
  const previous = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur) return;
    const posMs = stateRef.current.position;
    if (posMs > 3000) {
      await audioRef.current?.seekTo(0);
      songStartedAtRef.current = Date.now();
      setState((s) => ({ ...s, position: 0 }));
      return;
    }
    // recentIds[0] is the current song. Walk backwards until we find one
    // still in the catalog — songs that were deleted (e.g. the legacy seed
    // purge) can sit stale in the recents list, which would otherwise make
    // the prev button silently no-op.
    let prevSong: Song | null = null;
    for (let i = 1; i < recentIdsRef.current.length; i++) {
      const candId = recentIdsRef.current[i];
      const cand = stateRef.current.catalog.find((s) => s.id === candId);
      if (cand) { prevSong = cand; break; }
    }
    if (!prevSong) {
      // No history — degrade to a simple replay.
      await audioRef.current?.seekTo(0);
      songStartedAtRef.current = Date.now();
      setState((s) => ({ ...s, position: 0 }));
      return;
    }
    if (await checkDailyLimit()) return;
    audioRef.current?.suspendCurrent();
    // Drop the current id from recents so the prev song becomes [0] cleanly.
    recentIdsRef.current = recentIdsRef.current.slice(1);
    await playInternal(prevSong);
  }, [playInternal, checkDailyLimit]);

  // Flip shuffle. When turning ON, drop the queued upcoming tracks (keeping
  // the current one) and refill from the now-randomized producer — otherwise
  // the user would tap shuffle and still hear the pre-ranked queue. When
  // turning OFF, the queue is also refilled so the ranker can re-engage.
  const toggleShuffle = useCallback(async () => {
    const next = !isShufflingRef.current;
    isShufflingRef.current = next;
    setState((s) => ({ ...s, isShuffling: next }));
    const queue = queueRef.current;
    const cur = stateRef.current.current;
    if (queue && cur) {
      await queue.reset(cur);
    }
  }, []);

  // Hint the audio preloader that these songs are likely to be tapped soon.
  // Used by screens like Explore to prefetch top trending tiles so the
  // tap-to-play feels instant. Fire-and-forget; Preloader dedupes by id.
  const warmSongs = useCallback((songs: Song[]) => {
    const pre = preloaderRef.current;
    if (!pre) return;
    for (const s of songs) {
      if (!pre.has(s.id)) pre.preload(s).catch(() => {});
    }
  }, []);

  // Called by the player UI right after the native share sheet returns
  // `sharedAction` — never on cancel. Logs the event and applies the +5
  // share signal to the taste profile.
  const recordShare = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return;
    trackerRef.current?.track({
      user_id: userId,
      song_id: cur.id,
      event_type: 'shared',
      vibe_context: stateRef.current.vibe ?? null,
    });
    sessionRef.current = applySessionSignal(sessionRef.current, cur, { kind: 'share' });
    setState((s) => s.taste ? { ...s, taste: applySignal(s.taste, cur, { kind: 'share' }) } : s);
    await bumpEngagement();
  }, [userId, bumpEngagement]);

  const save = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur || !userId || !libraryRef.current) return;
    const next = !libraryRef.current.isSaved(cur.id);
    await libraryRef.current.setSaved(cur, next);
    setState((s) => ({ ...s, saved: next }));
    trackerRef.current?.track({
      user_id: userId,
      song_id: cur.id,
      event_type: next ? 'saved' : 'unsaved',
      vibe_context: stateRef.current.vibe ?? null,
    });
    sessionRef.current = applySessionSignal(sessionRef.current, cur, { kind: next ? 'save' : 'unsave' });
    setState((s) => s.taste ? { ...s, taste: applySignal(s.taste, cur, { kind: next ? 'save' : 'unsave' }) } : s);
    if (next) await bumpEngagement();
  }, [userId, bumpEngagement]);

  // Toggle the heart on the current song. Mirrors save() but writes to
  // user_song_likes and uses the 'like'/'unlike' signal kind (weight 2.5).
  // Optimistic: the heart flips before the DB round-trip lands.
  const like = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return;
    const wasLiked = likedIdsRef.current.has(cur.id);
    const next = !wasLiked;
    // Optimistic flip.
    if (next) likedIdsRef.current.add(cur.id);
    else likedIdsRef.current.delete(cur.id);
    setState((s) => ({ ...s, liked: next }));

    // Signal first — taste should react even if the DB write later fails.
    sessionRef.current = applySessionSignal(sessionRef.current, cur, { kind: next ? 'like' : 'unlike' });
    setState((s) => s.taste ? { ...s, taste: applySignal(s.taste, cur, { kind: next ? 'like' : 'unlike' }) } : s);

    if (HAS_SUPABASE && supabase) {
      try {
        if (next) {
          await supabase.from('user_song_likes').upsert(
            { user_id: userId, song_id: cur.id },
            { onConflict: 'user_id,song_id' },
          );
        } else {
          await supabase.from('user_song_likes').delete()
            .eq('user_id', userId).eq('song_id', cur.id);
        }
      } catch {
        // Optimistic on failure — TikTok-style. Visibly rolling back the
        // heart on every failed network round-trip feels like a glitch,
        // and the most common failure mode (anon-auth-off, no JWT) is
        // structural rather than transient. The taste signal already
        // applied in-session; persistence rebuilds from the DB next
        // cold start so the state self-heals.
      }
    }
    if (next) await bumpEngagement();
  }, [userId, bumpEngagement]);

  const setVibe = useCallback(async (vibe: Activity | null) => {
    // Limit gate FIRST — otherwise we'd stop the current song just to fail
    // to start the next one, leaving the user with nothing playing.
    if (await checkDailyLimit()) return;
    // Same reasoning as playSpecific — kill the old sound's listener up-front
    // so its didJustFinish can't race the new song we're about to start.
    audioRef.current?.suspendCurrent();
    // Update the synchronous ref first — the queue producer reads it during
    // the immediate refill below, before React commits a new state.
    vibeRef.current = vibe;
    setState((s) => ({ ...s, vibe }));
    if (queueRef.current) {
      recordEndOfSong(true);
      await queueRef.current.reset();
      const next = queueRef.current.current();
      if (next) await playInternal(next);
    }
  }, [playInternal, recordEndOfSong, checkDailyLimit]);

  // "Most Popular in US" mix from Explore. Sorts the catalog by the most
  // authoritative popularity signal available:
  //   1) server-side trending_score from song_daily_stats (preferred)
  //   2) raw plays from song_daily_stats (next-best)
  //   3) editorial launch_score (cold-start fallback)
  //   4) stable hash on song.id (final fallback so the button always plays
  //      *something* even on a fresh catalog with no server data and no
  //      editorial scores).
  // No shuffle: we want the actual chart, not a random sample.
  const playPopular = useCallback(async () => {
    if (!queueRef.current) return;
    if (await checkDailyLimit()) return;
    const catalog = stateRef.current.catalog;
    if (catalog.length === 0) return;

    const stats = statsRef.current;
    const hashScore = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) {
        h = ((h << 5) - h) + id.charCodeAt(i);
        h |= 0;
      }
      return Math.abs(h) / 0x7fffffff;
    };
    const scored = catalog.map((song) => {
      const s = stats.get(song.id);
      const serverScore = s ? (s.trending_score * 1.0 + Math.log10(1 + s.plays) * 0.1) : 0;
      const editorial = song.launch_score ?? 0;
      // Pick the strongest signal available; if nothing else fires, the hash
      // gives every song a stable, distinct ordering so the slice is never
      // empty and the button always plays something.
      const score = serverScore > 0
        ? serverScore
        : editorial > 0
          ? editorial
          : hashScore(song.id);
      return { song, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 30).map((r) => r.song);
    if (top.length === 0) return;  // catalog was 0 — already guarded above

    audioRef.current?.suspendCurrent();
    recordEndOfSong(true);
    await queueRef.current.setQueue(top);
    await playInternal(top[0]);
  }, [playInternal, recordEndOfSong, checkDailyLimit]);

  // Play an explicit list of songs (Library playlist tap). The first plays
  // immediately; the rest sit in the QueueManager so skip / auto-advance
  // walks the playlist in the curated order. Beyond the tail of the
  // playlist the regular ranker refill kicks back in.
  const playPlaylist = useCallback(async (songs: Song[]) => {
    if (!queueRef.current || songs.length === 0) return;
    if (await checkDailyLimit()) return;
    audioRef.current?.suspendCurrent();
    recordEndOfSong(true);
    await queueRef.current.setQueue(songs);
    await playInternal(songs[0]);
  }, [playInternal, recordEndOfSong, checkDailyLimit]);

  const playSpecific = useCallback(async (song: Song) => {
    if (!queueRef.current) return;
    // Limit gate FIRST — never stop the current song if we can't actually
    // play the new one. Otherwise the user is left in a silent frozen state.
    if (await checkDailyLimit()) return;
    // Critical: synchronously detach the current sound's listener BEFORE any
    // awaits run. Otherwise the about-to-end song's `didJustFinish` can fire
    // mid-await and kick off an auto-advance that races this manual play,
    // leaving two sounds playing simultaneously.
    audioRef.current?.suspendCurrent();
    recordEndOfSong(true);
    await queueRef.current.playSpecific(song);
    await playInternal(song);
  }, [playInternal, recordEndOfSong, checkDailyLimit]);

  const seek = useCallback(async (positionMillis: number) => {
    if (!audioRef.current) return;
    if (!Number.isFinite(positionMillis)) return;
    const dur = stateRef.current.duration;
    if (dur <= 0) return;
    const clamped = Math.max(0, Math.min(positionMillis, dur));
    try {
      await audioRef.current.seekTo(clamped);
    } catch {
      // Defensive — seekTo already swallows, but belt-and-suspenders.
    }
    songStartedAtRef.current = Date.now() - clamped;
    setState((s) => ({ ...s, position: clamped }));
  }, []);

  const persistTaste = useCallback(async (taste: TasteProfile) => {
    if (!HAS_SUPABASE || !supabase || !userId) return;
    try {
      await supabase
        .from('user_taste_profiles')
        .upsert({ ...taste, user_id: userId }, { onConflict: 'user_id' });
    } catch {
      // best-effort
    }
  }, [userId]);

  const getSession = useCallback((): SessionProfile => sessionRef.current, []);

  // Snapshot-style mood builder. Reads recentIds + interactionCount at
  // call time so freshness rules and user-stage weights use the very
  // latest signals (refs, not state — no re-render needed).
  const buildMoodList = useCallback((mood: Mood, limit = 20): Song[] => {
    return buildMoodPlaylist(mood, {
      catalog: stateRef.current.catalog,
      taste: stateRef.current.taste,
      recentSongIds: recentIdsRef.current,
      interactionCount: interactionCountRef.current,
      limit,
    });
  }, []);

  const value = useMemo<PlayerValue>(() => ({
    ...state,
    togglePlay,
    skip,
    previous,
    toggleShuffle,
    replay,
    save,
    like,
    recordShare,
    seek,
    setVibe,
    playSpecific,
    playPlaylist,
    playPopular,
    warmSongs,
    getSession,
    buildMoodList,
  }), [
    state, togglePlay, skip, previous, toggleShuffle, replay, save, like, recordShare,
    seek, setVibe, playSpecific, playPlaylist, playPopular, warmSongs, getSession, buildMoodList,
  ]);

  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
