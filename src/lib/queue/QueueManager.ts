import { Image as ExpoImage } from 'expo-image';
import { Song } from '@/types';
import { Preloader } from '@/lib/audio/Preloader';

// QueueManager — Boulevard's Infinite Personalized Playback engine.
//
// CONTRACT (read this before editing):
//   1. Once a song starts playing, the queue MUST continue to produce a
//      "next" song forever, until the user explicitly pauses/stops. There
//      is no concept of "queue ended" in Boulevard.
//   2. The producer is source-agnostic: anywhere a UI can press play —
//      Explore, Library, Mood shelf, single song, future playlists — the
//      same QueueManager fills what comes after. Do NOT branch playback
//      logic per surface; add new surfaces by feeding into setQueue() or
//      playSpecific() and inherit infinite playback for free.
//   3. refill() is called after every advance(). It tops the queue back
//      up to TOTAL_DEPTH from (a) curatedTail, (b) the personalized
//      producer, and (c) a guaranteed deep-recycle pass that allows older
//      songs to recur when the catalog is small.
//   4. If you add a new play entry point in the future, route it through
//      PlayerContext (playSpecific / playPlaylist / playPopular). Never
//      drive AudioPlayer directly — that bypasses refill and creates a
//      silent dead-end.
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
/**
 * Minimum songs the queue is guaranteed to hold AFTER a refill, even when
 * the personalized producer has nothing fresh to offer. If the producer
 * runs dry (small catalog, narrow taste, every song "recent") we recycle
 * older songs to stay above this floor — Boulevard's "never go silent"
 * guarantee. The taste profile still drives selection; we just relax the
 * recency penalty so the queue cannot stall.
 */
const INFINITE_FLOOR = 3;

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
          // If the producer fails we still play what we have. The deep
          // recycle pass below catches us if the queue is critically low.
        }
      }

      // 3) Deep-recycle pass — Boulevard's "never go silent" guarantee.
      //    If after the producer call the queue is still below
      //    INFINITE_FLOOR, the personalized lane is exhausted (small
      //    catalog or every fresh candidate filtered out). Re-call the
      //    producer with ONLY the current queue as the avoid list — any
      //    older song the user has already heard becomes a candidate
      //    again. The taste profile still scores selection so this is a
      //    relaxed cooldown, not random replay.
      //
      //    The producer is responsible for honoring recency penalties via
      //    its own scoring; this just opens the eligible pool. Together
      //    these two passes mean: queue length AFTER refill ≥ floor as
      //    long as the producer's catalog has any non-suppressed song.
      if (this.queue.length < INFINITE_FLOOR) {
        try {
          const queueOnly = this.queue.map((s) => s.id);
          const recycled = await this.producer(queueOnly, TOTAL_DEPTH - this.queue.length);
          for (const s of recycled) {
            if (!have.has(s.id)) {
              this.queue.push(s);
              have.add(s.id);
            }
          }
        } catch {
          // Last-resort failure. Whatever's left in the queue still plays;
          // the user's next advance() retries the whole refill cycle.
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
