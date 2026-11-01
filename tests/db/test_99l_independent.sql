-- v2.55: independent stylists — product commission, own prices, private clients.
delete from public.salons where slug = 'tst-ind';
delete from public.sms_messages;
delete from public.rate_limit_events;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', '09120008881@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', '09120008882@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000d3', '09120008883@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-ind', 'سالن مستقل', '09120008881', 'beauty');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as h from public.salons where slug = 'tst-ind' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-0000000000d3');
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tst-ind-cut', :'h', 'کوتاهی', 'female', 'hair', 60, 1000000, true) on conflict (id) do nothing;
insert into public.stylists (id, salon_id, name, gender, phone, active) values
  ('tst-ind-a', :'h', 'آوا', 'female', '09120008882', true),
  ('tst-ind-b', :'h', 'باران', 'female', '09120008883', true);
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', :'h', '09120008881', 'مدیر', 'owner', null),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', :'h', '09120008882', 'آوا', 'stylist', 'tst-ind-a'),
  ('aaaaaaaa-0000-0000-0000-0000000000d3', :'h', '09120008883', 'باران', 'stylist', 'tst-ind-b');
select date_trunc('month', public.salon_today())::date as m \gset

-- completed visits: client 1 only with A (independent, private), client 2 with A and B, client 3 only B
insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code, original_price, final_price)
values ('tst-ind-1', :'h', 'tst-ind-cut', 'tst-ind-a', 'م۱', '09351280001', public.salon_today(), 600, 660, 'confirmed', 'IND001', 1000000, 1000000),
       ('tst-ind-2', :'h', 'tst-ind-cut', 'tst-ind-a', 'م۲', '09351280002', public.salon_today(), 700, 760, 'confirmed', 'IND002', 1000000, 1000000),
       ('tst-ind-3', :'h', 'tst-ind-cut', 'tst-ind-b', 'م۲', '09351280002', public.salon_today(), 800, 860, 'confirmed', 'IND003', 1000000, 1000000),
       ('tst-ind-4', :'h', 'tst-ind-cut', 'tst-ind-b', 'م۳', '09351280003', public.salon_today(), 600, 660, 'confirmed', 'IND004', 1000000, 1000000);
select set_config('app.trusted_rpc', 'on', false);
update public.appointments set status = 'completed' where id like 'tst-ind-%';
select set_config('app.trusted_rpc', '', false);

-- ---- orders default to the stylist of the last visit ------------------------------------
insert into public.orders (salon_id, code, customer_name, customer_phone, delivery, subtotal, total, payment_method, status)
values (:'h', 'IND-O1', 'م۱', '09351280001', 'pickup', 2000000, 2000000, 'cash', 'pending'),
       (:'h', 'IND-O2', 'م۹', '09351289999', 'pickup', 500000, 500000, 'cash', 'pending');
select tst.ok((select sold_by from public.orders where code = 'IND-O1') = 'tst-ind-a', 'order defaults to last stylist');
select tst.ok((select sold_by from public.orders where code = 'IND-O2') is null, 'unknown client → no seller');
select id as o2 from public.orders where code = 'IND-O2' \gset

set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120008882@salon.local', :'h');
select tst.ok(public.set_order_seller(:'o2', 'tst-ind-a') ->> 'ok' = 'false', 'stylist cannot set seller');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120008881@salon.local', :'h');
select tst.ok(public.set_order_seller(:'o2', 'tst-ind-a') ->> 'ok' = 'true', 'manager sets seller');
select tst.ok(public.set_order_seller(:'o2', 'nope') ->> 'ok' = 'false', 'unknown stylist rejected');

-- A: 20% share, 10% product commission, own prices, private clients
insert into public.stylist_contracts (stylist_id, kind, service_share_pct, collector, effective_from, product_commission_pct, own_prices, private_clients)
values ('tst-ind-a', 'share', 20, 'salon', :'m', 10, true, true);
select tst.expect_error($$insert into public.stylist_contracts (stylist_id, kind, service_share_pct, product_commission_pct) values ('tst-ind-b', 'share', 10, 120)$$);
select public.stylist_statement('tst-ind-a', :'m') as sa \gset
-- gross 2,000,000, share 400,000; products 2,500,000 → commission 250,000
select tst.ok((:'sa'::json ->> 'product_sales')::bigint = 2500000 and (:'sa'::json ->> 'product_commission')::bigint = 250000, 'A: product sales + commission');
select tst.ok((:'sa'::json ->> 'balance')::bigint = 2000000 - 400000 + 250000 and (:'sa'::json ->> 'stylist_net')::bigint = 1850000, 'A: commission in balance');
-- a cancelled order does not count
reset role;
update public.orders set status = 'cancelled' where id = :'o2';
set role authenticated;
select tst.ok((public.stylist_statement('tst-ind-a', :'m') ->> 'product_sales')::bigint = 2000000, 'cancelled order excluded');

-- ---- own prices ------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120008882@salon.local', :'h');
insert into public.stylist_prices (stylist_id, service_id, price) values ('tst-ind-a', 'tst-ind-cut', 1500000);
select tst.ok((select count(*) from public.stylist_prices) = 1, 'A sets her own price');
select tst.expect_error($$insert into public.stylist_prices (stylist_id, service_id, price) values ('tst-ind-b', 'tst-ind-cut', 100000)$$);
select tst.expect_error($$select public.contract_on('tst-ind-b', current_date)$$);
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d3', '09120008883@salon.local', :'h');
-- B has no contract allowing it
select tst.expect_error($$insert into public.stylist_prices (stylist_id, service_id, price) values ('tst-ind-b', 'tst-ind-cut', 900000)$$);
select tst.ok((select count(*) from public.stylist_prices) = 0, 'B cannot see A prices');
reset role;
select set_config('request.jwt.claim.sub', '', false);

set role anon;
select tst.as_anon(:'h');
select tst.ok(json_array_length(public.get_stylist_prices()) = 1
              and (public.get_stylist_prices() -> 0 ->> 'price')::bigint = 1500000, 'public price list');
reset role;

-- a fresh booking with A gets her price; one with B does not
insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code, original_price, final_price)
values ('tst-ind-5', :'h', 'tst-ind-cut', 'tst-ind-a', 'م۵', '09351280005', public.salon_today() + 1, 600, 660, 'confirmed', 'IND005', 1000000, 1000000),
       ('tst-ind-6', :'h', 'tst-ind-cut', 'tst-ind-b', 'م۶', '09351280006', public.salon_today() + 1, 600, 660, 'confirmed', 'IND006', 1000000, 1000000);
set role anon;
select tst.as_anon(:'h');
select tst.ok(public.apply_stylist_price('tst-ind-5', '09351289999') ->> 'ok' = 'false', 'wrong phone');
select tst.ok(public.apply_stylist_price('tst-ind-5', '09351280005') ->> 'ok' = 'true', 'A price applied');
select tst.ok(public.apply_stylist_price('tst-ind-5', '09351280005') ->> 'ok' = 'false', 'not applied twice');
select tst.ok(public.apply_stylist_price('tst-ind-6', '09351280006') ->> 'ok' = 'false', 'B has no own price');
reset role;
select tst.ok((select original_price = 1500000 and final_price = 1500000 from public.appointments where id = 'tst-ind-5'), 'booking repriced');
-- turning own_prices off hides the list
update public.stylist_contracts set own_prices = false where stylist_id = 'tst-ind-a';
set role anon;
select tst.as_anon(:'h');
select tst.ok(json_array_length(public.get_stylist_prices()) = 0, 'list hidden when contract stops it');
reset role;
update public.stylist_contracts set own_prices = true where stylist_id = 'tst-ind-a';

-- ---- private clients ---------------------------------------------------------------------
select tst.ok(public.is_private_client(:'h', '09351280001'), 'client 1 is A''s private client');
select tst.ok(not public.is_private_client(:'h', '09351280002'), 'shared client is not private');
select tst.ok(not public.is_private_client(:'h', '09351280003'), 'B client is not private');
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for) values
  (:'h', '09351280001', 'x', 'campaign', 'queued', now()),
  (:'h', '09351280002', 'x', 'campaign', 'queued', now()),
  (:'h', '09351280001', 'x', 'slot_offer', 'queued', now()),
  (:'h', '09351280001', 'x', 'custom', 'queued', now());
select tst.ok((select count(*) from public.sms_messages where to_phone = '09351280001' and kind in ('campaign', 'slot_offer')) = 0
              and (select count(*) from public.sms_messages where to_phone = '09351280001' and kind = 'custom') = 1
              and (select count(*) from public.sms_messages where to_phone = '09351280002' and kind = 'campaign') = 1, 'marketing to private clients skipped');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120008881@salon.local', :'h');
select tst.ok(public.private_client_phones()::jsonb = '["09351280001"]'::jsonb, 'manager sees private phones');
select tst.expect_error($$select public.is_private_client(current_salon_id(), '09351280001')$$);
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120008882@salon.local', :'h');
select tst.ok(public.private_client_phones()::jsonb = '[]'::jsonb, 'stylist gets nothing');
reset role;
select set_config('request.jwt.claim.sub', '', false);

delete from public.sms_messages;
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-0000000000d3');
delete from public.salons where slug = 'tst-ind';
