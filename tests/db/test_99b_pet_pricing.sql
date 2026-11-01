-- v2.45: breed prices, aggression surcharge, add-ons, size thresholds.
delete from public.salons where slug = 'tst-pets3';
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local') on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-pets3', 'گرومینگ تست', '09120007777', 'pet');
reset role;

select id as ps from public.salons where slug = 'tst-pets3' \gset
delete from public.working_hours where salon_id = :'ps' and staff_id is null;  -- v2.60 seeds defaults
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-p3wh-' || d, :'ps', null, d, '09:00', '21:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-groomer3', :'ps', 'گرومر', 'pet', '09120008888', true);
update public.stylists set active = true where id = 'tst-groomer3';
update public.app_settings set auto_confirm_bookings = true, pet_aggressive_surcharge_percent = 30 where salon_id = :'ps';
select public.open_booking_window();
select id as bath from public.services where salon_id = :'ps' and gender = 'dog' and category = 'bath' \gset
select id as full_groom from public.services where salon_id = :'ps' and gender = 'dog' and name = 'اصلاح کامل + حمام' \gset
select id as detangle from public.services where salon_id = :'ps' and gender = 'dog' and is_addon \gset

select tst.ok(public.norm_breed('چاو چاو') = public.norm_breed('چاو‌چاو') and public.norm_breed('چاو چاو') = public.norm_breed(' چاوچاو '), 'breed names match across spacing/ZWNJ');
select tst.ok(public.norm_breed('پامرانيك') = public.norm_breed('پامرانیک'), 'Arabic ی/ک match Persian');
select tst.expect_error($$update public.app_settings set pet_size_limits = '{10,5,30}' where salon_id = (select id from public.salons where slug = 'tst-pets3')$$);

select tst.as_anon(:'ps');
set role anon;
-- aggression surcharge on top of the size price, recorded as an extra charge
select public.create_public_booking(:'bath', 'tst-groomer3', public.salon_today() + 2, 600, 'رضا', '09351119901', 'dog', null,
  '{"name":"رکس","size":"medium","temperament":"aggressive"}') as r1 \gset
select tst.ok((:'r1'::json ->> 'final_price')::bigint = 910000, 'medium bath 700,000 + 30% = 910,000');
select tst.ok((:'r1'::json -> 'extra_charges' -> 0 ->> 'amount')::bigint = 210000, 'surcharge reported');
-- calm animal: no surcharge
select tst.ok((public.create_public_booking(:'bath', 'tst-groomer3', public.salon_today() + 2, 720, 'سارا', '09351119902', 'dog', null,
  '{"name":"لوسی","size":"small","temperament":"calm"}') ->> 'final_price')::bigint = 500000, 'calm small dog: list price');
-- breed price over size; spelling variants match
select public.create_public_booking(:'full_groom', 'tst-groomer3', public.salon_today() + 3, 600, 'نیما', '09351119903', 'dog', null,
  '{"name":"خرسی","size":"large","breed":"چاوچاو"}') as r3 \gset
select tst.ok((:'r3'::json ->> 'final_price')::bigint = 3500000, 'chow chow price');
select tst.ok(public.create_public_booking(:'full_groom', 'tst-groomer3', public.salon_today() + 4, 600, 'مهسا', '09351119904', 'dog', null,
  '{"name":"پشمک","size":"small","breed":"پامرانین"}') ->> 'final_price' = '1900000', 'pomeranian price');
-- other breed: price announced in salon
select tst.ok((public.create_public_booking(:'full_groom', 'tst-groomer3', public.salon_today() + 5, 600, 'علی', '09351119905', 'dog', null,
  '{"name":"جکی","size":"medium","breed":"مخلوط"}') ->> 'final_price') is null, 'other breeds: price in salon');
-- add-ons are for staff only
select tst.ok(public.create_public_booking(:'detangle', 'tst-groomer3', public.salon_today() + 6, 600, 'علی', '09351119905', 'dog', null,
  '{"name":"جکی","size":"medium"}') ->> 'ok' = 'false', 'add-on not bookable online');
reset role;

select tst.ok((select end_min - start_min from public.appointments where id = :'r3'::json ->> 'id') = 180, 'chow chow duration');
select tst.ok((select extra_charges -> 0 ->> 'label' from public.appointments where id = :'r1'::json ->> 'id') = 'حیوان پرخاشگر', 'extra charge stored');

-- staff complete a visit with add-ons (two half hours of detangling)
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
reset role;
update public.appointments
   set status = 'completed', final_price = final_price + 700000,
       extra_charges = extra_charges || '[{"label":"گره‌زدایی × ۲","amount":700000}]'::jsonb
 where id = :'r1'::json ->> 'id';
select tst.ok((select final_price = 1610000 and jsonb_array_length(extra_charges) = 2 from public.appointments where id = :'r1'::json ->> 'id'), 'add-ons added at completion');
select tst.expect_error($$update public.appointments set extra_charges = '{}'::jsonb where salon_id = (select id from public.salons where slug = 'tst-pets3')$$);

-- a salon-sent link applies the surcharge for an aggressive pet too
set role service_role;
select public.create_rebooking_token(:'ps', '09351119901', :'bath', 'tst-groomer3', 'manual') as rtok \gset
reset role;
set role anon;
select tst.ok((public.create_booking_from_rebooking_token(:'rtok', public.salon_today() + 9, 600) ->> 'final_price')::bigint = 910000, 'link booking carries the surcharge');
reset role;

delete from public.salons where slug = 'tst-pets3';
