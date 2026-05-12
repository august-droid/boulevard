import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import uuid from 'react-native-uuid';
import { Song, Activity, TasteProfile, SongStats } from '@/types';
import { AudioPlayer, PlaybackTickPayload } from '@/lib/audio/AudioPlayer';
import { Preloader } from '@/lib/audio/Preloader';
import { QueueManager } from '@/lib/queue/QueueManager';
import { rankCandidates } from '@/lib/recommendation/RecommendationEngine';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { applySignal, emptyProfile, signalsFromPlayback } from '@/lib/taste/TasteProfile';
import { EventTracker } from '@/lib/events/EventTracker';
import { SEED_SONGS } from '@/lib/seed/songs';
import { loadCatalog } from '@/lib/catalog/loadCatalog';
import { catalogHydrator } from '@/lib/catalog/catalogHydration';
import { LibraryStore } from '@/lib/library/LibraryStore';
import { DailyLimiter } from '@/lib/limits/DailyLimiter';
import { scheduleDailyResetNotification, cancelDailyResetNotification } from '@/lib/limits/limitNotifications';
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
    setDailyState, bumpBlockedAttempts,
  } = auth;

  // Long-lived singletons. Created lazily; do not recreate on rerender.
  const audioRef = useRef<AudioPlayer | null>(null);
  const preloaderRef = useRef<Preloader | null>(null);
  const queueRef = useRef<QueueManager | null>(null);
  const trackerRef = useRef<EventTracker | null>(null);
  const libraryRef = useRef<LibraryStore | null>(null);
  const limiterRef = useRef<DailyLimiter | null>(null);
  const isPremiumRef = useRef(false);
  useEffect(() => { isPremiumRef.current = isPremium; }, [isPremium]);

  // Mirrors used by the producer closure so it always sees fresh values
  // without needing to re-bind the QueueManager.
  const interactionCountRef = useRef(0);
  useEffect(() => { interactionCountRef.current = songsHeard; }, [songsHeard]);
  const statsRef = useRef<Map<string, SongStats>>(new Map());

  // Per-song timing.
  const songStartedAtRef = useRef<number>(0);

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

      const limiter = new DailyLimiter(userId);
      // Reconcile with Supabase up-front so a wiped AsyncStorage doesn't grant
      // a fresh 20 plays. Falls back to local-only when offline.
      const initialDaily = await limiter.reconcileWithServer();
      setDailyState(initialDaily.count, initialDaily.limitHit);
      // If the user is back inside the app and either still has plays today
      // or the day rolled over, cancel any pending reset notification —
      // we don't want to ping them about plays they already know they have.
      if (!initialDaily.limitHit) {
        cancelDailyResetNotification().catch(() => {});
      }

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
      const offTick = audio.onTick((p: PlaybackTickPayload) => {
        setState((s) => ({
          ...s,
          position: p.positionMillis,
          duration: p.durationMillis || s.duration,
          isPlaying: p.isPlaying,
        }));
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
          if (data) taste = data as TasteProfile;
        } catch {
          // ignore
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
        if (isShufflingRef.current) {
          const avoid = new Set(avoidIds);
          const pool = stateRef.current.catalog.filter((s) => !avoid.has(s.id));
          // Fisher-Yates partial shuffle — enough randomness for `count` picks
          // without rearranging the entire catalog every refill.
          for (let i = 0; i < Math.min(count, pool.length); i++) {
            const j = i + Math.floor(Math.random() * (pool.length - i));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          return pool.slice(0, count);
        }
        return rankCandidates(
          catalog,
          {
            taste: stateRef.current.taste ?? taste,
            vibe: vibeRef.current,
            recentSongIds: recentIdsRef.current,
            interactionCount: interactionCountRef.current,
            stats: statsRef.current,
          },
          avoidIds,
          count,
        );
      };

      const queue = new QueueManager(producer, preloader);
      queueRef.current = queue;

      if (cancelled) return;

      // Spotify-style cold start: stage the last song the user heard so it
      // shows on the Home / mini player surface, but DO NOT auto-play.
      // The user taps play themselves when they're ready.
      const lastId = await AsyncStorage.getItem(LAST_SONG_KEY);
      const lastSong = lastId ? catalog.find((s) => s.id === lastId) ?? null : null;

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

  // Shared daily-limit gate. Returns `true` when blocked. Callers should
  // bail without disrupting the currently-playing song.
  const checkDailyLimit = useCallback(async (): Promise<boolean> => {
    if (!limiterRef.current || isPremiumRef.current) return false;
    const peek = await limiterRef.current.read();
    if (peek.limitHit) {
      setDailyState(peek.count, true);
      // Re-fires the paywall trigger effect even if dailyLimitHit was already
      // true (e.g. user dismissed it then tried to play again).
      bumpBlockedAttempts();
      // Make sure the "your songs are back" notification is queued for 9am
      // tomorrow. Dedupes internally, so repeated cap-hit events are safe.
      scheduleDailyResetNotification().catch(() => {});
      return true;
    }
    return false;
  }, [setDailyState, bumpBlockedAttempts]);

  const playInternal = useCallback(async (song: Song) => {
    if (!audioRef.current || !preloaderRef.current || !userId) return;

    // Daily cap PEEK — has to run before we promise the user anything visual.
    // Cheap (single AsyncStorage read).
    if (limiterRef.current && !isPremiumRef.current) {
      const peek = await limiterRef.current.read();
      if (peek.limitHit) {
        setDailyState(peek.count, true);
        bumpBlockedAttempts();
        scheduleDailyResetNotification().catch(() => {});
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
    }));

    // Side-effects that don't need to block the user's first frame —
    // fire-and-forget so they run in parallel with the audio load.
    libraryRef.current?.addRecent(song).catch(() => {});
    AsyncStorage.setItem(LAST_SONG_KEY, song.id).catch(() => {});
    if (limiterRef.current && !isPremiumRef.current) {
      limiterRef.current.bump()
        .then((s) => {
          setDailyState(s.count, s.limitHit);
          // The 20th play of the day just lit the cap — schedule the
          // "back tomorrow at 9am" reminder. scheduleDailyResetNotification
          // dedupes so this is safe even if multiple plays race.
          if (s.limitHit) {
            scheduleDailyResetNotification().catch(() => {});
          }
        })
        .catch(() => {});
    }

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
  }, [userId, bumpSongsHeard, setDailyState, bumpBlockedAttempts]);

  useEffect(() => { playInternalRef.current = playInternal; }, [playInternal]);

  const recordEndOfSong = useCallback((skipped: boolean) => {
    const cur = stateRef.current.current;
    if (!cur || !userId) return;
    const listenSec = (Date.now() - songStartedAtRef.current) / 1000;
    const durationSec = cur.duration_seconds;
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

    const signals = signalsFromPlayback({
      listenSeconds: listenSec,
      durationSeconds: durationSec,
      skipped,
    });
    if (signals.length > 0) {
      setState((s) => {
        if (!s.taste) return s;
        let next = s.taste;
        for (const sig of signals) next = applySignal(next, cur, sig);
        void persistTaste(next);
        return { ...s, taste: next };
      });
    }
  }, [userId]);

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
    // recentIds[0] is the current song; [1] is the one before it.
    const prevId = recentIdsRef.current[1];
    const prevSong = prevId
      ? stateRef.current.catalog.find((s) => s.id === prevId)
      : null;
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
    setState((s) => s.taste ? { ...s, taste: applySignal(s.taste, cur, { kind: next ? 'save' : 'unsave' }) } : s);
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

  const value = useMemo<PlayerValue>(() => ({
    ...state,
    togglePlay,
    skip,
    previous,
    toggleShuffle,
    replay,
    save,
    recordShare,
    seek,
    setVibe,
    playSpecific,
    playPlaylist,
    playPopular,
    warmSongs,
  }), [
    state, togglePlay, skip, previous, toggleShuffle, replay, save, recordShare,
    seek, setVibe, playSpecific, playPlaylist, playPopular, warmSongs,
  ]);

  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
