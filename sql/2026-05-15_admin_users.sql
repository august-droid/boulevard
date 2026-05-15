-- Admin-panel access control. Replaces the single shared DASHBOARD_ADMIN_TOKEN
-- with a per-user model backed by Supabase Auth (email/password + Google).
--
-- A row in admin_users grants access to /admin. invited_by tracks who added
-- whom; user_id is filled in the first time the invitee signs in (matched by
-- email) so we can invite people before they have created an auth account.
--
-- Bootstrap: the first admin can be seeded via the BOOTSTRAP_ADMIN_EMAILS
-- env var on the functions side — any signed-in Supabase user whose email is
-- in that list is treated as an admin and gets an admin_users row created on
-- first request. After that, the email allowlist runs the show.
--
-- Idempotent: handles both a fresh database and the legacy admin_users that
-- only had (user_id pk, added_at, note).

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  user_id uuid references auth.users(id) on delete set null,
  role text not null default 'admin',
  invited_by uuid references auth.users(id) on delete set null,
  invited_by_email text,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  last_seen_at timestamptz
);

-- Migrate the legacy schema if present (was: user_id pk, added_at, note).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.admin_users'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id)'
  ) then
    alter table public.admin_users drop constraint admin_users_pkey;
  end if;
end $$;

alter table public.admin_users add column if not exists id uuid default gen_random_uuid();
update public.admin_users set id = gen_random_uuid() where id is null;
alter table public.admin_users alter column id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.admin_users'::regclass and contype = 'p'
  ) then
    alter table public.admin_users add primary key (id);
  end if;
end $$;

alter table public.admin_users alter column user_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.admin_users'::regclass
      and conname = 'admin_users_user_id_fkey'
  ) then
    alter table public.admin_users
      add constraint admin_users_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
end $$;

alter table public.admin_users add column if not exists email text;
alter table public.admin_users add column if not exists role text not null default 'admin';
alter table public.admin_users add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.admin_users add column if not exists invited_by_email text;
alter table public.admin_users add column if not exists invited_at timestamptz not null default now();
alter table public.admin_users add column if not exists accepted_at timestamptz;
alter table public.admin_users add column if not exists last_seen_at timestamptz;
alter table public.admin_users alter column email set not null;

alter table public.admin_users drop column if exists added_at;
alter table public.admin_users drop column if exists note;

create unique index if not exists admin_users_email_key
  on public.admin_users (lower(email));
create index if not exists admin_users_user_id_idx
  on public.admin_users (user_id);

alter table public.admin_users enable row level security;

-- Public read so the mobile app's isAdmin() check still works under anon-key
-- (it does a select user_id where user_id = $1). The dashboard functions use
-- the service-role key, which bypasses RLS, so they're unaffected.
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.admin_users'::regclass
      and polname = 'admin_users public read'
  ) then
    create policy "admin_users public read" on public.admin_users
      for select using (true);
  end if;
end $$;
