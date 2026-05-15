-- Boulevard free-tier cap moves from "N plays per day" to "10 unique full
-- listens, lifetime." A full listen means the song was heard to at least
-- 90% of its duration. Skips before 90% do not count. Replays do not
-- double-count: each song id is tracked once.
--
-- We also persist a small signup-prompt flag on the profile so the SignupSheet
-- only fires once per user across devices.
--
-- Idempotent: safe to run multiple times.

alter table public.user_profiles
  add column if not exists completed_song_ids text[] not null default '{}',
  add column if not exists completed_song_count int not null default 0,
  add column if not exists signup_prompt_shown_at timestamptz;

-- Existing aggregate table is now unused for enforcement. We leave it in
-- place so legacy rows are preserved for analytics; nothing reads it.
comment on table public.user_daily_listens is
  'Deprecated 2026-05-14: free-tier cap moved to user_profiles.completed_song_count. Retained for historical analytics only.';
