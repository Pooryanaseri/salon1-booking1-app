-- ============================================================================
-- Migration v2.31 — booking SMS move into the database (run after v2.30)
-- ============================================================================
-- Before: the browser of whoever made the booking sent the booking SMS
-- through the send-sms Edge Function. For an anonymous customer that meant:
--   * send-sms had to accept anonymous "send"/"schedule" calls with a
--     caller-chosen recipient AND text — an open SMS relay on the salon's
--     sender and credit (5/hour per number was the only limit);
--   * the stylist's "new booking" SMS always failed (its kind was not on
--     the anonymous allow-list);
--   * bookings made from SMS links (rebooking, waitlist, closure) got no
--     confirmation and no reminder at all — only the main form sent them;
--   * a customer moving their own booking left the old reminder queued
--     for the old time, and the cron sweep then skipped the new time
--     because "a reminder already exists".
--
-- Now two triggers on public.appointments own these messages for every
-- booking path, rendering the salon's own templates server-side:
--   AFTER INSERT  → confirmation to the customer, "new booking" to the
--                   stylist (same-day only when the morning digest is on),
--                   and the reminder (for confirmed bookings).
--   AFTER UPDATE of status/date/start_min → (re)queue the reminder when a
--                   booking becomes confirmed or moves; drop queued
--                   reminders when it's cancelled / no-show / done.
-- The Edge Function no longer accepts anonymous send/schedule at all (see
-- supabase/functions/send-sms). Messages are queued and sent by the
-- cron-reminders drain — schedule it every minute (supabase/cron.sql).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Formatting helpers (same algorithm as src/lib/format.js)
-- ----------------------------------------------------------------------------
create or replace function public.jalali_label(p_date date)
returns text
language plpgsql immutable as $fn$
declare
  g_d_m constant int[] := array[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  months constant text[] := array['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
  gy int := extract(year from p_date)::int;
  gm int := extract(month from p_date)::int;
  gd int := extract(day from p_date)::int;
  jy int; jm int; jd int; gy2 int; days int;
begin
  jy := case when gy <= 1600 then 0 else 979 end;
  gy := gy - case when gy <= 1600 then 621 else 1600 end;
  gy2 := case when gm > 2 then gy + 1 else gy end;
  days := 365 * gy + (gy2 + 3) / 4 - (gy2 + 99) / 100 + (gy2 + 399) / 400 - 80 + gd + g_d_m[gm];
  jy := jy + 33 * (days / 12053);
  days := days % 12053;
  jy := jy + 4 * (days / 1461);
  days := days % 1461;
  if days > 365 then
    jy := jy + (days - 1) / 365;
    days := (days - 1) % 365;
  end if;
  if days < 186 then
    jm := 1 + days / 31;  jd := 1 + days % 31;
  else
    jm := 7 + (days - 186) / 30;  jd := 1 + (days - 186) % 30;
  end if;
  return public.fa_digits(jd::text) || ' ' || months[jm] || ' ' || public.fa_digits(jy::text);
end;
$fn$;

create or replace function public.render_sms(p_body text, p_vars jsonb)
returns text
language plpgsql immutable as $fn$
declare v_out text := coalesce(p_body, ''); v_key text; v_val text;
begin
  for v_key, v_val in select key, value from jsonb_each_text(p_vars) loop
    v_out := replace(v_out, '{{' || v_key || '}}', coalesce(v_val, ''));
  end loop;
  -- any placeholder we don't know about renders empty, like the client did
  return regexp_replace(v_out, '\{\{\w+\}\}', '', 'g');
end;
$fn$;

-- The salon's default template for a kind, or the built-in fallback.
create or replace function public.booking_sms_text(p_appt public.appointments, p_kind text)
returns text
language plpgsql stable security definer set search_path = public as $fn$
declare v_tpl text; v_service text; v_salon text;
begin
  select body into v_tpl from public.sms_templates
   where salon_id = p_appt.salon_id and kind = p_kind and body <> ''
   order by is_default desc, created_at limit 1;
  v_tpl := coalesce(v_tpl, case p_kind
    when 'confirmation' then E'{{name}} عزیز، نوبت شما در {{salon}} ثبت شد.\nخدمت: {{service}}\nتاریخ: {{date}} ساعت {{time}}\nکد پیگیری: {{code}}'
    when 'reminder'     then E'{{name}} عزیز، یادآوری نوبت شما در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما هستیم.'
  end);
  select name into v_service from public.services where id = p_appt.service_id and salon_id = p_appt.salon_id;
  select name into v_salon from public.salons where id = p_appt.salon_id;
  return public.render_sms(v_tpl, jsonb_build_object(
    'name',    coalesce(nullif(trim(p_appt.customer_name), ''), 'مشتری'),
    'service', coalesce(v_service, 'خدمت'),
    'date',    public.jalali_label(p_appt.date),
    'time',    public.fa_clock(p_appt.start_min),
    'stylist', coalesce(nullif(p_appt.staff_name, ''), 'بدون آرایشگر مشخص'),
    'code',    coalesce(p_appt.tracking_code, ''),
    'salon',   coalesce(v_salon, 'سالن')
  ));
end;
$fn$;
revoke all on function public.booking_sms_text(public.appointments, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) Reminder queue — one place decides when (and whether) it goes out
-- ----------------------------------------------------------------------------
create or replace function public.requeue_reminder(p_appt public.appointments)
returns void
language plpgsql security definer set search_path = public as $fn$
declare v_hours int; v_send_at timestamptz;
begin
  update public.sms_messages
     set status = 'cancelled', error = 'superseded: booking changed'
   where appointment_id = p_appt.id and kind = 'reminder' and status = 'queued';

  if p_appt.status not in ('confirmed', 'rescheduled') or p_appt.customer_phone !~ '^09[0-9]{9}$' then
    return;
  end if;

  select reminder_hours_before into v_hours from public.stylists where id = p_appt.staff_id and salon_id = p_appt.salon_id;
  v_send_at := ((p_appt.date + make_interval(mins => p_appt.start_min))
                 at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))
               - make_interval(hours => coalesce(v_hours, 3));
  if v_send_at <= now() then
    return; -- window already open: the cron-reminders sweep covers it
  end if;

  insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
  values (p_appt.salon_id, p_appt.customer_phone, public.booking_sms_text(p_appt, 'reminder'),
          'reminder', p_appt.id, 'queued', v_send_at);
end;
$fn$;
revoke all on function public.requeue_reminder(public.appointments) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) Triggers
-- ----------------------------------------------------------------------------
create or replace function public.queue_new_booking_messages()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_staff_phone text; v_digest boolean; v_service text;
begin
  if new.customer_phone ~ '^09[0-9]{9}$' then
    insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
    values (new.salon_id, new.customer_phone, public.booking_sms_text(new, 'confirmation'),
            'confirmation', new.id, 'queued', now());
  end if;

  if new.staff_id is not null then
    select phone into v_staff_phone from public.stylists where id = new.staff_id and salon_id = new.salon_id;
    select staff_daily_digest into v_digest from public.app_settings where salon_id = new.salon_id;
    -- with the morning digest on, later days are covered by that day's digest
    if v_staff_phone ~ '^09[0-9]{9}$' and (not coalesce(v_digest, false) or new.date = public.salon_today()) then
      select name into v_service from public.services where id = new.service_id and salon_id = new.salon_id;
      insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
      values (new.salon_id, v_staff_phone,
              'نوبت جدید: ' || coalesce(nullif(trim(new.customer_name), ''), 'مشتری') || ' — ' || coalesce(v_service, 'خدمت')
                || E'\n' || public.jalali_label(new.date) || ' ساعت ' || public.fa_clock(new.start_min),
              'staff_new_booking', new.id, 'queued', now());
    end if;
  end if;

  perform public.requeue_reminder(new);
  return new;
end;
$fn$;

drop trigger if exists trg_queue_new_booking_messages on public.appointments;
create trigger trg_queue_new_booking_messages
  after insert on public.appointments
  for each row execute function public.queue_new_booking_messages();

create or replace function public.sync_reminder_on_change()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status in ('confirmed', 'rescheduled') then
    -- became active, or moved: schedule for the (new) time
    if old.status not in ('confirmed', 'rescheduled') or old.date <> new.date or old.start_min <> new.start_min then
      perform public.requeue_reminder(new);
    end if;
  elsif old.status in ('confirmed', 'rescheduled') then
    -- no longer active (cancelled, no-show, completed, closure, …)
    perform public.requeue_reminder(new); -- cancels the queued one, queues nothing
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_sync_reminder_on_change on public.appointments;
create trigger trg_sync_reminder_on_change
  after update of status, date, start_min on public.appointments
  for each row execute function public.sync_reminder_on_change();
