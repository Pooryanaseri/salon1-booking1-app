-- ============================================================================
--  Repair script — "ورود مدیر خطا می‌دهد" (owner/manager login fails)
--
--  ROOT CAUSE: this app logs in with phone + password, but under the hood
--  it's still Supabase Auth, which needs an email. Since there's no real
--  email, the app makes one up (phone@salon.local). If your Supabase
--  project has "Confirm email" turned ON (Authentication → Providers →
--  Email), signUp() creates the auth.users row but does NOT create an
--  active session — and without a session, the very next step (inserting
--  the matching public.users profile row, which needs auth.uid() to satisfy
--  its RLS policy) silently fails. Net result: an auth.users row exists,
--  but no public.users row — so login always fails with "account not
--  found", no matter how correct the password is.
--
--  FIX, TWO PARTS:
--  1. Turn OFF "Confirm email": Supabase Dashboard → Authentication →
--     Providers → Email → toggle "Confirm email" off. (Required — these
--     synthetic addresses can never receive a real confirmation link, so
--     this must stay off for phone-based login to work at all.)
--  2. Run STEP 2 below to create the missing profile row for an account
--     that's already stuck in this state. (If you're setting up fresh and
--     haven't tried registering yet, turning off Confirm email above is
--     enough — you can just register normally afterward.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — Diagnose: find the stuck auth user and confirm there's no
-- matching profile row. Replace the phone number if you're repairing a
-- different account.
-- ---------------------------------------------------------------------------
select
  au.id, au.email, au.email_confirmed_at,
  pu.id as profile_id, pu.role
from auth.users au
left join public.users pu on pu.id = au.id
where au.email = '09120000000@salon.local';
-- If this returns one row with a non-null `id` but a null `profile_id`,
-- that confirms the diagnosis above.

-- ---------------------------------------------------------------------------
-- STEP 2 — Repair: create the missing profile row for that same account,
-- as owner. Safe to re-run (ON CONFLICT DO NOTHING) — only creates the row
-- if it's genuinely missing.
-- ---------------------------------------------------------------------------
insert into public.users (id, phone, role, full_name, active)
select au.id, '09120000000', 'owner', 'مدیر سالن', true
from auth.users au
where au.email = '09120000000@salon.local'
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- STEP 3 (optional) — If "Confirm email" was on and the account was never
-- actually confirmed, force-confirm it directly so signInWithPassword()
-- stops rejecting it with "Email not confirmed" even before Step 1 turns
-- the setting off for future signups.
-- ---------------------------------------------------------------------------
update auth.users set email_confirmed_at = now()
where email = '09120000000@salon.local' and email_confirmed_at is null;

-- After running this, log in again with 09120000000 and your real password
-- (the one you actually registered with — this script does not change or
-- reset your password).
