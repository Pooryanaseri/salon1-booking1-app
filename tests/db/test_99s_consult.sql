-- v2.68: consultation requests in beauty salons (women's / men's).
delete from public.sms_messages; delete from public.rate_limit_events;
delete from public.appointments where salon_id = '00000000-0000-0000-0000-000000000001';
delete from public.quote_requests where salon_id = '00000000-0000-0000-0000-000000000001';
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tst-cons-m', '00000000-0000-0000-0000-000000000001', 'کوتاهی مردانه تست', 'male', 'hair', 30, 200000, true)
on conflict (id) do update set is_active = true;
update public.app_settings set consult_enabled = true where salon_id = '00000000-0000-0000-0000-000000000001';

-- ---- the customer asks -------------------------------------------------------------
select tst.as_anon();
set role anon;
select tst.ok(public.request_consultation('نگار', '09351234001', 'female', array['tst-cons-m'], '{}') ->> 'ok' = 'false', 'a men''s service is not in the women''s section');
select tst.ok(public.request_consultation('نگار', '09351234001', 'kid', array['tsvc'], '{}') ->> 'ok' = 'false', 'section checked');
select tst.ok(public.request_consultation('نگار', '09351234001', 'female', '{}', '{}') ->> 'ok' = 'false', 'at least one service');
select public.request_consultation('نگار', '09351234001', 'female', array['tsvc'],
  '{"hair_length":"long","hair_texture":"curly","hair_condition":"damaged","last_color":"lt3","allergy":"به آمونیاک","goal":"بالیاژ عسلی","hack":"x","skin":"weird"}',
  'موهایم شکننده است', 'عصر') ->> 'id' as q \gset
reset role;
select tst.ok((select kind = 'consult' and customer_gender = 'female' and pet_species is null and pet_name is null and status = 'pending'
                 and details = '{"hair_length":"long","hair_texture":"curly","hair_condition":"damaged","last_color":"lt3","allergy":"به آمونیاک","goal":"بالیاژ عسلی"}'::jsonb
                 from public.quote_requests where id = :'q'::uuid), 'stored; unknown keys and answers dropped');
select tst.ok((select count(*) from public.sms_messages where to_phone = '09121110000' and kind = 'quote_request'
                 and body like '%درخواست مشاوره (زنانه)%موی بلند، فر، آسیب‌دیده%کمتر از ۳ ماه%حساسیت: به آمونیاک%بالیاژ عسلی%') = 1, 'the women''s stylist is texted the details');
select tst.ok((select count(*) from public.sms_messages where to_phone = '09351234001' and body like '%درخواست مشاورهٔ شما%') = 1, 'customer told it was received');

-- ---- the salon prices it; the customer books at that price ---------------------------
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok((select count(*) from public.quote_requests where id = :'q'::uuid) = 1, 'staff see it');
select public.send_quote(:'q'::uuid, 1800000, 150, 'tst1', 'شامل تست رنگ') as sq \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok(:'sq'::json ->> 'ok' = 'true', 'price sent');
select tst.ok((select body from public.sms_messages where to_phone = '09351234001' and kind = 'quote') like 'نگار عزیز، قیمت رنگ ریشه تست در %۱,۸۰۰,۰۰۰ تومان%', 'price SMS reads right without an animal');
select split_part(:'sq'::json ->> 'link', 'token=', 2) as tok \gset
select tst.as_anon();
set role anon;
select public.resolve_rebooking_token(:'tok') as rt \gset
select tst.ok((:'rt'::json ->> 'price')::bigint = 1800000 and (:'rt'::json ->> 'duration')::int = 150 and :'rt'::json ->> 'is_quote' = 'true', 'link shows the quoted price');
select public.create_booking_from_rebooking_token(:'tok', public.salon_today() + 4, 600, 'tst1') as bk \gset
reset role;
select tst.ok(:'bk'::json ->> 'ok' = 'true', 'booked from the link');
select tst.ok((select final_price = 1800000 and end_min - start_min = 150 and customer_gender = 'female' and pet_name is null
                 from public.appointments where id = :'bk'::json ->> 'id'), 'booking at the quoted price and length');
select tst.ok((select status = 'booked' from public.quote_requests where id = :'q'::uuid), 'request marked booked');

-- ---- men's section, decline, switch off -------------------------------------------------
set role anon;
select public.request_consultation('علی', '09351234002', 'male', array['tst-cons-m'], '{"hair_length":"short","skin":"oily"}') ->> 'id' as m \gset
reset role;
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select public.decline_quote(:'m'::uuid, 'این خدمت را انجام نمی‌دهیم');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((select body from public.sms_messages where to_phone = '09351234002' and kind = 'quote') like '%برای درخواست کوتاهی مردانه تست امکان پذیرش نیست%', 'decline SMS names the service');
update public.app_settings set consult_enabled = false where salon_id = '00000000-0000-0000-0000-000000000001';
select tst.as_anon();
set role anon;
select tst.ok(public.request_consultation('علی', '09351234003', 'male', array['tst-cons-m'], '{}') ->> 'ok' = 'false', 'switched off: refused');
reset role;
update public.app_settings set consult_enabled = true where salon_id = '00000000-0000-0000-0000-000000000001';
select tst.ok(public.consult_details_text('{}') = '' and public.consult_details_text('{"skin":"oily"}') = 'پوست چرب', 'details text');

delete from public.sms_messages;
delete from public.appointments where salon_id = '00000000-0000-0000-0000-000000000001';
delete from public.quote_requests where salon_id = '00000000-0000-0000-0000-000000000001';
delete from public.services where id = 'tst-cons-m';
