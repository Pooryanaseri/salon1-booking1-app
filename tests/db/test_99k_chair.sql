-- v2.54: chair rental / revenue share — contracts, statement, ledger,
-- salon income, rent reminders.
delete from public.salons where slug = 'tst-chr';
delete from public.sms_messages;
delete from public.rate_limit_events;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', '09120009991@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', '09120009992@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', '09120009993@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-chr', 'سالن صندلی', '09120009991', 'beauty');
reset role;
select id as h from public.salons where slug = 'tst-chr' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000000c3');
insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tst-chr-cut', :'h', 'رنگ', 'female', 'hair', 60, 1000000, true) on conflict (id) do nothing;
insert into public.stylists (id, salon_id, name, gender, phone, active) values
  ('tst-chr-a', :'h', 'آزاده', 'female', '09120009992', true),
  ('tst-chr-b', :'h', 'بهار', 'female', '09120009993', true);
update public.stylists set active = true where id in ('tst-chr-a', 'tst-chr-b');
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', :'h', '09120009991', 'مدیر', 'owner', null),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', :'h', '09120009992', 'آزاده', 'stylist', 'tst-chr-a'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', :'h', '09120009993', 'بهار', 'stylist', 'tst-chr-b');
select date_trunc('month', public.salon_today())::date as m \gset

-- three completed visits for A (1,000,000 each), two for B
insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code, original_price, final_price)
values ('tst-chr-1', :'h', 'tst-chr-cut', 'tst-chr-a', 'م۱', '09351270001', :'m', 600, 660, 'confirmed', 'CHR001', 1000000, 1000000),
       ('tst-chr-2', :'h', 'tst-chr-cut', 'tst-chr-a', 'م۲', '09351270002', :'m', 700, 760, 'confirmed', 'CHR002', 1000000, 1000000),
       ('tst-chr-3', :'h', 'tst-chr-cut', 'tst-chr-a', 'م۳', '09351270003', :'m', 800, 860, 'confirmed', 'CHR003', 1000000, 700000),
       ('tst-chr-4', :'h', 'tst-chr-cut', 'tst-chr-b', 'م۴', '09351270004', :'m', 600, 660, 'confirmed', 'CHR004', 1000000, 1000000),
       ('tst-chr-5', :'h', 'tst-chr-cut', 'tst-chr-b', 'م۵', '09351270005', :'m', 700, 760, 'confirmed', 'CHR005', 1000000, 1000000);
select set_config('app.trusted_rpc', 'on', false);
update public.appointments set gift_card_amount = 300000 where id = 'tst-chr-3';   -- 700,000 cash + 300,000 gift card
update public.appointments set status = 'completed' where id like 'tst-chr-%';
select set_config('app.trusted_rpc', '', false);
-- an online deposit of 200,000 on B's first visit
insert into public.payments (salon_id, appointment_id, amount_rial, authority, status, paid_at)
values (:'h', 'tst-chr-4', 2000000, 'tst-chr-auth', 'paid', now());

-- ---- contracts ---------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120009991@salon.local', :'h');
-- A: hybrid, the salon collects: rent 2,000,000 + 10%
insert into public.stylist_contracts (stylist_id, kind, rent_amount, service_share_pct, collector, rent_due_day, effective_from)
values ('tst-chr-a', 'hybrid', 2000000, 10, 'salon', extract(day from public.salon_today())::int % 28 + 1, :'m');
-- B: 30% share, she collects herself
insert into public.stylist_contracts (stylist_id, kind, service_share_pct, collector, effective_from)
values ('tst-chr-b', 'share', 30, 'stylist', :'m');
select tst.expect_error($$insert into public.stylist_contracts (stylist_id, kind, service_share_pct) values ('tst-chr-b', 'share', 130)$$);
insert into public.stylist_ledger (stylist_id, month, kind, amount, label) values
  ('tst-chr-a', :'m', 'charge', 150000, 'رنگ مصرفی'),
  ('tst-chr-a', :'m', 'paid_to_stylist', 500000, 'علی‌الحساب');

-- A: gross 3,000,000 (incl. the gift card) — salon holds it all
select public.stylist_statement('tst-chr-a', :'m') as sa \gset
select tst.ok((:'sa'::json ->> 'gross')::bigint = 3000000 and (:'sa'::json ->> 'held_by_salon')::bigint = 3000000
              and (:'sa'::json ->> 'salon_share')::bigint = 300000 and (:'sa'::json ->> 'rent')::bigint = 2000000, 'A: gross, share, rent');
-- 3,000,000 − 300,000 − 2,000,000 − 150,000 − 500,000 = 50,000 the salon still owes her
select tst.ok((:'sa'::json ->> 'balance')::bigint = 50000 and (:'sa'::json ->> 'stylist_net')::bigint = 550000, 'A: balance after charge and advance');

-- B: gross 2,000,000, she holds 1,800,000, salon holds the 200,000 deposit; owes 30% = 600,000 → owes 400,000
select public.stylist_statement('tst-chr-b', :'m') as sb \gset
select tst.ok((:'sb'::json ->> 'held_by_stylist')::bigint = 1800000 and (:'sb'::json ->> 'online')::bigint = 200000
              and (:'sb'::json ->> 'balance')::bigint = -400000, 'B: stylist collects, owes the share minus the deposit');
insert into public.stylist_ledger (stylist_id, month, kind, amount, label) values ('tst-chr-b', :'m', 'paid_to_salon', 400000, 'تسویه');
select tst.ok((public.stylist_statement('tst-chr-b', :'m') ->> 'balance')::bigint = 0, 'B: settled');

-- salon income instead of turnover
select public.contract_income(:'m', (:'m'::date + interval '29 days')::date) as ci \gset
select tst.ok((select sum((r ->> 'share')::bigint + (r ->> 'rent')::bigint) from json_array_elements(:'ci'::json -> 'rows') r) = 300000 + 2000000 + 600000,
              'salon income: shares + rent');

-- ---- each stylist sees only their own ----------------------------------------------------
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c3', '09120009993@salon.local', :'h');
select tst.ok(public.stylist_statement('tst-chr-b', :'m') ->> 'ok' = 'true', 'B reads her statement');
select tst.ok(public.stylist_statement('tst-chr-a', :'m') ->> 'ok' = 'false', 'B cannot read A');
select tst.ok((select count(*) from public.stylist_contracts) = 1 and (select count(*) from public.stylist_ledger) = 1, 'B sees only her rows');
select tst.expect_error($$insert into public.stylist_ledger (stylist_id, month, kind, amount) values ('tst-chr-b', date_trunc('month', current_date), 'credit', 999999)$$);
select tst.ok(public.contract_income(current_date, current_date) ->> 'ok' = 'false', 'stylist cannot read salon income');
-- an employee (no contract) gets a plain answer
reset role;
select set_config('request.jwt.claim.sub', '', false);
delete from public.stylist_contracts where stylist_id = 'tst-chr-b';
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000c1', '09120009991@salon.local', :'h');
select tst.ok(public.stylist_statement('tst-chr-b', :'m') ->> 'kind' = 'employee', 'no contract → employee');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---- rent reminder on the due day ---------------------------------------------------------------
update public.stylist_contracts set rent_due_day = extract(day from public.salon_today())::int
 where stylist_id = 'tst-chr-a';
select tst.ok(public.rent_reminders() >= 0, 'reminders run');
select tst.ok(case when extract(day from public.salon_today()) <= 28
                   then (select count(*) from public.sms_messages where kind = 'rent' and to_phone = '09120009992') = 1 else true end, 'A reminded once');
select public.rent_reminders();
select tst.ok((select count(*) from public.sms_messages where kind = 'rent' and to_phone = '09120009992') <= 1, 'no second reminder');

delete from public.payments where authority = 'tst-chr-auth';
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000000c3');
delete from public.salons where slug = 'tst-chr';
