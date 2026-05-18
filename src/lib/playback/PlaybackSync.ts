import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { getDeviceId, getDeviceLabel } from './deviceId';

// Boulevard Connect — cross-device playback.
//
// One row in public.playback_sessions per user. Exactly one signed-in
// device is "active": it owns audio and reports its now-playing state.
// Every other device is a "remote" — it mirrors the active device's
// now-playing surface and issues commands (change song, play/pause,
// skip, seek) that the active device applies.
//
// This module owns the realtime sync; PlayerContext wires its playback
// engine to the callbacks. When Supabase is unreachable or the migration
// has not been applied, start() degrades silently: the device simply
// stays 'active' (solo playback — the pre-Connect behavior).

export type PlaybackMode = 'active' | 'remote';

export type PlaybackCommand =
  | { type: 'play-song'; songId: string }
  | { type: 'toggle' }
  | { type: 'skip' }
  | { type: 'previous' }
  | { type: 'seek'; positionMs: number };

/** What a remote device renders — mirrored from the active device's row. */
export interface RemoteNowPlaying {
  songId: string | null;
  isPlaying: boolean;
  positionMs: number;
  activeDeviceLabel: string | null;
}

/** Snapshot the active device reports up to the session row. */
export interface NowPlayingSnapshot {
  songId: string | null;
  isPlaying: boolean;
  positionMs: number;
}

interface SessionRow {
  active_device_id: string | null;
  active_device_label: string | null;
  song_id: string | null;
  is_playing: boolean;
  position_ms: number;
  heartbeat_at: string | null;
  command: PlaybackCommand | null;
  command_seq: number;
  command_by: string | null;
}

// The active device refreshes its claim on this cadence; a remote retries
// claiming on a slightly longer one, so a dropped active device (closed
// tab / killed app) is taken over within ~15-30s.
const HEARTBEAT_MS = 12_000;
const RECLAIM_MS = 15_000;

export class PlaybackSync {
  private userId: string | null = null;
  private deviceId = '';
  private deviceLabel = '';
  private mode: PlaybackMode = 'active';
  private modeAnnounced = false;
  private channel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private lastCommandSeq = 0;
  private started = false;
  private activeLabel: string | null = null;
  private getNowPlaying: () => NowPlayingSnapshot =
    () => ({ songId: null, isPlaying: false, positionMs: 0 });

  // Wired by PlayerContext.
  onMode: (mode: PlaybackMode, activeLabel: string | null) => void = () => {};
  onCommand: (cmd: PlaybackCommand) => void = () => {};
  onRemoteState: (state: RemoteNowPlaying) => void = () => {};

  getMode(): PlaybackMode { return this.mode; }
  getActiveLabel(): string | null { return this.activeLabel; }
  isRemote(): boolean { return this.mode === 'remote'; }

  /** Claim or join the session for `userId`, then keep it synced. Safe to
   *  call again after stop() — e.g. when the signed-in user changes. */
  async start(userId: string, getNowPlaying: () => NowPlayingSnapshot): Promise<void> {
    if (this.started) return;
    if (!HAS_SUPABASE || !supabase || !userId) return; // solo — stays 'active'
    this.started = true;
    this.userId = userId;
    this.getNowPlaying = getNowPlaying;
    this.deviceId = await getDeviceId();
    this.deviceLabel = getDeviceLabel();
    await this.claim(false);
    this.subscribe();
    this.reclaimTimer = setInterval(() => { void this.claim(false); }, RECLAIM_MS);
  }

  /** Tear down timers + realtime and reset to the solo default. */
  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.heartbeatTimer = null;
    this.reclaimTimer = null;
    if (this.channel && supabase) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.started = false;
    this.mode = 'active';
    this.modeAnnounced = false;
    this.lastCommandSeq = 0;
    this.activeLabel = null;
  }

  /** Active device → push the current now-playing state to the row. Called
   *  by PlayerContext whenever the song or play/pause state changes. */
  async reportNow(): Promise<void> {
    if (this.mode !== 'active') return;
    await this.writeState();
  }

  /** Remote device → ask the active device to do something. */
  async sendCommand(cmd: PlaybackCommand): Promise<void> {
    if (!supabase || !this.userId) return;
    const seq = this.lastCommandSeq + 1;
    this.lastCommandSeq = seq;
    try {
      await supabase
        .from('playback_sessions')
        .update({ command: cmd, command_seq: seq, command_by: this.deviceId, updated_at: new Date().toISOString() })
        .eq('user_id', this.userId);
    } catch {
      // Offline — the control simply doesn't land; no playback disruption.
    }
  }

  /** Explicit "play on this device" — force-claim the session from a live
   *  holder. The caller (PlayerContext) starts local playback after this. */
  async takeOver(): Promise<void> {
    await this.claim(true);
  }

  // ---- internals ---------------------------------------------------------

  private async claim(takeOver: boolean): Promise<void> {
    if (!supabase || !this.userId) return;
    try {
      const { data, error } = await supabase.rpc('claim_playback_session', {
        p_device_id: this.deviceId,
        p_device_label: this.deviceLabel,
        p_take_over: takeOver,
      });
      if (error || !data) return;
      const row = (Array.isArray(data) ? data[0] : data) as SessionRow | undefined;
      if (row) this.applyRow(row);
    } catch {
      // Offline / migration not applied — keep the current (solo) mode.
    }
  }

  private subscribe(): void {
    if (!supabase || !this.userId || this.channel) return;
    this.channel = supabase
      .channel(`playback:${this.userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'playback_sessions', filter: `user_id=eq.${this.userId}` },
        (payload) => {
          const row = payload.new as SessionRow | undefined;
          if (row) this.applyRow(row);
        },
      )
      .subscribe();
  }

  private applyRow(row: SessionRow): void {
    this.activeLabel = row.active_device_label;
    const iAmActive = row.active_device_id === this.deviceId;
    const nextMode: PlaybackMode = iAmActive ? 'active' : 'remote';

    // Command channel — only the active device applies commands, and never
    // one it issued itself.
    if (row.command_seq > this.lastCommandSeq) {
      const fresh = row.command;
      this.lastCommandSeq = row.command_seq;
      if (iAmActive && fresh && row.command_by !== this.deviceId) {
        this.onCommand(fresh);
      }
    }

    const changed = nextMode !== this.mode || !this.modeAnnounced;
    this.mode = nextMode;
    this.modeAnnounced = true;
    this.syncTimers();
    if (changed) this.onMode(nextMode, this.activeLabel);

    // Remote → mirror what the active device is playing.
    if (nextMode === 'remote') {
      this.onRemoteState({
        songId: row.song_id,
        isPlaying: row.is_playing,
        positionMs: row.position_ms,
        activeDeviceLabel: row.active_device_label,
      });
    }
  }

  private syncTimers(): void {
    if (this.mode === 'active' && !this.heartbeatTimer) {
      void this.heartbeat();
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_MS);
    } else if (this.mode === 'remote' && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.mode !== 'active') return;
    await this.writeState();
  }

  private async writeState(): Promise<void> {
    if (!supabase || !this.userId) return;
    const now = this.getNowPlaying();
    try {
      await supabase
        .from('playback_sessions')
        .update({
          active_device_id: this.deviceId,
          active_device_label: this.deviceLabel,
          song_id: now.songId,
          is_playing: now.isPlaying,
          position_ms: Math.max(0, Math.round(now.positionMs)),
          heartbeat_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', this.userId);
    } catch {
      // Offline — the next heartbeat retries.
    }
  }
}
