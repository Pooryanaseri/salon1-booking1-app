-- Migration v2.21 — fix: stylists could not save their own working hours.
-- Idempotent, no data changes, does not modify any earlier migration.
--
-- ROOT CAUSE: working_hours, time_offs, and approved_dates never had an
-- explicit GRANT anywhere in schema.sql — they relied entirely on
-- Supabase's implicit default table privileges for anon/authenticated.
-- v2.19 already fixed this exact fragility for appointments (see that
-- migration's comments); these three tables were missed at the time.
-- On any project without Supabase's original broad default grant (e.g.
-- one that's had prior manual privilege hardening), every write —
-- including a stylist saving their own hours via the already-correct RLS
-- policy from v2.15 — fails with a bare "permission denied for table
-- working_hours", before RLS is even evaluated. Confirmed by loading the
-- real schema into a plain Postgres instance (which has no such implicit
-- default) and reproducing the exact failure as the stylist role.
--
-- The existing RLS policies (p_sched_write on working_hours/time_offs:
-- manager full access, stylist own rows only; p_sched_write on
-- approved_dates: manager only) are completely unchanged — this only adds
-- the missing base grants they depend on. anon needs SELECT on all three
-- because bootstrap() reads them for the public booking flow's
-- availability calculation, before any login.

grant select on public.working_hours to anon, authenticated;
grant insert, update, delete on public.working_hours to authenticated;

grant select on public.time_offs to anon, authenticated;
grant insert, update, delete on public.time_offs to authenticated;

grant select on public.approved_dates to anon, authenticated;
grant insert, update, delete on public.approved_dates to authenticated;
