-- Boulevard — admin-controlled split-testing / experimentation system.
--
-- Adds a scalable A/B-testing backend: experiments, variants, deterministic
-- assignments, event tracking, autopilot-generated reports, and a human
-- approval gate. Nothing here touches existing app tables — music playback,
-- signup, the paywall and the existing admin (review queue) are untouched.
--
-- Design notes:
--   • One running experiment per surface_key. The activation trigger blocks a
--     second `running` experiment on the same surface, so a user can never be
--     enrolled in two conflicting tests for the same surface.
--   • Variant assignment is deterministic client-side (hash of experiment_id +
--     subject_id). These tables persist the assignment for audit + analytics.
--   • Winners NEVER auto-apply. Autopilot moves a finished test to
--     `awaiting_approval` and writes a report; only approve_experiment() makes
--     a winning variant the live default.
--   • RLS: normal users may read active experiments (via the SECURITY DEFINER
--     get_active_experiments() RPC only) and write their own assignment +
--     event rows. Everything else is admin-only.
--
-- Idempotent: safe to run multiple times in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ============================================================
-- is_admin() — shared admin predicate, used by every RLS policy below.
-- A user is an admin if they have a public.admin_users row keyed to their uid.
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = auth.uid()
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ============================================================
-- experiments
-- ============================================================
create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hypothesis text,
  -- The app surface this test changes. Only one experiment may be `running`
  -- per surface_key at a time (enforced by the activation trigger).
  surface_key text not null,
  -- Coarse experiment family: onboarding | premium_popup | algorithm | design | engagement.
  category text not null default 'design',
  status text not null default 'draft'
    check (status in (
      'draft','running','paused','completed',
      'awaiting_approval','approved','rejected','archived'
    )),
  -- The single primary metric the winner is judged on (a metric key, e.g.
  -- 'premium_conversion_rate'). Secondary metrics are tracked but not decisive.
  goal_metric text,
  secondary_metrics text[] not null default '{}',
  -- Plain-text success bar the admin commits to before launch.
  success_criteria text,
  -- Audience targeting rules (jsonb). Empty object = everyone.
  -- Shape: { platform?: 'web'|'ios'|'android', anonymous_only?: bool,
  --          premium?: bool, min_songs_heard?: int }
  audience jsonb not null default '{}'::jsonb,
  -- Completion thresholds. A test may complete when EITHER the sample size OR
  -- the runtime bar is met AND statistical confidence clears the threshold.
  min_sample_size int not null default 0,
  min_runtime_hours int not null default 0,
  confidence_threshold numeric not null default 0.95
    check (confidence_threshold >= 0.5 and confidence_threshold <= 0.999),
  start_date timestamptz,
  end_date timestamptz,
  -- Filled by autopilot when a report is generated (the recommended winner).
  recommended_variant_id uuid,
  -- Filled by approve_experiment() once a human signs off. This is what makes
  -- a variant the live default — get_active_experiments() serves it to all.
  winner_variant_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists experiments_status_idx on public.experiments (status);
create index if not exists experiments_surface_idx on public.experiments (surface_key);

-- ============================================================
-- experiment_variants
-- ============================================================
create table if not exists public.experiment_variants (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  -- Short stable key shown in reports: 'A', 'B', 'control', etc.
  key text not null,
  name text not null,
  is_control boolean not null default false,
  -- Free-form JSON the surface reads to render itself. See VariantConfig
  -- examples in src/lib/experiments/catalog.ts.
  config jsonb not null default '{}'::jsonb,
  -- Relative traffic share. Buckets are weighted by this integer.
  traffic_weight int not null default 1 check (traffic_weight >= 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (experiment_id, key)
);

create index if not exists experiment_variants_exp_idx
  on public.experiment_variants (experiment_id);

-- Late FK: experiments references a variant id (winner / recommended).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'experiments_winner_variant_fkey'
  ) then
    alter table public.experiments
      add constraint experiments_winner_variant_fkey
      foreign key (winner_variant_id)
      references public.experiment_variants(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'experiments_recommended_variant_fkey'
  ) then
    alter table public.experiments
      add constraint experiments_recommended_variant_fkey
      foreign key (recommended_variant_id)
      references public.experiment_variants(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- experiment_assignments
-- One row per (experiment, subject). subject_id is auth.uid()::text for
-- signed-in + anonymous Supabase users. Deterministic — the client computes
-- the same variant every time; this table is the audit + analytics record.
-- ============================================================
create table if not exists public.experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  variant_id uuid not null references public.experiment_variants(id) on delete cascade,
  subject_id text not null,
  subject_kind text not null default 'user' check (subject_kind in ('user','anon')),
  surface_key text not null,
  assigned_at timestamptz not null default now(),
  unique (experiment_id, subject_id)
);

create index if not exists experiment_assignments_exp_idx
  on public.experiment_assignments (experiment_id, variant_id);
create index if not exists experiment_assignments_subject_idx
  on public.experiment_assignments (subject_id);

-- ============================================================
-- experiment_events
-- Raw experiment telemetry. event_type is free text (scalable) — see the
-- EXPERIMENT_EVENTS list in src/lib/experiments/catalog.ts.
-- `value` carries numeric payloads (session_length seconds, songs_played, …).
-- ============================================================
create table if not exists public.experiment_events (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  variant_id uuid not null references public.experiment_variants(id) on delete cascade,
  subject_id text not null,
  event_type text not null,
  value numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists experiment_events_exp_idx
  on public.experiment_events (experiment_id, variant_id, event_type);
create index if not exists experiment_events_created_idx
  on public.experiment_events (created_at desc);

-- ============================================================
-- experiment_reports
-- One row per autopilot/manual report. body holds the full structured report
-- (variant stats, recommendation, risks, implementation notes).
-- ============================================================
create table if not exists public.experiment_reports (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  primary_metric text,
  winner_variant_id uuid references public.experiment_variants(id) on delete set null,
  confidence numeric,
  sample_size int,
  body jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

create index if not exists experiment_reports_exp_idx
  on public.experiment_reports (experiment_id, generated_at desc);

-- ============================================================
-- experiment_approvals
-- The human decision log. One row per approve/reject/continue action.
-- ============================================================
create table if not exists public.experiment_approvals (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  report_id uuid references public.experiment_reports(id) on delete set null,
  decision text not null check (decision in ('approved','rejected','continued','manual')),
  chosen_variant_id uuid references public.experiment_variants(id) on delete set null,
  notes text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now()
);

create index if not exists experiment_approvals_exp_idx
  on public.experiment_approvals (experiment_id, decided_at desc);

-- ============================================================
-- experiment_suggestions
-- AI-recommended split tests the admin can approve into a draft, or dismiss.
-- suggestion_key is a stable hash so a dismissed idea never reappears.
-- ============================================================
create table if not exists public.experiment_suggestions (
  id uuid primary key default gen_random_uuid(),
  suggestion_key text not null unique,
  title text not null,
  hypothesis text not null,
  surface_key text not null,
  category text not null,
  goal_metric text not null,
  variants jsonb not null default '[]'::jsonb,
  rationale text,
  status text not null default 'open'
    check (status in ('open','accepted','dismissed')),
  created_experiment_id uuid references public.experiments(id) on delete set null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- updated_at touch trigger for experiments
-- ============================================================
create or replace function public.touch_experiment_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists experiments_touch_updated_at on public.experiments;
create trigger experiments_touch_updated_at
  before update on public.experiments
  for each row execute function public.touch_experiment_updated_at();

-- ============================================================
-- Activation guard. Runs whenever an experiment transitions INTO `running`.
-- Refuses to launch a test that is missing required fields, or that would
-- conflict with another running test on the same surface.
-- ============================================================
create or replace function public.experiment_activation_guard()
returns trigger language plpgsql as $$
declare
  variant_count int;
  conflicting int;
begin
  if new.status = 'running'
     and (tg_op = 'INSERT' or old.status is distinct from 'running') then

    if new.hypothesis is null or btrim(new.hypothesis) = '' then
      raise exception 'Experiment cannot go live without a hypothesis';
    end if;
    if new.goal_metric is null or btrim(new.goal_metric) = '' then
      raise exception 'Experiment cannot go live without a primary metric';
    end if;
    if new.success_criteria is null or btrim(new.success_criteria) = '' then
      raise exception 'Experiment cannot go live without success criteria';
    end if;
    if coalesce(new.min_sample_size, 0) <= 0
       and coalesce(new.min_runtime_hours, 0) <= 0 then
      raise exception 'Experiment needs a minimum sample size or minimum runtime';
    end if;

    select count(*) into variant_count
    from public.experiment_variants
    where experiment_id = new.id;
    if variant_count < 2 then
      raise exception 'Experiment needs at least 2 variants to go live';
    end if;

    select count(*) into conflicting
    from public.experiments
    where surface_key = new.surface_key
      and status = 'running'
      and id <> new.id;
    if conflicting > 0 then
      raise exception
        'Another experiment is already running on surface "%"', new.surface_key;
    end if;

    if new.start_date is null then
      new.start_date := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists experiments_activation_guard on public.experiments;
create trigger experiments_activation_guard
  before insert or update on public.experiments
  for each row execute function public.experiment_activation_guard();

-- ============================================================
-- get_active_experiments() — the ONLY way a normal client reads experiments.
-- Returns running + approved experiments with their variants. SECURITY
-- DEFINER so it bypasses the admin-only RLS on the experiments table while
-- exposing only the fields the app needs to render a variant (no hypothesis,
-- no reports, no audience internals beyond what's needed for targeting).
-- ============================================================
create or replace function public.get_active_experiments()
returns table (
  id uuid,
  surface_key text,
  category text,
  status text,
  goal_metric text,
  audience jsonb,
  winner_variant_id uuid,
  variants jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.surface_key,
    e.category,
    e.status,
    e.goal_metric,
    e.audience,
    e.winner_variant_id,
    coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'id', v.id,
                  'key', v.key,
                  'name', v.name,
                  'is_control', v.is_control,
                  'config', v.config,
                  'traffic_weight', v.traffic_weight,
                  'sort_order', v.sort_order
                ) order by v.sort_order, v.created_at)
       from public.experiment_variants v
       where v.experiment_id = e.id),
      '[]'::jsonb
    ) as variants
  from public.experiments e
  where e.status in ('running','approved');
$$;

grant execute on function public.get_active_experiments() to anon, authenticated;

-- ============================================================
-- experiment_event_rollup(p_experiment_id) — per-variant event aggregates.
-- Admin-only. Powers live results + report generation on the dashboard.
-- ============================================================
create or replace function public.experiment_event_rollup(p_experiment_id uuid)
returns table (
  variant_id uuid,
  event_type text,
  n_events bigint,
  n_subjects bigint,
  value_sum numeric,
  value_sq_sum numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ev.variant_id,
    ev.event_type,
    count(*)                                    as n_events,
    count(distinct ev.subject_id)               as n_subjects,
    coalesce(sum(ev.value), 0)                  as value_sum,
    coalesce(sum(ev.value * ev.value), 0)       as value_sq_sum
  from public.experiment_events ev
  where ev.experiment_id = p_experiment_id
    and public.is_admin()
  group by ev.variant_id, ev.event_type;
$$;

grant execute on function public.experiment_event_rollup(uuid) to authenticated;

-- ============================================================
-- experiment_assignment_counts(p_experiment_id) — enrolled subjects per
-- variant. Admin-only. Used as the denominator for subject-rate metrics.
-- ============================================================
create or replace function public.experiment_assignment_counts(p_experiment_id uuid)
returns table (
  variant_id uuid,
  subjects bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select a.variant_id, count(distinct a.subject_id) as subjects
  from public.experiment_assignments a
  where a.experiment_id = p_experiment_id
    and public.is_admin()
  group by a.variant_id;
$$;

grant execute on function public.experiment_assignment_counts(uuid) to authenticated;

-- ============================================================
-- submit_experiment_report(p_experiment_id, p_report, p_winner, p_confidence,
--   p_sample_size) — autopilot/manual report writer. Inserts the report,
-- records the recommended winner, and moves the experiment to
-- `awaiting_approval`. NEVER changes the live default. Admin-only.
-- ============================================================
create or replace function public.submit_experiment_report(
  p_experiment_id uuid,
  p_report jsonb,
  p_winner_variant_id uuid default null,
  p_confidence numeric default null,
  p_sample_size int default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_metric text;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  select goal_metric into v_metric
  from public.experiments where id = p_experiment_id;

  insert into public.experiment_reports (
    experiment_id, primary_metric, winner_variant_id,
    confidence, sample_size, body
  )
  values (
    p_experiment_id, v_metric, p_winner_variant_id,
    p_confidence, p_sample_size, coalesce(p_report, '{}'::jsonb)
  )
  returning id into v_report_id;

  update public.experiments
  set status = 'awaiting_approval',
      recommended_variant_id = p_winner_variant_id,
      end_date = coalesce(end_date, now())
  where id = p_experiment_id
    and status in ('running','paused','completed');

  return v_report_id;
end;
$$;

grant execute on function public.submit_experiment_report(uuid, jsonb, uuid, numeric, int)
  to authenticated;

-- ============================================================
-- approve_experiment(...) — the human approval gate. The ONLY function that
-- makes a winning variant the live default (status -> approved). Admin-only.
--   decision = 'approved'  -> winner_variant_id = recommended, status approved
--   decision = 'manual'    -> winner_variant_id = p_chosen,    status approved
--   decision = 'rejected'  -> status rejected, no winner (default unchanged)
--   decision = 'continued' -> status back to running
-- ============================================================
create or replace function public.approve_experiment(
  p_experiment_id uuid,
  p_report_id uuid,
  p_decision text,
  p_chosen_variant_id uuid default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recommended uuid;
  v_winner uuid;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_decision not in ('approved','rejected','continued','manual') then
    raise exception 'invalid decision %', p_decision;
  end if;

  select recommended_variant_id into v_recommended
  from public.experiments where id = p_experiment_id;

  insert into public.experiment_approvals (
    experiment_id, report_id, decision, chosen_variant_id, notes, decided_by
  )
  values (
    p_experiment_id, p_report_id, p_decision,
    case when p_decision = 'manual' then p_chosen_variant_id
         when p_decision = 'approved' then v_recommended
         else null end,
    p_notes, auth.uid()
  );

  if p_decision = 'approved' then
    v_winner := v_recommended;
    update public.experiments
    set status = 'approved', winner_variant_id = v_winner
    where id = p_experiment_id;
  elsif p_decision = 'manual' then
    v_winner := p_chosen_variant_id;
    update public.experiments
    set status = 'approved', winner_variant_id = v_winner
    where id = p_experiment_id;
  elsif p_decision = 'rejected' then
    update public.experiments
    set status = 'rejected', winner_variant_id = null
    where id = p_experiment_id;
  elsif p_decision = 'continued' then
    update public.experiments
    set status = 'running', recommended_variant_id = null
    where id = p_experiment_id;
  end if;
end;
$$;

grant execute on function public.approve_experiment(uuid, uuid, text, uuid, text)
  to authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.experiments            enable row level security;
alter table public.experiment_variants    enable row level security;
alter table public.experiment_assignments enable row level security;
alter table public.experiment_events      enable row level security;
alter table public.experiment_reports     enable row level security;
alter table public.experiment_approvals   enable row level security;
alter table public.experiment_suggestions enable row level security;

-- experiments: admin-only direct access. Normal clients use the
-- get_active_experiments() RPC (SECURITY DEFINER) instead.
drop policy if exists "experiments admin all" on public.experiments;
create policy "experiments admin all" on public.experiments
  for all using (public.is_admin()) with check (public.is_admin());

-- variants: admin-only direct access (clients get configs via the RPC).
drop policy if exists "variants admin all" on public.experiment_variants;
create policy "variants admin all" on public.experiment_variants
  for all using (public.is_admin()) with check (public.is_admin());

-- assignments: a user may read + create their OWN assignment rows; admins
-- may read everything.
drop policy if exists "assignments own insert" on public.experiment_assignments;
create policy "assignments own insert" on public.experiment_assignments
  for insert with check (subject_id = auth.uid()::text);

drop policy if exists "assignments own select" on public.experiment_assignments;
create policy "assignments own select" on public.experiment_assignments
  for select using (subject_id = auth.uid()::text or public.is_admin());

-- events: a user may insert their OWN event rows; admins may read everything.
drop policy if exists "events own insert" on public.experiment_events;
create policy "events own insert" on public.experiment_events
  for insert with check (subject_id = auth.uid()::text);

drop policy if exists "events admin select" on public.experiment_events;
create policy "events admin select" on public.experiment_events
  for select using (public.is_admin());

-- reports / approvals / suggestions: fully admin-only.
drop policy if exists "reports admin all" on public.experiment_reports;
create policy "reports admin all" on public.experiment_reports
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "approvals admin all" on public.experiment_approvals;
create policy "approvals admin all" on public.experiment_approvals
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "suggestions admin all" on public.experiment_suggestions;
create policy "suggestions admin all" on public.experiment_suggestions
  for all using (public.is_admin()) with check (public.is_admin());
