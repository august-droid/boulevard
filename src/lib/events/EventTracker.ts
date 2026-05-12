import { Platform } from 'react-native';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { UserEvent } from '@/types';

// EventTracker batches user events and flushes them to Supabase.
// We never block the UI on a flush. On error we keep the events in the buffer
// and try again on the next flush — the same buffer is also drained on app
// background so we don't lose data on a cold-kill.

const FLUSH_INTERVAL_MS = 4000;
const MAX_BUFFER = 50;

export class EventTracker {
  private buffer: UserEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  track(event: Omit<UserEvent, 'session_id' | 'device_type'>) {
    this.buffer.push({
      ...event,
      session_id: this.sessionId,
      device_type: Platform.OS,
    });
    if (this.buffer.length >= MAX_BUFFER) {
      this.flush().catch(() => {});
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    if (!HAS_SUPABASE || !supabase) {
      // Local-only mode: drop the buffer so it doesn't grow unbounded.
      this.buffer = [];
      return;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    const { error } = await supabase.from('user_events').insert(batch);
    if (error) {
      // Re-queue on failure, but cap so memory doesn't grow forever.
      this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFER * 2);
    }
  }
}
