-- ============================================================================
-- Migration v2.25 — Autopilot 2.0: post-service lifecycle + weekly
-- reconciliation (part 1 of 3: status lifecycle, feedback RLS + trigger)
-- ============================================================================
-- Adds two new appointment statuses:
--   pending_verification — set automatically once appointment_time +
--     duration has elapsed for a confirmed/rescheduled booking (part 2's
--     scheduled function). Not yet confirmed as attended.
--   archived_unconfirmed — a pending_verification booking nobody ever
--     resolved (neither the customer via feedback nor the owner via
--     reconciliation) within 7 days. Terminal, and — critically — NEVER
--     awards loyalty/referral points or counts as revenue (see part 2's
--     archive function and the isRevenueEligible() frontend helper).
--
-- Also folds in a real, pre-existing gap found while working on this:
-- public.feedbacks (from v2.14) and its v2.18 hardening (manager-only
-- read, get_feedback_stats()) were never actually present in schema.sql —
-- confirmed by grepping the file directly. This migration adds the
-- complete, current definition of both to schema.sql for the first time,
-- alongside the feedback-loop changes below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) sms_messages gets a 'cancelled' status (cron-reminders' new abort-
--    before-send check) and two new kinds for the weekly dispatch
--    (reconciliation_prompt, weekly_summary).
-- ----------------------------------------------------------------------------
alter table public.sms_messages drop constraint if exists sms_messages_status_check;
alter table public.sms_messages add constraint sms_messages_status_check
  check (status in ('queued','sent','failed','delivered','cancelled'));
alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check
  check (kind in ('confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom','reconciliation_prompt','weekly_summary'));

-- ----------------------------------------------------------------------------
-- 1) Status check constraint — add the two new terminal/intermediate
--    statuses. Every existing status value is untouched.
-- ----------------------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in (
    'pending','confirmed','cancelled','rescheduled','completed','no_show',
    'reschedule_proposed','pending_verification','archived_unconfirmed'
  ));

-- ----------------------------------------------------------------------------
-- 2) feedbacks — full definition (table + salon_id + all policies +
--    get_feedback_stats), consolidating v2.14 + v2.18 + this migration's
--    changes into schema.sql for the first time, plus:
--    - salon_id, derived server-side from the referenced appointment (a
--      BEFORE INSERT trigger, not a client-supplied value — can't be
--      spoofed, and works even though the public feedback page has no
--      salon/session context of its own).
--    - insert policy widened to allow pending_verification, not just
--      completed (the whole point of this feature: the customer's rating
--      IS the confirmation).
--    - an AFTER INSERT trigger that upgrades the appointment to
--      'completed' in the same transaction — which in turn fires
--      sync_customer_from_appointment exactly once, the normal way
--      (old.status = 'pending_verification', new.status = 'completed'),
--      so loyalty/referral/RFM all follow their EXISTING, already-
--      idempotent path with no special-casing needed here.
-- ----------------------------------------------------------------------------
create table if not exists public.feedbacks (
  id         text primary key default 'fb-' || substr(md5(gen_random_uuid()::text), 1, 12),
  salon_id   uuid not null references public.salons(id) on delete cascade,
  booking_id text not null unique references public.appointments(id) on delete cascade,
  rating     int not null check (rating between 1 and 5),
  tags       text[] not null default '{}',
  comment    text not null default '',
  created_at timestamptz not null default now()
);
alter table public.feedbacks add column if not exists salon_id uuid;
update public.feedbacks f set salon_id = a.salon_id
  from public.appointments a where a.id = f.booking_id and f.salon_id is null;
do $$
begin
  if exists (select 1 from public.feedbacks where salon_id is null) then
    raise exception 'feedbacks has orphaned rows with no resolvable salon_id — resolve before re-running';
  end if;
  alter table public.feedbacks alter column salon_id set not null;
exception when others then null; -- already not-null from a prior run
end $$;
create index if not exists feedbacks_created_at_idx on public.feedbacks (created_at);
create index if not exists feedbacks_salon_idx on public.feedbacks (salon_id);

alter table public.feedbacks enable row level security;

create or replace function public.set_feedback_salon_id() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  select salon_id into new.salon_id from public.appointments where id = new.booking_id;
  return new;
end;
$fn$;
drop trigger if exists trg_set_feedback_salon_id on public.feedbacks;
create trigger trg_set_feedback_salon_id
  before insert on public.feedbacks
  for each row execute function public.set_feedback_salon_id();

-- Helper for the insert policy below — RLS policy EXPRESSIONS evaluate
-- whatever tables they reference with the CALLING role's own privileges,
-- never bypassed by anything else (confirmed directly: a raw
-- `exists (select from appointments ...)` here failed with a real
-- "permission denied for table appointments", since anon correctly has no
-- direct grant on appointments — by design, since v2.19). Wrapping the
-- same lookup in a SECURITY DEFINER function makes it resolve with the
-- function owner's privileges instead, the same pattern every other
-- cross-table RLS check in this schema already relies on (is_manager(),
-- current_salon_id(), etc.) — this was simply the first policy that
-- needed it for a table the caller has no base grant on at all.
create or replace function public.appointment_status_for_feedback(p_booking_id text)
returns text
language sql stable security definer set search_path = public as $fn$
  select status from public.appointments where id = p_booking_id;
$fn$;
grant execute on function public.appointment_status_for_feedback(text) to anon, authenticated;

drop policy if exists p_feedback_insert on public.feedbacks;
create policy p_feedback_insert on public.feedbacks
  for insert
  with check (
    public.appointment_status_for_feedback(booking_id) in ('completed', 'pending_verification')
  );

drop policy if exists p_feedback_read on public.feedbacks;
create policy p_feedback_read on public.feedbacks for select
  using (public.is_manager() and salon_id = public.current_salon_id());

grant select, insert on public.feedbacks to anon, authenticated;

create or replace function public.upgrade_appointment_on_feedback() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  update public.appointments
     set status = 'completed'
   where id = new.booking_id and status = 'pending_verification';
  return new;
end;
$fn$;
drop trigger if exists trg_upgrade_appointment_on_feedback on public.feedbacks;
create trigger trg_upgrade_appointment_on_feedback
  after insert on public.feedbacks
  for each row execute function public.upgrade_appointment_on_feedback();

create or replace function public.get_feedback_stats()
returns table (
  total_count bigint, avg_rating numeric,
  rating_1 bigint, rating_2 bigint, rating_3 bigint, rating_4 bigint, rating_5 bigint
)
language sql stable security definer set search_path = public as $fn$
  select
    count(*)::bigint as total_count,
    round(avg(rating)::numeric, 2) as avg_rating,
    count(*) filter (where rating = 1)::bigint as rating_1,
    count(*) filter (where rating = 2)::bigint as rating_2,
    count(*) filter (where rating = 3)::bigint as rating_3,
    count(*) filter (where rating = 4)::bigint as rating_4,
    count(*) filter (where rating = 5)::bigint as rating_5
  from public.feedbacks
  where public.is_manager() and salon_id = public.current_salon_id();
$fn$;
grant execute on function public.get_feedback_stats() to authenticated;

-- ----------------------------------------------------------------------------
-- 3) report_appointment_no_show — the OTHER half of the feedback-page
--    interaction ("client indicates non-attendance"). Deliberately
--    separate from the feedbacks table/RPC above: rating a visit you
--    didn't have doesn't make sense, so this skips feedbacks entirely and
--    moves the appointment straight to 'no_show'. Same bearer-token trust
--    model as feedback submission (booking_id is already an opaque,
--    unguessable-in-practice id — see v2.14's original rationale).
-- ----------------------------------------------------------------------------
create or replace function public.report_appointment_no_show(p_booking_id text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from public.appointments where id = p_booking_id;
  if v_status is null then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  if v_status <> 'pending_verification' then
    return json_build_object('ok', false, 'error', 'این نوبت قابل‌گزارش نیست');
  end if;
  update public.appointments set status = 'no_show' where id = p_booking_id;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.report_appointment_no_show(text) to anon, authenticated;
