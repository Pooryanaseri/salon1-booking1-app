-- ============================================================================
-- Migration v2.30 — fixes from a review pass (run after v2.29)
-- ============================================================================
--  1. (salon_today(), the salon-local date used by v2.28/v2.29, lives in
--     v2.28.) The functions redefined below use it too.
--  2. Closures and the rolling booking window:
--     - open_booking_window() no longer (re)opens a day that has an active
--       closure;
--     - announcing a closure removes the day from approved_dates, and
--       revoking it puts the day back (when auto-open is on), so the public
--       booking page stops offering times the server will then refuse.
--  3. handle_closure_announcement() also cancels 'pending' and
--     'reschedule_proposed' bookings on the closed day (they were left in
--     place), and no longer sends a broken relative link when app.base_url
--     isn't set.
--  4. run_predictive_rebooking(): a customer with an empty name made the SMS
--     body NULL, which failed the insert and aborted the whole run; also
--     skips sending when there's no usable link.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Salon-local date
-- ----------------------------------------------------------------------------
-- salon_today() itself is defined in v2.28 (its first user); the v2.28 and
-- v2.29 automation functions already use it.

-- ----------------------------------------------------------------------------
-- 2) Closures vs. the rolling booking window
-- ----------------------------------------------------------------------------
create or replace function public.open_booking_window(p_salon_id uuid default null)
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_added int;
begin
  insert into public.approved_dates (salon_id, date)
  select s.salon_id, (public.salon_today() + g.i)::date
    from public.app_settings s
    join public.salons sa on sa.id = s.salon_id and sa.active
    cross join lateral generate_series(0, s.booking_window_days - 1) as g(i)
   where s.auto_open_days
     and (p_salon_id is null or s.salon_id = p_salon_id)
     and not exists (
       select 1 from public.salon_closures c
        where c.salon_id = s.salon_id and c.closure_date = public.salon_today() + g.i and c.is_active
     )
  on conflict (salon_id, date) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end;
$fn$;
revoke all on function public.open_booking_window(uuid) from public, anon, authenticated;

create or replace function public.sync_closure_with_open_days()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.is_active then
    delete from public.approved_dates where salon_id = new.salon_id and date = new.closure_date;
  elsif tg_op = 'UPDATE' and old.is_active then
    insert into public.approved_dates (salon_id, date)
    select new.salon_id, new.closure_date
      from public.app_settings s
     where s.salon_id = new.salon_id and s.auto_open_days
       and new.closure_date between public.salon_today() and public.salon_today() + s.booking_window_days - 1
    on conflict (salon_id, date) do nothing;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_sync_closure_with_open_days on public.salon_closures;
create trigger trg_sync_closure_with_open_days
  after insert or update of is_active on public.salon_closures
  for each row execute function public.sync_closure_with_open_days();

-- Days already closed before this migration: take them out of the window now.
delete from public.approved_dates ad
 using public.salon_closures c
 where c.salon_id = ad.salon_id and c.closure_date = ad.date and c.is_active;

-- ----------------------------------------------------------------------------
-- 3) handle_closure_announcement — same as v2.26 plus the fixes above
-- ----------------------------------------------------------------------------
create or replace function public.handle_closure_announcement(
  p_salon_id uuid, p_closure_date date, p_closure_type text, p_notes text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_appt record;
  v_affected int := 0;
  v_reason_note text;
  v_token text;
  v_body text;
  v_salon_name text;
  v_link text;
begin
  if not (public.is_manager() and p_salon_id = public.current_salon_id()) then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_closure_type not in ('holiday', 'maintenance', 'personal_leave') then
    return json_build_object('ok', false, 'error', 'نوع تعطیلی نامعتبر است');
  end if;

  insert into public.salon_closures (salon_id, closure_date, closure_type, notes, is_active)
  values (p_salon_id, p_closure_date, p_closure_type, coalesce(p_notes, ''), true)
  on conflict (salon_id, closure_date) do update
    set closure_type = excluded.closure_type, notes = excluded.notes, is_active = true;

  select name into v_salon_name from public.salons where id = p_salon_id;
  v_reason_note := case p_closure_type
    when 'holiday' then ''
    else ' (تعطیلی ناگهانی به دلیل ' || case p_closure_type when 'maintenance' then 'تعمیرات' else 'مرخصی' end || ')'
  end;

  for v_appt in
    select * from public.appointments
     where salon_id = p_salon_id and date = p_closure_date
       and status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed') -- v2.30: pending / awaiting-reply bookings were left on a closed day
  loop
    update public.appointments set status = 'cancelled_by_salon' where id = v_appt.id;
    v_affected := v_affected + 1;

    -- A single-use rebooking token (part 1) tied to this customer's own
    -- phone and service — never the raw phone/service in the SMS URL
    -- itself, only an opaque token the frontend/RPC resolve server-side.
    v_token := public.create_rebooking_token(p_salon_id, v_appt.customer_phone, v_appt.service_id, v_appt.staff_id, 'closure');

    v_link := public.public_link('/book?token=' || v_token);
    v_body := coalesce(v_salon_name, 'سالن') || ': متاسفانه نوبت شما در این تاریخ به دلیل تعطیلی لغو شد' || v_reason_note || '. '
      || case when v_link is not null then 'برای رزرو زمان جدید لمس کنید: ' || v_link
              else 'برای رزرو زمان جدید با سالن تماس بگیرید.' end;

    insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
    values (p_salon_id, v_appt.customer_phone, v_body, 'cancellation', v_appt.id, 'queued', now());
  end loop;

  return json_build_object('ok', true, 'affected_appointments', v_affected);
end;
$fn$;
grant execute on function public.handle_closure_announcement(uuid, date, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) run_predictive_rebooking — same as v2.26 plus the fixes above
-- ----------------------------------------------------------------------------
create or replace function public.run_predictive_rebooking()
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_candidate record;
  v_token text;
  v_body text;
  v_sent int := 0;
  v_link text;
begin
  for v_candidate in
    with last_visit as (
      select
        a.salon_id, a.customer_phone, a.service_id,
        max(a.date) as last_date,
        (array_agg(a.customer_name order by a.date desc))[1] as customer_name,
        (array_agg(a.staff_id order by a.date desc))[1] as staff_id
      from public.appointments a
      where a.status = 'completed'
      group by a.salon_id, a.customer_phone, a.service_id
    )
    select
      lv.salon_id, lv.customer_phone, lv.customer_name, lv.service_id, lv.staff_id,
      s.name as service_name, s.average_cycle_days, lv.last_date,
      sal.name as salon_name
    from last_visit lv
    join public.services s on s.id = lv.service_id and s.salon_id = lv.salon_id and s.is_active
    join public.salons sal on sal.id = lv.salon_id and sal.active
    where s.average_cycle_days is not null
      and current_date between
            lv.last_date + (s.average_cycle_days - 3)
        and lv.last_date + (s.average_cycle_days + 2)
      -- not already upcoming for the same service
      and not exists (
        select 1 from public.appointments up
        where up.salon_id = lv.salon_id and up.customer_phone = lv.customer_phone and up.service_id = lv.service_id
          and up.status in ('pending', 'confirmed', 'rescheduled', 'pending_verification')
          and up.date >= current_date
      )
      -- not already nudged recently for this same service
      and not exists (
        select 1 from public.rebooking_tokens rt
        where rt.salon_id = lv.salon_id and rt.customer_phone = lv.customer_phone and rt.service_id = lv.service_id
          and rt.reason = 'predictive' and rt.created_at > now() - interval '10 days'
      )
      -- respects opt-out — this is a retention/marketing nudge, not a
      -- transactional message, and the queued-message send path (unlike
      -- send-sms's direct "send" action) has no opt-out check of its own
      and not coalesce(
        (select c.sms_opt_out from public.customers c where c.salon_id = lv.salon_id and c.phone = lv.customer_phone),
        false
      )
  loop
    v_token := public.create_rebooking_token(
      v_candidate.salon_id, v_candidate.customer_phone, v_candidate.service_id, v_candidate.staff_id, 'predictive'
    );

    v_link := public.public_link('/book?token=' || v_token);
    -- v2.30: without a public address there's no usable link — skip rather
    -- than send a broken one (the token simply expires unused).
    continue when v_link is null;
    -- v2.30: nullif() on an empty name made the WHOLE body NULL, failing the
    -- insert and aborting the run for every customer after it.
    v_body := 'سلام' || coalesce(' ' || nullif(trim(v_candidate.customer_name), ''), '') || E'\n' ||
      'وقتشه برای ' || v_candidate.service_name || ' بعدی‌تون وقت بگیرید! برای حفظ ظاهرتون و رزرو زمان دلخواه، لمس کنید: ' || v_link;

    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (v_candidate.salon_id, v_candidate.customer_phone, v_body, 'predictive_rebooking', 'queued', now());

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;
