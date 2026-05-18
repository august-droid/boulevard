-- Boulevard — per-song engagement counters: likes, saves, shares.
--
-- Like songs.stream_count (see 2026-05-16_stream_counting.sql), these columns
-- ride the catalog every app already loads (`select * from songs`), so every
-- surface — web, iOS, Android, desktop — sees them with no extra query. The
-- player surfaces a count once it clears 100.
--
-- Source of truth:
--   • likes  → public.user_song_likes  (one row per user per liked song)
--   • shares → public.user_events      (event_type = 'shared')
--   • saves  → public.user_events      (event_type = 'saved' minus 'unsaved')
--
-- Maintenance is two-part:
--   1. A backfill that recomputes the absolute counts from those tables —
--      this is the "rollup", and it is idempotent: safe to re-run any time
--      to self-heal drift.
--   2. AFTER triggers that keep the counters live between rollups.
--
-- Idempotent overall. Run it in the Supabase SQL editor.

-- 1. Columns.
alter table public.songs
  add column if not exists like_count  bigint not null default 0,
  add column if not exists save_count  bigint not null default 0,
  add column if not exists share_count bigint not null default 0;

-- 2. Backfill / rollup — recompute absolute counts from the source tables.
update public.songs s set
  like_count = coalesce((
    select count(*) from public.user_song_likes l where l.song_id = s.id
  ), 0),
  share_count = coalesce((
    select count(*) from public.user_events e
    where e.song_id = s.id and e.event_type = 'shared'
  ), 0),
  save_count = greatest(0, coalesce((
    select count(*) filter (where e.event_type = 'saved')
         - count(*) filter (where e.event_type = 'unsaved')
    from public.user_events e where e.song_id = s.id
  ), 0));

-- 3a. Live maintenance — likes (user_song_likes insert / delete).
--     SECURITY DEFINER so the trigger can write songs (read-only to clients).
create or replace function public.bump_song_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.songs set like_count = like_count + 1 where id = new.song_id;
  elsif tg_op = 'DELETE' then
    update public.songs set like_count = greatest(0, like_count - 1) where id = old.song_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_song_like_count on public.user_song_likes;
create trigger trg_song_like_count
  after insert or delete on public.user_song_likes
  for each row execute function public.bump_song_like_count();

-- 3b. Live maintenance — saves + shares (user_events insert; event_type
--     selects the counter). Ignores every other event_type.
create or replace function public.bump_song_event_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.song_id is null then
    return null;
  end if;
  if new.event_type = 'shared' then
    update public.songs set share_count = share_count + 1 where id = new.song_id;
  elsif new.event_type = 'saved' then
    update public.songs set save_count = save_count + 1 where id = new.song_id;
  elsif new.event_type = 'unsaved' then
    update public.songs set save_count = greatest(0, save_count - 1) where id = new.song_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_song_event_count on public.user_events;
create trigger trg_song_event_count
  after insert on public.user_events
  for each row execute function public.bump_song_event_count();
