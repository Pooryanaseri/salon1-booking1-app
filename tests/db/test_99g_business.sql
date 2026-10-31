-- v2.50: revenue extras, profile, coupons, gift cards, commission,
-- online packages, smart deposit.
delete from public.salons where slug = 'tst-biz';
delete from public.sms_messages;
delete from public.rate_limit_events;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', '09120006661@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', '09120006662@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-biz', 'پت بیز', '09120006661', 'pet');
reset role;
select id as bz from public.salons where slug = 'tst-biz' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000d2');
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-bwh-' || d, :'bz', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-biz-g', :'bz', 'گرومر بیز', 'pet', '09120006662', true);
update public.stylists set active = true, commission_pct = 40, package_commission_pct = 10 where id = 'tst-biz-g';
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', :'bz', '09120006661', 'مدیر', 'manager', null),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', :'bz', '09120006662', 'گرومر', 'stylist', 'tst-biz-g');
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false where salon_id = :'bz';
select public.open_booking_window();
select id as nails from public.services where salon_id = :'bz' and gender = 'dog' and category = 'nails_pet' \gset
select price as nprice from public.services where id = :'nails' \gset

-- ---- coupons on a booking ------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120006661@salon.local', :'bz');
insert into public.coupons (code, percent, scope, max_uses) values ('YALDA20', 20, 'booking', 2);
insert into public.coupons (code, amount, scope, min_total) values ('SHOP50', 50000, 'shop', 200000);
reset role;
select tst.expect_error($$insert into public.coupons (salon_id, code, percent, amount) values ('00000000-0000-0000-0000-000000000001', 'BAD', 10, 1000)$$);
select tst.as_anon(:'bz');
set role anon;
select tst.ok(public.check_coupon('yalda20', 'booking', 100000) ->> 'discount' = '20000', 'preview is case-insensitive');
select tst.ok(public.check_coupon('YALDA20', 'shop', 100000) ->> 'ok' = 'false', 'scope respected');
select tst.ok(public.check_coupon('NOPE', 'booking', 100000) ->> 'ok' = 'false', 'unknown code');
select public.create_public_booking(:'nails', 'tst-biz-g', public.salon_today(), 600, 'سارا', '09351240001', 'dog', null, '{"name":"پاپی","size":"small"}') ->> 'id' as b1 \gset
select tst.ok(public.apply_booking_coupon(:'b1', '09351240001', 'YALDA20') ->> 'ok' = 'true', 'coupon on booking');
select tst.ok(public.apply_booking_coupon(:'b1', '09351240001', 'YALDA20') ->> 'ok' = 'false', 'once per booking');
select public.create_public_booking(:'nails', 'tst-biz-g', public.salon_today(), 660, 'سارا', '09351240001', 'dog', null, '{"name":"پاپی","size":"small"}') ->> 'id' as b1b \gset
select tst.ok(public.apply_booking_coupon(:'b1b', '09351240001', 'YALDA20') ->> 'error' = 'این کد را قبلاً استفاده کرده‌اید', 'once per customer');
reset role;
select tst.ok((select coupon_discount = round(:nprice * 0.2) and final_price = :nprice - round(:nprice * 0.2) from public.appointments where id = :'b1'), 'price reduced');

-- ---- coupons in the shop ----------------------------------------------------------
insert into public.shop_settings (salon_id, enabled) values (:'bz', true);
insert into public.products (salon_id, name, price, stock, low_stock_at) values (:'bz', 'غذای سگ', 300000, 4, 3);
select id as prod from public.products where salon_id = :'bz' \gset
set role anon;
select tst.ok(public.place_order('سارا', '09351240001', format('[{"product_id":"%s","qty":1}]', :'prod')::jsonb, 'pickup', 'cash', '', '', '', 'SHOP50') ->> 'total' = '250000', 'shop coupon');
select tst.ok(public.place_order('علی', '09351240002', format('[{"product_id":"%s","qty":1}]', :'prod')::jsonb, 'pickup', 'cash', '', '', '', 'YALDA20') ->> 'error' = 'این کد برای فروشگاه نیست', 'booking code refused in shop');
select tst.ok(public.place_order('علی', '09351240002', format('[{"product_id":"%s","qty":1}]', :'prod')::jsonb, 'pickup', 'cash') ->> 'ok' = 'true', 'no coupon still works');
reset role;

-- ---- gift cards --------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120006662@salon.local', :'bz');
select public.issue_gift_card(100000, '09351240003', 'مینا', 'نیما', 'تولدت مبارک') ->> 'code' as gcode \gset
reset role;
select tst.ok(:'gcode' ~ '^G[A-Z2-9]{8}$', 'gift code format');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351240003' and kind = 'gift_card' and body like '%کارت هدیهٔ ۱۰۰,۰۰۰ تومانی%«تولدت مبارک»%'), 'recipient SMS');
set role anon;
select tst.ok((public.gift_card_balance(lower(:'gcode')) ->> 'balance')::int = 100000, 'balance check');
reset role;
-- the groomer redeems it on b1 (final price after coupon)
select final_price as fp1 from public.appointments where id = :'b1' \gset
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120006662@salon.local', :'bz');
select public.redeem_gift_card(:'gcode', :'b1') as rd \gset
select tst.ok(public.redeem_gift_card(:'gcode', :'b1') ->> 'ok' = 'false', 'once per visit');
reset role;
select tst.ok((:'rd'::json ->> 'used')::bigint = least(100000, :fp1), 'used up to the price');
select tst.ok((select balance from public.gift_cards where code = :'gcode') = 100000 - least(100000, :fp1), 'balance reduced');
-- online purchase needs a merchant
select tst.as_anon(:'bz');
set role anon;
select tst.ok(public.create_gift_card(200000, 'نیما', '09351240004', 'مینا', '09351240005') ->> 'ok' = 'false', 'no merchant, no online gift card');
reset role;
insert into public.salon_payment_settings (salon_id, zarinpal_merchant_id) values (:'bz', 'zp-test');
set role anon;
select public.create_gift_card(200000, 'نیما', '09351240004', 'مینا', '09351240005', 'برای تو') ->> 'id' as gid \gset
select tst.expect_error($$select * from public.gift_cards$$);
reset role;
select tst.ok((select status from public.gift_cards where id = :'gid') = 'awaiting_payment', 'waits for payment');
set role service_role;
select tst.ok(public.confirm_gift_card_payment(:'gid', 'REFG') = 'confirmed' and public.confirm_gift_card_payment(:'gid', 'REFG') = 'already', 'payment activates once');
reset role;
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351240005' and kind = 'gift_card'), 'online gift card SMS');

-- ---- packages online ---------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120006661@salon.local', :'bz');
insert into public.pet_packages (name, service_id, sessions, price) values ('۳ ناخن', :'nails', 3, 300000);
reset role;
select id as pk from public.pet_packages where salon_id = :'bz' \gset
select tst.as_anon(:'bz');
set role anon;
select public.buy_package_online(:'pk', '09351240006', 'لیلا') ->> 'id' as ppid \gset
reset role;
select tst.ok((select status from public.package_purchases where id = :'ppid') = 'awaiting_payment', 'online package pending');
set role service_role;
select tst.ok(public.confirm_package_payment(:'ppid', 'REFP') = 'confirmed', 'paid package active');
reset role;
select tst.ok((select status = 'active' and payment_ref = 'REFP' from public.package_purchases where id = :'ppid'), 'activated');
-- a groomer's desk sale is credited to them
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120006662@salon.local', :'bz');
select public.sell_package(:'pk', '09351240007');
reset role;
select tst.ok((select sold_by from public.package_purchases where customer_phone = '09351240007') = 'tst-biz-g', 'seller recorded');

-- ---- commission & revenue ------------------------------------------------------------
update public.appointments set status = 'completed' where id = :'b1';
select final_price as fpc from public.appointments where id = :'b1' \gset
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d2', '09120006662@salon.local', :'bz');
select public.commission_report(public.salon_today() - 1, public.salon_today() + 1) as cr \gset
select tst.ok((:'cr'::json -> 'rows' -> 0 ->> 'services_commission')::bigint = round(:fpc * 0.4)
              and (:'cr'::json -> 'rows' -> 0 ->> 'packages_commission')::bigint = 30000, 'commission computed');
select tst.ok(public.revenue_extras(public.salon_today() - 1, public.salon_today() + 1) ->> 'ok' = 'false', 'revenue is manager-only');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120006661@salon.local', :'bz');
select public.revenue_extras(public.salon_today() - 1, public.salon_today() + 1) as rv \gset
reset role;
select tst.ok((:'rv'::json ->> 'shop_revenue')::bigint = 550000 and (:'rv'::json ->> 'packages_revenue')::bigint = 600000
              and (:'rv'::json ->> 'gift_cards_revenue')::bigint = 300000, 'revenue extras');
select tst.ok(json_array_length(:'rv'::json -> 'low_stock') = 1 and (:'rv'::json -> 'top_products' -> 0 ->> 'qty')::int = 2, 'top products and low stock');

-- ---- profile -------------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000d1', '09120006661@salon.local', :'bz');
insert into public.salon_profiles (about, address, instagram, map_url) values ('بهترین گرومینگ', 'تهران، ولیعصر', 'petbiz', 'https://maps.example/x');
select tst.expect_error($$update public.salon_profiles set map_url = 'javascript:alert(1)'$$);
reset role;
insert into public.feedbacks (salon_id, booking_id, rating, comment) values (:'bz', :'b1', 5, 'خیلی عالی و تمیز');
select tst.as_anon(:'bz');
set role anon;
select public.get_salon_profile() as pf \gset
reset role;
select tst.ok(:'pf'::json ->> 'instagram' = 'petbiz' and (:'pf'::json -> 'rating' ->> 'count')::int = 1
              and :'pf'::json -> 'reviews' -> 0 ->> 'name' = 'سارا' and json_array_length(:'pf'::json -> 'hours') = 7, 'public profile');

-- ---- smart deposit -----------------------------------------------------------------------
update public.app_settings set deposit_percent = 20, deposit_min_price = 0, deposit_mode = 'risky' where salon_id = :'bz';
select tst.as_anon(:'bz');
set role anon;
select tst.ok((public.deposit_terms() ->> 'mode') = 'risky', 'mode public');
select tst.ok(public.create_public_booking(:'nails', 'tst-biz-g', public.salon_today() + 1, 600, 'رضا', '09351240008', 'dog', null, '{"name":"رکس","size":"small"}') ->> 'status' <> 'awaiting_payment', 'reliable customer: no deposit');
reset role;
insert into public.appointments (id, salon_id, customer_name, customer_phone, customer_gender, service_id, staff_id, date, start_min, end_min, status, tracking_code)
values ('tst-biz-ns', :'bz', 'بدقول', '09351240009', 'dog', :'nails', 'tst-biz-g', public.salon_today() - 10, 600, 615, 'no_show', 'TBZNS1');
set role anon;
select tst.ok(public.create_public_booking(:'nails', 'tst-biz-g', public.salon_today() + 1, 660, 'بدقول', '09351240009', 'dog', null, '{"name":"مکس","size":"small"}') ->> 'status' = 'awaiting_payment', 'after a no-show: deposit');
reset role;

-- ---- isolation ---------------------------------------------------------------------------
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(not exists (select 1 from public.coupons) and not exists (select 1 from public.gift_cards), 'other salon sees nothing');
select tst.ok(public.redeem_gift_card(:'gcode', :'b1') ->> 'ok' = 'false', 'other salon cannot redeem');
reset role;

delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000d2');
delete from public.salons where slug = 'tst-biz';
