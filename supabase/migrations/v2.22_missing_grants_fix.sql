-- Migration v2.22 — fix: stylist self-registration was completely broken,
-- and while reproducing it, a wider systemic gap was found and fixed too:
-- 13 tables across the whole schema had zero explicit grants, relying
-- entirely on Supabase's implicit default privileges. Idempotent, no data
-- changes, does not modify any earlier migration.
--
-- ROOT CAUSE: registerStylist() (src/lib/auth.js, wired up in the already
-- fully-built StylistAuthPanel UI — "ورود آرایشگر" → "ثبت‌نام") inserts a
-- row into stylists as its first step. stylists' only write policy
-- (p_mgr_write) requires is_manager(), which reads the caller's role from
-- public.users — but a person who has JUST signed up has no users row yet
-- (that row is only created in registerStylist()'s LAST step). Confirmed
-- by reproducing this exact sequence against a real Postgres instance:
-- `permission denied for table stylists`.
--
-- FIX: a narrow, additional INSERT policy for stylists, allowing a
-- self-registration row ONLY when:
--   1. the caller genuinely has no profile yet (no public.users row for
--      their auth.uid() — this can only be true once, at first
--      registration; the moment registerStylist()'s users insert
--      succeeds, this becomes permanently false for that person), and
--   2. the phone number in the row being inserted matches their own
--      authenticated identity (the local part of auth.email(), which is
--      always `${phone}@<domain>` for this app's synthetic-email auth
--      model — see phoneToEmail() in src/lib/supabase.js), so nobody can
--      use this carve-out to insert a stylist profile for a phone number
--      other than the one they just verified ownership of via Supabase
--      Auth signup.
-- This is purely additive to the existing p_mgr_write policy (RLS
-- policies for the same command are OR'd together) — managers keep their
-- full existing stylists access unchanged.

drop policy if exists p_stylists_selfreg on public.stylists;
create policy p_stylists_selfreg on public.stylists for insert
  with check (
    not exists (select 1 from public.users where id = auth.uid())
    and split_part(coalesce(auth.email(), ''), '@', 1) = phone
  );

-- ----------------------------------------------------------------------------
-- Part 2 — while reproducing the bug above, the actual failure encountered
-- first was `permission denied for table users` (users had zero explicit
-- grants at all, so even its own, already-correct RLS policies were
-- unreachable). A full audit of every table in the schema against its
-- actual grant statements found 13 tables in this same state — the same
-- class of fragility already fixed individually for appointments (v2.19)
-- and working_hours/time_offs/approved_dates (v2.21), just not caught
-- everywhere at once until now. Each grant below is derived directly from
-- that table's own existing, unchanged RLS policies (visible in
-- schema.sql) — nothing here loosens what RLS actually permits; it only
-- makes the privilege model explicit instead of depending on a platform
-- default that may not hold on every project.
-- ----------------------------------------------------------------------------

grant select on public.audit_log to authenticated;

grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.campaign_targets to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant select, insert, update, delete on public.sms_templates to authenticated;

grant select on public.loyalty_ledger to authenticated;
grant select, insert on public.sms_messages to authenticated;

grant select on public.loyalty_settings to anon, authenticated;
grant insert, update, delete on public.loyalty_settings to authenticated;

grant select on public.services to anon, authenticated;
grant insert, update, delete on public.services to authenticated;

grant select on public.stylists to anon, authenticated;
grant insert, update, delete on public.stylists to authenticated;

grant select, insert, update, delete on public.users to authenticated;

grant select, insert on public.waitlist to anon, authenticated;
grant delete on public.waitlist to authenticated;
