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
  // A sound a still-in-flight play() call created/started but has not yet
  // promoted to `this.sound`. Tracked so a concurrent play() can silence it.
  // Without this, two back-to-back play() calls each see `this.sound === null`
  // (the first call nulled it) and neither stops the other — so two songs
  // play at once until the older call's generation check unloads its sound.
  private pendingSound: Audio.Sound | null = null;
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
   * Concurrency: every call grabs a generation number and, before doing any
   * async work, retires BOTH the established current sound AND any sound a
   * still-in-flight play() left in `pendingSound`. The sound this call starts
   * is published to `pendingSound` *before* it can make noise, so a newer
   * play() that races in can find and silence it. If a newer play() has
   * started by the time this one's async work resolves, we discard the sound
   * we loaded and bail. The net effect: no matter how many play() calls fire
   * back to back, only the newest one is ever audible.
   */
  async play(song: Song, preloadedSound?: Audio.Sound) {
    const myGen = ++this.generation;

    // Retire every sound that is or could be audible right now — the
    // established current sound AND any sound an in-flight play() started.
    this.retire(this.sound);
    this.retire(this.pendingSound);
    this.sound = null;
    this.pendingSound = null;
    this.currentSongId = null;

    let sound: Audio.Sound | null = preloadedSound ?? null;
    try {
      if (!sound) {
        const created = await Audio.Sound.createAsync(
          { uri: song.audio_url },
          { shouldPlay: true, volume: 1.0, progressUpdateIntervalMillis: 250 },
        );
        sound = created.sound;
        // A newer play() started while createAsync was awaiting — discard.
        if (myGen !== this.generation) { await this.safeUnload(sound); return; }
        // Visible to a concurrent play() from here on.
        this.pendingSound = sound;
      } else {
        if (myGen !== this.generation) { await this.safeUnload(sound); return; }
        // Publish BEFORE playAsync makes the preloaded sound audible, so a
        // concurrent play() can find and silence it during the awaits below.
        this.pendingSound = sound;
        await sound.playAsync();
        await sound.setProgressUpdateIntervalAsync(250);
      }
    } catch (err) {
      // If a newer play() superseded us, the failure is just our own sound
      // being torn down by that call — not a real load error. Stay silent.
      if (myGen !== this.generation) return;
      await this.safeUnload(sound);
      if (this.pendingSound === sound) this.pendingSound = null;
      const reason = (err as Error)?.message ?? 'audio_load_failed';
      this.loadFailedListeners.forEach((l) => l(song.id, reason));
      return;
    }

    // A newer play() started during our awaits — discard the sound we loaded.
    // (`!sound` can't happen here in practice, but it narrows the type.)
    if (myGen !== this.generation || !sound) {
      if (this.pendingSound === sound) this.pendingSound = null;
      await this.safeUnload(sound);
      return;
    }

    // Bind status updates to *this* generation, so a stale sound's late
    // callback can't fire end events for the now-current song.
    sound.setOnPlaybackStatusUpdate(this.bindStatusListener(myGen));
    this.sound = sound;
    this.pendingSound = null;
    this.currentSongId = song.id;
  }

  /** Detach + silence + unload a sound. Fire-and-forget; safe on null. */
  private retire(s: Audio.Sound | null) {
    if (!s) return;
    try { s.setOnPlaybackStatusUpdate(null); } catch { /* nothing */ }
    // Best-effort instant silence, then unload — both fire-and-forget.
    s.setStatusAsync({ shouldPlay: false, volume: 0 }).catch(() => {});
    s.unloadAsync().catch(() => {});
  }

  /** Awaitable detach + unload. Safe on null. */
  private async safeUnload(s: Audio.Sound | null) {
    if (!s) return;
    try { s.setOnPlaybackStatusUpdate(null); } catch { /* nothing */ }
    try { await s.unloadAsync(); } catch { /* already gone */ }
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
    // Invalidate any in-flight play() so it bails instead of promoting its
    // sound after we've stopped, and retire a sound it may have started.
    this.generation++;
    this.retire(this.pendingSound);
    this.pendingSound = null;
    const s = this.sound;
    this.sound = null;
    this.currentSongId = null;
    if (s) {
      try {
        s.setOnPlaybackStatusUpdate(null);
        await s.unloadAsync();
      } catch {
        // Sound may already be torn down by the OS; safe to ignore.
      }
    }
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
