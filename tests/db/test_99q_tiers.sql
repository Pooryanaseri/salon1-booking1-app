-- v2.64: tiers by number of stylists, SMS allowance per tier, upgrades, SMS packs.
delete from public.salons where slug = 'tst-tier';
delete from public.sms_messages;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000f1', '09120008881@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
update public.platform_settings set enforce_subscription = false, zarinpal_merchant_id = '00000000-0000-0000-0000-000000000000',
       trial_days = 14, trial_sms = 200, trial_plan = 'herfei', sms_price = 250, sms_packs = '{500,1000,5000}';

-- ---- the tiers ------------------------------------------------------------------
select tst.ok((select count(*) from public.platform_plans where active and price_3 is not null) = 4, 'four tiers on sale');
select tst.ok(public.plan_price('paye', 3) = 6000000 and public.plan_price('paye', 6) = 11400000 and public.plan_price('paye', 12) = 21600000, 'base tier prices');
select tst.ok(public.plan_price('paye', 1) is null, 'tiers are sold for 3/6/12 months only');
select tst.ok(public.plan_price('bozorg', 3, 25) = 21000000 + 5 * 900000, 'over 20 stylists: extra seats');
select tst.ok(public.plan_price('bozorg', 12, 25) = 75500000 + round(5 * 900000::numeric * 75500000 / 21000000), 'extra seats at the yearly ratio');
select tst.ok(public.plan_sms('vizhe', 6) = 9000, 'SMS allowance per tier and period');
select tst.ok(public.sms_parts(repeat('ا', 70)) = 1 and public.sms_parts(repeat('ا', 71)) = 2 and public.sms_parts(repeat('ا', 135)) = 3, 'SMS parts');

-- ---- a new salon: trial tier + trial SMS ---------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-tier', 'سالن سطح', '09120008881', 'beauty');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select id as t from public.salons where slug = 'tst-tier' \gset
select tst.ok((select plan_id = 'herfei' and sms_balance = 200 from public.salons where id = :'t'), 'new salon: trial tier and trial SMS');
update public.stylists set active = false where salon_id = :'t';
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
insert into public.users (id, salon_id, phone, full_name, role) values ('aaaaaaaa-0000-0000-0000-0000000000f1', :'t', '09120008881', 'مدیر', 'owner');

-- ---- stylist limit ----------------------------------------------------------------
insert into public.stylists (id, salon_id, name, gender, active)
select 'tst-tier-' || g, :'t', 'آرایشگر ' || g, 'female', true from generate_series(1, 6) g;   -- not enforced: no limit
select tst.ok(public.active_stylist_count(:'t') = 6, 'not enforced: no limit');
update public.stylists set active = false where id = 'tst-tier-6';
update public.platform_settings set enforce_subscription = true;
select tst.ok(public.stylist_limit(:'t') = 5, 'trial tier allows 5');
select tst.expect_error($$insert into public.stylists (id, salon_id, name, gender, active)
  values ('tst-tier-7', (select id from public.salons where slug = 'tst-tier'), 'هفتم', 'female', true)$$);
select tst.expect_error($$update public.stylists set active = true where id = 'tst-tier-6'$$);
insert into public.stylists (id, salon_id, name, gender, active) values ('tst-tier-8', :'t', 'غیرفعال', 'female', false);
select tst.ok(true, 'an inactive stylist can always be added');
update public.stylists set name = 'آرایشگر یک' where id = 'tst-tier-1';
select tst.ok(true, 'editing an active stylist is never blocked');

-- ---- buying: the tier must fit, SMS comes with it --------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120008881@salon.local', :'t');
select tst.ok(public.create_plan_invoice('paye', 3) ->> 'ok' = 'false', 'a tier too small for 5 stylists is refused');
select public.create_plan_invoice('herfei', 3) as inv \gset
select tst.ok((:'inv'::json ->> 'amount')::bigint = 10000000, 'herfei 3 months: 10,000,000');
select public.my_plan() as mp \gset
select tst.ok(:'mp'::json ->> 'seat_limit' = '5' and :'mp'::json ->> 'active_stylists' = '5', 'my_plan: seats used / allowed');
select tst.ok((select (x ->> 'price_6')::bigint = 19000000 and x ->> 'fits' = 'true'
                 from json_array_elements(:'mp'::json -> 'plans') x where x ->> 'id' = 'herfei'), 'my_plan: tier prices');
select tst.ok((select x ->> 'fits' = 'false' from json_array_elements(:'mp'::json -> 'plans') x where x ->> 'id' = 'paye'), 'my_plan: tier that does not fit');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select public.confirm_plan_payment((:'inv'::json ->> 'id')::uuid, 'R1');
select tst.ok((select sms_balance = 2700 and plan_id = 'herfei' and plan_expires_at = (public.salon_today() + 14 + interval '3 months')::date
                 from public.salons where id = :'t'), 'paid: SMS added, counted from the old expiry');

-- ---- upgrade mid-term: only the difference for the days left ----------------------
select public.upgrade_quote(:'t', 'vizhe', null) as q \gset
select plan_expires_at - public.salon_today() as left from public.salons where id = :'t' \gset
select tst.ok((:'q'::json ->> 'amount')::bigint = (round((15000000 - 10000000) / 90.0 * :left / 1000.0) * 1000)::bigint, 'upgrade price = difference for the days left');
select tst.ok(public.upgrade_quote(:'t', 'paye', null) ->> 'ok' = 'false', 'no "upgrade" to a smaller tier');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120008881@salon.local', :'t');
select public.create_upgrade_invoice('vizhe', null) as up \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);
select public.confirm_plan_payment((:'up'::json ->> 'id')::uuid, 'R2');
select tst.ok((select plan_id = 'vizhe' and plan_expires_at = (public.salon_today() + 14 + interval '3 months')::date from public.salons where id = :'t'), 'upgraded, same expiry');
update public.stylists set active = true where id = 'tst-tier-6';
select tst.ok(public.active_stylist_count(:'t') = 6, 'room for more stylists after the upgrade');

-- ---- SMS allowance -------------------------------------------------------------------
update public.salons set sms_balance = 1 where id = :'t';
insert into public.sms_messages (salon_id, to_phone, body, kind, status, provider, sent_at)
values (:'t', '09350000001', repeat('ب', 100), 'confirmation', 'sent', 'kavenegar (platform)', now());
select tst.ok((select sms_balance from public.salons where id = :'t') = -1, 'a 2-part SMS on the platform line costs 2');
insert into public.sms_messages (salon_id, to_phone, body, kind, status, provider, sent_at)
values (:'t', '09120008881', 'تمدید', 'plan', 'sent', 'kavenegar (platform)', now());
select tst.ok((select sms_balance from public.salons where id = :'t') = -1, 'renewal reminders are free');
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
values (:'t', '09350000002', 'تخفیف!', 'campaign', 'queued', now()), (:'t', '09350000002', 'یادآوری', 'reminder', 'queued', now());
select tst.ok((select count(*) from public.sms_messages where salon_id = :'t' and kind = 'campaign') = 0
              and (select count(*) from public.sms_messages where salon_id = :'t' and kind = 'reminder') = 1, 'no allowance: campaigns stop, reminders go');
select tst.ok(not public.sms_may_send(:'t', 'loyalty') and public.sms_may_send(:'t', 'cancellation'), 'sms_may_send for the Edge Functions');
update public.sms_messages set status = 'sent', provider = 'kavenegar (platform)' where salon_id = :'t' and kind = 'reminder';
select tst.ok((select sms_balance from public.salons where id = :'t') = -2, 'a queued SMS is counted when it goes out');
update public.sms_messages set status = 'delivered' where salon_id = :'t' and kind = 'reminder';
select tst.ok((select sms_balance from public.salons where id = :'t') = -2, 'delivered after sent: not counted twice');
-- own SMS account: no allowance at all
insert into public.salon_sms_settings (salon_id, provider, api_key) values (:'t', 'kavenegar', 'k');
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for) values (:'t', '09350000003', 'تخفیف!', 'campaign', 'queued', now());
select tst.ok((select count(*) from public.sms_messages where salon_id = :'t' and kind = 'campaign') = 1, 'own SMS account: never limited');
delete from public.salon_sms_settings where salon_id = :'t';

-- ---- buying SMS packs --------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000f1', '09120008881@salon.local', :'t');
select tst.ok(public.create_sms_invoice(700) ->> 'ok' = 'false', 'only the offered packs');
select public.create_sms_invoice(1000) as pk \gset
select tst.ok((:'pk'::json ->> 'amount')::bigint = 250000, '1,000 SMS at 250 toman');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select public.confirm_plan_payment((:'pk'::json ->> 'id')::uuid, 'R3');
select tst.ok((select sms_balance from public.salons where id = :'t') = 998, 'pack settles the negative balance');

-- ---- not enforced / no expiry: nothing is limited or counted ---------------------
update public.platform_settings set enforce_subscription = false;
select tst.ok(public.stylist_limit(:'t') is null and public.sms_may_send(:'t', 'campaign'), 'enforcement off: no limits');

-- ---- admin by hand ---------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_set_plan(:'t', 'bozorg', public.salon_today() + 30, 500);
select tst.ok(exists (select 1 from json_array_elements(public.admin_subscription_overview() -> 'rows') r
                       where r ->> 'name' = 'سالن سطح' and r ->> 'plan_name' = 'بزرگ' and (r ->> 'sms_balance')::int = 1498
                         and (r ->> 'stylists')::int = 6), 'admin: plan and SMS by hand, overview');
reset role;
select set_config('request.jwt.claim.sub', '', false);

update public.platform_settings set enforce_subscription = false, zarinpal_merchant_id = '';
delete from public.sms_messages;
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
delete from public.salons where slug = 'tst-tier';
