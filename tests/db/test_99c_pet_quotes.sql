-- v2.46: price quotes — request, answer, book at the quoted price, dashboard.
delete from public.salons where slug = 'tst-quotes';
delete from public.sms_messages;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000a9', '09120009999@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-quotes', 'گرومینگ استعلام', '09120009999', 'pet');
reset role;
select id as qs from public.salons where slug = 'tst-quotes' \gset
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000a9';
insert into public.users (id, salon_id, phone, full_name, role) values ('aaaaaaaa-0000-0000-0000-0000000000a9', :'qs', '09120009999', 'مدیر گرومینگ', 'manager');
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-qwh-' || d, :'qs', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-groomer-q', :'qs', 'گرومر', 'pet', '09120005551', true);
update public.stylists set active = true where id = 'tst-groomer-q';
update public.app_settings set auto_confirm_bookings = true where salon_id = :'qs';
select public.open_booking_window();
select tst.ok((select pet_quote_mode from public.app_settings where salon_id = :'qs') = 'all', 'quotes on by default');
select id as full_groom from public.services where salon_id = :'qs' and name = 'اصلاح کامل + حمام' \gset
select id as nails from public.services where salon_id = :'qs' and gender = 'dog' and category = 'nails_pet' \gset
select id as catbath from public.services where salon_id = :'qs' and gender = 'cat' and category = 'bath' \gset
select id as detangle from public.services where salon_id = :'qs' and gender = 'dog' and is_addon \gset

-- ---- customer request -----------------------------------------------------
select tst.as_anon();
set role anon;
select tst.ok(public.request_quote('سارا', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array['tsvc']) ->> 'error' = 'این سالن استعلام قیمت ندارد', 'beauty salon: no quotes');
reset role;
select tst.as_anon(:'qs');
set role anon;
select tst.ok(public.request_quote('سارا', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', '{}') ->> 'ok' = 'false', 'needs a service');
select tst.ok(public.request_quote('سارا', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'catbath']) ->> 'ok' = 'false', 'cat service for a dog refused');
select tst.ok(public.request_quote('سارا', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'detangle']) ->> 'ok' = 'false', 'add-on not requestable');
select tst.ok(public.request_quote('سارا', '09351114401', 'dog', '{"size":"medium"}', array[:'full_groom']) ->> 'ok' = 'false', 'pet name required');
select public.request_quote('سارا', '09351114401', 'dog', '{"name":"پاپی","size":"medium","breed":"شیتزو","temperament":"nervous"}',
  array[:'full_groom', :'nails'], 'موهایش گره زیادی دارد', 'پنجشنبه صبح') as q1 \gset
select tst.ok((:'q1'::json ->> 'ok')::boolean, 'quote requested');
select tst.expect_error($$select * from public.quote_requests$$);
reset role;
select (:'q1'::json ->> 'id') as q1id \gset
select tst.ok((select status = 'pending' and services_label like '%اصلاح کامل + حمام%' and services_label like '%کوتاهی ناخن%' and pet_id is not null
                 from public.quote_requests where id = :'q1id'), 'stored with label and pet');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351114401' and kind = 'quote_request'), 'customer told');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09120009999' and kind = 'quote_request' and body like 'درخواست قیمت جدید: پاپی%'), 'manager told');

-- ---- staff answer ---------------------------------------------------------
set role anon;
select tst.expect_error(format($$select public.send_quote(%L, 2000000, 150)$$, :'q1id'), 'permission denied');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a9', '09120009999@salon.local', :'qs');
select tst.ok((select count(*) from public.quote_requests) = 1, 'manager sees the request');
select tst.ok(public.send_quote(:'q1id', 500, 150) ->> 'ok' = 'false', 'price required');
select tst.ok(public.send_quote(:'q1id', 2200000, 1000) ->> 'ok' = 'false', 'duration bounded');
select public.send_quote(:'q1id', 2200000, 150, 'tst-groomer-q', 'شامل گره‌زدایی') as s1 \gset
reset role;
select tst.ok((:'s1'::json ->> 'ok')::boolean, 'quote sent');
select split_part(:'s1'::json ->> 'link', 'token=', 2) as tok1 \gset
select tst.ok((select body from public.sms_messages where to_phone = '09351114401' and kind = 'quote' order by created_at desc limit 1)
              like 'سارا عزیز، قیمت %برای پاپی در گرومینگ استعلام: ۲,۲۰۰,۰۰۰ تومان (حدود ۱۵۰ دقیقه).%/book?token=%', 'quote SMS with price and link');

-- ---- booking through the link ----------------------------------------------
set role anon;
select public.resolve_rebooking_token(:'tok1') as rv \gset
select tst.ok((:'rv'::json ->> 'is_quote')::boolean and (:'rv'::json ->> 'price')::bigint = 2200000 and (:'rv'::json ->> 'duration')::int = 150
              and :'rv'::json ->> 'pet_name' = 'پاپی', 'link resolves to the quote');
select tst.ok((select count(*) from public.get_available_slots_for_rebooking(:'tok1', public.salon_today() + 2)) = 18, 'half-hour slots fitting 150 min (09:00–17:30)');
select public.create_booking_from_rebooking_token(:'tok1', public.salon_today() + 2, 600) as b1 \gset
select tst.ok((:'b1'::json ->> 'final_price')::bigint = 2200000, 'booked at the quoted price');
select tst.ok(public.create_booking_from_rebooking_token(:'tok1', public.salon_today() + 3, 600) ->> 'ok' = 'false', 'link used once');
reset role;
select tst.ok((select end_min - start_min = 150 and quote_id = :'q1id' and services_label like '%کوتاهی ناخن%' and pet_name = 'پاپی' and staff_id = 'tst-groomer-q'
                 from public.appointments where id = :'b1'::json ->> 'id'), 'appointment carries quote, label, pet, groomer');
select tst.ok((select status = 'booked' and appointment_id = :'b1'::json ->> 'id' from public.quote_requests where id = :'q1id'), 'quote marked booked');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a9', '09120009999@salon.local', :'qs');
select tst.ok(public.send_quote(:'q1id', 1, 30) ->> 'ok' = 'false', 'booked quote is closed');
reset role;

-- ---- dashboard: list, fresh link, re-quote, cancel, decline, expiry ----------
select tst.as_anon(:'qs');
set role anon;
select public.request_quote('', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'nails']) ->> 'id' as q2id \gset
select public.request_quote('', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'nails']) ->> 'id' as q3id \gset
select public.request_quote('', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'nails']) ->> 'id' as q4id \gset
select tst.ok(public.request_quote('', '09351114401', 'dog', '{"name":"پاپی","size":"medium"}', array[:'nails']) ->> 'ok' = 'false', 'at most three open requests');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a9', '09120009999@salon.local', :'qs');
select split_part(public.send_quote(:'q2id', 300000, 30) ->> 'link', 'token=', 2) as tok2 \gset
select split_part(public.send_quote(:'q2id', 250000, 30) ->> 'link', 'token=', 2) as tok2b \gset
select tst.ok(public.decline_quote(:'q3id', 'این هفته ظرفیت نداریم') ->> 'ok' = 'true', 'declined');
reset role;
select tst.ok(exists (select 1 from public.sms_messages where kind = 'quote' and body like '%امکان پذیرش نیست.%ظرفیت نداریم'), 'decline SMS with reason');
set role anon;
select tst.ok(public.resolve_rebooking_token(:'tok2') ->> 'ok' = 'false', 're-quote replaces the old link');
select tst.ok((public.resolve_rebooking_token(:'tok2b') ->> 'price')::bigint = 250000, 'new link has the new price');
reset role;
set role service_role;
select public.request_booking_otp_internal('09351114401', :'qs') ->> 'otp' as otp \gset
reset role;
set role anon;
select public.verify_booking_otp('09351114401', :'otp') ->> 'token' as btok \gset
select public.my_quotes_with_token(:'btok') as mq \gset
select tst.ok(json_array_length(:'mq'::json) = 4, 'dashboard lists the customer''s quotes');
select tst.ok((select count(*) from json_array_elements(:'mq'::json) e where e ->> 'status' = 'declined') = 1, 'declined shown');
select public.my_quote_link(:'btok', :'q2id') ->> 'token' as tok2c \gset
select tst.ok(public.resolve_rebooking_token(:'tok2b') ->> 'ok' = 'false' and (public.resolve_rebooking_token(:'tok2c') ->> 'ok')::boolean, 'dashboard issues a fresh link');
select tst.ok(public.cancel_my_quote(:'btok', :'q4id') ->> 'ok' = 'true', 'customer cancels a request');
select tst.ok(public.my_quote_link(:'btok', :'q4id') ->> 'ok' = 'false', 'no link for a cancelled request');
reset role;
update public.quote_requests set expires_at = now() - interval '1 minute' where id = :'q2id';
set role anon;
select tst.ok(public.resolve_rebooking_token(:'tok2c') ->> 'ok' = 'false', 'expired quote link refused');
select tst.ok((select e ->> 'status' from json_array_elements(public.my_quotes_with_token(:'btok')) e where e ->> 'id' = :'q2id') = 'expired', 'expired shown');
reset role;

-- ---- isolation ---------------------------------------------------------------
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(not exists (select 1 from public.quote_requests), 'another salon sees no quotes');
select tst.ok(public.send_quote(:'q2id', 300000, 30) ->> 'ok' = 'false', 'another salon cannot answer');
reset role;

delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000a9';
delete from public.salons where slug = 'tst-quotes';
