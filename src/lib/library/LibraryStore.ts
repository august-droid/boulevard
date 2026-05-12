import AsyncStorage from '@react-native-async-storage/async-storage';
import { Song, LibraryType } from '@/types';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

// LibraryStore writes to Supabase when configured AND in-memory + AsyncStorage
// for fast local reads. Anonymous users get a fully local library; once they
// sign in we'd back-fill, but for the MVP we just keep local data as the source
// of truth and mirror writes to Supabase opportunistically.

const STORAGE_PREFIX = 'boulevard.library.v1';

interface CacheShape {
  saved: Record<string, Song>;
  recent: Song[]; // ordered, capped
}

const RECENT_CAP = 50;

function emptyCache(): CacheShape {
  return { saved: {}, recent: [] };
}

export class LibraryStore {
  private userId: string;
  private cache: CacheShape = emptyCache();
  private hydrated = false;
  private listeners = new Set<() => void>();

  constructor(userId: string) {
    this.userId = userId;
  }

  setUser(userId: string) {
    if (this.userId === userId) return;
    this.userId = userId;
    this.cache = emptyCache();
    this.hydrated = false;
    this.notify();
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  private storageKey() {
    return `${STORAGE_PREFIX}.${this.userId}`;
  }

  async hydrate() {
    if (this.hydrated) return;
    const raw = await AsyncStorage.getItem(this.storageKey());
    if (raw) {
      try {
        this.cache = JSON.parse(raw);
      } catch {
        this.cache = emptyCache();
      }
    }
    this.hydrated = true;
    this.notify();
  }

  private async persist() {
    await AsyncStorage.setItem(this.storageKey(), JSON.stringify(this.cache));
  }

  isSaved(songId: string) {
    return Boolean(this.cache.saved[songId]);
  }

  saved(): Song[] { return Object.values(this.cache.saved); }
  recent(): Song[] { return this.cache.recent; }

  async setSaved(song: Song, saved: boolean) {
    if (saved) this.cache.saved[song.id] = song;
    else delete this.cache.saved[song.id];
    await this.persist();
    this.notify();
    // Fire-and-forget mirror — the local cache is authoritative for the UI,
    // we don't want Supabase latency to delay a Save tap by 100-300ms.
    this.mirror(song.id, 'saved', saved).catch(() => {});
  }

  async addRecent(song: Song) {
    this.cache.recent = [song, ...this.cache.recent.filter((s) => s.id !== song.id)].slice(0, RECENT_CAP);
    await this.persist();
    this.notify();
    this.mirror(song.id, 'recent', true).catch(() => {});
  }

  private async mirror(songId: string, type: LibraryType, present: boolean) {
    if (!HAS_SUPABASE || !supabase) return;
    try {
      if (present) {
        await supabase.from('library').upsert(
          { user_id: this.userId, song_id: songId, type },
          { onConflict: 'user_id,song_id,type' },
        );
      } else {
        await supabase
          .from('library')
          .delete()
          .eq('user_id', this.userId)
          .eq('song_id', songId)
          .eq('type', type);
      }
    } catch {
      // Best-effort sync — local cache is the source of truth for the MVP.
    }
  }
}
