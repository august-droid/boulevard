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
  /**
   * Overflow from `setQueue` — when a curated list is longer than the
   * 10-slot in-memory queue, the rest sits here. `refill()` drains this
   * BEFORE calling the producer, so a 50-song playlist plays in full
   * before the personalized ranker ever sees it. Without this, the user
   * tapping their 50-song playlist hears 10 of their songs then silently
   * gets bounced into ranker picks — the bug this exists to prevent.
   */
  private curatedTail: Song[] = [];
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
    this.curatedTail = [];
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
    // Same latency fix — synchronous clear, async refill. Drops any curated
    // tail since the user just navigated away from the playlist context.
    this.preloader.clear();
    this.queue = [song];
    this.curatedTail = [];
    await this.refill();
    this.notify();
  }

  /**
   * Replace the queue with an explicit ordered list (playlist tap).
   *
   * The first TOTAL_DEPTH songs sit in the in-memory queue (preloaded as
   * usual). Anything beyond that goes into `curatedTail` and is drained
   * by `refill()` before the personalized ranker is consulted. This means
   * a 50-song playlist plays all 50 songs in order, then the ranker takes
   * over with songs the user hasn't heard yet.
   */
  async setQueue(songs: Song[]) {
    if (songs.length === 0) return;
    this.preloader.clear();
    this.queue = songs.slice(0, TOTAL_DEPTH);
    this.curatedTail = songs.slice(TOTAL_DEPTH);
    await this.refill();
    this.notify();
  }

  /** Ensure queue is full and the next PRELOAD_DEPTH songs are decoding. */
  private async refill() {
    if (this.queue.length < TOTAL_DEPTH) {
      const have = new Set(this.queue.map((s) => s.id));

      // 1) Drain the curated tail FIRST. A playlist longer than the queue's
      //    in-memory depth must play to completion before the ranker is
      //    consulted, otherwise the user silently bounces into recommended
      //    songs partway through their own playlist.
      while (this.queue.length < TOTAL_DEPTH && this.curatedTail.length > 0) {
        const next = this.curatedTail.shift()!;
        if (have.has(next.id)) continue;
        this.queue.push(next);
        have.add(next.id);
      }

      // 2) Once the curated tail is empty, fall back to the personalized
      //    producer to keep the queue from running dry.
      const stillNeed = TOTAL_DEPTH - this.queue.length;
      if (stillNeed > 0) {
        try {
          const avoid = [...have];
          const more = await this.producer(avoid, stillNeed);
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
