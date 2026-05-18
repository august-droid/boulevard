import { Song } from '@/types';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { cleanSongTitle } from '@/lib/catalog/loadCatalog';

// Background catalog hydration.
//
// New Suno-generated songs land in Supabase asynchronously. We poll the
// catalog every few minutes and emit a fresh snapshot if anything changed.
// Subscribers (PlayerContext) receive the new list and merge it silently —
// the queue manager and currently-playing audio are not disturbed.
//
// This file intentionally has no React imports — it's a plain event emitter
// so it can be unit-tested and reused outside the React tree.

const POLL_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

type Listener = (songs: Song[]) => void;

class CatalogHydrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();
  private lastFetchedAt = 0;
  private lastKnownIds = new Set<string>();
  private inflight: Promise<void> | null = null;

  start() {
    if (this.timer) return;
    // Don't fire immediately — PlayerContext does its own initial load.
    // We layer on top with subsequent refreshes.
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onSnapshot(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Force a refresh (e.g. after app foreground). */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!HAS_SUPABASE || !supabase) return;

    this.inflight = (async () => {
      try {
        const { data, error } = await supabase!
          .from('songs')
          .select('*, artists!inner(is_hidden)')
          .eq('is_live', true)
          .eq('approval_status', 'approved')
          .eq('approved_by_human', true) // human-only gate, see loadCatalog
          .eq('artists.is_hidden', false) // backend-only artist filter, see loadCatalog
          .order('created_at', { ascending: false })
          .limit(2000);
        if (error || !data) return;

        const next = (data as (Song & { artists?: unknown })[]).map((row) => {
          const { artists: _omit, ...rest } = row;
          const song = rest as Song;
          return { ...song, title: cleanSongTitle(song.title, song.genre, song.id) };
        });
        const nextIds = new Set(next.map((s) => s.id));

        // Only notify when the set actually changed.
        let changed = nextIds.size !== this.lastKnownIds.size;
        if (!changed) {
          for (const id of nextIds) {
            if (!this.lastKnownIds.has(id)) { changed = true; break; }
          }
        }
        if (!changed) return;

        this.lastKnownIds = nextIds;
        this.lastFetchedAt = Date.now();
        this.listeners.forEach((l) => l(next));
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /** Tell the hydrator about the catalog we already have so the first delta is accurate. */
  seed(songs: Song[]) {
    this.lastKnownIds = new Set(songs.map((s) => s.id));
    this.lastFetchedAt = Date.now();
  }
}

export const catalogHydrator = new CatalogHydrator();
