-- Adds avatar_url to user_profiles.
--
-- When a user signs in with a social provider (Google), the app captures the
-- provider's profile photo URL. Storing it here lets the comment list and the
-- comment composer show the real picture instead of the procedural gradient
-- orb. Null for users who signed up with email or have no photo — the UI
-- falls back to the avatar_seed gradient in that case.

alter table public.user_profiles
  add column if not exists avatar_url text;
