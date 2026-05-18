-- Cross-device playback ("Boulevard Connect").
--
-- One row per user. Exactly one of a user's signed-in devices is the
-- "active" device: it owns audio and reports its now-playing state here.
-- Every other device of the same account reads this row to mirror the
-- now-playing surface, and writes a command (bumping command_seq) to
-- control the active device — change song, play/pause, skip, seek.
--
-- The active device refreshes heartbeat_at on a timer. If it goes stale
-- (tab closed / app killed), another device may claim the session via
-- claim_playback_session() — it takes over paused, never auto-playing.

create table if not exists public.playback_sessions (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  -- The device currently allowed to produce audio. Null = nobody active.
  active_device_id     text,
  -- Human label for the "Playing on <device>" hint shown on other devices.
  active_device_label  text,
  -- Reported now-playing state, written by the active device only.
  song_id              text,
  is_playing           boolean     not null default false,
  position_ms          integer     not null default 0,
  -- Liveness — the active device bumps this on a timer; a stale beat lets
  -- another device claim the session.
  heartbeat_at         timestamptz,
  -- Command channel — any device bumps command_seq + writes a command for
  -- the active device to apply. Shape: {"type":"play-song","songId":"..."},
  -- {"type":"toggle"}, {"type":"skip"}, {"type":"previous"},
  -- {"type":"seek","positionMs":1234}.
  command              jsonb,
  command_seq          bigint      not null default 0,
  command_by           text,
  updated_at           timestamptz not null default now()
);

alter table public.playback_sessions enable row level security;

-- A user only ever sees / writes their own session row.
drop policy if exists "playback_sessions: own row select" on public.playback_sessions;
create policy "playback_sessions: own row select" on public.playback_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "playback_sessions: own row insert" on public.playback_sessions;
create policy "playback_sessions: own row insert" on public.playback_sessions
  for insert with check (auth.uid() = user_id);

drop policy if exists "playback_sessions: own row update" on public.playback_sessions;
create policy "playback_sessions: own row update" on public.playback_sessions
  for update using (auth.uid() = user_id);

-- Atomic claim. A device calls this on launch (and again to take over a
-- stale session). It wins the session when nobody holds it, when the
-- holder's heartbeat is stale, or when it already holds it. Returns the
-- resulting row — the caller is the active device iff
-- active_device_id = p_device_id. `p_take_over` forces a claim even from a
-- live holder (used by the explicit "play on this device" control).
create or replace function public.claim_playback_session(
  p_device_id    text,
  p_device_label text default null,
  p_take_over    boolean default false
)
returns public.playback_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.playback_sessions;
  stale  constant interval := interval '35 seconds';
begin
  insert into public.playback_sessions (user_id, active_device_id, active_device_label, heartbeat_at, is_playing)
    values (auth.uid(), p_device_id, p_device_label, now(), false)
  on conflict (user_id) do update set
    active_device_id = case
      when p_take_over
        or playback_sessions.active_device_id is null
        or playback_sessions.active_device_id = p_device_id
        or playback_sessions.heartbeat_at is null
        or playback_sessions.heartbeat_at < now() - stale
      then p_device_id
      else playback_sessions.active_device_id
    end,
    active_device_label = case
      when p_take_over
        or playback_sessions.active_device_id is null
        or playback_sessions.active_device_id = p_device_id
        or playback_sessions.heartbeat_at is null
        or playback_sessions.heartbeat_at < now() - stale
      then p_device_label
      else playback_sessions.active_device_label
    end,
    heartbeat_at = case
      when p_take_over
        or playback_sessions.active_device_id is null
        or playback_sessions.active_device_id = p_device_id
        or playback_sessions.heartbeat_at is null
        or playback_sessions.heartbeat_at < now() - stale
      then now()
      else playback_sessions.heartbeat_at
    end,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

-- Realtime — every device sees row changes the instant they're written.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'playback_sessions'
  ) then
    alter publication supabase_realtime add table public.playback_sessions;
  end if;
end $$;
