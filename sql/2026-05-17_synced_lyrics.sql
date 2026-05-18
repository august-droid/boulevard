-- Boulevard — time-synced (LRC) lyrics.
--
-- Adds an optional `synced_lyrics` column to the songs table. It holds lyrics
-- in standard LRC format — each line prefixed with one or more [mm:ss.xx]
-- timestamps, e.g.
--
--   [00:12.40]You know
--   [00:14.10]What this is
--   [00:16.85]Move it like that
--
-- When a song has this, the player (src/components/PlayerSheet.tsx via
-- src/lib/lyrics/syncedLyrics.ts) highlights the exact line being sung so
-- listeners can sing along. When it's NULL the player falls back to the
-- existing plain-text `lyrics` column and estimates the active line by
-- spreading lines evenly across the duration.
--
-- The catalog query is `select * from songs`, so the column is picked up by
-- every Boulevard surface (web, iOS, Android, desktop) with no client change.
--
-- Idempotent: safe to run multiple times. Run it in the Supabase SQL editor.

alter table public.songs
  add column if not exists synced_lyrics text;

comment on column public.songs.synced_lyrics is
  'Optional LRC-format synced lyrics ([mm:ss.xx] per line). NULL = the player estimates line timing from plain-text lyrics.';
