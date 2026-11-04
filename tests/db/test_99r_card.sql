-- v2.66: card-to-card payments approved by the platform owner.
delete from public.salons where slug = 'tst-card';
delete from public.sms_messages;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
update public.platform_settings set enforce_subscription = false, zarinpal_merchant_id = '', card_enabled = false,
       card_number = '', card_holder = '', card_sheba = '', owner_mobile = '', grace_days = 5,
       trial_days = 14, trial_sms = 200, trial_plan = 'herfei', sms_price = 250, sms_packs = '{500,1000,5000}';

select tst.expect_error($$update public.platform_settings set card_enabled = true$$);              -- no card yet
select tst.expect_error($$update public.platform_settings set card_number = '1234'$$);             -- 16 digits
update public.platform_settings set card_enabled = true, card_number = '6037991234567890', card_holder = 'مالک پلتفرم',
       card_sheba = 'IR' || repeat('1', 24), owner_mobile = '09120001111';

set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-card', 'سالن کارت', '09120006661', 'beauty');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as c from public.salons where slug = 'tst-card' \gset
update public.stylists set active = false where salon_id = :'c';
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
insert into public.users (id, salon_id, phone, full_name, role) values ('aaaaaaaa-0000-0000-0000-0000000000c1', :'c', '09120006661', 'مدیر', 'owner');
insert into public.stylists (id, salon_id, name, gender, active) values ('tst-card-1', :'c', 'سارا', 'female', true);
delete from public.sms_messages;

-- ---- the salon pays by card --------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local', :'c');
select tst.ok(public.create_plan_invoice('paye', 3) ->> 'ok' = 'false', 'no merchant: online refused');
select public.create_card_invoice('plan', 'paye', 6, null, null) as inv \gset
select tst.ok((:'inv'::json ->> 'amount')::bigint = 11400000 and :'inv'::json ->> 'card_number' = '6037991234567890', 'card invoice: amount and card');
select tst.ok(public.create_card_invoice('plan', 'paye', 1, null, null) ->> 'ok' = 'false', 'same price rules as online');
select tst.ok(public.my_card_payments() ->> 'enabled' = 'true'
              and json_array_length(public.my_card_payments() -> 'invoices') = 1, 'salon sees how to pay and its invoice');
select tst.ok(public.submit_card_payment((:'inv'::json ->> 'id')::uuid, '12', '1234') ->> 'ok' = 'false', 'tracking number checked');
select tst.ok(public.submit_card_payment((:'inv'::json ->> 'id')::uuid, '۱۲۳۴۵۶۷۸', '۵۵۶۶') ->> 'ok' = 'true', 'submitted (Persian digits ok)');
select tst.ok(public.submit_card_payment((:'inv'::json ->> 'id')::uuid, '12345678', '5566') ->> 'ok' = 'false', 'no double submit');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((select card_ref = '12345678' and card_last4 = '5566' and status = 'submitted' from public.plan_invoices
                where id = (:'inv'::json ->> 'id')::uuid), 'stored in latin digits');
select tst.ok((select count(*) from public.sms_messages where to_phone = '09120001111' and body like '%کارت‌به‌کارت جدید%سالن کارت%') = 1, 'owner texted');

-- ---- a submitted payment keeps the salon open for 48 hours -----------------------------
update public.platform_settings set enforce_subscription = true;
update public.salons set plan_expires_at = public.salon_today() - 10 where id = :'c';
select tst.ok(public.subscription_state(:'c') = 'grace', 'waiting for approval: not locked');
update public.plan_invoices set submitted_at = now() - interval '3 days' where id = (:'inv'::json ->> 'id')::uuid;
select tst.ok(public.subscription_state(:'c') = 'locked', 'after 48 hours: locked again');
update public.plan_invoices set submitted_at = now() where id = (:'inv'::json ->> 'id')::uuid;

-- ---- the owner approves -------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local', :'c');
select tst.ok(public.admin_review_card_payment((:'inv'::json ->> 'id')::uuid, true, '') ->> 'ok' = 'false', 'a salon cannot approve itself');
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(exists (select 1 from json_array_elements(public.admin_card_payments() -> 'rows') r
                       where r ->> 'salon' = 'سالن کارت' and r ->> 'status' = 'submitted' and r ->> 'card_ref' = '12345678'), 'owner sees it');
select tst.ok(public.admin_review_card_payment((:'inv'::json ->> 'id')::uuid, true, '') ->> 'ok' = 'true', 'approved');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((select plan_id = 'paye' and plan_expires_at = (public.salon_today() + interval '6 months')::date and sms_balance = 200 + 2000
                 from public.salons where id = :'c'), 'approval = online payment: 6 months from today, SMS added');
select tst.ok(public.subscription_state(:'c') = 'active', 'active again');
select tst.ok((select count(*) from public.sms_messages where to_phone = '09120006661' and body like '%تایید شد%') = 1, 'salon texted');

-- ---- a rejected SMS pack can be corrected and sent again ------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local', :'c');
select public.create_card_invoice('sms', null, 0, null, 1000) as pk \gset
select tst.ok((:'pk'::json ->> 'amount')::bigint = 250000, 'SMS pack by card');
select public.submit_card_payment((:'pk'::json ->> 'id')::uuid, '99999', '1111');
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(public.admin_review_card_payment((:'pk'::json ->> 'id')::uuid, false, '') ->> 'ok' = 'false', 'rejecting needs a reason');
select tst.ok(public.admin_review_card_payment((:'pk'::json ->> 'id')::uuid, false, 'مبلغی با این شماره پیگیری نیامد') ->> 'ok' = 'true', 'rejected');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local', :'c');
select tst.ok((select x ->> 'review_note' from json_array_elements(public.my_card_payments() -> 'invoices') x where x ->> 'id' = :'pk'::json ->> 'id')
              = 'مبلغی با این شماره پیگیری نیامد', 'salon sees why');
select tst.ok(public.submit_card_payment((:'pk'::json ->> 'id')::uuid, '88888888', '1111') ->> 'ok' = 'true', 'sent again after rejection');
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_review_card_payment((:'pk'::json ->> 'id')::uuid, true, '');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tst.ok((select sms_balance from public.salons where id = :'c') = 3200, 'pack added on approval');

-- ---- card off: no new card invoices -----------------------------------------------------------
update public.platform_settings set card_enabled = false;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120006661@salon.local', :'c');
select tst.ok(public.create_card_invoice('sms', null, 0, null, 500) ->> 'ok' = 'false', 'card off: refused');
select tst.ok(public.my_card_payments() ->> 'card_number' = '', 'card off: number hidden');
reset role;
select set_config('request.jwt.claim.sub', '', false);

update public.platform_settings set enforce_subscription = false, card_enabled = false, card_number = '', card_holder = '',
       card_sheba = '', owner_mobile = '';
delete from public.sms_messages;
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
delete from public.salons where slug = 'tst-card';
