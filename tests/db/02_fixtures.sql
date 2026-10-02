-- Shared fixtures (run as the database owner after all migrations).
-- Salon S1 = the default salon created by the v2.24 migration.
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', '09125550000@salon.local') on conflict do nothing;
insert into public.users (id, salon_id, phone, full_name, role)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', '09125550000', 'مدیر تست', 'owner')
on conflict (id) do nothing;

insert into public.stylists (id, salon_id, name, gender, phone, active)
values ('tst1', '00000000-0000-0000-0000-000000000001', 'مهسا تست', 'female', '09121110000', true)
on conflict (id) do update set phone = excluded.phone, active = true;
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tsvc', '00000000-0000-0000-0000-000000000001', 'رنگ ریشه تست', 'female', 'color', 60, 450000, true)
on conflict (id) do update set price = 450000, is_active = true;

delete from public.working_hours where salon_id = '00000000-0000-0000-0000-000000000001';
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-wh-' || d, '00000000-0000-0000-0000-000000000001', null, d, '09:00', '20:00', false from generate_series(0, 6) d;

update public.app_settings set
  auto_confirm_bookings = true, auto_open_days = true, booking_window_days = 30,
  staff_daily_digest = true, manager_daily_digest = true,
  waitlist_auto_offer = true, attendance_confirmation = true,
  deposit_percent = 0, deposit_min_price = 0
where salon_id = '00000000-0000-0000-0000-000000000001';
select public.open_booking_window();
