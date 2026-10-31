-- v2.49: pet care — grooming status, visit report, reminders, consent,
-- transport, packages, large-dog capacity.
delete from public.salons where slug = 'tst-care';
delete from public.sms_messages;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', '09120007771@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', '09120007772@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-care', 'پت کر تست', '09120007771', 'pet');
reset role;
select id as cs from public.salons where slug = 'tst-care' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000c2');
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-cwh-' || d, :'cs', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active) values
  ('tst-care-g1', :'cs', 'گرومر یک', 'pet', '09120007772', true),
  ('tst-care-g2', :'cs', 'گرومر دو', 'pet', '09120007773', true);
update public.stylists set active = true where id in ('tst-care-g1', 'tst-care-g2');
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', :'cs', '09120007771', 'مدیر', 'manager', null),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', :'cs', '09120007772', 'گرومر یک', 'stylist', 'tst-care-g1');
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false where salon_id = :'cs';
select public.open_booking_window();
select id as nails from public.services where salon_id = :'cs' and gender = 'dog' and category = 'nails_pet' \gset

-- ---- booking with birthday + consent; public settings ------------------------
select tst.as_anon(:'cs');
set role anon;
select tst.ok(public.pet_care_settings() ->> 'consent_mode' = 'risky' and length(public.pet_care_settings() ->> 'consent_text') > 20, 'consent settings public');
select public.create_public_booking(:'nails', 'tst-care-g1', public.salon_today(), 600, 'نگار', '09351230001', 'dog', null,
  '{"name":"پشمک","size":"small","temperament":"aggressive","birth_date":"2020-03-15","consent":"true"}') as b1 \gset
select tst.ok((:'b1'::json ->> 'ok')::boolean, 'booked');
reset role;
select (:'b1'::json ->> 'id') as b1id \gset
select tst.ok((select birth_date = '2020-03-15' and consent_at is not null and consent_text like 'صحت اطلاعات%' from public.pets where salon_id = :'cs' and name = 'پشمک'), 'birthday and consent stored on the pet');

-- ---- transport ---------------------------------------------------------------
set role anon;
select tst.ok(public.request_pet_transport(:'b1id', '09351230001', 'تهران، خیابان ولیعصر، پلاک ۱۰') ->> 'error' = 'سرویس رفت‌وبرگشت فعال نیست', 'transport off by default');
reset role;
update public.app_settings set pet_transport_enabled = true, pet_transport_fee = 200000 where salon_id = :'cs';
select final_price as p0 from public.appointments where id = :'b1id' \gset
set role anon;
select tst.ok(public.request_pet_transport(:'b1id', '09350000000', 'تهران، خیابان ولیعصر، پلاک ۱۰') ->> 'ok' = 'false', 'wrong phone refused');
select tst.ok(public.request_pet_transport(:'b1id', '09351230001', 'کوتاه') ->> 'ok' = 'false', 'address required');
select tst.ok(public.request_pet_transport(:'b1id', '09351230001', 'تهران، خیابان ولیعصر، پلاک ۱۰') ->> 'ok' = 'true', 'transport added');
select tst.ok(public.request_pet_transport(:'b1id', '09351230001', 'تهران، خیابان ولیعصر، پلاک ۱۰') ->> 'ok' = 'false', 'only once');
reset role;
select tst.ok((select transport_fee = 200000 and final_price = :p0 + 200000 and extra_charges @> '[{"label":"سرویس رفت‌وبرگشت"}]' from public.appointments where id = :'b1id'), 'fee added to the price');

-- ---- grooming status ------------------------------------------------------------
set role anon;
select tst.expect_error(format($$select public.set_groom_stage(%L, 'ready')$$, :'b1id'), 'permission denied');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c2', '09120007772@salon.local', :'cs');
select tst.ok(public.set_groom_stage(:'b1id', 'washing') ->> 'ok' = 'false', 'bad stage');
select tst.ok(public.set_groom_stage(:'b1id', 'bathing') ->> 'ok' = 'true', 'bathing');
select tst.ok(public.set_groom_stage(:'b1id', 'ready') ->> 'ok' = 'true', 'ready');
select public.set_groom_stage(:'b1id', 'ready');
reset role;
select tst.ok((select count(*) from public.sms_messages where kind = 'pet_update' and to_phone = '09351230001' and body like 'پشمک آمادهٔ تحویل است%آورده می‌شود.') = 1, 'one ready SMS (with transport note)');

-- ---- visit report ----------------------------------------------------------------
insert into public.shop_settings (salon_id, enabled) values (:'cs', true);
insert into public.products (salon_id, name, price) values (:'cs', 'شامپو ضد کک', 250000);
select id as prod from public.products where salon_id = :'cs' \gset
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c2', '09120007772@salon.local', :'cs');
select public.save_visit_report(:'b1id', '{"fleas":true,"ears":true,"bogus":true,"behavior":"nervous"}',
  'کک داشت، شامپو مخصوص زدیم', array[:'cs' || '/' || :'b1id' || '/before-abcdef12.jpg', :'cs' || '/' || :'b1id' || '/after-abcdef34.jpg', 'evil/path.jpg'],
  array[:'prod']::uuid[], true) as r1 \gset
reset role;
select tst.ok((:'r1'::json ->> 'ok')::boolean and (:'r1'::json ->> 'sent')::boolean, 'report sent');
select tst.ok((select checks = '{"fleas":true,"ears":true,"behavior":"nervous"}'::jsonb and cardinality(photos) = 2 from public.pet_visit_reports where appointment_id = :'b1id'), 'only known checks and this visit''s photos kept');
select tst.ok((select temperament from public.pets where salon_id = :'cs' and name = 'پشمک') = 'nervous', 'behaviour updates the profile');
select split_part(:'r1'::json ->> 'link', 'token=', 2) as rtok \gset
select tst.ok(exists (select 1 from public.sms_messages where kind = 'pet_report' and body like 'گزارش آرایش پشمک%(با عکس قبل و بعد)%/visit?token=%'), 'report SMS');
set role anon;
select public.get_visit_report(:'rtok') as vr \gset
select tst.ok((:'vr'::json ->> 'ok')::boolean and :'vr'::json ->> 'pet_name' = 'پشمک' and json_array_length(:'vr'::json -> 'products') = 1
              and json_array_length(:'vr'::json -> 'photos') = 2, 'owner sees the report with products');
select tst.ok(public.get_visit_report('0000') ->> 'ok' = 'false', 'bad token');
select tst.expect_error($$select * from public.pet_visit_reports$$);
reset role;
-- another salon's staff cannot write a report for this visit
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(public.save_visit_report(:'b1id', '{}') ->> 'ok' = 'false', 'other salon refused');
select tst.ok(not exists (select 1 from public.pet_visit_reports), 'other salon sees no reports');
reset role;

-- ---- packages -----------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120007771@salon.local', :'cs');
insert into public.pet_packages (name, service_id, sessions, price) values ('۳ ناخن', :'nails', 3, 300000);
select id as pk from public.pet_packages where salon_id = :'cs' \gset
select public.sell_package(:'pk', '09351230001', 'نگار') ->> 'id' as pu \gset
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c2', '09120007772@salon.local', :'cs');
select tst.ok(public.use_package_session(:'pu', :'b1id') ->> 'ok' = 'true', 'the groomer redeems a session');
select tst.ok(public.use_package_session(:'pu', :'b1id') ->> 'ok' = 'false', 'once per visit');
reset role;
select tst.ok((select sessions_left from public.package_purchases where id = :'pu') = 2, 'sessions decremented');
select tst.ok((select final_price = 200000 and package_purchase_id = :'pu' from public.appointments where id = :'b1id'), 'service covered, transport still charged');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'pet_package' and body like 'بستهٔ «۳ ناخن» (۳ جلسه)%'), 'package SMS');
set role anon;
select tst.ok(json_array_length(public.get_pet_packages()) = 1, 'packages listed publicly');
reset role;
set role service_role;
select public.request_booking_otp_internal('09351230001', :'cs') ->> 'otp' as otp \gset
reset role;
set role anon;
select public.verify_booking_otp('09351230001', :'otp') ->> 'token' as btok \gset
select tst.ok((public.my_packages_with_token(:'btok') -> 0 ->> 'left')::int = 2, 'dashboard shows sessions left');
select tst.ok(json_array_length(public.my_visit_reports_with_token(:'btok')) = 1, 'dashboard shows the report');
reset role;

-- ---- capacity ------------------------------------------------------------------
update public.app_settings set pet_large_capacity = 1 where salon_id = :'cs';
select tst.as_anon(:'cs');
set role anon;
select tst.ok((public.create_public_booking(:'nails', 'tst-care-g1', public.salon_today() + 3, 600, 'الف', '09351230002', 'dog', null, '{"name":"رکس","size":"large"}') ->> 'ok')::boolean, 'first large dog');
select tst.expect_error(format($$select public.create_public_booking(%L, 'tst-care-g2', public.salon_today() + 3, 600, 'ب', '09351230003', 'dog', null, '{"name":"مکس","size":"giant"}')$$, :'nails'), 'ظرفیت سگ‌های بزرگ');
select tst.ok((public.create_public_booking(:'nails', 'tst-care-g2', public.salon_today() + 3, 600, 'ج', '09351230004', 'dog', null, '{"name":"مینی","size":"small"}') ->> 'ok')::boolean, 'small dog still fits');
select tst.ok((public.create_public_booking(:'nails', 'tst-care-g2', public.salon_today() + 3, 720, 'ب', '09351230003', 'dog', null, '{"name":"مکس","size":"giant"}') ->> 'ok')::boolean, 'large dog at another time');
reset role;

-- ---- reminders -------------------------------------------------------------------
delete from public.sms_messages where salon_id = :'cs';
update public.pets set vaccine_valid_until = public.salon_today() + 5 where salon_id = :'cs' and name = 'پشمک';
update public.pets set last_visit_date = public.salon_today() - 45, birth_date = public.salon_today() - interval '3 years' where salon_id = :'cs' and name = 'رکس';
update public.app_settings set pet_birthday_message = 'این هفته ۱۰٪ تخفیف حمام' where salon_id = :'cs';
-- رکس has a future booking → no "time to groom"; مکس has none
update public.pets set last_visit_date = public.salon_today() - 43 where salon_id = :'cs' and name = 'مینی';
update public.appointments set status = 'cancelled' where salon_id = :'cs' and customer_phone = '09351230004';
set role service_role;
select public.pet_care_reminders() as n1 \gset
select public.pet_care_reminders() as n2 \gset
reset role;
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351230001' and body like '%اعتبار واکسن پشمک%'), 'vaccine reminder');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351230004' and body like 'وقت آرایش مینی رسیده%'), 'groom-cycle reminder');
select tst.ok(not exists (select 1 from public.sms_messages where to_phone = '09351230002' and body like 'وقت آرایش%'), 'no nudge when already booked');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351230002' and body like 'تولد رکس مبارک!%۱۰٪ تخفیف%'), 'birthday with the salon offer');
select tst.ok(:n2 = 0, 'each reminder sent once');

delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000c2');
delete from public.salons where slug = 'tst-care';
