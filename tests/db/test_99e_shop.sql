-- v2.48: online shop — settings, products, orders, stock, payment, statuses.
delete from public.salons where slug = 'tst-shop';
delete from public.sms_messages;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000b1', '09120008881@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000b2', '09120008882@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-shop', 'پت‌شاپ تست', '09120008881', 'pet');
reset role;
select id as ss from public.salons where slug = 'tst-shop' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-0000000000b2');
insert into public.users (id, salon_id, phone, full_name, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000b1', :'ss', '09120008881', 'مدیر شاپ', 'manager');
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-shop-groomer', :'ss', 'گرومر شاپ', 'pet', '09120008882', true);
update public.stylists set active = true where id = 'tst-shop-groomer';
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000b2', :'ss', '09120008882', 'گرومر شاپ', 'stylist', 'tst-shop-groomer');

-- ---- shop off by default ---------------------------------------------------
select tst.as_anon(:'ss');
set role anon;
select tst.ok(not (public.get_shop() ->> 'enabled')::boolean, 'shop off by default');
select tst.ok(public.place_order('سارا', '09351110001', '[]', 'pickup', 'cash') ->> 'error' = 'فروشگاه این سالن فعال نیست', 'closed shop refuses orders');
select tst.expect_error($$select * from public.products$$);
select tst.expect_error($$select * from public.orders$$);
reset role;

-- ---- manager sets up the shop ---------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b1', '09120008881@salon.local', :'ss');
insert into public.shop_settings (salon_id, enabled, pickup_enabled, shipping_enabled, shipping_fee, free_shipping_over, shipping_area)
values (:'ss', true, true, true, 80000, 1000000, 'فقط تهران');
insert into public.products (name, category, price, stock) values ('غذای خشک سگ ۲ کیلو', 'food', 450000, 3);
insert into public.products (name, category, price, stock) values ('شامپو گربه', 'grooming', 220000, null);
insert into public.products (name, category, price, stock, active) values ('قلاده قدیمی', 'accessories', 150000, 5, false);
select tst.expect_error($$insert into public.products (name, price) values ('ارزان', 10)$$);
reset role;
select id as food from public.products where salon_id = :'ss' and name like 'غذای%' \gset
select id as shampoo from public.products where salon_id = :'ss' and name = 'شامپو گربه' \gset
select id as oldcollar from public.products where salon_id = :'ss' and name = 'قلاده قدیمی' \gset

set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b2', '09120008882@salon.local', :'ss');
select tst.ok((select count(*) from public.products) = 3, 'staff see products');
update public.products set price = 1000 where id = :'food';
select tst.ok((select price from public.products where id = :'food') = 450000, 'staff cannot edit products');
reset role;

-- ---- storefront ------------------------------------------------------------
select tst.as_anon(:'ss');
set role anon;
select public.get_shop() as shop \gset
select tst.ok((:'shop'::json ->> 'enabled')::boolean and json_array_length(:'shop'::json -> 'products') = 2, 'only active products listed');
select tst.ok(not (:'shop'::json ->> 'online')::boolean and (:'shop'::json ->> 'cash')::boolean, 'no merchant → pay at delivery');
select tst.ok(:'shop'::json ->> 'shipping_area' = 'فقط تهران' and (:'shop'::json ->> 'shipping_fee')::int = 80000, 'shipping terms public');
select tst.ok(public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":1}]', :'food')::jsonb, 'pickup', 'online') ->> 'error'
              = 'روش پرداخت در دسترس نیست', 'online refused without a merchant');
select tst.ok(public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":1}]', :'oldcollar')::jsonb, 'pickup', 'cash') ->> 'ok' = 'false', 'inactive product refused');
select tst.ok(public.place_order('سارا', '09351110001', '[{"product_id":"nope","qty":1}]', 'pickup', 'cash') ->> 'error' = 'سبد خرید نامعتبر است', 'garbage cart refused');
select tst.ok(public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":4}]', :'food')::jsonb, 'pickup', 'cash') ->> 'error'
              like '%فقط ۳ عدد%' or public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":4}]', :'food')::jsonb, 'pickup', 'cash') ->> 'error' like '%فقط 3 عدد%', 'stock checked');
select tst.ok(public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":1}]', :'food')::jsonb, 'shipping', 'cash', 'کوتاه') ->> 'error'
              = 'آدرس کامل را وارد کنید', 'shipping needs an address');

-- shipping order below the free threshold: fee applies; duplicates merged
select public.place_order('سارا', '09351110001',
  format('[{"product_id":"%s","qty":1},{"product_id":"%s","qty":1}]', :'shampoo', :'shampoo')::jsonb,
  'shipping', 'cash', 'تهران، خیابان ولیعصر، کوچه ۱۲، پلاک ۴', '۱۲۳۴۵۶۷۸۹۰', 'زنگ دوم') as o1 \gset
select tst.ok((:'o1'::json ->> 'ok')::boolean and (:'o1'::json ->> 'subtotal')::bigint = 440000
              and (:'o1'::json ->> 'shipping_fee')::bigint = 80000 and (:'o1'::json ->> 'total')::bigint = 520000, 'priced on the server with shipping');
-- pickup order of 3 food: stock goes to 0
select public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":3}]', :'food')::jsonb, 'pickup', 'cash') as o2 \gset
select tst.ok((:'o2'::json ->> 'shipping_fee')::bigint = 0 and (:'o2'::json ->> 'status') = 'pending', 'pickup order pending');
select tst.ok(public.place_order('علی', '09351110002', format('[{"product_id":"%s","qty":1}]', :'food')::jsonb, 'pickup', 'cash') ->> 'error' like '%تمام شده%', 'sold out');
reset role;
select (:'o1'::json ->> 'id') as o1id, (:'o2'::json ->> 'id') as o2id \gset
select tst.ok((select stock from public.products where id = :'food') = 0, 'stock reserved');
select tst.ok((select postal_code from public.orders where id = :'o1id') = '1234567890', 'postal code normalised');
select tst.ok((select qty from public.order_items where order_id = :'o1id') = 2, 'duplicate lines merged');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09351110001' and kind = 'order' and body like '%ثبت شد%پرداخت هنگام تحویل%'), 'customer SMS');
select tst.ok(exists (select 1 from public.sms_messages where to_phone = '09120008881' and kind = 'order_staff' and body like 'سفارش جدید%'), 'manager SMS');

-- ---- staff handles orders ----------------------------------------------------
set role anon;
select tst.expect_error(format($$select public.set_order_status(%L, 'confirmed')$$, :'o1id'), 'permission denied');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b2', '09120008882@salon.local', :'ss');
select tst.ok((select count(*) from public.orders) = 2 and (select count(*) from public.order_items) = 2, 'staff see orders');
select tst.ok(public.set_order_status(:'o1id', 'ready') ->> 'ok' = 'false', 'shipping order cannot be "ready for pickup"');
select tst.ok(public.set_order_status(:'o1id', 'shipped', 'کد مرسوله ۱۲۳') ->> 'ok' = 'true', 'shipped');
select tst.ok(public.set_order_status(:'o2id', 'ready') ->> 'ok' = 'true', 'ready for pickup');
select tst.ok(public.set_order_status(:'o2id', 'cancelled') ->> 'ok' = 'false', 'cancel needs a reason');
select tst.ok(public.set_order_status(:'o2id', 'cancelled', 'مشتری نیامد') ->> 'ok' = 'true', 'cancelled');
select tst.ok(public.set_order_status(:'o2id', 'delivered') ->> 'ok' = 'false', 'closed order stays closed');
reset role;
select tst.ok((select stock from public.products where id = :'food') = 3, 'cancel releases stock');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order' and body like '%ارسال شد.%کد مرسوله ۱۲۳'), 'shipped SMS with note');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order' and body like '%آمادهٔ تحویل%مبلغ قابل پرداخت%'), 'ready SMS with amount due');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order' and body like '%لغو شد.%مشتری نیامد'), 'cancel SMS');

delete from public.rate_limit_events where bucket like 'order:%';
-- ---- online payment ------------------------------------------------------------
insert into public.salon_payment_settings (salon_id, zarinpal_merchant_id) values (:'ss', 'zp-merchant-test');
select tst.as_anon(:'ss');
set role anon;
select tst.ok((public.get_shop() ->> 'online')::boolean and not (public.get_shop() ->> 'cash')::boolean, 'merchant → online only');
select public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":2}]', :'food')::jsonb, 'pickup', 'online') as o3 \gset
select tst.ok(:'o3'::json ->> 'status' = 'awaiting_payment', 'online order waits for payment');
reset role;
select (:'o3'::json ->> 'id') as o3id \gset
select tst.ok(not exists (select 1 from public.sms_messages where kind = 'order_staff' and body like '%' || (:'o3'::json ->> 'code') || '%'), 'no SMS before payment');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b1', '09120008881@salon.local', :'ss');
select tst.ok(public.set_order_status(:'o3id', 'confirmed') ->> 'error' = 'این سفارش هنوز پرداخت نشده', 'unpaid online order cannot be processed');
reset role;
set role service_role;
select tst.ok(public.confirm_order_payment(:'o3id', 'REF1') = 'confirmed', 'payment confirms the order');
select tst.ok(public.confirm_order_payment(:'o3id', 'REF1') = 'already', 'verify is idempotent');
reset role;
select tst.ok((select status = 'pending' and paid_at is not null and payment_ref = 'REF1' from public.orders where id = :'o3id'), 'paid order pending');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order' and body like '%' || (:'o3'::json ->> 'code') || '%و پرداخت شد%'), 'paid SMS');
-- cancelling a paid order flags a refund
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b1', '09120008881@salon.local', :'ss');
select public.set_order_status(:'o3id', 'cancelled', 'کالا آسیب دیده');
select tst.ok((select refund_needed from public.orders where id = :'o3id'), 'refund flagged');
select tst.ok(public.mark_order_refunded(:'o3id') ->> 'ok' = 'true', 'refund recorded');
select tst.ok(not (select refund_needed from public.orders where id = :'o3id'), 'refund flag cleared');
reset role;

delete from public.rate_limit_events where bucket like 'order:%';
-- expiry: unpaid online order released after 20 minutes; late payment re-reserves
select tst.as_anon(:'ss');
set role anon;
select public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":3}]', :'food')::jsonb, 'pickup', 'online') ->> 'id' as o4id \gset
reset role;
select tst.ok((select stock from public.products where id = :'food') = 0, 'online order reserves stock');
update public.orders set created_at = now() - interval '25 minutes' where id = :'o4id';
set role service_role;
select tst.ok(public.expire_unpaid_orders() >= 1, 'expired');
reset role;
select tst.ok((select status = 'cancelled' and cancel_reason = 'expired' from public.orders where id = :'o4id') and (select stock from public.products where id = :'food') = 3, 'expiry releases stock');
set role service_role;
select tst.ok(public.confirm_order_payment(:'o4id', 'REF4') = 'confirmed', 'late payment re-reserves when stock allows');
reset role;
select tst.ok((select stock from public.products where id = :'food') = 0, 'stock taken again');
update public.products set stock = 3 where id = :'food';
select tst.as_anon(:'ss');
set role anon;
select public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":3}]', :'food')::jsonb, 'pickup', 'online') ->> 'id' as o5id \gset
reset role;
update public.orders set created_at = now() - interval '25 minutes' where id = :'o5id';
select public.expire_unpaid_orders();
update public.products set stock = 1 where id = :'food';
set role service_role;
select tst.ok(public.confirm_order_payment(:'o5id', 'REF5') = 'refund', 'late payment without stock → refund');
reset role;
select tst.ok((select refund_needed and status = 'cancelled' from public.orders where id = :'o5id'), 'refund flagged for late payment');

delete from public.rate_limit_events where bucket like 'order:%';
-- ---- customer dashboard ----------------------------------------------------------
update public.salon_payment_settings set zarinpal_merchant_id = '' where salon_id = :'ss';
select tst.as_anon(:'ss');
set role anon;
select public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":1}]', :'shampoo')::jsonb, 'pickup', 'cash') ->> 'id' as o6id \gset
reset role;
set role service_role;
select public.request_booking_otp_internal('09351110001', :'ss') ->> 'otp' as otp \gset
reset role;
set role anon;
select public.verify_booking_otp('09351110001', :'otp') ->> 'token' as btok \gset
select public.my_orders_with_token(:'btok') as mo \gset
select tst.ok(json_array_length(:'mo'::json) = 6, 'dashboard lists orders (silently expired unpaid ones hidden)');
select tst.ok((select json_array_length(e -> 'items') from json_array_elements(:'mo'::json) e where e ->> 'id' = :'o1id') = 1, 'order items included');
select tst.ok(public.cancel_my_order(:'btok', :'o1id') ->> 'ok' = 'false', 'shipped order not cancellable');
select tst.ok(public.cancel_my_order(:'btok', :'o6id') ->> 'ok' = 'true', 'customer cancels a pending order');
select tst.ok(public.my_orders_with_token('bad-token')::text = '[]', 'bad token sees nothing');
reset role;
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order_staff' and body like '%را مشتری (سارا) لغو کرد.'), 'manager told about cancel');

-- ---- isolation -------------------------------------------------------------------
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(not exists (select 1 from public.orders) and not exists (select 1 from public.products where salon_id = :'ss'), 'another salon sees nothing');
select tst.ok(public.set_order_status(:'o3id', 'delivered') ->> 'ok' = 'false', 'another salon cannot change orders');
reset role;
select tst.as_anon();
set role anon;
select tst.ok(public.place_order('سارا', '09351110001', format('[{"product_id":"%s","qty":1}]', :'shampoo')::jsonb, 'pickup', 'cash') ->> 'ok' = 'false', 'another salon''s products cannot be ordered');
reset role;

delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-0000000000b2');
delete from public.salons where slug = 'tst-shop';
