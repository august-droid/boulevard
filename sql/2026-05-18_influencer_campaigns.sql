-- Boulevard — influencer campaign management for the /admin panel.
--
-- Adds a self-contained creator-CRM backend: discovery + scoring, a 14-stage
-- pipeline, fixed-fee deals tied to campaigns, and an outreach log. Nothing
-- here touches the user-facing app (player, signup, paywall) or the existing
-- admin review queue — all four tables are admin-only via public.is_admin().
--
-- Design notes:
--   • view_follower_ratio and engagement_rate are STORED generated columns —
--     always correct, filterable + sortable in SQL.
--   • score (1-100) is written by the /admin client (influencers.js) because
--     it blends generated metrics with subjective admin ratings and tunable
--     curves; keeping the formula in code makes it easy to retune.
--   • cost_per_signup / cost_per_1k_views on a deal are generated columns.
--   • The /admin SPA reads + writes these tables directly with the anon key +
--     the signed-in admin's session; RLS (is_admin()) is the security gate.
--     No new Netlify functions needed.
--
-- Idempotent: safe to run multiple times in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ============================================================
-- is_admin() — shared admin predicate (also defined by the experiments
-- migration). Re-declared here so this file is self-contained.
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
-- touch_influencer_updated_at — shared updated_at trigger function.
-- ============================================================
create or replace function public.touch_influencer_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================
-- influencer_creators — discovery, scoring, pipeline status, ad-usage.
-- ============================================================
create table if not exists public.influencer_creators (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('tiktok','instagram')),
  creator_name text not null default '',
  username text not null,
  profile_url text,
  followers integer not null default 0 check (followers >= 0),
  avg_views integer not null default 0 check (avg_views >= 0),
  avg_likes integer not null default 0 check (avg_likes >= 0),
  avg_comments integer not null default 0 check (avg_comments >= 0),
  -- avg_views / followers — strong reach signal for underpriced creators.
  view_follower_ratio numeric generated always as (
    case when followers > 0 then round(avg_views::numeric / followers, 4) else 0 end
  ) stored,
  -- (avg_likes + avg_comments) / avg_views.
  engagement_rate numeric generated always as (
    case when avg_views > 0 then round((avg_likes + avg_comments)::numeric / avg_views, 4) else 0 end
  ) stored,
  -- Subjective admin ratings (0-100) that feed the score.
  audience_fit integer not null default 60 check (audience_fit between 0 and 100),
  content_quality integer not null default 60 check (content_quality between 0 and 100),
  -- Computed by the /admin client. 1-100, with a coarse label.
  score integer not null default 0 check (score between 0 and 100),
  score_label text not null default 'maybe'
    check (score_label in ('priority','good_test','maybe','skip')),
  score_breakdown jsonb not null default '{}'::jsonb,
  niche text,
  country text,
  language text,
  audience_age text,
  audience_gender text,
  contact_method text check (contact_method in ('email','dm','agency','other')),
  contact_info text,
  notes text,
  status text not null default 'discovered' check (status in (
    'discovered','approved_outreach','contacted','replied','negotiating',
    'deal_agreed','brief_sent','content_received','revision_requested',
    'approved','posted','paid','rejected','blacklisted'
  )),
  last_contacted_at timestamptz,
  next_follow_up_at date,
  -- Ad usage / whitelisting — the best organic content becomes paid ads.
  can_use_as_ad boolean not null default false,
  can_edit_video boolean not null default false,
  can_use_handle boolean not null default false,
  ad_usage_duration text,
  ad_extra_fee numeric,
  spark_ads_code text,
  meta_partnership_access text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One creator per platform handle — also the CSV-import duplicate key.
create unique index if not exists influencer_creators_handle_key
  on public.influencer_creators (platform, lower(username));
create index if not exists influencer_creators_status_idx
  on public.influencer_creators (status);
create index if not exists influencer_creators_score_idx
  on public.influencer_creators (score desc);

drop trigger if exists influencer_creators_touch on public.influencer_creators;
create trigger influencer_creators_touch
  before update on public.influencer_creators
  for each row execute function public.touch_influencer_updated_at();

-- ============================================================
-- influencer_campaigns — a fixed-fee campaign across one or both platforms.
-- ============================================================
create table if not exists public.influencer_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform text not null default 'tiktok'
    check (platform in ('tiktok','instagram','both')),
  goal text not null default 'app_signups' check (goal in (
    'app_signups','website_signups','listens','viral_reach','paid_whitelisting'
  )),
  budget numeric not null default 0,
  target_creators integer not null default 0,
  target_cpa numeric,
  target_cpm numeric,
  target_cost_per_signup numeric,
  target_view_follower_ratio numeric,
  start_date date,
  end_date date,
  brief text,
  landing_page_url text,
  tracking_link text,
  utm_source text,
  utm_campaign text,
  status text not null default 'draft'
    check (status in ('draft','active','completed','archived')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists influencer_campaigns_status_idx
  on public.influencer_campaigns (status);

drop trigger if exists influencer_campaigns_touch on public.influencer_campaigns;
create trigger influencer_campaigns_touch
  before update on public.influencer_campaigns
  for each row execute function public.touch_influencer_updated_at();

-- ============================================================
-- influencer_deals — one creator assigned to one campaign: the fixed-fee
-- agreement, unique tracking link, and post-campaign performance.
-- ============================================================
create table if not exists public.influencer_deals (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.influencer_campaigns(id) on delete cascade,
  creator_id uuid not null references public.influencer_creators(id) on delete cascade,
  -- Deal terms.
  agreed_fee numeric not null default 0,
  deliverables text,
  num_posts integer not null default 1 check (num_posts >= 0),
  usage_rights text not null default 'organic_only'
    check (usage_rights in ('organic_only','paid_ads_allowed','whitelisting_allowed')),
  usage_period text not null default '30_days'
    check (usage_period in ('30_days','90_days','unlimited')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','deposit_paid','paid')),
  payment_method text,
  -- External URL or `storage:influencer-invoices/<path>` for an uploaded file.
  invoice_url text,
  content_deadline date,
  posting_deadline date,
  -- Tracking — utm_creator is the per-creator slug; tracking_link is the
  -- full unique URL handed to the creator.
  utm_creator text,
  tracking_link text,
  -- Performance.
  posted_url text,
  final_views integer not null default 0 check (final_views >= 0),
  final_likes integer not null default 0 check (final_likes >= 0),
  final_comments integer not null default 0 check (final_comments >= 0),
  final_shares integer not null default 0 check (final_shares >= 0),
  final_saves integer not null default 0 check (final_saves >= 0),
  signups integer not null default 0 check (signups >= 0),
  cost_per_signup numeric generated always as (
    case when signups > 0 then round(agreed_fee / signups, 2) else null end
  ) stored,
  cost_per_1k_views numeric generated always as (
    case when final_views > 0 then round(agreed_fee / final_views * 1000, 2) else null end
  ) stored,
  brief_angle text,
  content_brief text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, creator_id)
);

create index if not exists influencer_deals_campaign_idx
  on public.influencer_deals (campaign_id);
create index if not exists influencer_deals_creator_idx
  on public.influencer_deals (creator_id);

drop trigger if exists influencer_deals_touch on public.influencer_deals;
create trigger influencer_deals_touch
  before update on public.influencer_deals
  for each row execute function public.touch_influencer_updated_at();

-- ============================================================
-- influencer_outreach — log of every generated/sent DM + email, with
-- follow-up reminders and response tracking.
-- ============================================================
create table if not exists public.influencer_outreach (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.influencer_creators(id) on delete cascade,
  campaign_id uuid references public.influencer_campaigns(id) on delete set null,
  channel text not null check (channel in ('tiktok_dm','instagram_dm','email')),
  message text not null default '',
  sent boolean not null default false,
  sent_at timestamptz,
  follow_up_at date,
  response_status text not null default 'none'
    check (response_status in ('none','replied','no_reply','declined')),
  response_notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists influencer_outreach_creator_idx
  on public.influencer_outreach (creator_id, created_at desc);

-- ============================================================
-- RLS — every table is admin-only. The /admin SPA reads + writes with the
-- anon key under the signed-in admin's session; is_admin() is the gate.
-- ============================================================
alter table public.influencer_creators  enable row level security;
alter table public.influencer_campaigns enable row level security;
alter table public.influencer_deals     enable row level security;
alter table public.influencer_outreach  enable row level security;

drop policy if exists "influencer_creators admin all" on public.influencer_creators;
create policy "influencer_creators admin all" on public.influencer_creators
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "influencer_campaigns admin all" on public.influencer_campaigns;
create policy "influencer_campaigns admin all" on public.influencer_campaigns
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "influencer_deals admin all" on public.influencer_deals;
create policy "influencer_deals admin all" on public.influencer_deals
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "influencer_outreach admin all" on public.influencer_outreach;
create policy "influencer_outreach admin all" on public.influencer_outreach
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- Storage — private bucket for uploaded invoices / receipts. Admin-only.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('influencer-invoices', 'influencer-invoices', false)
on conflict (id) do nothing;

drop policy if exists "influencer_invoices admin all" on storage.objects;
create policy "influencer_invoices admin all" on storage.objects
  for all to authenticated
  using (bucket_id = 'influencer-invoices' and public.is_admin())
  with check (bucket_id = 'influencer-invoices' and public.is_admin());
