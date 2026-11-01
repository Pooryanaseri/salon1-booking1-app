-- v2.60: a new salon can take bookings straight away.
--
-- A salon created in /admin had no working hours and no open days until the
-- daily cron ran open_booking_window() — so the booking page and quote links
-- offered no times ("برای این روز زمان خالی نیست"). Now a new salon gets
-- default hours (Sat–Thu 09:00–21:00, Friday closed; the manager changes
-- them in «ساعات کاری») and its booking window is opened at once.
-- Existing salons without hours get the same defaults. Safe to run more than once.

create or replace function public.seed_salon_hours(p_salon uuid)
returns void
language sql security definer set search_path = public as $fn$
  insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
  select 'wh-' || p_salon || '-' || d, p_salon, null, d,
         case when d = 6 then '00:00' else '09:00' end, case when d = 6 then '00:00' else '21:00' end, d = 6
    from generate_series(0, 6) d
   where not exists (select 1 from public.working_hours w where w.salon_id = p_salon and w.staff_id is null)
  on conflict do nothing;
$fn$;
revoke all on function public.seed_salon_hours(uuid) from public, anon, authenticated;

create or replace function public.provision_salon_defaults() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.loyalty_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  insert into public.customer_segment_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  insert into public.app_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  perform public.seed_salon_hours(new.id);
  perform public.open_booking_window(new.id);
  return new;
end;
$fn$;

-- backfill: salons that never got hours, and today's booking window for all
select public.seed_salon_hours(id) from public.salons;
select public.open_booking_window();
