-- ============================================================================
-- Migration v2.39 — reminder timing in the SMS panel (run after v2.38)
-- ============================================================================
-- The "how many hours before the visit" setting for the customer reminder
-- lived only per stylist (stylist edit form). Managers now set it once for
-- the salon in Panel → پیامک, including "off":
--   * app_settings.reminder_hours_before (0 = no reminders);
--   * set_reminder_hours(h) — manager only — saves it, applies it to every
--     stylist of the salon, and moves reminders that are already queued for
--     upcoming bookings to the new time (or drops them when turned off);
--   * requeue_reminder() and the cron-reminders sweep honour "off".
-- A stylist can still adjust their own value afterwards; the salon setting
-- is the default and the off switch.
-- ============================================================================

alter table public.app_settings add column if not exists reminder_hours_before int not null default 3;
alter table public.app_settings drop constraint if exists app_settings_reminder_hours_check;
alter table public.app_settings add constraint app_settings_reminder_hours_check
  check (reminder_hours_before between 0 and 72);

-- Start from what the salon effectively used so far (its stylists' most
-- common value), so upgrading changes nothing by itself.
update public.app_settings s
   set reminder_hours_before = sub.h
  from (
    select salon_id, mode() within group (order by reminder_hours_before) as h
      from public.stylists group by salon_id
  ) sub
 where sub.salon_id = s.salon_id and sub.h between 0 and 72;

create or replace function public.requeue_reminder(p_appt public.appointments)
returns void
language plpgsql security definer set search_path = public as $fn$
declare v_hours int; v_salon_hours int; v_send_at timestamptz;
begin
  update public.sms_messages
     set status = 'cancelled', error = 'superseded: booking changed'
   where appointment_id = p_appt.id and kind = 'reminder' and status = 'queued';

  if p_appt.status not in ('confirmed', 'rescheduled') or p_appt.customer_phone !~ '^09[0-9]{9}$' then
    return;
  end if;

  select reminder_hours_before into v_salon_hours from public.app_settings where salon_id = p_appt.salon_id;
  if coalesce(v_salon_hours, 3) = 0 then
    return; -- reminders turned off for this salon
  end if;
  select reminder_hours_before into v_hours from public.stylists where id = p_appt.staff_id and salon_id = p_appt.salon_id;
  v_hours := coalesce(nullif(v_hours, 0), v_salon_hours, 3);

  v_send_at := ((p_appt.date + make_interval(mins => p_appt.start_min))
                 at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))
               - make_interval(hours => v_hours);
  if v_send_at <= now() then
    return; -- window already open: the cron-reminders sweep covers it
  end if;

  insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
  values (p_appt.salon_id, p_appt.customer_phone, public.booking_sms_text(p_appt, 'reminder'),
          'reminder', p_appt.id, 'queued', v_send_at);
end;
$fn$;
revoke all on function public.requeue_reminder(public.appointments) from public, anon, authenticated;

create or replace function public.set_reminder_hours(p_hours int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_appt public.appointments; v_moved int := 0;
begin
  if not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_hours is null or p_hours < 0 or p_hours > 72 then
    return json_build_object('ok', false, 'error', 'مقدار نامعتبر است');
  end if;

  update public.app_settings set reminder_hours_before = p_hours where salon_id = v_salon;
  if p_hours > 0 then
    update public.stylists set reminder_hours_before = p_hours where salon_id = v_salon;
  end if;

  -- Re-time every upcoming booking's reminder (requeue_reminder drops the
  -- queued one and queues the new time — or nothing when turned off).
  for v_appt in
    select a.* from public.appointments a
     where a.salon_id = v_salon and a.status in ('confirmed', 'rescheduled')
       and a.date >= public.salon_today()
  loop
    perform public.requeue_reminder(v_appt);
    v_moved := v_moved + 1;
  end loop;

  return json_build_object('ok', true, 'hours', p_hours, 'requeued', v_moved);
end;
$fn$;
grant execute on function public.set_reminder_hours(int) to authenticated;
