-- Boulevard — admin analytics dashboard backend.
--
-- Adds a set of read-only, admin-only RPCs that turn the existing telemetry
-- (user_events, songs, song_daily_stats, user_profiles, auth.users) into the
-- metrics the admin Analytics screen renders: conversion funnels, session
-- quality, listening behavior, top content, and algorithm/distribution health
-- — on a day / week / month basis, each with the previous period for
-- comparison.
--
-- Nothing here writes app data. Every function is SECURITY DEFINER + gated by
-- is_admin(), so a non-admin gets a permission error, never data.
--
-- One small piece of new instrumentation: user_profiles gains is_premium /
-- premium_since (mirrored from the client, see AuthContext) because premium
-- status lives in RevenueCat, not the database. Everything else is derived
-- from data the app already records.
--
-- Idempotent: safe to run multiple times in the Supabase SQL editor.

-- ============================================================
-- is_admin() — re-declared so this migration is self-contained.
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ============================================================
-- Premium mirror. Premium status is owned by RevenueCat; the client mirrors
-- it here (fire-and-forget) so the dashboard can read free→premium conversion.
-- ============================================================
alter table public.user_profiles
  add column if not exists is_premium boolean not null default false,
  add column if not exists premium_since timestamptz;

-- Speeds up every windowed scan the analytics RPCs run.
create index if not exists user_events_created_idx
  on public.user_events (created_at desc);
create index if not exists user_events_session_idx
  on public.user_events (session_id);

-- ============================================================
-- analytics_bounds(period, offset) — the [start, end) of a period.
--   period ∈ 'day' | 'week' | 'month'
--   offset  = how many whole periods back (0 = current, 1 = previous, …)
-- ============================================================
create or replace function public.analytics_bounds(p_period text, p_offset int)
returns table (s timestamptz, e timestamptz)
language sql
stable
as $$
  select
    case p_period
      when 'day'  then date_trunc('day',  now()) - make_interval(days   := p_offset)
      when 'week' then date_trunc('week', now()) - make_interval(weeks  := p_offset)
      else             date_trunc('month',now()) - make_interval(months := p_offset)
    end,
    case p_period
      when 'day'  then date_trunc('day',  now()) - make_interval(days   := p_offset - 1)
      when 'week' then date_trunc('week', now()) - make_interval(weeks  := p_offset - 1)
      else             date_trunc('month',now()) - make_interval(months := p_offset - 1)
    end;
$$;

-- ============================================================
-- analytics_window_metrics(start, end) — every headline KPI for one window,
-- as a jsonb object. The single source of truth reused by both the overview
-- and the timeseries RPCs.
-- ============================================================
create or replace function public.analytics_window_metrics(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days      numeric := greatest(extract(epoch from (p_end - p_start)) / 86400.0, 1);
  v_plays     bigint;
  v_streams   bigint;
  v_active    bigint;
  v_sessions  bigint;
  v_early     bigint;
  v_new_users bigint;
  v_signups   bigint;
  v_new_prem  bigint;
  v_prem_act  bigint;
  v_avg_sess  numeric;
  v_avg_pct   numeric;
begin
  select
    count(*) filter (where event_type = 'song_started'),
    count(*) filter (where event_type = 'stream'),
    count(distinct user_id),
    count(distinct session_id),
    count(*) filter (
      where event_type = 'song_skipped' and coalesce(completion_percentage, 0) < 0.30
    )
  into v_plays, v_streams, v_active, v_sessions, v_early
  from public.user_events
  where created_at >= p_start and created_at < p_end;

  select coalesce(avg(completion_percentage), 0)
  into v_avg_pct
  from public.user_events
  where created_at >= p_start and created_at < p_end
    and event_type in ('song_completed', 'song_skipped')
    and completion_percentage is not null;

  -- Session length = span of one session_id's events, capped at 4h so a
  -- backgrounded app cannot inflate the average.
  select coalesce(avg(span), 0)
  into v_avg_sess
  from (
    select least(extract(epoch from (max(created_at) - min(created_at))), 14400) as span
    from public.user_events
    where created_at >= p_start and created_at < p_end and session_id is not null
    group by session_id
  ) t;

  select count(*) into v_new_users
  from auth.users
  where created_at >= p_start and created_at < p_end;

  select count(*) into v_signups
  from auth.users
  where created_at >= p_start and created_at < p_end
    and coalesce(is_anonymous, false) = false;

  select count(*) into v_new_prem
  from public.user_profiles
  where premium_since >= p_start and premium_since < p_end;

  select count(*) into v_prem_act
  from public.user_profiles up
  where up.is_premium = true
    and up.user_id in (
      select distinct user_id from public.user_events
      where created_at >= p_start and created_at < p_end
    );

  return jsonb_build_object(
    'window_days',            round(v_days, 2),
    'plays',                  v_plays,
    'streams',                v_streams,
    'active_users',           v_active,
    'sessions',               v_sessions,
    'app_opens_per_day',      round(v_sessions / v_days, 2),
    'new_users',              v_new_users,
    'signups',                v_signups,
    'signup_conversion_rate', case when v_new_users > 0 then round(v_signups::numeric / v_new_users, 4) else 0 end,
    'new_premium',            v_new_prem,
    'premium_conversion_rate',case when v_new_users > 0 then round(v_new_prem::numeric / v_new_users, 4) else 0 end,
    'premium_active_rate',    case when v_active > 0 then round(v_prem_act::numeric / v_active, 4) else 0 end,
    'avg_session_seconds',    round(v_avg_sess, 1),
    'avg_listen_pct',         round(v_avg_pct, 4),
    'drop_off_rate',          case when v_plays > 0 then round(v_early::numeric / v_plays, 4) else 0 end,
    'hook_rate',              case when v_plays > 0 then round(1 - v_early::numeric / v_plays, 4) else 0 end
  );
end;
$$;

grant execute on function public.analytics_window_metrics(timestamptz, timestamptz) to authenticated;

-- ============================================================
-- analytics_overview(period) — current period + previous period side by side.
-- ============================================================
create or replace function public.analytics_overview(p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cs timestamptz; ce timestamptz;
  ps timestamptz; pe timestamptz;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_period not in ('day', 'week', 'month') then p_period := 'week'; end if;

  select s, e into cs, ce from public.analytics_bounds(p_period, 0);
  select s, e into ps, pe from public.analytics_bounds(p_period, 1);

  return jsonb_build_object(
    'period',         p_period,
    'current_start',  cs,
    'previous_start', ps,
    'current',        public.analytics_window_metrics(cs, ce),
    'previous',       public.analytics_window_metrics(ps, pe)
  );
end;
$$;

grant execute on function public.analytics_overview(text) to authenticated;

-- ============================================================
-- analytics_timeseries(period, buckets) — the last N periods, oldest first,
-- each with the full metric set. Powers the trend sparklines.
-- ============================================================
create or replace function public.analytics_timeseries(p_period text, p_buckets int)
returns table (bucket_start timestamptz, metrics jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  i  int;
  bs timestamptz;
  be timestamptz;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_period not in ('day', 'week', 'month') then p_period := 'week'; end if;
  p_buckets := least(greatest(coalesce(p_buckets, 12), 1), 60);

  for i in reverse (p_buckets - 1)..0 loop
    select s, e into bs, be from public.analytics_bounds(p_period, i);
    bucket_start := bs;
    metrics := public.analytics_window_metrics(bs, be);
    return next;
  end loop;
end;
$$;

grant execute on function public.analytics_timeseries(text, int) to authenticated;

-- ============================================================
-- analytics_top_content(kind, period, offset, limit) — ranked content lists.
--   kind ∈ genres | moods | artists | songs | replay_songs | retention_songs
--        | worlds | onboarding_songs | clusters | onboarding_clusters
-- Returns label / sub / value / unit so the screen can render any list the
-- same way. `value` is a count or a 0..1 rate depending on `unit`.
-- ============================================================
create or replace function public.analytics_top_content(
  p_kind text,
  p_period text,
  p_offset int default 0,
  p_limit int default 10
)
returns table (label text, sub text, value numeric, unit text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_lim int := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select s, e into v_start, v_end from public.analytics_bounds(p_period, coalesce(p_offset, 0));

  if p_kind = 'genres' then
    return query
      select s.genre::text, 'genre'::text, count(*)::numeric, 'plays'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.event_type = 'song_started'
        and e.created_at >= v_start and e.created_at < v_end
        and s.genre is not null
      group by s.genre
      order by count(*) desc
      limit v_lim;

  elsif p_kind = 'moods' then
    return query
      select s.mood::text, 'mood'::text, count(*)::numeric, 'plays'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.event_type = 'song_started'
        and e.created_at >= v_start and e.created_at < v_end
        and s.mood is not null
      group by s.mood
      order by count(*) desc
      limit v_lim;

  elsif p_kind = 'artists' then
    return query
      select
        coalesce(to_jsonb(s.*) ->> 'artist_name', 'Unknown')::text,
        'artist'::text,
        count(*)::numeric,
        'plays'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.event_type = 'song_started'
        and e.created_at >= v_start and e.created_at < v_end
      group by 1
      order by count(*) desc
      limit v_lim;

  elsif p_kind = 'songs' then
    return query
      select
        s.title::text,
        coalesce(to_jsonb(s.*) ->> 'artist_name', s.genre)::text,
        count(*)::numeric,
        'plays'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.event_type = 'song_started'
        and e.created_at >= v_start and e.created_at < v_end
      group by s.id, s.title, s.genre, to_jsonb(s.*) ->> 'artist_name'
      order by count(*) desc
      limit v_lim;

  elsif p_kind = 'replay_songs' then
    return query
      select
        s.title::text,
        coalesce(to_jsonb(s.*) ->> 'artist_name', s.genre)::text,
        count(*)::numeric,
        'replays'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.event_type = 'replayed'
        and e.created_at >= v_start and e.created_at < v_end
      group by s.id, s.title, s.genre, to_jsonb(s.*) ->> 'artist_name'
      order by count(*) desc
      limit v_lim;

  elsif p_kind = 'retention_songs' then
    -- Songs whose listeners tend to come back: of each song's listeners in
    -- the window, the share who are active on >= 2 distinct days overall.
    return query
      with returners as (
        select user_id
        from public.user_events
        group by user_id
        having count(distinct created_at::date) >= 2
      ),
      song_listeners as (
        select e.song_id, e.user_id
        from public.user_events e
        where e.event_type = 'song_started'
          and e.created_at >= v_start and e.created_at < v_end
        group by e.song_id, e.user_id
      )
      select
        s.title::text,
        coalesce(to_jsonb(s.*) ->> 'artist_name', s.genre)::text,
        round(
          count(*) filter (where r.user_id is not null)::numeric / nullif(count(*), 0),
          4
        ),
        'retention'::text
      from song_listeners sl
      join public.songs s on s.id = sl.song_id
      left join returners r on r.user_id = sl.user_id
      group by s.id, s.title, s.genre, to_jsonb(s.*) ->> 'artist_name'
      having count(*) >= 5
      order by 3 desc
      limit v_lim;

  elsif p_kind = 'worlds' then
    -- Explore "worlds" map to the vibe_context a play started from.
    return query
      select
        e.vibe_context::text,
        'explore world'::text,
        count(*)::numeric,
        'plays'::text
      from public.user_events e
      where e.event_type = 'song_started'
        and e.created_at >= v_start and e.created_at < v_end
        and e.vibe_context is not null
      group by e.vibe_context
      order by count(*) desc
      limit v_lim;

  elsif p_kind in ('onboarding_songs', 'onboarding_clusters') then
    -- Onboarding = a user's earliest session. Hit-rate = share of plays heard
    -- to >= 50% (completed or skipped past the half-way mark).
    return query
      with first_session as (
        select distinct on (user_id) user_id, session_id
        from public.user_events
        where session_id is not null
        order by user_id, created_at
      ),
      ob as (
        select e.song_id, e.event_type, e.completion_percentage
        from public.user_events e
        join first_session fs
          on fs.user_id = e.user_id and fs.session_id = e.session_id
        where e.created_at >= v_start and e.created_at < v_end
          and e.event_type in ('song_started', 'song_completed', 'song_skipped')
      )
      select
        case when p_kind = 'onboarding_songs'
             then s.title::text
             else ('Cluster ' || coalesce(s.similarity_cluster, 0))::text end,
        (count(*) filter (where ob.event_type = 'song_started') || ' onboarding plays')::text,
        round(
          count(*) filter (
            where ob.event_type in ('song_completed', 'song_skipped')
              and coalesce(ob.completion_percentage, 0) >= 0.50
          )::numeric
          / nullif(count(*) filter (where ob.event_type in ('song_completed', 'song_skipped')), 0),
          4
        ),
        'hit_rate'::text
      from ob
      join public.songs s on s.id = ob.song_id
      group by
        case when p_kind = 'onboarding_songs' then s.title else 'Cluster ' || coalesce(s.similarity_cluster, 0) end
      having count(*) filter (where ob.event_type = 'song_started') >= 3
      order by 3 desc nulls last
      limit v_lim;

  elsif p_kind = 'clusters' then
    -- Similarity-cluster performance: avg completion of its plays.
    return query
      select
        ('Cluster ' || coalesce(s.similarity_cluster, 0))::text,
        (count(*) filter (where e.event_type = 'song_started') || ' plays')::text,
        round(
          avg(e.completion_percentage) filter (
            where e.event_type in ('song_completed', 'song_skipped')
          ),
          4
        ),
        'avg_completion'::text
      from public.user_events e
      join public.songs s on s.id = e.song_id
      where e.created_at >= v_start and e.created_at < v_end
      group by s.similarity_cluster
      having count(*) filter (where e.event_type = 'song_started') >= 5
      order by 3 desc nulls last
      limit v_lim;
  end if;
end;
$$;

grant execute on function public.analytics_top_content(text, text, int, int) to authenticated;

-- ============================================================
-- analytics_distribution() — algorithm/distribution health snapshot.
-- Reads the staged-distribution columns defensively via to_jsonb, so the
-- function is created successfully even on a project where the music-factory
-- distribution columns are not present (the section just reports zeros).
-- ============================================================
create or replace function public.analytics_distribution()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_new       bigint;
  v_rising    bigint;
  v_trending  bigint;
  v_suppressed bigint;
  v_staged    bigint;
  v_quality   jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  select
    count(*) filter (where stage = 'new_test'),
    count(*) filter (where stage = 'rising'),
    count(*) filter (where stage = 'trending'),
    count(*) filter (where stage = 'suppressed')
  into v_new, v_rising, v_trending, v_suppressed
  from (
    select to_jsonb(s.*) ->> 'distribution_stage' as stage
    from public.songs s
  ) d;

  v_staged := v_new + v_rising + v_trending + v_suppressed;

  -- Quality-score histogram in five 0.2-wide buckets.
  select coalesce(jsonb_agg(jsonb_build_object('bucket', b.bucket, 'count', b.cnt) order by b.bucket), '[]'::jsonb)
  into v_quality
  from (
    select
      width_bucket(q, 0, 1, 5) as bucket,
      count(*) as cnt
    from (
      select ((to_jsonb(s.*) ->> 'quality_score'))::numeric as q
      from public.songs s
    ) qq
    where q is not null
    group by 1
  ) b;

  return jsonb_build_object(
    'stage_counts', jsonb_build_object(
      'new_test', v_new, 'rising', v_rising,
      'trending', v_trending, 'suppressed', v_suppressed
    ),
    'staged_total', v_staged,
    -- Survival = made it out of new_test without being suppressed.
    'new_test_survival_rate',
      case when (v_rising + v_trending + v_suppressed) > 0
           then round((v_rising + v_trending)::numeric / (v_rising + v_trending + v_suppressed), 4)
           else 0 end,
    'rising_to_trending_rate',
      case when (v_rising + v_trending) > 0
           then round(v_trending::numeric / (v_rising + v_trending), 4)
           else 0 end,
    'suppression_rate',
      case when v_staged > 0
           then round(v_suppressed::numeric / v_staged, 4)
           else 0 end,
    'quality_histogram', coalesce(v_quality, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.analytics_distribution() to authenticated;
