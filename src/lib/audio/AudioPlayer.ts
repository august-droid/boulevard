import { Audio, AVPlaybackStatus, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import { Song } from '@/types';

// AudioPlayer wraps a single Expo Audio.Sound instance and exposes
// a small, app-shaped API. It owns the *currently playing* sound only.
// Preloading future sounds is handled by Preloader.

export interface PlaybackTickPayload {
  positionMillis: number;
  durationMillis: number;
  isPlaying: boolean;
  didJustFinish: boolean;
}

type TickListener = (p: PlaybackTickPayload) => void;
type EndListener = () => void;
type LoadFailedListener = (songId: string, reason: string) => void;

export class AudioPlayer {
  private sound: Audio.Sound | null = null;
  private currentSongId: string | null = null;
  private tickListeners = new Set<TickListener>();
  private endListeners = new Set<EndListener>();
  private loadFailedListeners = new Set<LoadFailedListener>();
  // Generation counter — every play() bumps it. Stale status updates from
  // a sound that has since been replaced check their generation and bail.
  private generation = 0;

  /**
   * Synchronously cancel the current sound's playback status callback.
   * Call this the moment the user picks a new song, BEFORE any awaits in
   * the calling code — otherwise the current song's didJustFinish can fire
   * during those awaits and trigger an auto-advance that races the manual
   * play and ends up with two sounds playing at once.
   */
  suspendCurrent() {
    if (this.sound) {
      try { this.sound.setOnPlaybackStatusUpdate(null); } catch { /* nothing */ }
    }
    // Bump generation so any in-flight onStatusUpdate callbacks no-op.
    this.generation++;
  }

  /**
   * Load and immediately play a song. Accepts an already-loaded Sound to skip
   * the network hop.
   *
   * Fast-path skip: the previous sound is detached + paused synchronously and
   * its unload is fired in the background. We DO NOT await it. That removes
   * ~200-500ms of latency between user-taps-skip and audio-starts. The next
   * song's playAsync() resolves in ~10-50ms when preloaded.
   *
   * Concurrency: every call grabs a generation number. If a newer play() has
   * started by the time this one's async work resolves, we clean up the sound
   * we just loaded and bail without making it the current.
   */
  async play(song: Song, prelodedSound?: Audio.Sound) {
    const myGen = ++this.generation;

    // ---- Detach + retire the previous sound. Synchronous wherever possible. ----
    const oldSound = this.sound;
    this.sound = null;
    this.currentSongId = null;
    if (oldSound) {
      try { oldSound.setOnPlaybackStatusUpdate(null); } catch { /* nothing */ }
      // Best-effort silence so we don't briefly play two streams. Both calls
      // are async but fire-and-forget — we don't await them.
      oldSound.setStatusAsync({ shouldPlay: false, volume: 0 }).catch(() => {});
      oldSound.unloadAsync().catch(() => {});
    }

    // ---- Start the new sound. ----
    let sound = prelodedSound;
    try {
      if (!sound) {
        const created = await Audio.Sound.createAsync(
          { uri: song.audio_url },
          { shouldPlay: true, volume: 1.0, progressUpdateIntervalMillis: 250 },
        );
        sound = created.sound;
      } else {
        // Preloaded sounds were created with shouldPlay=false.
        await sound.playAsync();
        await sound.setProgressUpdateIntervalAsync(250);
      }
    } catch (err) {
      // Load failed — emit a loadFailed event so the caller can auto-skip,
      // then give up cleanly so we don't poison the player state.
      if (sound) { try { await sound.unloadAsync(); } catch {} }
      const reason = (err as Error)?.message ?? 'audio_load_failed';
      this.loadFailedListeners.forEach((l) => l(song.id, reason));
      return;
    }

    // A newer play() started during our await — discard the sound we loaded.
    if (myGen !== this.generation) {
      try { await sound.unloadAsync(); } catch {}
      return;
    }

    // Bind status updates to *this* generation, so a stale sound's late
    // callback can't fire end events for the now-current song.
    sound.setOnPlaybackStatusUpdate(this.bindStatusListener(myGen));
    this.sound = sound;
    this.currentSongId = song.id;
  }

  private bindStatusListener(gen: number) {
    return (status: AVPlaybackStatus) => {
      if (gen !== this.generation) return;
      if (!status.isLoaded) return;
      const payload: PlaybackTickPayload = {
        positionMillis: status.positionMillis ?? 0,
        durationMillis: status.durationMillis ?? 0,
        isPlaying: status.isPlaying,
        didJustFinish: status.didJustFinish === true,
      };
      this.tickListeners.forEach((l) => l(payload));
      if (status.didJustFinish) this.endListeners.forEach((l) => l());
    };
  }

  async pause() {
    await this.sound?.pauseAsync();
  }

  async resume() {
    await this.sound?.playAsync();
  }

  async toggle() {
    if (!this.sound) return;
    const status = await this.sound.getStatusAsync();
    if (!status.isLoaded) return;
    if (status.isPlaying) await this.sound.pauseAsync();
    else await this.sound.playAsync();
  }

  async seekTo(positionMillis: number) {
    if (!this.sound) return;
    if (!Number.isFinite(positionMillis) || positionMillis < 0) return;
    try {
      await this.sound.setPositionAsync(Math.round(positionMillis));
    } catch {
      // Sound may have been unloaded mid-seek (skip race, song swap) — safe to swallow.
    }
  }

  async stop() {
    if (!this.sound) return;
    try {
      this.sound.setOnPlaybackStatusUpdate(null);
      await this.sound.unloadAsync();
    } catch {
      // Sound may already be torn down by the OS; safe to ignore.
    }
    this.sound = null;
    this.currentSongId = null;
  }

  getCurrentSongId() {
    return this.currentSongId;
  }

  onTick(l: TickListener) {
    this.tickListeners.add(l);
    return () => this.tickListeners.delete(l);
  }

  onEnd(l: EndListener) {
    this.endListeners.add(l);
    return () => this.endListeners.delete(l);
  }

  /**
   * Subscribe to "this song failed to load" events — bad CDN URL, network
   * timeout, codec issue, etc. PlayerContext wires this to auto-skip so the
   * user never gets stuck on a broken row.
   */
  onLoadFailed(l: LoadFailedListener) {
    this.loadFailedListeners.add(l);
    return () => this.loadFailedListeners.delete(l);
  }

  /**
   * Configure the audio session for Spotify-style background playback.
   * Must be called before the first .play() so iOS picks up the category.
   *
   *   staysActiveInBackground   keep playing when the app goes to background
   *   playsInSilentModeIOS      play even when the user has the ringer off
   *   interruptionModeIOS       on calls/sirens, duck rather than stop
   *   shouldDuckAndroid         lower volume for short interruptions
   *   playThroughEarpieceAndroid false means route through the loud speaker
   */
  static async configureSession() {
    await Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DuckOthers,
      shouldDuckAndroid: true,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: false,
    });
  }
}
