-- ============================================================================
-- Migration v2.28 — Hands-off automation
-- ============================================================================
-- Goal: stylists and the salon manager should only need the app for things
-- that genuinely need a person. Three pieces, each switchable per salon in
-- app_settings (all ON by default):
--
--   1. auto_confirm_bookings — a booking that already passed every server
--      check in create_public_booking (working hours, closures, overlap
--      exclusion constraint) is created 'confirmed' instead of 'pending'.
--      Implemented as a BEFORE INSERT trigger so every creation path
--      (public booking, rebooking tokens) gets it without redefining each
--      RPC. Side effects that were silently broken for unconfirmed
--      bookings now just work: reminders (cron-reminders only sends for
--      confirmed/rescheduled) and the post-visit lifecycle
--      (transition_elapsed_appointments only picks up confirmed/
--      rescheduled).
--
--   2. auto_open_days + booking_window_days — instead of someone opening
--      each day by hand, open_booking_window() keeps the next N days in
--      approved_dates for every salon that has it on. Days that must stay
--      shut use the existing closures / time-off, exactly as before. The
--      existing RPCs that check approved_dates are untouched.
--      This also replaces the 'salon-roll-approved-dates' cron job, which
--      has been failing since v2.24 (it inserted without salon_id and used
--      the pre-multitenant `on conflict (date)` key).
--
--   3. staff_daily_digest / manager_daily_digest — queue_daily_digests()
--      queues ONE morning SMS per stylist with their day, and one short
--      summary per owner/manager (only when there's something to say).
--      Rows go into sms_messages as 'queued'; the existing cron-reminders
--      drain sends them, so there's no new Edge Function to deploy.
--
-- Schedule (see supabase/cron.sql):
--   select public.open_booking_window();   -- daily
--   select public.queue_daily_digests();   -- daily, before opening time
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Settings
-- ----------------------------------------------------------------------------
alter table public.app_settings add column if not exists auto_confirm_bookings boolean not null default true;
alter table public.app_settings add column if not exists auto_open_days        boolean not null default true;
alter table public.app_settings add column if not exists booking_window_days   int     not null default 30;
alter table public.app_settings add column if not exists staff_daily_digest    boolean not null default true;
alter table public.app_settings add column if not exists manager_daily_digest  boolean not null default true;

alter table public.app_settings drop constraint if exists app_settings_booking_window_days_check;
alter table public.app_settings add constraint app_settings_booking_window_days_check
  check (booking_window_days between 7 and 90);

-- ----------------------------------------------------------------------------
-- 2) Auto-confirm
-- ----------------------------------------------------------------------------
create or replace function public.auto_confirm_new_appointment()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'pending'
     and coalesce((select auto_confirm_bookings from public.app_settings where salon_id = new.salon_id), false)
  then
    new.status := 'confirmed';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_auto_confirm_new_appointment on public.appointments;
create trigger trg_auto_confirm_new_appointment
  before insert on public.appointments
  for each row execute function public.auto_confirm_new_appointment();

-- Bookings already waiting on a manual confirm, in salons that now
-- auto-confirm: confirm them too, so nothing is left stuck in the old queue.
update public.appointments a
   set status = 'confirmed'
  from public.app_settings s
 where s.salon_id = a.salon_id
   and s.auto_confirm_bookings
   and a.status = 'pending'
   and a.date >= current_date;

-- ----------------------------------------------------------------------------
-- 3) Rolling booking window
-- ----------------------------------------------------------------------------
create or replace function public.open_booking_window(p_salon_id uuid default null)
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_added int;
begin
  insert into public.approved_dates (salon_id, date)
  select s.salon_id, (current_date + g.i)::date
    from public.app_settings s
    join public.salons sa on sa.id = s.salon_id and sa.active
    cross join lateral generate_series(0, s.booking_window_days - 1) as g(i)
   where s.auto_open_days
     and (p_salon_id is null or s.salon_id = p_salon_id)
  on conflict (salon_id, date) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end;
$fn$;
-- Scheduler-only for the all-salons form; a manager may (re)open their own
-- salon's window right after changing the setting — see the wrapper below.
revoke all on function public.open_booking_window(uuid) from public, anon, authenticated;

create or replace function public.open_my_booking_window()
returns int
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then
    raise exception 'forbidden';
  end if;
  return public.open_booking_window(public.current_salon_id());
end;
$fn$;
grant execute on function public.open_my_booking_window() to authenticated;

-- Open the window once now, so turning this migration on doesn't wait a day.
select public.open_booking_window();

-- ----------------------------------------------------------------------------
-- 4) Morning digests
-- ----------------------------------------------------------------------------
alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check
  check (kind in (
    'confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom',
    'reconciliation_prompt','weekly_summary','predictive_rebooking',
    'reschedule_proposed','feedback_request','feedback_followup','staff_new_booking',
    'daily_digest'
  ));

create or replace function public.fa_digits(p text) returns text
language sql immutable as $$ select translate(p, '0123456789', '۰۱۲۳۴۵۶۷۸۹') $$;

create or replace function public.fa_clock(p_min int) returns text
language sql immutable as $$
  select public.fa_digits(lpad((p_min / 60)::text, 2, '0') || ':' || lpad((p_min % 60)::text, 2, '0'))
$$;

create or replace function public.queue_daily_digests(p_date date default current_date)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_set record; v_st record; v_mgr record;
  v_lines text; v_count int; v_body text;
  v_total int; v_unassigned int; v_pending int; v_waitlist int;
  v_staff_sent int := 0; v_mgr_sent int := 0;
  c_max_lines constant int := 8; -- keeps the SMS to a couple of parts at most
begin
  for v_set in
    select s.*, sa.name as salon_name
      from public.app_settings s
      join public.salons sa on sa.id = s.salon_id and sa.active
     where s.staff_daily_digest or s.manager_daily_digest
  loop
    -- One SMS per stylist who has bookings today. No bookings = no SMS.
    if v_set.staff_daily_digest then
      for v_st in
        select st.id, st.name, st.phone
          from public.stylists st
         where st.salon_id = v_set.salon_id and st.active and st.phone ~ '^09[0-9]{9}$'
      loop
        select count(*),
               string_agg(public.fa_clock(x.start_min) || ' ' || x.customer_name || ' — ' || x.service_name, E'\n' order by x.start_min)
                 filter (where x.rn <= c_max_lines)
          into v_count, v_lines
          from (
            select a.start_min, a.customer_name, coalesce(sv.name, 'خدمت') as service_name,
                   row_number() over (order by a.start_min) as rn
              from public.appointments a
              left join public.services sv on sv.id = a.service_id and sv.salon_id = a.salon_id
             where a.salon_id = v_set.salon_id and a.staff_id = v_st.id and a.date = p_date
               and a.status in ('confirmed', 'rescheduled', 'pending')
          ) x;

        continue when coalesce(v_count, 0) = 0;
        -- Never queue the same digest twice for the same day (re-runs are safe).
        continue when exists (
          select 1 from public.sms_messages m
           where m.salon_id = v_set.salon_id and m.kind = 'daily_digest'
             and m.to_phone = v_st.phone and m.created_at::date = current_date
        );

        v_body := 'برنامهٔ امروز شما (' || public.fa_digits(v_count::text) || ' نوبت):' || E'\n' || v_lines
               || case when v_count > c_max_lines
                       then E'\n' || 'و ' || public.fa_digits((v_count - c_max_lines)::text) || ' نوبت دیگر'
                       else '' end;
        insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
        values (v_set.salon_id, v_st.phone, v_body, 'daily_digest', 'queued', now());
        v_staff_sent := v_staff_sent + 1;
      end loop;
    end if;

    -- One short summary per owner/manager — only the numbers that matter
    -- and only what actually needs a person. Nothing to report = no SMS.
    if v_set.manager_daily_digest then
      select count(*) filter (where status in ('confirmed', 'rescheduled', 'pending')),
             count(*) filter (where status in ('confirmed', 'rescheduled', 'pending') and staff_id is null),
             count(*) filter (where status = 'pending')
        into v_total, v_unassigned, v_pending
        from public.appointments
       where salon_id = v_set.salon_id and date = p_date;
      select count(*) into v_waitlist from public.waitlist where salon_id = v_set.salon_id and date = p_date;

      if v_total > 0 or v_pending > 0 then
        v_body := v_set.salon_name || ' — امروز ' || public.fa_digits(v_total::text) || ' نوبت.'
          || case when v_unassigned > 0 then E'\n' || '⚠ ' || public.fa_digits(v_unassigned::text) || ' نوبت بدون آرایشگر' else '' end
          || case when v_pending > 0 then E'\n' || '⚠ ' || public.fa_digits(v_pending::text) || ' نوبت منتظر تایید شما' else '' end
          || case when v_waitlist > 0 then E'\n' || public.fa_digits(v_waitlist::text) || ' نفر در لیست انتظار امروز' else '' end;

        for v_mgr in
          select u.phone from public.users u
           where u.salon_id = v_set.salon_id and u.active and u.role in ('owner', 'manager')
             and u.phone ~ '^09[0-9]{9}$'
        loop
          continue when exists (
            select 1 from public.sms_messages m
             where m.salon_id = v_set.salon_id and m.kind = 'daily_digest'
               and m.to_phone = v_mgr.phone and m.created_at::date = current_date
          );
          insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
          values (v_set.salon_id, v_mgr.phone, v_body, 'daily_digest', 'queued', now());
          v_mgr_sent := v_mgr_sent + 1;
        end loop;
      end if;
    end if;
  end loop;

  return json_build_object('ok', true, 'staff', v_staff_sent, 'managers', v_mgr_sent);
end;
$fn$;
revoke all on function public.queue_daily_digests(date) from public, anon, authenticated;
