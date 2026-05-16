-- Boulevard — global qualified-stream counting.
--
-- A "stream" is counted once per play session, the moment the listener
-- reaches >= 30 seconds OR >= 70% of a song (whichever comes first). The
-- client (src/contexts/PlayerContext.tsx + src/lib/stats/recordStream.ts)
-- owns the per-session guard so pause/resume, seeking, replay and re-opening
-- the player never double-count. This migration adds the backend it writes to.
--
-- All Boulevard surfaces — web, iOS, Android, and the desktop app (which just
-- loads the web app) — call record_stream() against this same Supabase
-- project, so the count is global and consistent everywhere.
--
-- record_stream() is the ONLY writer of the counter: clients cannot PATCH
-- songs.stream_count directly (songs is select-only under RLS), and each
-- stream is stamped with the server-trusted auth.uid().
--
-- Idempotent: safe to run multiple times. Run it in the Supabase SQL editor.

-- 1. Lifetime stream counter on each song. It rides the catalog every app
--    already loads (`select * from songs`), so the value is visible on the
--    web, mobile and desktop apps with no extra query.
alter table public.songs
  add column if not exists stream_count bigint not null default 0;

-- 2. Allow the 'stream' event_type. Drop whatever CHECK constraint currently
--    governs user_events.event_type (regardless of its name) and recreate it
--    with the full known set plus 'stream'.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'user_events'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%event_type%'
  loop
    execute format('alter table public.user_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.user_events
  add constraint user_events_event_type_check
  check (event_type in (
    'song_started', 'song_completed', 'song_skipped', 'song_impressed',
    'saved', 'unsaved', 'replayed', 'shared', 'volume_changed', 'searched',
    'stream'
  ));

-- 3. record_stream(p_song_id) — the single, server-side stream writer.
--    SECURITY DEFINER so it can bump songs.stream_count (the songs table is
--    read-only to clients) and log the event with the trusted auth.uid().
--    Returns the post-increment lifetime count: when it returns 1, the
--    caller is the first listener of that song platform-wide.
create or replace function public.record_stream(p_song_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_count bigint;
begin
  -- No authenticated session (rare local-UUID fallback): skip silently.
  if uid is null or p_song_id is null then
    return 0;
  end if;
  -- Unknown song id: ignore so a bad client cannot create orphan rows.
  if not exists (select 1 from public.songs where id = p_song_id) then
    return 0;
  end if;

  -- Audit row (also feeds analytics / device_type breakdowns).
  insert into public.user_events (user_id, song_id, event_type)
  values (uid, p_song_id, 'stream');

  -- The global counter every app reads. The row-level lock on this UPDATE
  -- serializes concurrent first-streams, so exactly one caller ever gets 1.
  update public.songs
  set stream_count = stream_count + 1
  where id = p_song_id
  returning stream_count into new_count;

  return new_count;
end;
$$;

grant execute on function public.record_stream(uuid) to anon, authenticated;
