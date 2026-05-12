import { Image as ExpoImage } from 'expo-image';
import { Song } from '@/types';
import { Preloader } from '@/lib/audio/Preloader';

// QueueManager holds the next 8–10 songs in memory and coordinates with
// Preloader to keep the next 5 fully decoded.
//
//   queue[0]   -> currently playing (owned by AudioPlayer, but kept here for context)
//   queue[1..5]-> preloaded (audio decoded, instant skip)
//   queue[6..] -> metadata only
//
// Preload depth was raised from 3 → 5 so rapid skip storms (3-5 in 10s)
// don't outrun the decoder cache. Cover art for the same window is also
// prefetched into expo-image's disk cache so artwork pops in instantly.
//
// The producer is injected: it returns a batch of fresh recommendations
// avoiding any song IDs we pass in. This lets us swap rule-based and
// server-side recommenders without touching queue logic.

const PRELOAD_DEPTH = 5;
const COVER_PREFETCH_DEPTH = 6;
const TOTAL_DEPTH = 10;

export type Producer = (avoidIds: string[], count: number) => Promise<Song[]>;

export class QueueManager {
  private queue: Song[] = [];
  private preloader: Preloader;
  private producer: Producer;
  private listeners = new Set<() => void>();

  constructor(producer: Producer, preloader: Preloader) {
    this.producer = producer;
    this.preloader = preloader;
  }

  setProducer(p: Producer) {
    this.producer = p;
  }

  getQueue(): readonly Song[] {
    return this.queue;
  }

  current(): Song | null {
    return this.queue[0] ?? null;
  }

  peekNext(n = 3): Song[] {
    return this.queue.slice(1, 1 + n);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  /** Hard reset (e.g. when vibe changes). Optionally start with a seed song. */
  async reset(seed?: Song) {
    // Preloader.clear is now synchronous (drops fire-and-forget) so this
    // returns control instantly — the previous version awaited in-flight
    // CDN downloads which was the root cause of the 5–7s play-tap delay.
    this.preloader.clear();
    this.queue = seed ? [seed] : [];
    await this.refill();
    this.notify();
  }

  /** Skip to the next song. Returns the new current. */
  async advance(): Promise<Song | null> {
    this.queue.shift();
    await this.refill();
    this.notify();
    return this.current();
  }

  /** Insert a song at the front (used for direct play, e.g. Library tap). */
  async playSpecific(song: Song) {
    // Same latency fix — synchronous clear, async refill.
    this.preloader.clear();
    this.queue = [song];
    await this.refill();
    this.notify();
  }

  /** Ensure queue is full and the next PRELOAD_DEPTH songs are decoding. */
  private async refill() {
    const need = TOTAL_DEPTH - this.queue.length;
    if (need > 0) {
      try {
        const avoid = this.queue.map((s) => s.id);
        const more = await this.producer(avoid, need);
        // Defensively de-dupe in case the producer ignores avoid.
        const have = new Set(avoid);
        for (const s of more) {
          if (!have.has(s.id)) {
            this.queue.push(s);
            have.add(s.id);
          }
        }
      } catch {
        // If the producer fails we still play what we have. The next skip retries.
      }
    }

    // Preload the next 5 (positions 1..5). We skip position 0 because the
    // AudioPlayer is already responsible for playing it.
    const toPreload = this.queue.slice(1, 1 + PRELOAD_DEPTH);
    toPreload.forEach((s) => {
      // Fire and forget — Preloader dedupes.
      this.preloader.preload(s).catch(() => {});
    });

    // Prefetch cover art for the next 6 (slightly deeper than audio preload
    // since images decode fast and live in expo-image's disk cache). This
    // makes the artwork pop in instantly when the user skips ahead.
    const covers = this.queue.slice(0, COVER_PREFETCH_DEPTH).map((s) => s.cover_url);
    if (covers.length > 0) {
      ExpoImage.prefetch(covers, 'memory-disk').catch(() => {});
    }
  }
}
