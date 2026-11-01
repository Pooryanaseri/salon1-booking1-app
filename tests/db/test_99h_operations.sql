-- v2.51: pet health, variants + tracking, supplies, check-in, branches, MFA, backups.
delete from public.salons where slug in ('tst-ops', 'tst-ops2');
delete from public.sms_messages;
delete from public.rate_limit_events;
do $$ begin if to_regclass('auth.mfa_factors') is not null then delete from auth.mfa_factors; end if; end $$;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-ops', 'شعبه یک', '09120005551', 'pet');
select public.admin_create_salon('tst-ops2', 'شعبه دو', '09120005559', 'pet');
reset role;
select id as o1 from public.salons where slug = 'tst-ops' \gset
select id as o2 from public.salons where slug = 'tst-ops2' \gset
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e2');
delete from public.working_hours where salon_id = :'o1' and staff_id is null;  -- v2.60 seeds defaults
insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
select 'tst-owh-' || d, :'o1', null, d, '09:00', '20:00', false from generate_series(0, 6) d;
insert into public.stylists (id, salon_id, name, gender, phone, active) values ('tst-ops-g', :'o1', 'گرومر', 'pet', '09120005552', true);
update public.stylists set active = true where id = 'tst-ops-g';
insert into public.users (id, salon_id, phone, full_name, role, stylist_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', :'o1', '09120005551', 'مالک', 'owner', null),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', :'o1', '09120005552', 'گرومر', 'stylist', 'tst-ops-g');
update public.app_settings set auto_confirm_bookings = true, staff_daily_digest = false, pet_vet_partner = 'دامپزشکی مهر ۰۲۱۱۲۳۴' where salon_id = :'o1';
select public.open_booking_window();
select id as nails from public.services where salon_id = :'o1' and gender = 'dog' and category = 'nails_pet' \gset

-- ---- check-in + pet health -------------------------------------------------------
select tst.as_anon(:'o1');
set role anon;
select public.create_public_booking(:'nails', 'tst-ops-g', public.salon_today(), 600, 'سارا', '09351250001', 'dog', null, '{"name":"پاپی","size":"small"}') as b \gset
reset role;
select (:'b'::json ->> 'id') as bid, (:'b'::json ->> 'tracking_code') as tcode \gset
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local', :'o1');
select tst.ok(public.check_in('NOPE-1') ->> 'ok' = 'false', 'unknown code');
select tst.ok(public.check_in('https://salon.example/checkin?code=' || lower(:'tcode')) ->> 'pet_name' = 'پاپی', 'check-in from a QR link');
select tst.ok((public.check_in(:'tcode') ->> 'already')::boolean, 'second scan says already');
select id as pet from public.pets where owner_phone = '09351250001' \gset
select tst.ok(public.record_pet_weight(:'pet', 6.4) ->> 'ok' = 'true', 'weight recorded');
select tst.ok(public.record_pet_weight(:'pet', 900) ->> 'ok' = 'false', 'bad weight');
update public.pets set allergies = 'شامپوی عطردار', vet_name = 'دکتر رضایی' where id = :'pet';
select public.save_visit_report(:'bid', '{"skin":true}', '', '{}', '{}', true) ->> 'link' as rl \gset
reset role;
select tst.ok((select checked_in_at is not null and groom_stage = 'arrived' from public.appointments where id = :'bid'), 'checked in and arrived');
select tst.ok((select weight_kg = 6.4 from public.pets where id = :'pet') and (select count(*) from public.pet_weights where pet_id = :'pet') = 1, 'weight history');
select tst.ok((select allergies from public.pets where id = :'pet') = 'شامپوی عطردار', 'groomer keeps health notes');
set role anon;
select tst.ok(public.get_visit_report(split_part(:'rl', 'token=', 2)) ->> 'vet_partner' = 'دامپزشکی مهر ۰۲۱۱۲۳۴', 'partner vet suggested on findings');
reset role;

-- ---- variants + tracking ------------------------------------------------------------
insert into public.shop_settings (salon_id, enabled, shipping_enabled, shipping_fee) values (:'o1', true, true, 50000);
insert into public.products (salon_id, name, price, stock, variant_group, variant_label) values
  (:'o1', 'غذای سگ ۲ کیلو', 300000, 5, 'غذای سگ', '۲ کیلو'),
  (:'o1', 'غذای سگ ۱۰ کیلو', 1200000, 2, 'غذای سگ', '۱۰ کیلو');
select id as big from public.products where variant_label = '۱۰ کیلو' and salon_id = :'o1' \gset
select tst.as_anon(:'o1');
set role anon;
select tst.ok((select count(*) from json_array_elements(public.get_shop() -> 'products') e where e ->> 'variant_group' = 'غذای سگ') = 2, 'variants listed');
select public.place_order('سارا', '09351250001', format('[{"product_id":"%s","qty":1}]', :'big')::jsonb,
  'shipping', 'cash', 'تهران، خیابان آزادی، پلاک ۱۲') ->> 'id' as oid \gset
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local', :'o1');
select tst.ok(public.set_order_status(:'oid', 'shipped', '', '123456789012', 'پست') ->> 'ok' = 'true', 'shipped with tracking');
reset role;
select tst.ok((select tracking_code = '123456789012' and carrier = 'پست' from public.orders where id = :'oid'), 'tracking stored');
select tst.ok(exists (select 1 from public.sms_messages where kind = 'order' and body like '%کد رهگیری (پست): 123456789012%'), 'tracking in SMS');

-- ---- supplies --------------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local', :'o1');
insert into public.supplies (name, unit, qty, low_at) values ('شامپو', 'لیتر', 0, 2);
select id as sup from public.supplies where salon_id = :'o1' \gset
select tst.ok(public.supply_move(:'sup', 'purchase', 5, 900000, 'خرید ماهانه') ->> 'qty' = '5.00', 'purchase');
reset role;
select tst.ok(exists (select 1 from public.expenses where salon_id = :'o1' and category = 'supplies' and amount = 900000 and title = 'خرید شامپو'), 'purchase booked as expense');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local', :'o1');
select tst.ok(public.supply_move(:'sup', 'purchase', 5, 1000) ->> 'ok' = 'false', 'groomer cannot buy');
select tst.ok((public.supply_move(:'sup', 'use', 3.5) ->> 'low')::boolean, 'use → low stock');
select tst.ok(public.supply_move(:'sup', 'use', 10) ->> 'error' = 'موجودی کافی نیست', 'cannot go negative');
reset role;

-- ---- branches ------------------------------------------------------------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local', :'o1');
select tst.ok(public.admin_link_branch('09120005551', 'tst-ops2') ->> 'ok' = 'false', 'only the platform admin links branches');
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(public.admin_link_branch('09120005551', 'tst-ops2') ->> 'ok' = 'true', 'branch linked');
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local', :'o1');
select tst.ok(json_array_length(public.my_branches()) = 2 and json_array_length(public.branches_summary()) = 2, 'owner sees both branches');
select tst.ok(public.switch_branch('00000000-0000-0000-0000-000000000001') ->> 'ok' = 'false', 'cannot switch to a foreign salon');
select tst.ok(public.switch_branch(:'o2') ->> 'slug' = 'tst-ops2', 'switched');
select tst.ok(public.current_salon_id() = :'o2' and public.is_manager(), 'now managing branch two');
select public.switch_branch(:'o1');
reset role;

-- ---- MFA ------------------------------------------------------------------------------------
create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
insert into auth.mfa_factors (user_id, status) values ('aaaaaaaa-0000-0000-0000-0000000000e1', 'verified');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local', :'o1');
select set_config('request.jwt.claims', '{"aal":"aal1"}', false);
select tst.ok(not public.is_manager() and not public.is_staff(), 'password-only session is not staff once MFA is on');
select set_config('request.jwt.claims', '{"aal":"aal2"}', false);
select tst.ok(public.is_manager(), 'aal2 session is');
select set_config('request.jwt.claims', '', false);
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local', :'o1');
select tst.ok(public.is_staff(), 'staff without a factor unaffected');
reset role;
delete from auth.mfa_factors;

-- ---- backups ----------------------------------------------------------------------------------
set role service_role;
select tst.ok(public.backup_all_salons() >= 2, 'nightly backup');
reset role;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e1', '09120005551@salon.local', :'o1');
select tst.ok(json_array_length(public.my_backups()) = 1, 'manager sees their backups');
select (public.my_backups() -> 0 ->> 'id') as bk \gset
select tst.ok(jsonb_array_length(public.get_backup(:'bk') -> 'appointments') >= 1 and (public.get_backup(:'bk') -> 'supplies' -> 0 ->> 'name') = 'شامپو', 'backup has the data');
select tst.ok(public.backup_now() ->> 'ok' = 'false', 'throttled');
select tst.expect_error($$select * from public.salon_backups$$);
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000e2', '09120005552@salon.local', :'o1');
select tst.ok(public.get_backup(:'bk') is null and json_array_length(public.my_backups()) = 0, 'groomers cannot read backups');
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(public.get_backup(:'bk') is null, 'other salon cannot read');
reset role;

-- an authenticated account with no staff row is never a manager
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-0000000000ef', 'stranger@salon.local') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000ef', 'stranger@salon.local', :'o1');
select tst.ok(public.is_manager() is false and public.is_staff() is false, 'no users row: not staff (and not NULL)');
select tst.ok(public.revenue_extras(public.salon_today() - 30, public.salon_today()) ->> 'ok' = 'false', 'stranger cannot read revenue');
select tst.ok(public.mark_order_refunded(:'oid') ->> 'ok' = 'false', 'stranger cannot mark refunds');
reset role;
select set_config('request.jwt.claim.sub', '', false);

delete from public.users where id in ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e2');
delete from public.salons where slug in ('tst-ops', 'tst-ops2');
