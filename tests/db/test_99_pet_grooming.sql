-- v2.44: pet grooming salons — type, starter menu, pet profiles, size-based
-- price and duration, vaccination rule, pet SMS, isolation.
delete from public.sms_messages;
delete from public.salons where slug in ('tst-pets', 'tst-pets2');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local') on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;

-- ---- the platform admin creates a pet salon ---------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok((public.admin_create_salon('tst-pets', 'پت‌شاپ تست', '09120004444', 'zoo') ->> 'ok')::boolean is false, 'unknown type rejected');
select tst.ok((public.admin_create_salon('tst-pets', 'پت‌شاپ تست', '09120004444', 'pet') ->> 'ok')::boolean, 'pet salon created');
select tst.ok((public.admin_create_salon('tst-pets2', 'سالن', '09120005555') ->> 'ok')::boolean, 'type defaults to beauty');
select tst.ok(exists (select 1 from public.admin_list_salons() where slug = 'tst-pets' and business_type = 'pet'), 'type shown in the salon list');
reset role;

select id as pet_salon from public.salons where slug = 'tst-pets' \gset
select tst.ok((select count(*) from public.services where salon_id = :'pet_salon') = 12, 'starter dog/cat menu seeded (v2.45 menu)');
select tst.ok((select bool_and(gender in ('dog', 'cat')) from public.services where salon_id = :'pet_salon'), 'starter services are dog/cat');
select tst.ok(not exists (select 1 from public.services s join public.salons x on x.id = s.salon_id where x.slug = 'tst-pets2'), 'beauty salon gets no pet menu');
select tst.ok(public.salon_sections(:'pet_salon') = array['dog', 'cat'], 'pet sections');

-- hours, a groomer serving both, open days
delete from public.working_hours where salon_id = :'pet_salon' and staff_id is null;  -- v2.60 seeds defaults
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-pwh-' || d, :'pet_salon', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active)
values ('tst-groomer', :'pet_salon', 'آرایشگر پت', 'pet', '09120006666', true);
update public.stylists set active = true where id = 'tst-groomer';  -- inserts start unapproved (v2.35)
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false where salon_id = :'pet_salon';
select public.open_booking_window();
select id as bath from public.services where salon_id = :'pet_salon' and gender = 'dog' and category = 'bath' \gset
select id as nails from public.services where salon_id = :'pet_salon' and gender = 'dog' and category = 'nails_pet' \gset
select id as catbath from public.services where salon_id = :'pet_salon' and gender = 'cat' and category = 'bath' \gset

-- ---- public booking -----------------------------------------------------------
select tst.as_anon(:'pet_salon');
set role anon;
select tst.ok(public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 2, 600, 'علی', '09351117777', 'female', null, '{"name":"پاپی","size":"large"}') ->> 'error' = 'نوع حیوان نامعتبر است', 'beauty section refused in a pet salon');
select tst.ok(public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 2, 600, 'علی', '09351117777', 'dog') ->> 'error' = 'نام حیوان را وارد کنید', 'pet required');
select tst.ok(public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 2, 600, 'علی', '09351117777', 'dog', null, '{"name":"پاپی","size":"huge"}') ->> 'ok' = 'false', 'bad size refused');
select tst.ok(public.create_public_booking(:'catbath', 'tst-groomer', public.salon_today() + 2, 600, 'علی', '09351117777', 'dog', null, '{"name":"پاپی","size":"large"}') ->> 'error' = 'این خدمت برای این حیوان نیست', 'cat service refused for a dog');

select public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 2, 600, 'علی', '09351117777', 'dog', null,
  '{"name":" پاپی ","size":"large","breed":"گلدن","temperament":"aggressive","weight_kg":"32","notes":"به سشوار حساس است"}') as b1 \gset
select tst.ok((:'b1'::json ->> 'ok')::boolean, 'dog booked');
select tst.ok((:'b1'::json ->> 'final_price')::bigint = 1800000, 'priced for a large dog');
-- the same slot cannot be taken for a smaller dog either: 19:30 + 90 min is past closing
select tst.ok(public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 3, 1140, 'علی', '09351117777', 'dog', null, '{"name":"پاپی","size":"large"}') ->> 'error' = 'خارج از ساعات کاری است', 'large-dog duration checked against closing time');
select tst.ok(public.create_public_booking(:'bath', 'tst-groomer', public.salon_today() + 3, 1140, 'علی', '09351117777', 'dog', null, '{"name":"کوچولو","size":"small"}') ->> 'ok' = 'true', 'small dog fits (45 min)');
select tst.expect_error($$select * from public.pets$$);
reset role;

select (:'b1'::json ->> 'id') as a1 \gset
select tst.ok((select end_min - start_min from public.appointments where id = :'a1') = 90, 'large-dog duration booked');
select tst.ok((select pet_name = 'پاپی' and pet_size = 'large' and customer_gender = 'dog' and pet_id is not null from public.appointments where id = :'a1'), 'pet snapshot on the booking');
select tst.ok((select breed = 'گلدن' and temperament = 'aggressive' and weight_kg = 32 and owner_notes <> '' from public.pets where salon_id = :'pet_salon' and name = 'پاپی'), 'pet profile saved');
select tst.ok((select body from public.sms_messages where appointment_id = :'a1' and kind = 'confirmation') like 'علی عزیز، نوبت پاپی در پت‌شاپ تست ثبت شد.%', 'customer SMS names the pet');
select tst.ok((select body from public.sms_messages where appointment_id = :'a1' and kind = 'staff_new_booking') like 'نوبت جدید: پاپی (سگ، گلدن، بزرگ) — صاحب: علی%پرخاشگر%', 'groomer SMS names the pet and warns');

-- the next booking for the same pet updates its profile, keeps what was not sent
set role anon;
select tst.ok(public.create_public_booking(:'nails', 'tst-groomer', public.salon_today() + 4, 600, 'علی', '09351117777', 'dog', null, '{"name":"پاپی","size":"medium"}') ->> 'ok' = 'true', 'second booking');
reset role;
select tst.ok((select count(*) from public.pets where salon_id = :'pet_salon' and owner_phone = '09351117777' and lower(name) = 'پاپی') = 1, 'one profile per pet');
select tst.ok((select size = 'medium' and breed = 'گلدن' and temperament = 'aggressive' from public.pets where salon_id = :'pet_salon' and name = 'پاپی'), 'size refreshed, other fields kept');

-- ---- vaccination rule -------------------------------------------------------
update public.app_settings set pet_require_vaccination = true where salon_id = :'pet_salon';
set role anon;
select tst.ok(public.create_public_booking(:'catbath', 'tst-groomer', public.salon_today() + 5, 600, 'مینا', '09351118888', 'cat', null, '{"name":"ملوس","size":"small"}') ->> 'ok' = 'false', 'no vaccination date refused');
select tst.ok(public.create_public_booking(:'catbath', 'tst-groomer', public.salon_today() + 5, 600, 'مینا', '09351118888', 'cat', null,
  json_build_object('name', 'ملوس', 'size', 'small', 'vaccine_valid_until', public.salon_today() + 4)::jsonb) ->> 'ok' = 'false', 'vaccination expiring before the visit refused');
select tst.ok(public.create_public_booking(:'catbath', 'tst-groomer', public.salon_today() + 5, 600, 'مینا', '09351118888', 'cat', null,
  json_build_object('name', 'ملوس', 'size', 'small', 'vaccine_valid_until', public.salon_today() + 200)::jsonb) ->> 'final_price' = '800000', 'valid vaccination: cat booked');
reset role;
update public.app_settings set pet_require_vaccination = false where salon_id = :'pet_salon';

-- ---- reschedule keeps the size's duration --------------------------------------
set role service_role;
select public.request_booking_otp_internal('09351117777', :'pet_salon') ->> 'otp' as otp \gset
reset role;
select tst.as_anon(:'pet_salon');
set role anon;
select public.verify_booking_otp('09351117777', :'otp') ->> 'token' as tok \gset
select tst.ok(public.reschedule_my_booking_with_token(:'tok', :'a1', public.salon_today() + 6, 600) ->> 'ok' = 'true', 'pet booking rescheduled');
reset role;
select tst.ok((select end_min - start_min from public.appointments where id = :'a1') = 90, 'still the large-dog duration');

-- ---- a salon-sent link books the customer's animal at its size --------------
update public.appointments set status = 'completed' where id = :'a1';
select tst.ok((select last_visit_date from public.pets where name = 'پاپی' and salon_id = :'pet_salon') = public.salon_today() + 6, 'completed visit stamps the pet');
set role service_role;
select public.create_rebooking_token(:'pet_salon', '09351117777', :'bath', 'tst-groomer', 'manual') as rtok \gset
reset role;
set role anon;
select public.create_booking_from_rebooking_token(:'rtok', public.salon_today() + 8, 600) as rb \gset
reset role;
select tst.ok((:'rb'::json ->> 'final_price')::bigint = 700000, 'link booking priced for the pet''s current (medium) size');
select tst.ok((select pet_name = 'پاپی' and end_min - start_min = 60 from public.appointments where id = :'rb'::json ->> 'id'), 'link booking carries the pet and its duration');

-- ---- beauty salons are unchanged; pets stay inside their salon ---------------
select tst.as_anon();
set role anon;
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 9, 600, 'سارا', '09351112233', 'dog') ->> 'error' = 'جنسیت نامعتبر است', 'pet section refused in a beauty salon');
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 9, 600, 'سارا', '09351112233', 'female') ->> 'ok' = 'true', 'beauty booking still works without a pet');
reset role;
select tst.expect_error(format($$insert into public.appointments (id, salon_id, customer_name, customer_phone, customer_gender, service_id, date, start_min, end_min, status, tracking_code, pet_id)
  values ('tst-xpet', '00000000-0000-0000-0000-000000000001', 'x', '09351110000', 'female', 'tsvc', current_date + 20, 600, 660, 'confirmed', 'XPET1', '%s')$$,
  (select id from public.pets where name = 'پاپی' and salon_id = :'pet_salon')), 'pet does not belong');
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(not exists (select 1 from public.pets), 'another salon''s manager sees no pets');
reset role;

-- ---- switching type ---------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(public.admin_update_salon(:'pet_salon', p_business_type => 'beauty') ->> 'ok' = 'false', 'salon with bookings keeps its type');
select tst.ok(public.admin_update_salon((select id from public.salons where slug = 'tst-pets2'), p_business_type => 'pet') ->> 'ok' = 'true', 'unused salon switches type');
reset role;
select tst.ok((select count(*) from public.services s join public.salons x on x.id = s.salon_id where x.slug = 'tst-pets2' and s.gender in ('dog', 'cat')) = 12, 'switch seeds the pet menu');

-- ---- service_at_size --------------------------------------------------------
select tst.ok((select (public.service_at_size(s, 'giant')).duration_minutes = 90 and (public.service_at_size(s, null)).price = 1800000
                 and (public.service_at_size(s, 'small')).price = 500000 and (public.service_at_size(s, 'small')).duration_minutes = 45
               from public.services s where id = :'bath'), 'size tiers and fallback');
select tst.ok((select (public.service_at_size(s, 'giant')).price = s.price from public.services s where id = :'nails'), 'no tier: base price');

delete from public.salons where slug in ('tst-pets', 'tst-pets2');
