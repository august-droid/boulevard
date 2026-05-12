import { Audio } from 'expo-av';
import { Song } from '@/types';

// Preloader keeps a small LRU of *loaded* Audio.Sound instances keyed by song id.
// We deliberately cap concurrency so we never hold more than a handful of
// decoded sounds in memory on low-end Android devices.

// Higher cap so rapid skips don't outrun the preloader AND so that Explore /
// Library screens can predictively warm likely-tap targets without evicting
// the queue's next-up sounds. Memory cost is ~1 MB per decoded sound on iOS,
// so 10 is still well under any practical limit.
const MAX_PRELOADED = 10;

interface Entry {
  songId: string;
  sound: Audio.Sound;
  loading: Promise<Audio.Sound>;
}

export class Preloader {
  private entries = new Map<string, Entry>();

  has(songId: string) {
    return this.entries.has(songId);
  }

  /** Begin preloading a song. Safe to call repeatedly. */
  preload(song: Song): Promise<Audio.Sound> {
    const existing = this.entries.get(song.id);
    if (existing) return existing.loading;

    const loading = (async () => {
      const { sound } = await Audio.Sound.createAsync(
        { uri: song.audio_url },
        { shouldPlay: false, volume: 1.0 },
      );
      return sound;
    })();

    // Capture loading first so concurrent calls dedupe.
    const stub: Entry = { songId: song.id, sound: null as unknown as Audio.Sound, loading };
    this.entries.set(song.id, stub);

    loading
      .then((sound) => {
        const e = this.entries.get(song.id);
        if (e) e.sound = sound;
        this.evictIfNeeded(song.id);
      })
      .catch(() => {
        // Drop failed entries so a retry can happen later.
        this.entries.delete(song.id);
      });

    return loading;
  }

  /** Hand off a preloaded sound to the player. Removes it from the cache. */
  async take(songId: string): Promise<Audio.Sound | null> {
    const entry = this.entries.get(songId);
    if (!entry) return null;
    try {
      const sound = await entry.loading;
      this.entries.delete(songId);
      return sound;
    } catch {
      this.entries.delete(songId);
      return null;
    }
  }

  /**
   * Drop a specific song from the cache. The slot is freed immediately —
   * the underlying expo-av unload fires in the background.
   *
   * Critically, we DO NOT await `entry.loading`. If a song is still
   * downloading (mid-flight Suno/R2 fetch), awaiting it can take seconds,
   * which is exactly what caused the 5–7s play-tap delay on Explore.
   */
  drop(songId: string) {
    const entry = this.entries.get(songId);
    if (!entry) return;
    this.entries.delete(songId);
    entry.loading
      .then((sound) => sound.unloadAsync().catch(() => {}))
      .catch(() => {});
  }

  /** Drop everything. Synchronous — see drop() for why. */
  clear() {
    const ids = Array.from(this.entries.keys());
    ids.forEach((id) => this.drop(id));
  }

  private async evictIfNeeded(keepId: string) {
    if (this.entries.size <= MAX_PRELOADED) return;
    // Evict in insertion order (Map preserves it), skipping the freshly-loaded one.
    const order = Array.from(this.entries.keys());
    for (const id of order) {
      if (this.entries.size <= MAX_PRELOADED) break;
      if (id === keepId) continue;
      await this.drop(id);
    }
  }
}
