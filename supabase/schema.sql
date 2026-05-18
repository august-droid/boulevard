-- Boulevard MVP schema
-- Run this in the Supabase SQL editor.

create extension if not exists "uuid-ossp";

-- ============================================================
-- songs
-- ============================================================
create table if not exists public.songs (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  audio_url text not null,
  cover_url text not null,
  -- Primary genre/mood for fast indexed lookups + back-compat. When the
  -- importer is given multiple values, the first wins. Arrays below carry
  -- the full set.
  genre text not null,
  genres text[] not null default '{}',
  bpm int,
  mood text not null,
  moods text[] not null default '{}',
  -- Internal scale stays 0..1. The CSV importer accepts the more human-friendly
  -- 1..10 input and divides by 10 before insert. CHECK is permissive so future
  -- imports from any reasonable scale won't reject.
  energy_score numeric not null check (energy_score >= 0 and energy_score <= 1),
  vocal_type text not null check (vocal_type in ('instrumental','male','female','mixed')),
  voice_gender text,
  similarity_cluster int not null default 0,
  drop_timestamps numeric[] default '{}',
  intro_length numeric default 0,
  -- activities the song is a good fit for (gym, focus, driving, etc.)
  activity_fit text[] default '{}',
  duration_seconds int not null,
  -- Editorial / cold-start signals. is_featured promotes a song into curated
  -- surfaces; launch_score (0..1) ranks new songs for users with little
  -- behavioral history.
  is_featured boolean not null default false,
  launch_score numeric not null default 0 check (launch_score >= 0 and launch_score <= 1),
  created_at timestamptz not null default now()
);

-- Migration for existing installs (idempotent).
alter table public.songs add column if not exists genres text[] not null default '{}';
alter table public.songs add column if not exists moods text[] not null default '{}';
alter table public.songs add column if not exists is_featured boolean not null default false;
alter table public.songs add column if not exists launch_score numeric not null default 0;
alter table public.songs alter column bpm drop not null;
alter table public.songs alter column similarity_cluster set default 0;

create index if not exists songs_featured_idx on public.songs (is_featured) where is_featured = true;
create index if not exists songs_launch_idx on public.songs (launch_score desc);

create index if not exists songs_genre_idx on public.songs (genre);
create index if not exists songs_mood_idx on public.songs (mood);
create index if not exists songs_genres_idx on public.songs using gin (genres);
create index if not exists songs_moods_idx on public.songs using gin (moods);
create index if not exists songs_cluster_idx on public.songs (similarity_cluster);

-- ============================================================
-- user_events
-- All interactions: play, skip, like, save, replay, complete, etc.
-- ============================================================
create table if not exists public.user_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  song_id uuid not null references public.songs(id) on delete cascade,
  event_type text not null check (event_type in (
    'song_started','song_completed','song_skipped',
    'saved','unsaved','replayed','shared','volume_changed','searched'
  )),
  skip_time_seconds numeric,
  listen_duration_seconds numeric,
  completion_percentage numeric,
  volume_change numeric,
  device_type text,
  session_id text,
  vibe_context text,
  created_at timestamptz not null default now()
);

create index if not exists user_events_user_idx on public.user_events (user_id);
create index if not exists user_events_song_idx on public.user_events (song_id);
create index if not exists user_events_type_idx on public.user_events (event_type);

-- ============================================================
-- user_taste_profiles
-- One row per user. Scores are JSON maps from category -> weight.
-- ============================================================
create table if not exists public.user_taste_profiles (
  user_id uuid primary key,
  genre_scores jsonb not null default '{}'::jsonb,
  mood_scores jsonb not null default '{}'::jsonb,
  bpm_preference numeric,
  energy_preference numeric,
  vocal_preferences jsonb not null default '{}'::jsonb,
  activity_scores jsonb not null default '{}'::jsonb,
  similarity_cluster_scores jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- library
-- One row per user-song-type combo (liked/saved/recent).
-- ============================================================
create table if not exists public.library (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  song_id uuid not null references public.songs(id) on delete cascade,
  type text not null check (type in ('saved','recent')),
  created_at timestamptz not null default now(),
  unique (user_id, song_id, type)
);

create index if not exists library_user_type_idx on public.library (user_id, type, created_at desc);

-- ============================================================
-- user_daily_listens
-- One row per (user, calendar day). Used to enforce the 20-songs/day
-- free-tier cap and to drive Explore's trending signals server-side.
-- The client keeps the authoritative count locally for speed; the row
-- here exists for cross-device sync and analytics.
-- ============================================================
create table if not exists public.user_daily_listens (
  user_id uuid not null,
  day date not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists daily_listens_day_idx on public.user_daily_listens (day desc);

-- ============================================================
-- song_daily_stats
-- Per-song aggregates rolled up daily. Powers the Explore trending
-- carousels and the auto-suppression rule in the recommender.
--
-- Stats are produced server-side by a scheduled job (Edge function / cron
-- on Supabase) that reads from user_events. The app only ever reads from
-- this table — never writes to it.
-- ============================================================
create table if not exists public.song_daily_stats (
  song_id uuid not null references public.songs(id) on delete cascade,
  day date not null,
  plays int not null default 0,
  unique_listeners int not null default 0,
  avg_completion numeric not null default 0 check (avg_completion between 0 and 1),
  skip_rate numeric not null default 0 check (skip_rate between 0 and 1),
  save_rate numeric not null default 0 check (save_rate between 0 and 1),
  replay_rate numeric not null default 0 check (replay_rate between 0 and 1),
  share_rate numeric not null default 0 check (share_rate between 0 and 1),
  -- Velocity = (plays_today - plays_yesterday) / max(plays_yesterday, 1).
  -- Clamped to [-1, 1] for stability.
  velocity_score numeric not null default 0,
  -- Final trending score the Explore ranker reads. Computed by the rollup
  -- job using the same weights as the client-side fallback so behavior is
  -- consistent in both modes.
  trending_score numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (song_id, day)
);

create index if not exists song_stats_day_idx on public.song_daily_stats (day desc);
create index if not exists song_stats_trending_idx on public.song_daily_stats (day desc, trending_score desc);

-- ============================================================
-- Helper: get_trending_today(limit_n int)
-- Returns the top trending songs for the current day. Used by Explore to
-- avoid the client having to roll up rates itself when stats exist.
-- ============================================================
create or replace function public.get_trending_today(limit_n int default 20)
returns table (
  song_id uuid,
  plays int,
  unique_listeners int,
  avg_completion numeric,
  skip_rate numeric,
  save_rate numeric,
  replay_rate numeric,
  share_rate numeric,
  velocity_score numeric,
  trending_score numeric
)
language sql stable as $$
  select song_id, plays, unique_listeners, avg_completion,
         skip_rate, save_rate, replay_rate, share_rate,
         velocity_score, trending_score
  from public.song_daily_stats
  where day = current_date
  order by trending_score desc
  limit limit_n;
$$;

-- ============================================================
-- Helper: roll_song_daily_stats(target_day date)
-- Aggregates user_events for the given day into song_daily_stats.
-- Run this from a cron job (Supabase scheduled function) every hour or so.
-- ============================================================
create or replace function public.roll_song_daily_stats(target_day date default current_date)
returns void
language plpgsql as $$
declare
  prev date := target_day - 1;
begin
  insert into public.song_daily_stats (
    song_id, day, plays, unique_listeners, avg_completion,
    skip_rate, save_rate, replay_rate, share_rate,
    velocity_score, trending_score, updated_at
  )
  select
    e.song_id,
    target_day,
    count(*) filter (where e.event_type = 'song_started')                                  as plays,
    count(distinct e.user_id) filter (where e.event_type = 'song_started')                 as unique_listeners,
    coalesce(avg(e.completion_percentage) filter (where e.event_type in ('song_completed','song_skipped')), 0) as avg_completion,
    coalesce(
      count(*) filter (where e.event_type = 'song_skipped')::numeric
        / nullif(count(*) filter (where e.event_type = 'song_started'), 0), 0)             as skip_rate,
    coalesce(
      count(*) filter (where e.event_type = 'saved')::numeric
        / nullif(count(*) filter (where e.event_type = 'song_started'), 0), 0)             as save_rate,
    coalesce(
      count(*) filter (where e.event_type = 'replayed')::numeric
        / nullif(count(*) filter (where e.event_type = 'song_started'), 0), 0)             as replay_rate,
    coalesce(
      count(*) filter (where e.event_type = 'shared')::numeric
        / nullif(count(*) filter (where e.event_type = 'song_started'), 0), 0)             as share_rate,
    0   as velocity_score,   -- filled in by the update below
    0   as trending_score,   -- ditto
    now() as updated_at
  from public.user_events e
  where e.created_at::date = target_day
  group by e.song_id
  on conflict (song_id, day) do update set
    plays = excluded.plays,
    unique_listeners = excluded.unique_listeners,
    avg_completion = excluded.avg_completion,
    skip_rate = excluded.skip_rate,
    save_rate = excluded.save_rate,
    replay_rate = excluded.replay_rate,
    share_rate = excluded.share_rate,
    updated_at = now();

  -- Velocity vs previous day. -1..1 then mapped to [0..1].
  update public.song_daily_stats t
  set velocity_score = greatest(0, least(1,
        0.5 + greatest(-1, least(1, (t.plays - coalesce(p.plays, 0))::numeric / greatest(coalesce(p.plays, 0), 1) )) / 2))
  from (
    select song_id, plays from public.song_daily_stats where day = prev
  ) p
  where t.day = target_day and t.song_id = p.song_id;

  -- Weighted blend matching the client fallback weights in src/lib/ranking/Trending.ts.
  update public.song_daily_stats
  set trending_score =
        0.18 * least(1, plays::numeric / 5000)
      + 0.22 * replay_rate
      + 0.18 * save_rate
      + 0.14 * avg_completion
      + 0.14 * greatest(0, 1 - skip_rate)
      + 0.14 * velocity_score
  where day = target_day;
end;
$$;

-- ============================================================
-- RLS
-- We trust the client with the authenticated user id for the MVP.
-- ============================================================
alter table public.songs enable row level security;
alter table public.user_events enable row level security;
alter table public.user_taste_profiles enable row level security;
alter table public.library enable row level security;
alter table public.user_daily_listens enable row level security;
alter table public.song_daily_stats enable row level security;

-- songs are public read
drop policy if exists "songs are readable" on public.songs;
create policy "songs are readable" on public.songs for select using (true);

-- a user can read/write their own rows
drop policy if exists "events: own rows" on public.user_events;
create policy "events: own rows" on public.user_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "taste: own rows" on public.user_taste_profiles;
create policy "taste: own rows" on public.user_taste_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "library: own rows" on public.library;
create policy "library: own rows" on public.library
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "daily_listens: own rows" on public.user_daily_listens;
create policy "daily_listens: own rows" on public.user_daily_listens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "song_stats are readable" on public.song_daily_stats;
create policy "song_stats are readable" on public.song_daily_stats
  for select using (true);

-- ============================================================
-- tiktok_registration_events
-- One row per user, ever. Written ONLY by the tiktok-event Netlify
-- function (service-role key). Its sole purpose is idempotency: the
-- primary key on user_id guarantees the server-side TikTok
-- CompleteRegistration conversion is sent at most once per user, so a
-- returning login can never re-fire it.
-- ============================================================
create table if not exists public.tiktok_registration_events (
  user_id uuid primary key,
  event_id text not null,
  signup_method text,
  tiktok_status text,
  created_at timestamptz not null default now()
);

-- Service-role only: RLS on with NO policies, so the anon and authenticated
-- roles can never read or write it. The Netlify function uses the
-- service-role key, which bypasses RLS.
alter table public.tiktok_registration_events enable row level security;
