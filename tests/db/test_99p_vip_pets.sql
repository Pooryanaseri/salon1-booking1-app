-- v2.61: VIP customers (no deposit, visible label), pet details, price requests reach the salon.
delete from public.sms_messages; delete from public.payments; delete from public.rate_limit_events;
delete from public.appointments where salon_id = '00000000-0000-0000-0000-000000000001';

-- ---- VIP in a beauty salon -------------------------------------------------------
update public.app_settings set deposit_percent = 20, deposit_min_price = 0 where salon_id = '00000000-0000-0000-0000-000000000001';
insert into public.salon_payment_settings (salon_id, zarinpal_merchant_id)
values ('00000000-0000-0000-0000-000000000001', '00000000-1111-2222-3333-444444444444')
on conflict (salon_id) do update set zarinpal_merchant_id = excluded.zarinpal_merchant_id;

set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local', '00000000-0000-0000-0000-000000000001');
select tst.ok(public.set_customer_vip('09351119001', true) ->> 'ok' = 'true', 'manager marks a VIP');
select tst.ok(public.set_customer_vip('123', true) ->> 'ok' = 'false', 'bad phone refused');
select tst.ok(public.vip_phones()::jsonb = '["09351119001"]'::jsonb, 'staff see the VIP list');
reset role;
select set_config('request.jwt.claim.sub', '', false);

select tst.as_anon();
set role anon;
select tst.ok(public.is_vip_customer('09351119001') and not public.is_vip_customer('09351119002'), 'customer sees own VIP status');
select tst.expect_error($$select public.set_customer_vip('09351119002', true)$$);
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 600, 'وی‌آی‌پی', '09351119001', 'female') as v \gset
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 720, 'عادی', '09351119002', 'female') as n \gset
reset role;
select tst.ok(:'v'::json ->> 'status' <> 'awaiting_payment' and :'v'::json ->> 'deposit_amount' is null, 'VIP: no deposit');
select tst.ok(:'n'::json ->> 'status' = 'awaiting_payment', 'others still pay the deposit');
update public.app_settings set deposit_percent = 0 where salon_id = '00000000-0000-0000-0000-000000000001';
delete from public.salon_payment_settings where salon_id = '00000000-0000-0000-0000-000000000001';

-- ---- pet salon: required breed, details, request reaches owner + groomers --------
delete from public.salons where slug = 'tst-vipet';
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local') on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-vipet', 'پت وی‌آی‌پی', '09120004441', 'pet');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as ps from public.salons where slug = 'tst-vipet' \gset
insert into public.stylists (id, salon_id, name, gender, phone, active) values
  ('tst-vip-dog', :'ps', 'گرومر سگ', 'dog', '09120004442', true),
  ('tst-vip-cat', :'ps', 'گرومر گربه', 'cat', '09120004443', true);
update public.stylists set active = true where id in ('tst-vip-dog', 'tst-vip-cat');
select id as fg from public.services where salon_id = :'ps' and name = 'اصلاح کامل + حمام' \gset

select tst.as_anon(:'ps');
set role anon;
select tst.expect_error(format($$select public.request_quote('سارا', '09351119101', 'dog', '{"name":"پاپی","size":"medium"}', array[%L])$$, :'fg'));
select public.request_quote('سارا', '09351119101', 'dog',
  '{"name":"پاپی","size":"medium","breed":"پامرانین","age_months":"15","first_grooming":"true","supplies":["حوله","شامپوی ضد حساسیت"],"supplies_note":"پوستش حساس است"}',
  array[:'fg']) ->> 'ok' as q \gset
reset role;
select tst.ok(:'q' = 'true', 'quote requested');
select tst.ok((select age_months = 15 and age_set_on = current_date and first_grooming and supplies = array['حوله', 'شامپوی ضد حساسیت'] and supplies_note = 'پوستش حساس است'
                 from public.pets where salon_id = :'ps' and name = 'پاپی'), 'pet details saved');
select tst.ok((select count(*) from public.sms_messages where salon_id = :'ps' and kind = 'quote_request' and to_phone = '09120004441') = 1, 'owner texted (no account yet)');
select tst.ok((select count(*) from public.sms_messages where salon_id = :'ps' and kind = 'quote_request' and to_phone = '09120004442') = 1, 'dog groomer texted');
select tst.ok((select count(*) from public.sms_messages where salon_id = :'ps' and kind = 'quote_request' and to_phone = '09120004443') = 0, 'cat groomer not texted for a dog');
select tst.ok((select body from public.sms_messages where salon_id = :'ps' and to_phone = '09120004441') like '%نژاد: پامرانین%سن: ۱ سال و ۳ ماه%اولین آرایش%نیاز: حوله، شامپوی ضد حساسیت%', 'message carries the details');
-- a later visit keeps details that were not sent again
set role anon;
select public.request_quote('سارا', '09351119101', 'dog', '{"name":"پاپی","size":"medium","breed":"پامرانین"}', array[:'fg']) ->> 'ok' as q2 \gset
reset role;
select tst.ok((select age_months = 15 and first_grooming and cardinality(supplies) = 2 from public.pets where salon_id = :'ps' and name = 'پاپی'), 'details kept when not resent');
select tst.ok(public.pet_details_text('{"age_months":"5"}') like '%سن: ۵ ماه%', 'months under a year');

delete from public.sms_messages;
delete from public.customers where phone in ('09351119001', '09351119002');
delete from public.salons where slug = 'tst-vipet';
