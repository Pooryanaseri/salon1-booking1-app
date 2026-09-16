-- ============================================================================
--  Migration v2.5 — staff-proposed reschedule needs customer confirmation
--  Run AFTER schema.sql + earlier migrations. Idempotent.
--
--  Previously, when staff rescheduled a booking, the change applied
--  immediately with no customer say in it. Now: a staff-initiated reschedule
--  only PROPOSES a new time (status='reschedule_proposed', new time held in
--  pending_date/pending_start_min/pending_end_min) — the actual date/start_min
--  /end_min stay untouched until the customer confirms, rejects (cancels), or
--  picks a different time themselves from their own dashboard.
--
--  A customer's OWN self-service reschedule is unaffected — still immediate,
--  since it's their own choice already.
-- ============================================================================

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('pending','confirmed','cancelled','rescheduled','completed','no_show','reschedule_proposed'));

alter table public.appointments add column if not exists pending_date date;
alter table public.appointments add column if not exists pending_start_min integer;
alter table public.appointments add column if not exists pending_end_min integer;

alter table public.appointments drop constraint if exists appointments_pending_start_min_check;
alter table public.appointments add constraint appointments_pending_start_min_check
  check (pending_start_min is null or pending_start_min between 0 and 1440);

alter table public.appointments drop constraint if exists appointments_pending_end_min_check;
alter table public.appointments add constraint appointments_pending_end_min_check
  check (pending_end_min is null or pending_end_min between 0 and 1560);

-- No RLS change needed: p_appt_update's WITH CHECK already allows an
-- anonymous (customer) caller to set status to 'cancelled' or 'rescheduled'
-- — exactly the two outcomes a confirm/reject produces — and staff already
-- have unrestricted status access via is_manager()/my_stylist_id(). The
-- guard_anonymous_appt_update trigger's blocked-fields list doesn't include
-- pending_date/pending_start_min/pending_end_min, so customers can clear
-- them when responding.
