-- v2.60: a salon created from /admin is bookable at once (hours + open days).
delete from public.salons where slug = 'tst-new';
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local') on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-new', 'سالن تازه', '09120006661', 'pet');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as h from public.salons where slug = 'tst-new' \gset
select tst.ok((select count(*) from public.working_hours where salon_id = :'h' and staff_id is null) = 7, 'default hours for every day');
select tst.ok((select is_closed from public.working_hours where salon_id = :'h' and staff_id is null and day_of_week = 6), 'Friday closed');
select tst.ok((select count(*) from public.approved_dates where salon_id = :'h' and date >= public.salon_today())
              = (select booking_window_days from public.app_settings where salon_id = :'h'), 'booking window opened without cron');
-- hours the manager already set are never overwritten
update public.working_hours set start_time = '10:00' where salon_id = :'h' and staff_id is null and day_of_week = 0;
select public.seed_salon_hours(:'h');
select tst.ok((select start_time from public.working_hours where salon_id = :'h' and staff_id is null and day_of_week = 0) = '10:00', 'existing hours kept');
delete from public.salons where slug = 'tst-new';
