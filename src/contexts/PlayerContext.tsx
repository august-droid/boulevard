import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import { Audio } from 'expo-av';
import { Song, Activity, TasteProfile, SongStats } from '@/types';
import { AudioPlayer, PlaybackTickPayload } from '@/lib/audio/AudioPlayer';
import { Preloader } from '@/lib/audio/Preloader';
import { QueueManager } from '@/lib/queue/QueueManager';
import { rankCandidates } from '@/lib/recommendation/RecommendationEngine';
import {
  buildOnboardingSlate,
  OnboardingSlate,
  ONBOARDING_SIZE,
  type OnboardingSignalKind,
} from '@/lib/recommendation/OnboardingSlate';
import {
  SessionContextEngine,
  type SessionMode,
  type ContextAnchor,
} from '@/lib/recommendation/SessionContext';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { recordStream, qualifiesAsStream } from '@/lib/stats/recordStream';
import { applySessionSignal, applySignal, emptyProfile, emptySession, signalsFromPlayback } from '@/lib/taste/TasteProfile';
import type { SessionProfile } from '@/types';
import { EventTracker } from '@/lib/events/EventTracker';
import { loadCatalog } from '@/lib/catalog/loadCatalog';
import { catalogHydrator } from '@/lib/catalog/catalogHydration';
import { buildMoodPlaylist, Mood } from '@/lib/mood/MoodPlaylist';
import { moodStoreFor, MoodStore } from '@/lib/mood/MoodScoring';
import { exposureLogFor, ExposureLog } from '@/lib/recommendation/ExposureLog';
import { ChipMoodId, moodById } from '@/lib/mood/moodCatalog';
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
  /** Set to the song the user just became the first-ever listener of, so a
   *  celebration pop-up can fire. Cleared by dismissFirstListen(). */
  firstListen: Song | null;
}

/** Optional context for a play action — drives mood attribution and the
 *  artist-focused exception to the artist-variation rule (spec PART 5B). */
export interface PlayContext {
  /** The mood the user is playing from, if any. */
  moodId?: ChipMoodId | null;
  /** True for explicit artist sessions (artist page Play Top Songs, radio). */
  artistFocused?: boolean;
}

interface PlayerActions {
  togglePlay: () => Promise<void>;
  skip: () => Promise<void>;
  /** Dismiss the "you discovered this first" celebration pop-up. */
  dismissFirstListen: () => void;
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
  playSpecific: (song: Song, context?: PlayContext) => Promise<void>;
  /** Play a curated list of songs in order. First song plays, rest queue. */
  playPlaylist: (songs: Song[], context?: PlayContext) => Promise<void>;
  /** Stage a curated list of songs WITHOUT auto-playing. The first song is
   *  loaded into the player surface (mini player + queue) so a single play
   *  tap starts it. Used when the user opens a playlist. No-op while a song
   *  is actively playing — never hijacks active playback. */
  cuePlaylist: (songs: Song[]) => Promise<void>;
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
  /**
   * Contextual Session Engine: explicitly activate a session mode. Screens
   * use this for intents the play actions don't already cover — a genre lane
   * (`genre_focus`), the search screen (`search_focus`), or an Explore
   * "world" / discovery tile (`mood_focus` / `discovery_focus`). Pass
   * `'default'` to clear the context. Mood / artist / playlist modes are
   * already auto-activated by playPlaylist / playSpecific.
   */
  setSessionContext: (mode: SessionMode, anchor?: ContextAnchor) => void;
  /** Debug snapshot of the live session context — active mode, confidence,
   *  decay phase, anti-fatigue window. Null before the engine is ready. */
  getSessionContextDebug: () => Record<string, unknown> | null;
}

type PlayerValue = PlayerState & PlayerActions;

/** High-frequency playback progress. Split into its own context so the
 *  per-tick position updates never re-render screens that only care about
 *  the current song / play state (Explore tiles, Library rows, etc.). */
interface PlayerProgress {
  position: number; // ms
  duration: number; // ms
}

const PlayerCtx = createContext<PlayerValue | null>(null);
const PlayerProgressCtx = createContext<PlayerProgress | null>(null);

// Last song the user heard, persisted so the player surface is pre-staged
// on cold start. Spotify-style — the user sees their last track, doesn't
// have to find it again.
const LAST_SONG_KEY = 'boulevard.last_song_id';

// Persisted Contextual Session Engine snapshot. Lets a reopened app preserve
// the user's session DIRECTION (with decay applied) instead of a stale feed.
const SESSION_CONTEXT_KEY = 'boulevard.session_context';

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const {
    userId, isPremium, songsHeard, isAnonymous, completedLimitHit,
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
  // First-session onboarding slate (cold start). Non-null only while the user
  // is inside their first 10 songs; the producer serves it and every playback
  // signal re-ranks it. See lib/recommendation/OnboardingSlate.ts.
  const onboardingRef = useRef<OnboardingSlate | null>(null);
  // Contextual Session Engine — a complementary intent layer. Temporarily
  // biases ranking toward the user's current mode (artist universe / mood
  // world / genre lane / search / discovery) then decays back to long-term
  // taste. See lib/recommendation/SessionContext.ts.
  const sessionContextRef = useRef<SessionContextEngine | null>(null);
  // Dynamic-mood + 24h anti-repeat stores (per-user singletons, shared with
  // ExploreContext). Playback records outcomes into these.
  const moodStoreRef = useRef<MoodStore | null>(null);
  const exposureLogRef = useRef<ExposureLog | null>(null);
  // The mood / artist context the current playback session started from.
  const playContextRef = useRef<{ moodId: ChipMoodId | null; artistFocused: boolean }>({
    moodId: null,
    artistFocused: false,
  });
  const isPremiumRef = useRef(false);
  useEffect(() => { isPremiumRef.current = isPremium; }, [isPremium]);
  // Mirror of `isAnonymous` for the web login gate — read inside long-lived
  // play closures without re-binding them on every auth change.
  const isAnonymousRef = useRef(isAnonymous);
  useEffect(() => { isAnonymousRef.current = isAnonymous; }, [isAnonymous]);
  // Mirror of `completedLimitHit` — the web login gate (checkWebGate) reads
  // this synchronously to block the 11th play once 10 songs have been heard
  // to >=70%. On native this drives the paywall instead.
  const completedLimitHitRef = useRef(completedLimitHit);
  useEffect(() => { completedLimitHitRef.current = completedLimitHit; }, [completedLimitHit]);

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
  // True once the current play session has been counted as a stream (the
  // listener reached >=30s or >=70%). The per-play-session guard that keeps
  // pause/resume, seeking, replay, and re-opening the player from inflating
  // the global stream count. Reset on every new song in playInternal.
  const streamCountedRef = useRef(false);
  // Once-per-app-session guard for the "first listener" celebration. After a
  // fresh deploy every song sits at 0 streams, so without this the pop-up
  // would fire on nearly every song; we celebrate the first discovery of the
  // session and stay quiet after that.
  const firstListenShownRef = useRef(false);

  // Recent songs window for the recommender (penalize repetition).
  const recentIdsRef = useRef<string[]>([]);
  const RECENT_WINDOW = 8;

  const [state, setState] = useState<PlayerState>({
    current: null,
    isPlaying: false,
    vibe: null,
    saved: false,
    liked: false,
    // Starts empty — Explore shows a loading state until the real catalog
    // lands, instead of flashing the bundled seed list as if it were live.
    catalog: [],
    taste: null,
    library: null,
    libraryVersion: 0,
    isShuffling: false,
    firstListen: null,
  });

  // Mirrored ref so the long-lived producer closure sees the current shuffle
  // setting without needing to rebind the QueueManager each toggle.
  const isShufflingRef = useRef(false);

  // Mirror state into a ref so async callbacks and long-lived closures
  // (producer, tick listener, etc.) can read the latest snapshot without
  // depending on React's render cycle.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // High-frequency playback progress. Kept in its own state + context so a
  // position tick (several per second) never re-renders the screens that
  // subscribe to the main player value — Explore tiles, Library rows, etc.
  const [progress, setProgress] = useState<PlayerProgress>({ position: 0, duration: 0 });
  const progressRef = useRef(progress);
  useEffect(() => { progressRef.current = progress; }, [progress]);

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
      // These can reject (audio session on some OEMs, AsyncStorage I/O). A
      // failure must NOT abort setup before the catalog publishes, or Explore
      // would be stuck on its loading state forever.
      try { await AudioPlayer.configureSession(); } catch { /* non-fatal */ }

      const audio = new AudioPlayer();
      const preloader = new Preloader();
      const library = new LibraryStore(userId);
      try { await library.hydrate(); } catch { /* non-fatal — empty library */ }

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
      // Mood-scoring + anti-repeat stores. Hydration is idempotent — the
      // ExploreContext shares these same per-user singleton instances.
      moodStoreRef.current = moodStoreFor(userId);
      exposureLogRef.current = exposureLogFor(userId);
      void moodStoreRef.current.hydrate();
      void exposureLogRef.current.hydrate();

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
        setProgress((prev) => {
          const duration = p.durationMillis || prev.duration;
          if (prev.position === p.positionMillis && prev.duration === duration) return prev;
          return { position: p.positionMillis, duration };
        });
        // Only touch the main value when isPlaying actually flips. Returning
        // the same state reference makes React bail, so a steadily-playing
        // song never re-renders the screens subscribed to usePlayer().
        setState((s) => (s.isPlaying === p.isPlaying ? s : { ...s, isPlaying: p.isPlaying }));
        // Register the completion the moment playback crosses the threshold
        // (COMPLETION_THRESHOLD is 0.9 native / 0.7 web). On native this feeds
        // the 10-listen paywall cap; on web it feeds the 10-listen login gate.
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
        // Global stream count — one qualified stream per play session, the
        // moment the listener reaches >=30s OR >=70% of the song. The
        // streamCountedRef guard means pause/resume, seeking, replay and
        // re-opening the player never double-count. Writes through the
        // record_stream RPC so every Boulevard surface feeds the same
        // backend counter.
        if (
          !streamCountedRef.current &&
          qualifiesAsStream(p.positionMillis, p.durationMillis)
        ) {
          const cur = stateRef.current.current;
          if (cur) {
            streamCountedRef.current = true;
            // recordStream resolves with the song's new lifetime count — a
            // value of 1 means this listener was the first ever, so we fire
            // the discovery celebration (once per app session).
            recordStream(cur.id)
              .then((count) => {
                if (count === 1 && !firstListenShownRef.current) {
                  firstListenShownRef.current = true;
                  setState((s) => ({ ...s, firstListen: cur }));
                }
              })
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
      // rankCandidates wrapper — the normal lifetime ranker. Shared by the
      // standard path AND the onboarding "top-up" when the 10-song slate
      // runs short, so the hand-off out of onboarding is seamless.
      const rankPicks = (avoid: string[], n: number): Song[] => {
        // Artist-variation context (spec PART 5B): keep the same artist from
        // stacking up in the auto-extended queue.
        const recentArtistIds = recentIdsRef.current
          .map((id) => catalog.find((s) => s.id === id)?.artist_id ?? null)
          .filter((a): a is string => !!a);
        // rankCandidates owns its own quality fallback when the main path
        // returns empty — we trust whatever it hands back.
        return rankCandidates(
          catalog,
          {
            taste: stateRef.current.taste ?? taste,
            session: sessionRef.current,
            vibe: vibeRef.current,
            recentSongIds: recentIdsRef.current,
            interactionCount: interactionCountRef.current,
            stats: statsRef.current,
            currentArtistId: stateRef.current.current?.artist_id ?? null,
            recentArtistIds,
            artistFocused: playContextRef.current.artistFocused,
            // Contextual Session Engine — a temporary, decaying bias toward
            // the user's current intent. null when no mode is active, so the
            // ranker is unchanged from before this layer existed.
            context: sessionContextRef.current?.current() ?? null,
          },
          avoid,
          n,
        );
      };

      const producer = async (avoidIds: string[], count: number) => {
        let picks: Song[];

        // FIRST-SESSION ONBOARDING (cold start). While the user is inside
        // their first 10 songs, the queue is fed by the adaptive onboarding
        // slate instead of the cold-start ranker — a structured trust →
        // probe → recover → surprise → exploit → hook sequence that
        // re-ranks itself after every signal. Once the slate is exhausted
        // (or the user crosses 10 interactions) we fall straight back to the
        // lifetime ranker. Shuffle always bypasses onboarding.
        const ob = onboardingRef.current;
        const onboarding = !!ob && !ob.isComplete() &&
          interactionCountRef.current < ONBOARDING_SIZE && !isShufflingRef.current;

        if (onboarding && ob) {
          const slate = ob.serve(count, avoidIds);
          // Top up with the lifetime ranker if the slate ran short, so the
          // queue never stalls and onboarding blends into normal playback.
          picks = slate.length >= count
            ? slate
            : [...slate, ...rankPicks([...avoidIds, ...slate.map((s) => s.id)], count - slate.length)];
        } else if (isShufflingRef.current) {
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
          picks = rankPicks(avoidIds, count);
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

      // First-session onboarding: build the adaptive 10-song slate before the
      // queue's first refill so the producer can serve it. Only for users
      // still inside their first 10 songs. safetyMode is always on — Boulevard
      // never collects age, and the strategy brief mandates strict gating for
      // age-unknown users. The last-heard song seeds the slate's trust anchor.
      if (interactionCountRef.current < ONBOARDING_SIZE) {
        onboardingRef.current = buildOnboardingSlate(catalog, {
          safetyMode: true,
          seedSong: lastSong,
        });
      }

      // Contextual Session Engine — build it and restore the last session's
      // direction. restore() applies decay from the original timestamp and
      // drops a snapshot older than ~12h, so a next-day open starts fresh.
      const sessionEngine = new SessionContextEngine();
      try {
        sessionEngine.restore(await AsyncStorage.getItem(SESSION_CONTEXT_KEY));
      } catch { /* non-fatal — start in neutral default mode */ }
      sessionContextRef.current = sessionEngine;

      // Publish the real catalog / taste / library first so Explore swaps
      // off the bundled seed list and the rest of the app goes live.
      setState((s) => ({ ...s, catalog, taste, library }));

      const pendingPlay = pendingPlayRef.current;
      pendingPlayRef.current = null;

      if (pendingPlay) {
        // The user tapped a song while the stack was still booting. Honor
        // that tap now instead of staging the last-heard song — otherwise
        // the player opens on the wrong song.
        await queue.playSpecific(pendingPlay);
        await playInternalRef.current?.(pendingPlay);
      } else {
        // Cold start: seed the queue with the last song at position 0 (or let
        // the producer pick one) but DO NOT auto-play. Refill preloads 1..5;
        // we also warm position 0 so the first play tap is instant.
        await queue.reset(lastSong ?? undefined);
        const first = lastSong ?? queue.current();
        setState((s) => ({
          ...s,
          current: first,
          isPlaying: false,
          saved: first ? library.isSaved(first.id) : false,
          liked: first ? likedIdsRef.current.has(first.id) : false,
        }));
        setProgress({ position: 0, duration: first ? first.duration_seconds * 1000 : 0 });
        if (first && preloaderRef.current) {
          preloaderRef.current.preload(first).catch(() => {});
        }
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
  const playInternalRef = useRef<((song: Song, presolved?: Audio.Sound | null) => Promise<void>) | null>(null);
  const handleAdvanceRef = useRef<((skipped: boolean) => Promise<void>) | null>(null);
  // A song the user tapped before the player stack finished initializing.
  // playSpecific() stashes it here when the queue is not ready yet; setup
  // plays it the moment the stack is up, instead of dropping the tap.
  const pendingPlayRef = useRef<Song | null>(null);

  // ---- Playback ----

  // Shared completion-cap gate. Returns `true` when blocked. Callers
  // should bail without disrupting the currently-playing song so the user
  // is never yanked out of a track mid-listen.
  const checkDailyLimit = useCallback(async (): Promise<boolean> => {
    // The web app has no completion cap and no paywall — the login gate
    // (checkWebGate) is the only limit. Signed-in web users listen freely.
    if (Platform.OS === 'web') return false;
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

  // Web-only login gate. An anonymous web listener may hear 10 songs to at
  // least 70% each (FREE_COMPLETED_LIMIT, tracked by the CompletionLimiter);
  // the next play is then blocked and `bumpBlockedAttempts` surfaces the
  // sign-in sheet (RootNavigator watches it). Returns `true` when blocked.
  // Always returns false on native — native gates on the paywall instead.
  const checkWebGate = useCallback((): boolean => {
    if (Platform.OS !== 'web') return false;
    if (!isAnonymousRef.current) return false;
    if (!completedLimitHitRef.current) return false;
    bumpBlockedAttempts();
    return true;
  }, [bumpBlockedAttempts]);

  const playInternal = useCallback(async (song: Song, presolved?: Audio.Sound | null) => {
    if (!audioRef.current || !preloaderRef.current || !userId) return;

    // Web login gate. Backstops the auto-advance path (handleAdvance calls
    // playInternal directly); the explicit entry points gate earlier so they
    // don't stop the current song just to block the next one.
    if (checkWebGate()) return;

    // Completion cap PEEK — has to run before we promise the user anything
    // visual. Sync read against the in-memory set, no I/O. Skipped on web,
    // which has no completion cap.
    if (Platform.OS !== 'web' && limiterRef.current && !isPremiumRef.current) {
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
    // New play session = eligible to count one fresh stream.
    streamCountedRef.current = false;
    recentIdsRef.current = [
      song.id,
      ...recentIdsRef.current.filter((id) => id !== song.id),
    ].slice(0, RECENT_WINDOW);

    setState((s) => ({
      ...s,
      current: song,
      isPlaying: true,
      saved: libraryRef.current?.isSaved(song.id) ?? false,
      liked: likedIdsRef.current.has(song.id),
    }));
    setProgress({ position: 0, duration: song.duration_seconds * 1000 });

    // Side-effects that don't need to block the user's first frame —
    // fire-and-forget so they run in parallel with the audio load.
    libraryRef.current?.addRecent(song).catch(() => {});
    AsyncStorage.setItem(LAST_SONG_KEY, song.id).catch(() => {});

    // Anti-repeat + mood scoring (spec PART 3 / PART 8). recordPlayed feeds
    // the 24h suppression; a mood `start` is logged when playback began from
    // a mood context.
    exposureLogRef.current?.recordPlayed(song.id);
    if (playContextRef.current.moodId) {
      moodStoreRef.current?.record(playContextRef.current.moodId, 'start');
    }

    // ============================================================
    // Load + play. Preloaded path is ~10-50 ms; cold path is ~500-1500 ms
    // depending on CDN. Either way the UI is already showing the new song.
    // ============================================================
    // Reuse a sound the caller already pulled from the preloader — playSpecific
    // takes it before the queue swap clears the cache — else pull one now.
    const preloaded = presolved ?? (await preloaderRef.current.take(song.id));
    await audioRef.current.play(song, preloaded ?? undefined);

    trackerRef.current?.track({
      user_id: userId,
      song_id: song.id,
      event_type: 'song_started',
      vibe_context: stateRef.current.vibe ?? null,
    });

    void bumpSongsHeard();
  }, [userId, bumpSongsHeard, setCompletionState, bumpBlockedAttempts, checkWebGate]);

  useEffect(() => { playInternalRef.current = playInternal; }, [playInternal]);

  // Returns the discrete signal kinds the just-ended play produced, so the
  // caller can also feed them to the onboarding slate. Empty when nothing
  // meaningful happened (e.g. the staged song that was never actually heard).
  const recordEndOfSong = useCallback((skipped: boolean): OnboardingSignalKind[] => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return [];
    const durationSec = cur.duration_seconds;
    // Audio-position-based listen seconds. Survives pause + resume
    // correctly; never overestimates the way wall-clock did.
    const positionMs = progressRef.current.position;
    const listenSec = positionMs > 0 ? positionMs / 1000 : 0;
    const completion = durationSec > 0 ? Math.min(1, listenSec / durationSec) : 0;

    // Anti-repeat + mood scoring (spec PART 3 / PART 8). A song heard to the
    // completion threshold counts as completed even if the user then switched
    // away; only a genuine early exit counts as a skip.
    const moodCtx = playContextRef.current.moodId;
    if (completion >= COMPLETION_THRESHOLD) {
      exposureLogRef.current?.recordCompleted(cur.id);
      if (moodCtx) moodStoreRef.current?.record(moodCtx, 'completion');
    } else if (skipped && listenSec > 0) {
      // listenSec === 0 means the song was staged but never actually heard
      // (the cold-start staged song) — do not 24h-suppress something unplayed.
      exposureLogRef.current?.recordSkipped(cur.id);
      if (moodCtx) moodStoreRef.current?.record(moodCtx, 'skip');
    }

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
    return signals.map((sig) => sig.kind);
  }, [userId, setCompletionState]);

  /**
   * Feed a playback signal into the first-session onboarding slate, then
   * push the re-ranked upcoming songs into the live queue.
   *
   *  ended=true  — the song finished/was-skipped. The slate advances its
   *                blueprint cursor and re-ranks; the queue is refreshed by
   *                the advance()→refill()→producer flow that follows, so we
   *                do NOT touch the queue here (avoids racing advance()).
   *  ended=false — a mid-song signal (like/save/replay/share). No advance
   *                follows, so we replaceUpcoming() to apply the re-rank now.
   *
   * No-op once onboarding is complete — every other surface is untouched.
   */
  const feedOnboarding = useCallback((
    song: Song,
    kinds: OnboardingSignalKind[],
    ended: boolean,
  ) => {
    const ob = onboardingRef.current;
    if (!ob || ob.isComplete()) return;
    ob.applySignal(song, kinds, ended);
    if (!ended) {
      const cur = stateRef.current.current;
      void queueRef.current
        ?.replaceUpcoming(ob.serve(10, cur ? [cur.id] : []))
        .catch(() => {});
    }
  }, []);

  // ---- Contextual Session Engine glue ----

  /** Activate a session mode and persist the new direction (freshness). */
  const activateSessionContext = useCallback((mode: SessionMode, anchor: ContextAnchor = {}) => {
    const eng = sessionContextRef.current;
    if (!eng) return;
    if (mode === 'default') eng.reset();
    else eng.activate(mode, anchor);
    AsyncStorage.setItem(SESSION_CONTEXT_KEY, eng.serialize()).catch(() => {});
  }, []);

  /** Feed a playback outcome into the session engine — reinforces the mode on
   *  a positive, collapses confidence on a skip streak (real-time pivoting). */
  const registerSessionOutcome = useCallback((
    song: Song,
    kinds: string[],
    ended: boolean,
  ) => {
    sessionContextRef.current?.registerOutcome(song, kinds, ended);
  }, []);

  /** Map a play action's PlayContext onto a session mode + anchor. */
  const syncSessionFromPlay = useCallback((songs: Song[], context?: PlayContext) => {
    if (songs.length === 0) return;
    if (context?.moodId) {
      const m = moodById(context.moodId);
      const energyRange = m?.energyRange;
      activateSessionContext('mood_focus', {
        moodId: context.moodId,
        label: m?.label ?? context.moodId,
        anchorMicrotags: m?.microtags,
        anchorMoodWords: m?.moodWords,
        anchorEnergy: energyRange ? (energyRange[0] + energyRange[1]) / 2 : null,
        refSongs: songs.slice(0, 3),
      });
    } else if (context?.artistFocused) {
      activateSessionContext('artist_focus', {
        artistId: songs[0].artist_id ?? null,
        label: songs[0].artist_name ?? 'Artist',
        refSongs: songs.slice(0, 3),
      });
    } else {
      activateSessionContext('playlist_focus', {
        label: 'Playlist',
        refSongs: songs.slice(0, 5),
      });
    }
  }, [activateSessionContext]);

  const handleAdvance = useCallback(async (skipped: boolean) => {
    if (!queueRef.current) return;
    const endingSong = stateRef.current.current;
    const kinds = recordEndOfSong(skipped);
    // Re-rank the onboarding slate BEFORE advance() so the producer's refill
    // serves the freshly re-ranked upcoming songs.
    if (endingSong) {
      feedOnboarding(endingSong, kinds, true);
      // Feed the session engine: a skip streak collapses the active mode's
      // confidence (widening exploration), a completion reinforces it.
      registerSessionOutcome(endingSong, kinds, true);
    }
    const next = await queueRef.current.advance();
    if (next) await playInternal(next);
  }, [playInternal, recordEndOfSong, feedOnboarding, registerSessionOutcome]);

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
    // Limit gates first — never disrupt the current song if we can't play
    // anything new anyway.
    if (await checkDailyLimit()) return;
    if (checkWebGate()) return;
    void bumpSkipCount();
    // Detach the outgoing song's status listener synchronously so its
    // `didJustFinish` can't fire an auto-advance that races this manual skip.
    audioRef.current?.suspendCurrent();
    await handleAdvance(true);
  }, [handleAdvance, bumpSkipCount, checkDailyLimit, checkWebGate]);

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
    if (playContextRef.current.moodId) {
      moodStoreRef.current?.record(playContextRef.current.moodId, 'replay');
    }
    feedOnboarding(cur, ['replay'], false);
    // A replay is the strongest "I'm into this" confirmation — reinforce the
    // active session mode (spec #6: "replays artist repeatedly → strengthen").
    registerSessionOutcome(cur, ['replay'], false);
  }, [userId, feedOnboarding, registerSessionOutcome]);

  // Previous-track button. Matches Spotify/Apple Music behaviour:
  //   • > 3 s into the current song → seek to 0 (replay current)
  //   • otherwise → play the song before this one from the recent history
  //   • no history → seek to 0
  const previous = useCallback(async () => {
    const cur = stateRef.current.current;
    if (!cur) return;
    const posMs = progressRef.current.position;
    if (posMs > 3000) {
      await audioRef.current?.seekTo(0);
      songStartedAtRef.current = Date.now();
      setProgress((p) => ({ ...p, position: 0 }));
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
      setProgress((p) => ({ ...p, position: 0 }));
      return;
    }
    if (await checkDailyLimit()) return;
    if (checkWebGate()) return;
    audioRef.current?.suspendCurrent();
    // Drop the current id from recents so the prev song becomes [0] cleanly.
    recentIdsRef.current = recentIdsRef.current.slice(1);
    await playInternal(prevSong);
  }, [playInternal, checkDailyLimit, checkWebGate]);

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
    feedOnboarding(cur, ['share'], false);
    registerSessionOutcome(cur, ['share'], false);
    await bumpEngagement();
  }, [userId, bumpEngagement, feedOnboarding, registerSessionOutcome]);

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
    feedOnboarding(cur, [next ? 'save' : 'unsave'], false);
    if (next) registerSessionOutcome(cur, ['save'], false);
    if (next) {
      if (playContextRef.current.moodId) {
        moodStoreRef.current?.record(playContextRef.current.moodId, 'save_like');
      }
      await bumpEngagement();
    }
  }, [userId, bumpEngagement, feedOnboarding, registerSessionOutcome]);

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
    feedOnboarding(cur, [next ? 'like' : 'unlike'], false);
    if (next) registerSessionOutcome(cur, ['like'], false);
    if (next) {
      if (playContextRef.current.moodId) {
        moodStoreRef.current?.record(playContextRef.current.moodId, 'save_like');
      }
      await bumpEngagement();
    }
  }, [userId, bumpEngagement, feedOnboarding, registerSessionOutcome]);

  const setVibe = useCallback(async (vibe: Activity | null) => {
    // Limit gate FIRST — otherwise we'd stop the current song just to fail
    // to start the next one, leaving the user with nothing playing.
    if (await checkDailyLimit()) return;
    if (checkWebGate()) return;
    // Same reasoning as playSpecific — kill the old sound's listener up-front
    // so its didJustFinish can't race the new song we're about to start.
    audioRef.current?.suspendCurrent();
    // A vibe session is not a mood session — clear any mood attribution.
    playContextRef.current = { moodId: null, artistFocused: false };
    // A vibe change is a clean intent pivot — the vibe system biases the
    // ranker itself, so drop any contextual-session mode back to default
    // rather than double-biasing.
    activateSessionContext('default');
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
  }, [playInternal, recordEndOfSong, checkDailyLimit, checkWebGate, activateSessionContext]);

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
    if (checkWebGate()) return;
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
    playContextRef.current = { moodId: null, artistFocused: false };
    // "Most Popular" is a curated chart — a light playlist-focus context.
    syncSessionFromPlay(top);
    await queueRef.current.setQueue(top);
    await playInternal(top[0]);
  }, [playInternal, recordEndOfSong, checkDailyLimit, checkWebGate, syncSessionFromPlay]);

  // Play an explicit list of songs (Library playlist tap). The first plays
  // immediately; the rest sit in the QueueManager so skip / auto-advance
  // walks the playlist in the curated order. Beyond the tail of the
  // playlist the regular ranker refill kicks back in.
  const playPlaylist = useCallback(async (songs: Song[], context?: PlayContext) => {
    if (!queueRef.current || songs.length === 0) return;
    if (await checkDailyLimit()) return;
    if (checkWebGate()) return;
    audioRef.current?.suspendCurrent();
    recordEndOfSong(true);
    playContextRef.current = {
      moodId: context?.moodId ?? null,
      artistFocused: context?.artistFocused ?? false,
    };
    queueRef.current.setArtistFocused(playContextRef.current.artistFocused);
    // Activate the matching session mode (mood_focus / artist_focus /
    // playlist_focus) — temporarily biases the ranker toward this intent.
    syncSessionFromPlay(songs, context);
    await queueRef.current.setQueue(songs);
    await playInternal(songs[0]);
  }, [playInternal, recordEndOfSong, checkDailyLimit, checkWebGate, syncSessionFromPlay]);

  // Stage a playlist into the player without starting playback. Used when
  // the user opens a playlist: the first song is loaded onto the player
  // surface so a single play tap starts it. Mirrors the cold-start staging
  // path. Bails when a song is already playing so opening a playlist never
  // interrupts what the user is currently listening to.
  const cuePlaylist = useCallback(async (songs: Song[]) => {
    if (!queueRef.current || songs.length === 0) return;
    if (stateRef.current.isPlaying) return;
    // Unload any paused/staged audio so the next play tap starts the cued
    // song fresh — togglePlay keys off getCurrentSongId() being null.
    await audioRef.current?.stop();
    await queueRef.current.setQueue(songs);
    const first = songs[0];
    setState((s) => ({
      ...s,
      current: first,
      isPlaying: false,
      saved: libraryRef.current?.isSaved(first.id) ?? false,
      liked: likedIdsRef.current.has(first.id),
    }));
    setProgress({ position: 0, duration: first.duration_seconds * 1000 });
    // Warm the cued song so the first play tap is instant.
    preloaderRef.current?.preload(first).catch(() => {});
  }, []);

  const playSpecific = useCallback(async (song: Song, context?: PlayContext) => {
    if (!queueRef.current) {
      // The player stack is still initializing (catalog + queue not built).
      // Remember the tap so setup honors it the moment the stack is up,
      // instead of silently dropping it and leaving the staged song on screen.
      pendingPlayRef.current = song;
      return;
    }
    // Limit gate FIRST — never stop the current song if we can't actually
    // play the new one. Otherwise the user is left in a silent frozen state.
    if (await checkDailyLimit()) return;
    if (checkWebGate()) return;
    // Critical: synchronously detach the current sound's listener BEFORE any
    // awaits run. Otherwise the about-to-end song's `didJustFinish` can fire
    // mid-await and kick off an auto-advance that races this manual play,
    // leaving two sounds playing simultaneously.
    audioRef.current?.suspendCurrent();
    recordEndOfSong(true);
    // Record the context this session started from — after recordEndOfSong so
    // the outgoing song is still attributed to the previous context.
    playContextRef.current = {
      moodId: context?.moodId ?? null,
      artistFocused: context?.artistFocused ?? false,
    };
    queueRef.current.setArtistFocused(playContextRef.current.artistFocused);
    // An intentional artist-page play opens the "artist universe" session
    // mode; other direct taps leave the existing context to decay naturally.
    if (context?.artistFocused) syncSessionFromPlay([song], context);
    // Pull the preloaded sound BEFORE queue.playSpecific() clears the cache,
    // so a song Explore already warmed starts instantly, not cold-loaded.
    const preloaded = (await preloaderRef.current?.take(song.id)) ?? null;
    await queueRef.current.playSpecific(song);
    await playInternal(song, preloaded);
  }, [playInternal, recordEndOfSong, checkDailyLimit, checkWebGate, syncSessionFromPlay]);

  const seek = useCallback(async (positionMillis: number) => {
    if (!audioRef.current) return;
    if (!Number.isFinite(positionMillis)) return;
    const dur = progressRef.current.duration;
    if (dur <= 0) return;
    const clamped = Math.max(0, Math.min(positionMillis, dur));
    try {
      await audioRef.current.seekTo(clamped);
    } catch {
      // Defensive — seekTo already swallows, but belt-and-suspenders.
    }
    songStartedAtRef.current = Date.now() - clamped;
    setProgress((p) => ({ ...p, position: clamped }));
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

  // Debug snapshot of the live contextual-session state (spec #11).
  const getSessionContextDebug = useCallback(
    (): Record<string, unknown> | null => sessionContextRef.current?.debugSnapshot() ?? null,
    [],
  );

  // Clear the "you discovered this first" celebration once the user dismisses
  // the pop-up. The once-per-session ref stays set, so it does not re-fire.
  const dismissFirstListen = useCallback(() => {
    setState((s) => (s.firstListen ? { ...s, firstListen: null } : s));
  }, []);

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
    cuePlaylist,
    playPopular,
    warmSongs,
    getSession,
    buildMoodList,
    dismissFirstListen,
    setSessionContext: activateSessionContext,
    getSessionContextDebug,
  }), [
    state, togglePlay, skip, previous, toggleShuffle, replay, save, like, recordShare,
    seek, setVibe, playSpecific, playPlaylist, cuePlaylist, playPopular, warmSongs, getSession, buildMoodList,
    dismissFirstListen, activateSessionContext, getSessionContextDebug,
  ]);

  return (
    <PlayerCtx.Provider value={value}>
      <PlayerProgressCtx.Provider value={progress}>
        {children}
      </PlayerProgressCtx.Provider>
    </PlayerCtx.Provider>
  );
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}

/** Subscribe to high-frequency playback progress (position + duration).
 *  Re-renders on every tick — use only where the moving value is shown
 *  (progress bars). Screens that just need the song / play state should
 *  use usePlayer() instead, which stays stable while a song plays. */
export function usePlayerProgress(): PlayerProgress {
  const ctx = useContext(PlayerProgressCtx);
  if (!ctx) throw new Error('usePlayerProgress must be used within PlayerProvider');
  return ctx;
}
