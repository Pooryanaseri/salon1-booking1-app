-- v2.52: men's / women's salon suite — product costs, audience, shop analytics,
-- client records, visit report without a pet.
delete from public.salons where slug = 'tst-bty';
delete from public.sms_messages;
delete from public.rate_limit_events;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000f1', '09120007771@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', '09120007772@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000f3', '09120007773@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-bty', 'سالن زیبایی تست', '09120007771', 'beauty');
reset role;
select id as bt from public.salons where slug = 'tst-bty' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-0000000000f3');
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-btwh-' || d, :'bt', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tst-bty-cut', :'bt', 'کوتاهی مو', 'female', 'hair', 30, 400000, true) on conflict (id) do nothing;
insert into public.stylists (id, salon_id, name, gender, phone, active) values
  ('tst-bty-s1', :'bt', 'مینا', 'female', '09120007772', true),
  ('tst-bty-s2', :'bt', 'نگار', 'female', '09120007773', true);
update public.stylists set active = true where id in ('tst-bty-s1', 'tst-bty-s2');
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', :'bt', '09120007771', 'مدیر', 'manager', null),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', :'bt', '09120007772', 'مینا', 'stylist', 'tst-bty-s1'),
  ('aaaaaaaa-0000-0000-0000-0000000000f3', :'bt', '09120007773', 'نگار', 'stylist', 'tst-bty-s2');
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false where salon_id = :'bt';
insert into public.shop_settings (salon_id, enabled) values (:'bt', true);
select public.open_booking_window();
insert into public.products (salon_id, name, category, price, stock, audience) values
  (:'bt', 'روغن ریش', 'beard', 300000, 10, 'men'),
  (:'bt', 'سرم مو', 'hair', 500000, 10, 'women');
select id as beard from public.products where salon_id = :'bt' and name = 'روغن ریش' \gset
select id as serum from public.products where salon_id = :'bt' and name = 'سرم مو' \gset
select tst.expect_error(format($$update public.products set audience = 'kids' where id = %L$$, :'beard'));

-- ---- product costs: managers only ---------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120007771@salon.local', :'bt');
insert into public.product_costs (product_id, cost_price) values (:'beard', 180000);
select tst.ok((select count(*) from public.product_costs) = 1, 'manager reads costs');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f2', '09120007772@salon.local', :'bt');
select tst.ok((select count(*) from public.product_costs) = 0, 'stylist cannot see costs');
select tst.expect_error(format($$insert into public.product_costs (product_id, cost_price) values (%L, 1)$$, :'serum'));
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---- the shop shows audience, never cost ----------------------------------------
select tst.as_anon(:'bt');
set role anon;
select tst.ok((select bool_and(p ->> 'audience' in ('men', 'women')) and bool_and(not (p::jsonb ? 'cost_price'))
                 from json_array_elements(public.get_shop() -> 'products') p), 'get_shop: audience, no cost');
select public.place_order('سارا', '09351250001', format('[{"product_id":"%s","qty":2},{"product_id":"%s","qty":1}]', :'beard', :'serum')::jsonb, 'pickup', 'cash') ->> 'ok' as placed \gset
select public.create_public_booking('tst-bty-cut', 'tst-bty-s1', public.salon_today(), 600, 'سارا رضایی', '09351250001', 'female') ->> 'id' as v1 \gset
select public.create_public_booking('tst-bty-cut', 'tst-bty-s1', public.salon_today(), 660, 'لیلا', '09351250002', 'female') ->> 'id' as v2 \gset
reset role;
select tst.ok(:'placed' = 'true', 'order placed');
update public.appointments set status = 'completed' where id in (:'v1', :'v2');

-- ---- shop analytics -----------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120007771@salon.local', :'bt');
select public.shop_analytics(public.salon_today() - 7, public.salon_today()) as sa \gset
select tst.ok((:'sa'::json ->> 'revenue')::bigint = 1100000 and (:'sa'::json ->> 'orders')::int = 1 and (:'sa'::json ->> 'items')::int = 3, 'revenue, orders, items');
select tst.ok((:'sa'::json ->> 'cogs')::bigint = 360000 and (:'sa'::json ->> 'revenue_with_cost')::bigint = 600000, 'cost of goods from known costs');
select tst.ok((:'sa'::json ->> 'visit_customers')::int = 2 and (:'sa'::json ->> 'buyers_with_visit')::int = 1, 'attach: 1 of 2 visitors bought');
select tst.ok((select count(*) from json_array_elements(:'sa'::json -> 'by_category')) = 2, 'category breakdown');
select tst.ok(public.shop_analytics(public.salon_today(), public.salon_today() - 1) ->> 'ok' = 'false', 'bad range refused');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f2', '09120007772@salon.local', :'bt');
select tst.ok(public.shop_analytics(public.salon_today() - 7, public.salon_today()) ->> 'ok' = 'false', 'stylist cannot read shop analytics');

-- ---- client records ----------------------------------------------------------------
-- مینا has served 09351250001, نگار has not
insert into public.client_records (phone, allergies, hair_type, color_formula) values ('09351250001', 'حساسیت به آمونیاک', 'فر', '7.1 + اکسیدان ۶٪');
select tst.ok((select allergies from public.client_records where phone = '09351250001') = 'حساسیت به آمونیاک', 'stylist of the client writes the record');
select tst.ok((select updated_by from public.client_records where phone = '09351250001') = 'aaaaaaaa-0000-0000-0000-0000000000f2', 'who changed it is kept');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f3', '09120007773@salon.local', :'bt');
select tst.ok((select count(*) from public.client_records) = 0, 'other stylist does not see it');
select tst.expect_error($$insert into public.client_records (phone, notes) values ('09351250002', 'x')$$);
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120007771@salon.local', :'bt');
select tst.ok((select count(*) from public.client_records) = 1, 'manager sees all records');
select tst.expect_error($$insert into public.client_records (phone) values ('123')$$);

-- ---- visit report without a pet --------------------------------------------------
select public.save_visit_report(:'v1', '{"fleas":true,"behavior":"calm"}', 'رنگ 7.1 — تا ۴۸ ساعت نشویید',
  array[:'bt' || '/' || :'v1' || '/after-abcdef12.jpg'], array[:'serum']::uuid[], true) as rep \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((:'rep'::json ->> 'ok') = 'true', 'beauty visit report saved');
select tst.ok((select checks = '{}'::jsonb and cardinality(photos) = 1 from public.pet_visit_reports where appointment_id = :'v1'), 'pet checks ignored for people');
select tst.ok((select body like 'سارا عزیز، گزارش نوبت شما در سالن زیبایی تست (با عکس قبل و بعد) و محصولات پیشنهادی%'
                 from public.sms_messages where salon_id = :'bt' and kind = 'pet_report'), 'SMS speaks to the client');

delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-0000000000f3');
delete from public.salons where slug = 'tst-bty';
