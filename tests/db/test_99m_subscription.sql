-- v2.58: subscription enforcement — trial, grace window, lock, renewal, reminders.
delete from public.salons where slug = 'tst-sub';
delete from public.sms_messages;
delete from public.rate_limit_events;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '09120007771@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', '09120007772@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
update public.platform_settings set enforce_subscription = false, grace_days = 5, reminder_days = '{14,7,3,1}',
       discount_3 = 5, discount_6 = 10, discount_12 = 20, trial_days = 14, support_phone = '02112345678',
       zarinpal_merchant_id = '00000000-0000-0000-0000-000000000000';
insert into public.platform_plans (id, name, monthly_price, sms_quota, payment_fee_pct, active)
values ('tst-basic', 'پایه', 500000, 500, 1, true) on conflict (id) do update set monthly_price = 500000, active = true;

set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-sub', 'سالن اشتراک', '09120007771', 'beauty');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as h from public.salons where slug = 'tst-sub' \gset
select tst.ok((select plan_expires_at from public.salons where id = :'h') = public.salon_today() + 14, 'new salon gets the trial');
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e2');
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tst-sub-cut', :'h', 'کوتاهی', 'female', 'hair', 30, 300000, true) on conflict (id) do nothing;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-sub-a', :'h', 'سارا', 'female', '09120007772', true);
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', :'h', '09120007771', 'مدیر', 'owner', null),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', :'h', '09120007772', 'سارا', 'stylist', 'tst-sub-a');
insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code, original_price, final_price)
values ('tst-sub-1', :'h', 'tst-sub-cut', 'tst-sub-a', 'م۱', '09351290001', public.salon_today(), 600, 630, 'confirmed', 'SUB001', 300000, 300000);

-- ---- settings validation ----------------------------------------------------------
select tst.expect_error($$update public.platform_settings set reminder_days = '{0,7}'$$);
select tst.expect_error($$update public.platform_settings set grace_days = 45$$);
select tst.expect_error($$update public.platform_settings set discount_12 = 80$$);

-- ---- not enforced: an expired date changes nothing ---------------------------------
update public.salons set plan_expires_at = public.salon_today() - 30 where id = :'h';
select tst.ok(public.subscription_state(:'h') = 'active', 'not enforced → active');
update public.platform_settings set enforce_subscription = true;

-- ---- grace window ---------------------------------------------------------------------
update public.salons set plan_expires_at = public.salon_today() - 2 where id = :'h';
select tst.ok(public.subscription_state(:'h') = 'grace', 'two days after expiry → grace');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120007771@salon.local', :'h');
select tst.ok(public.is_staff() and public.is_manager(), 'grace: panel still works');
select tst.ok((select count(*) from public.appointments) = 1, 'grace: data readable');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---- locked -----------------------------------------------------------------------------
update public.salons set plan_expires_at = public.salon_today() - 6 where id = :'h';
select tst.ok(public.subscription_state(:'h') = 'locked', 'past the grace window → locked');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120007771@salon.local', :'h');
select tst.ok(not public.is_staff() and not public.is_manager(), 'locked: no staff access');
select tst.ok((select count(*) from public.appointments) = 0, 'locked: data hidden');
select tst.ok(public.contract_income(public.salon_today(), public.salon_today()) ->> 'ok' = 'false', 'locked: manager RPCs refuse');
select public.my_plan() as mp \gset
select tst.ok(:'mp'::json ->> 'ok' = 'true' and :'mp'::json ->> 'state' = 'locked'
              and (:'mp'::json -> 'discounts' ->> '12')::numeric = 20, 'locked: the subscription page still works');
select public.create_plan_invoice('tst-basic', 3) as inv \gset
select tst.ok(:'inv'::json ->> 'ok' = 'true' and (:'inv'::json ->> 'amount')::bigint = 1425000, 'locked: can buy (3 months, 5% off)');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120007772@salon.local', :'h');
select tst.ok(public.my_plan() ->> 'ok' = 'false', 'a stylist cannot buy');
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select tst.as_anon(:'h');
select tst.ok(public.subscription_status() ->> 'state' = 'locked' and public.subscription_status() ->> 'support_phone' = '02112345678', 'public status says locked');
reset role;
-- no new bookings or orders; no SMS except renewal reminders
select tst.expect_error($$insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code)
  values ('tst-sub-2', (select id from public.salons where slug = 'tst-sub'), 'tst-sub-cut', 'tst-sub-a', 'م۲', '09351290002', public.salon_today() + 1, 600, 630, 'pending', 'SUB002')$$);
select tst.expect_error($$insert into public.orders (salon_id, code, customer_name, customer_phone, delivery, subtotal, total, payment_method)
  values ((select id from public.salons where slug = 'tst-sub'), 'SUB-O1', 'م۲', '09351290002', 'pickup', 100000, 100000, 'cash')$$);
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for) values
  (:'h', '09351290001', 'x', 'custom', 'queued', now()),
  (:'h', '09120007771', 'x', 'plan', 'queued', now());
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h' and kind = 'custom') = 0
              and (select count(*) from public.sms_messages where salon_id = :'h' and kind = 'plan') = 1, 'locked: only plan SMS goes out');
delete from public.sms_messages where salon_id = :'h';

-- ---- paying unlocks at once, counted from today ---------------------------------------
select public.confirm_plan_payment((:'inv'::json ->> 'id')::uuid, 'REF1');
select tst.ok((select plan_expires_at from public.salons where id = :'h') = (public.salon_today() + interval '3 months')::date
              and public.subscription_state(:'h') = 'active', 'paid: active, 3 months from today');
-- renewing inside the grace window counts from the old expiry
update public.salons set plan_expires_at = public.salon_today() - 2 where id = :'h';
select public.extend_salon_plan(:'h', 'tst-basic', 1);
select tst.ok((select plan_expires_at from public.salons where id = :'h') = (public.salon_today() - 2 + interval '1 month')::date, 'grace renewal: no free days');
-- a salon without a date is never locked
update public.salons set plan_expires_at = null where id = :'h';
select tst.ok(public.subscription_state(:'h') = 'active', 'no date → unlimited');

-- ---- reminders ------------------------------------------------------------------------------
update public.salons set plan_expires_at = public.salon_today() + 7 where id = :'h';
select public.plan_reminders();
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h' and kind = 'plan' and to_phone = '09120007771'
                 and body like '%۷ روز دیگر%' and body like '%۰۲۱۱۲۳۴۵۶۷۸%') = 1, '7 days before: reminder with support phone');
select public.plan_reminders();
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h' and kind = 'plan') = 1, 'one a day');
delete from public.sms_messages where salon_id = :'h';
update public.salons set plan_expires_at = public.salon_today() + 5 where id = :'h';
select public.plan_reminders();
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h') = 0, 'no reminder on other days');
update public.salons set plan_expires_at = public.salon_today() - 5 where id = :'h';
select public.plan_reminders();
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h' and body like '%آخرین روز مهلت%') = 1, 'last grace day warning');
delete from public.sms_messages where salon_id = :'h';
update public.salons set plan_expires_at = public.salon_today() - 6 where id = :'h';
select public.plan_reminders();
select tst.ok((select count(*) from public.sms_messages where salon_id = :'h' and body like '%غیرفعال شد%') = 1, 'locked-day notice (plan SMS passes the lock)');

-- ---- owner discounts and admin overview ----------------------------------------------------
update public.platform_settings set discount_12 = 30;
select tst.ok(public.plan_price('tst-basic', 12) = 4200000 and public.plan_price('tst-basic', 2) is null, 'owner discount applied');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(exists (select 1 from json_array_elements(public.admin_subscription_overview() -> 'rows') r
                       where r ->> 'name' = 'سالن اشتراک' and r ->> 'state' = 'locked'), 'admin sees locked salon');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120007771@salon.local', :'h');
select tst.ok(public.admin_subscription_overview() ->> 'ok' = 'false', 'salon owner cannot see the overview');
update public.platform_settings set grace_days = 20;
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((select grace_days from public.platform_settings) = 5, 'settings only by the platform owner');

-- leave the platform as other tests expect
update public.platform_settings set enforce_subscription = false, discount_12 = 20, support_phone = '', zarinpal_merchant_id = '';
delete from public.sms_messages;
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e2');
delete from public.salons where slug = 'tst-sub';
delete from public.platform_plans where id = 'tst-basic';
