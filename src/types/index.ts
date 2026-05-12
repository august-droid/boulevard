// Domain types for Boulevard.

export type VocalType = 'instrumental' | 'male' | 'female' | 'mixed';

export type Activity =
  | 'gym'
  | 'focus'
  | 'driving'
  | 'party'
  | 'sleep'
  | 'sad'
  | 'aggressive'
  | 'calm'
  | 'late_night'
  | 'euphoric';

export const ACTIVITIES: { id: Activity; label: string }[] = [
  { id: 'gym', label: 'Gym' },
  { id: 'focus', label: 'Focus' },
  { id: 'driving', label: 'Driving' },
  { id: 'party', label: 'Party' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'sad', label: 'Sad' },
  { id: 'aggressive', label: 'Aggressive' },
  { id: 'calm', label: 'Calm' },
  { id: 'late_night', label: 'Late Night' },
  { id: 'euphoric', label: 'Euphoric' },
];

export type SongStatus = 'pending_review' | 'live' | 'rejected' | 'archived';
export type SongSource = 'seed' | 'suno' | 'manual';

export interface Song {
  id: string;
  title: string;
  audio_url: string;
  cover_url: string;
  // Primary genre/mood — first element of genres/moods arrays. Kept for
  // O(1) display and back-compat with single-value rows.
  genre: string;
  genres?: string[];
  bpm: number | null;
  mood: string;
  moods?: string[];
  energy_score: number; // 0..1 internal; CSV importer accepts 1..10
  vocal_type: VocalType;
  voice_gender?: string | null;
  similarity_cluster: number;
  drop_timestamps: number[];
  intro_length: number;
  activity_fit: Activity[];
  duration_seconds: number;
  is_featured?: boolean;
  /** 0..1 — editorial "this should land for new users" score. */
  launch_score?: number;
  /** 0..1 — derived from generation QA. Higher = better. */
  quality_score?: number;
  /** 0..1 — penalty applied by the recommender. Higher = suppressed more. */
  suppression_score?: number;
  /** Where the song came from. */
  source?: SongSource;
  /** Only `live` songs are served to clients. */
  status?: SongStatus;
  created_at?: string;
}

// ============================================================
// Generation pipeline (admin / backend-only)
// ============================================================

export type SongQueueStatus =
  | 'pending'      // queued for Suno
  | 'generating'   // Suno is working on it
  | 'completed'    // audio ready, awaiting QA
  | 'approved'     // promoted to songs catalog
  | 'rejected'     // failed QA
  | 'failed';      // generation errored

export interface SongQueueItem {
  id: string;
  title: string | null;
  genre: string | null;
  mood: string | null;
  vocal_gender: string | null;
  suno_prompt: string;
  status: SongQueueStatus;
  task_id: string | null;
  raw_audio_url: string | null;
  r2_audio_url: string | null;
  cover_url: string | null;
  rating: number | null;
  approved: boolean;
  // Per-dimension quality (0..1)
  intro_strength: number | null;
  hook_quality: number | null;
  vocal_quality: number | null;
  production_quality: number | null;
  replayability_score: number | null;
  quality_score: number | null;
  rejection_reason: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export type EventType =
  | 'song_started'
  | 'song_completed'
  | 'song_skipped'
  | 'saved'
  | 'unsaved'
  | 'replayed'
  | 'shared'
  | 'searched'
  | 'volume_changed';

export interface UserEvent {
  id?: string;
  user_id: string;
  song_id: string;
  event_type: EventType;
  skip_time_seconds?: number;
  listen_duration_seconds?: number;
  completion_percentage?: number;
  volume_change?: number;
  device_type?: string;
  session_id?: string;
  vibe_context?: Activity | null;
  created_at?: string;
}

export interface TasteProfile {
  user_id: string;
  genre_scores: Record<string, number>;
  mood_scores: Record<string, number>;
  bpm_preference: number | null;
  energy_preference: number | null;
  vocal_preferences: Record<VocalType, number>;
  activity_scores: Record<string, number>;
  similarity_cluster_scores: Record<string, number>;
  updated_at?: string;
}

export type LibraryType = 'saved' | 'recent';

export interface LibraryEntry {
  id?: string;
  user_id: string;
  song_id: string;
  type: LibraryType;
  created_at?: string;
}

/** Per-song aggregate stats (rolled up daily server-side). */
export interface SongStats {
  song_id: string;
  plays: number;
  unique_listeners: number;
  avg_completion: number; // 0..1
  skip_rate: number;      // 0..1
  save_rate: number;      // 0..1
  replay_rate: number;    // 0..1
  share_rate: number;     // 0..1
  velocity_score: number; // 0..1
  trending_score: number; // 0..1 (already blended server-side)
}
