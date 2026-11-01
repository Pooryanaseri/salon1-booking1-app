-- v2.53: off-peak, freed slots, add-on offers, events, reviews, sources,
-- staff targets, platform plans.
delete from public.salons where slug = 'tst-grw';
delete from public.sms_messages;
delete from public.rate_limit_events;
delete from public.platform_plans where id in ('tst-basic', 'tst-pro');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', '09120008882@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-grw', 'سالن رشد', '09120008881', 'beauty');
reset role;
select id as g from public.salons where slug = 'tst-grw' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a2');
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-gwh-' || d, :'g', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active) values
  ('tst-grw-cut', :'g', 'کوتاهی', 'female', 'hair', 30, 400000, true),
  ('tst-grw-mask', :'g', 'ماسک مو', 'female', 'hair', 20, 250000, true)
on conflict (id) do nothing;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-grw-s', :'g', 'رها', 'female', '09120008882', true);
update public.stylists set active = true where id = 'tst-grw-s';
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', :'g', '09120008881', 'مدیر', 'owner', null),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', :'g', '09120008882', 'رها', 'stylist', 'tst-grw-s');
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false where salon_id = :'g';
select public.open_booking_window();
select public.salon_today() + 1 as d1 \gset

-- ---- manager sets rules ---------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local', :'g');
insert into public.offpeak_rules (day_of_week, start_min, end_min, percent) values (public.schema_dow(:'d1'::date), 540, 720, 20);
insert into public.upsell_offers (service_id, addon_service_id, price, extra_minutes, pitch) values ('tst-grw-cut', 'tst-grw-mask', 200000, 20, 'موهایتان نرم‌تر');
select tst.expect_error($$insert into public.offpeak_rules (start_min, end_min, percent) values (600, 500, 10)$$);
select id as offer from public.upsell_offers where service_id = 'tst-grw-cut' \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---- a client books 10:00 tomorrow (inside the off-peak window) ---------------------
select tst.as_anon(:'g');
set role anon;
select tst.ok(json_array_length(public.get_offpeak_rules()) = 1 and json_array_length(public.get_upsell_offers()) = 1, 'public rules and offers');
select public.create_public_booking('tst-grw-cut', 'tst-grw-s', :'d1', 600, 'سارا', '09351260001', 'female') ->> 'id' as b1 \gset
select public.create_public_booking('tst-grw-cut', 'tst-grw-s', :'d1', 660, 'مریم', '09351260002', 'female') ->> 'id' as b2 \gset
select tst.ok(public.apply_offpeak(:'b1', '09351260001') ->> 'discount' = '80000', 'off-peak 20%');
select tst.ok(public.apply_offpeak(:'b1', '09351260001') ->> 'ok' = 'false', 'off-peak once');
select tst.ok(public.apply_offpeak(:'b1', '09350000000') ->> 'ok' = 'false', 'needs the booking phone');
-- add-on: 10:00 + 30 + 20 min runs into the 11:00 booking? 10:50 < 11:00 → fits
select tst.ok(public.apply_upsell(:'b1', '09351260001', :'offer') ->> 'ok' = 'true', 'add-on accepted');
select tst.ok(public.apply_upsell(:'b1', '09351260001', :'offer') ->> 'ok' = 'false', 'add-on once');
select tst.ok(public.set_booking_source(:'b1', '09351260001', 'Instagram') ->> 'ok' = 'true', 'source stored');
select tst.ok(public.set_booking_source(:'b1', '09351260001', 'google') ->> 'ok' = 'false', 'source only once');
select tst.ok(public.set_booking_source(:'b2', '09351260002', 'bad source!') ->> 'ok' = 'false', 'bad source refused');
reset role;
select tst.ok((select final_price = 400000 - 80000 + 200000 and end_min = 600 + 30 + 20 and source = 'instagram'
                      and extra_charges -> 0 ->> 'label' = 'ماسک مو' from public.appointments where id = :'b1'), 'booking updated');
select tst.ok((select accepted_count from public.upsell_offers where id = :'offer') = 1, 'offer counted');
-- 11:00 + 30 + 20 would run into nothing; make a 11:40 booking to block it
set role anon;
select public.create_public_booking('tst-grw-cut', 'tst-grw-s', :'d1', 700, 'لیلا', '09351260003', 'female') ->> 'id' as b3 \gset
select tst.ok(public.apply_upsell(:'b2', '09351260002', :'offer') ->> 'error' like '%وقت خالی نیست%', 'no room for the add-on');
reset role;

-- ---- freed slot offered to regulars who have not come lately ------------------------
update public.app_settings set slot_offer_lapsed = true, slot_offer_lapsed_days = 30 where salon_id = :'g';
insert into public.customers (salon_id, phone, name, gender, last_booking_at, total_visits, sms_opt_out) values
  (:'g', '09351269991', 'نازنین قدیمی', 'female', now() - interval '60 days', 6, false),
  (:'g', '09351269992', 'تازه', 'female', now() - interval '5 days', 2, false),
  (:'g', '09351269993', 'مخالف پیامک', 'female', now() - interval '60 days', 9, true),
  (:'g', '09351269994', 'آقا', 'male', now() - interval '60 days', 9, false)
on conflict do nothing;
update public.appointments set status = 'cancelled' where id = :'b2';
select tst.ok((select count(*) from public.sms_messages where kind = 'slot_offer' and salon_id = :'g') = 1
         and exists (select 1 from public.sms_messages where kind = 'slot_offer' and to_phone = '09351269991' and body like 'نازنین عزیز، یک نوبت کوتاهی فردا ساعت ۱۱:۰۰%/book?token=%'),
         'only the lapsed, opted-in, same-section regular is offered');
update public.appointments set status = 'cancelled' where id = :'b3';
select tst.ok((select count(*) from public.sms_messages where kind = 'slot_offer' and to_phone = '09351269991') = 1, 'one offer per 14 days');

-- ---- reviews ----------------------------------------------------------------------------
insert into public.salon_profiles (salon_id, review_url) values (:'g', 'https://g.page/r/tst-salon/review')
on conflict (salon_id) do update set review_url = excluded.review_url;
update public.appointments set status = 'completed' where id = :'b1';
insert into public.feedbacks (booking_id, rating, comment) values (:'b1', 5, 'عالی');
select tst.ok(public.feedback_followup(:'b1') ->> 'review_url' = 'https://g.page/r/tst-salon/review', '5 stars → public review link');
select tst.expect_error(format($$update public.salon_profiles set review_url = 'http://x.ir' where salon_id = %L$$, :'g'));
set role anon;
select public.create_public_booking('tst-grw-cut', 'tst-grw-s', :'d1', 900, 'ناراضی', '09351260004', 'female') ->> 'id' as b4 \gset
reset role;
update public.appointments set status = 'completed' where id = :'b4';
insert into public.feedbacks (booking_id, rating, comment) values (:'b4', 2, 'دیر شروع شد');
select tst.ok(public.feedback_followup(:'b4') ->> 'review_url' is null, 'low score: no public link');
select tst.ok((select body like 'امتیاز ۲ از ۵ — ناراضی 09351260004 (آرایشگر: رها)%دیر شروع شد%' from public.sms_messages
                where kind = 'rating_alert' and to_phone = '09120008881'), 'owner alerted');

-- ---- staff targets -------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local', :'g');
insert into public.staff_targets (stylist_id, month, revenue_target, visits_target, bonus)
values ('tst-grw-s', date_trunc('month', :'d1'::date)::date, 500000, 2, 300000);
select tst.expect_error($$insert into public.staff_targets (stylist_id, month) values ('tst-grw-s', '2026-01-05')$$);
select public.targets_progress(:'d1'::date) as tp \gset
select tst.ok((:'tp'::json -> 'rows' -> 0 ->> 'visits')::int = 2 and (:'tp'::json -> 'rows' -> 0 ->> 'revenue')::bigint = 920000
              and (:'tp'::json -> 'rows' -> 0 ->> 'bonus')::bigint = 300000, 'targets progress');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a2', '09120008882@salon.local', :'g');
select tst.ok(json_array_length(public.targets_progress(:'d1'::date) -> 'rows') = 1, 'stylist sees own row');
update public.staff_targets set bonus = 9999999;
reset role;
select tst.ok((select bonus from public.staff_targets where stylist_id = 'tst-grw-s') = 300000, 'stylist cannot change their bonus');
set role authenticated;

-- ---- events ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.as_anon(:'g');
set role anon;
select tst.ok(public.create_event_request('bride', public.salon_today(), 2, 'عروس', '09351260009') ->> 'ok' = 'false', 'event date must be ahead');
select public.create_event_request('bride', public.salon_today() + 30, 3, 'نگین', '09351260009', 'میکاپ عروس + ۲ همراه', 'ساعت ۸ صبح') ->> 'id' as ev \gset
select tst.expect_error($$select count(*) from public.event_requests$$);
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a2', '09120008882@salon.local', :'g');
select tst.ok(public.quote_event(:'ev', 20000000, 5000000, 'بیعانه برنمی‌گردد') ->> 'ok' = 'false', 'stylist cannot quote');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local', :'g');
select tst.ok(public.quote_event(:'ev', 20000000, 30000000, '') ->> 'ok' = 'false', 'deposit above total refused');
select tst.ok(public.quote_event(:'ev', 20000000, 5000000, 'بیعانه برنمی‌گردد') ->> 'sent' = 'true', 'quote sent');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select substring(body from 'token=([0-9a-f]{36})') as evtok from public.sms_messages where kind = 'event' and to_phone = '09351260009' \gset
set role anon;
select tst.ok(public.get_event_quote(:'evtok') ->> 'quote_total' = '20000000' and public.get_event_quote(:'evtok') ->> 'paid' = '0', 'client reads the quote');
select tst.ok(public.get_event_quote(repeat('a', 36)) ->> 'ok' = 'false', 'wrong token');
select tst.ok(public.accept_event_quote(:'evtok') ->> 'deposit' = '5000000', 'client accepts');
reset role;
select public.confirm_event_payment(:'ev', 5000000, 'ZP1');
select public.confirm_event_payment(:'ev', 5000000, 'ZP1');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a2', '09120008882@salon.local', :'g');
select tst.ok(public.record_event_payment(:'ev', 7000000, 'نقد') ->> 'left' = '8000000', 'staged payments');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local', :'g');
select tst.ok((public.revenue_extras(public.salon_today() - 1, public.salon_today()) ->> 'events_revenue')::bigint = 12000000, 'event income in accounting');

-- ---- platform plans --------------------------------------------------------------------
select tst.ok(public.admin_set_plan(:'g', null, null) ->> 'ok' = 'false', 'salon manager is not platform admin');
select tst.expect_error($$insert into public.platform_plans (id, name, monthly_price) values ('hack', 'x', 0)$$);
select tst.ok(public.create_plan_invoice('tst-pro', 1) ->> 'ok' = 'false', 'no platform merchant yet');
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
insert into public.platform_plans (id, name, monthly_price, sms_quota, payment_fee_pct, sort_order) values
  ('tst-basic', 'پایه', 0, 300, 2, 1), ('tst-pro', 'حرفه‌ای', 900000, 2000, 1, 2);
update public.platform_settings set zarinpal_merchant_id = '00000000-0000-0000-0000-000000000000';
select tst.ok(public.admin_set_plan(:'g', 'tst-basic', public.salon_today() + 14) ->> 'ok' = 'true', 'admin sets a trial plan');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a1', '09120008881@salon.local', :'g');
select tst.ok(public.my_plan() ->> 'plan_name' = 'پایه' and (public.my_plan() ->> 'payment_fee_pct')::numeric = 2, 'salon sees its plan');
select tst.ok(public.create_plan_invoice('tst-basic', 1) ->> 'error' = 'این پلن رایگان است', 'free plan has no invoice');
select public.create_plan_invoice('tst-pro', 12) as inv \gset
select tst.ok((:'inv'::json ->> 'amount')::bigint = 8640000, '12 months: 20% off');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000a2', '09120008882@salon.local', :'g');
select tst.ok(public.my_plan() ->> 'ok' = 'false', 'stylist cannot see the plan');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select public.confirm_plan_payment((:'inv'::json ->> 'id')::uuid, 'ZP9');
select public.confirm_plan_payment((:'inv'::json ->> 'id')::uuid, 'ZP9');
select tst.ok((select plan_id = 'tst-pro' and plan_expires_at = (public.salon_today() + 14 + interval '12 months')::date
                 from public.salons where id = :'g'), 'paid invoice extends from the current expiry, once');
insert into public.payments (salon_id, appointment_id, amount_rial, authority, status, paid_at)
values (:'g', :'b1', 10000000, 'tst-auth-grw', 'paid', now());
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_billing_report(public.salon_today()) as br \gset
select tst.ok((select (r ->> 'online_volume')::bigint = 1000000 and (r ->> 'fee')::bigint = 10000 and (r ->> 'subscription')::bigint = 8640000
                 from json_array_elements(:'br'::json -> 'rows') r where r ->> 'slug' = 'tst-grw'), 'billing report: volume, 1% fee, subscription');
reset role;
select set_config('request.jwt.claim.sub', '', false);

delete from public.payments where authority = 'tst-auth-grw';
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a2');
delete from public.salons where slug = 'tst-grw';
delete from public.platform_plans where id in ('tst-basic', 'tst-pro');
update public.platform_settings set zarinpal_merchant_id = '';
