// Domain types for Boulevard.

/** Artist as a first-class entity. The catalog stores artist_id /
 *  artist_name / artist_image_url denormalized on every Song; we derive a
 *  full Artist record by aggregating the catalog client-side. */
export interface Artist {
  id: string;
  name: string;
  image_url: string | null;
  /** Most-frequent genre across this artist's songs. */
  primary_genre: string | null;
  /** Total catalog songs for this artist. */
  song_count: number;
  /** Lifetime qualified streams summed across every one of this artist's
   *  songs. Real, server-maintained counter (songs.stream_count) — never a
   *  synthetic or estimated number. */
  total_streams: number;
  /** Followers — populated from supabase when available, null otherwise. */
  follower_count: number | null;
}


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
  // After the canonical-genre migration `genre` is a back-compat alias of
  // `canonical_genre` — so every existing reader is automatically canonical.
  genre: string;
  genres?: string[];
  /** Immutable original genre label, before canonicalisation. */
  raw_genre?: string | null;
  /** Controlled canonical genre (taxonomy value). Equal to `genre`. */
  canonical_genre?: string | null;
  /** Broad genre family the canonical genre belongs to (e.g. "Electronic"). */
  genre_family?: string | null;
  /** Nuanced sub-descriptor — original label / crossover recipe name.
   *  Identity-preserving; never flattened. */
  subgenre?: string | null;
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
  /** Lifetime qualified-stream count (>=30s or >=70% plays). Maintained
   *  server-side by the record_stream RPC; read-only on the client. */
  stream_count?: number;
  /** Lifetime like / save / share counts. Maintained server-side by triggers
   *  (sql/2026-05-17_engagement_counts.sql); read-only on the client. */
  like_count?: number;
  save_count?: number;
  share_count?: number;
  /** 0..1 — editorial "this should land for new users" score. */
  launch_score?: number;
  /** 0..1 — derived from generation QA. Higher = better. */
  quality_score?: number;
  /** 0..1 — penalty applied by the recommender. Higher = suppressed more. */
  suppression_score?: number;
  /** 0..1 — how unusual the production/vocal/mood is. >=0.6 = weird-that-works. */
  weirdness_score?: number | null;
  /** AI artist who "performs" the song — frozen vocal style + branding. */
  artist_id?: string | null;
  artist_name?: string | null;
  artist_image_url?: string | null;
  /** Plain-text lyrics returned by the generator. Used as the display source
   *  when `synced_lyrics` is absent — the player then estimates the active
   *  line by spreading lines evenly across the duration.
   *  Null/undefined → the lyrics tab shows a "not available" fallback. */
  lyrics?: string | null;
  /** Optional time-synced lyrics in LRC format — each line prefixed with one
   *  or more [mm:ss.xx] timestamps. When present the player highlights the
   *  exact line being sung; when absent it falls back to estimating from
   *  `lyrics`. */
  synced_lyrics?: string | null;
  /** Where the song came from. */
  source?: SongSource;
  /** Only `live` songs are served to clients. */
  status?: SongStatus;
  created_at?: string;

  // ---- Analyzer-produced fields (SongAnalyzer) ----
  /** 10–30 physical/specific tags: production, vocal, groove, instrument, context. Primary recommendation signal. */
  microtags?: string[];
  primary_listener_contexts?: string[];
  skip_risks?: string[];
  /** 0..1 — how immediately replayable the hook is. */
  hook_strength?: number;
  /** 0..1 — broad-appeal vs niche/experimental. */
  mainstream_fit?: number;
  /** 0..1 — distinct/memorable identity. (v2 — produced by SongAnalyzer, distinct from weirdness_score.) */
  uniqueness_score_v2?: number;

  // ---- Staged distribution (set by compute_promotion_scores rollup) ----
  distribution_stage?: 'new_test' | 'rising' | 'trending' | 'suppressed';
  impression_count?: number;
  promotion_score?: number;
  suppression_reason?: string | null;
  last_distribution_at?: string | null;
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
  | 'song_impressed'    // queued for the user (served, may or may not play)
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
  /** Lifetime preference over song microtags. Primary recommendation signal. */
  microtag_scores: Record<string, number>;
  updated_at?: string;
}

/**
 * Short-window "what the user is into RIGHT NOW" profile. Lives in memory
 * only, never persisted. Decays every signal (factor 0.92) and resets after
 * 30 min of inactivity. The ranker uses this as a multiplicative tilt on
 * top of lifetime taste — strong session signals dominate without
 * permanently rewriting the long-term profile.
 */
export interface SessionProfile {
  microtag_scores: Record<string, number>;
  last_interaction_at: number;  // epoch ms
}

export interface UserProfile {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_seed: string;
  /** Social-provider (e.g. Google) profile photo URL; null when none. */
  avatar_url?: string | null;
  created_at?: string;
}

export interface SongComment {
  id: string;
  song_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  timestamp_seconds: number | null;
  like_count: number;
  reply_count: number;
  created_at: string;
  // Joined client-side
  author?: UserProfile;
  liked_by_me?: boolean;
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
