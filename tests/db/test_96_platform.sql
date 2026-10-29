-- v2.41: platform admin, owner-phone binding, deactivation, per-salon SMS
-- account, waitlist privacy, feedback salon.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),  -- platform admin
  ('aaaaaaaa-0000-0000-0000-000000000002', '09120002222@salon.local'),  -- the new salon's owner
  ('aaaaaaaa-0000-0000-0000-000000000003', '09120003333@salon.local')   -- an outsider
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
delete from public.users where id in ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003');
delete from public.salons where slug in ('tst-new', 'tst-new2');

-- ---- creating salons: platform admin only --------------------------------
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');  -- a salon manager, not platform admin
select tst.ok((public.admin_create_salon('tst-new', 'سالن تازه', '09120002222') ->> 'ok')::boolean is false, 'salon manager cannot create salons');
select tst.ok(not exists (select 1 from public.admin_list_salons()), 'salon manager sees no salon list');
select tst.expect_error($$select owner_phone from public.salons$$);

select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok((public.admin_create_salon('admin', 'x', '09120002222') ->> 'ok')::boolean is false, 'reserved slug rejected');
select tst.ok((public.admin_create_salon('Bad Slug', 'x', '09120002222') ->> 'ok')::boolean is false, 'bad slug rejected');
select tst.ok((public.admin_create_salon('tst-new', 'سالن تازه', '0912') ->> 'ok')::boolean is false, 'bad owner phone rejected');
select tst.ok((public.admin_create_salon('tst-new', 'سالن تازه', '09120002222') ->> 'ok')::boolean, 'platform admin creates a salon');
select tst.ok((public.admin_create_salon('tst-new', 'دوباره', '09120002222') ->> 'ok')::boolean is false, 'duplicate slug rejected');
select tst.ok(exists (select 1 from public.admin_list_salons() where slug = 'tst-new' and not owner_registered and not sms_configured), 'listed: no owner yet, no SMS yet');
reset role;
select tst.ok(exists (select 1 from public.app_settings a join public.salons s on s.id = a.salon_id where s.slug = 'tst-new'), 'new salon got default settings');

-- ---- only the bound phone becomes its manager ----------------------------
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000003', '09120003333@salon.local', (select id from public.salons where slug = 'tst-new'));
select tst.expect_error($$insert into public.users (id, phone, role, full_name) values ('aaaaaaaa-0000-0000-0000-000000000003', '09120003333', 'manager', 'غریبه')$$, 'ثبت نشده');

select tst.as_user('aaaaaaaa-0000-0000-0000-000000000002', '09120002222@salon.local', (select id from public.salons where slug = 'tst-new'));
insert into public.users (id, phone, role, full_name) values ('aaaaaaaa-0000-0000-0000-000000000002', '09120002222', 'manager', 'مدیر سالن تازه');
select tst.ok((select role from public.users where id = 'aaaaaaaa-0000-0000-0000-000000000002') = 'owner', 'bound phone registers as owner');
select tst.ok(public.current_salon_id() = (select id from public.salons where slug = 'tst-new'), 'owner resolves to the new salon');

-- ---- per-salon SMS account: write-only key ----------------------------------
select tst.ok((public.get_sms_account() ->> 'configured')::boolean is false, 'no SMS account yet');
select tst.ok((public.set_sms_account('kavenegar', '', '1000') ->> 'ok')::boolean is false, 'key required the first time');
select tst.ok((public.set_sms_account('kavenegar', 'ABCDEF0123456789WXYZ', '10004346') ->> 'ok')::boolean, 'SMS account saved');
select tst.ok(public.get_sms_account() ->> 'key_hint' = 'WXYZ' and public.get_sms_account() ->> 'sender' = '10004346', 'only a hint of the key comes back');
select tst.ok((public.set_sms_account('kavenegar', '', '2000') ->> 'ok')::boolean, 'sender change keeps the key');
select tst.expect_error($$select api_key from public.salon_sms_settings$$);
reset role;
select tst.ok((select api_key from public.salon_sms_settings s join public.salons n on n.id = s.salon_id where n.slug = 'tst-new') = 'ABCDEF0123456789WXYZ' , 'key kept, service role can read it');

set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select tst.ok(exists (select 1 from public.admin_list_salons() where slug = 'tst-new' and owner_registered and sms_configured), 'list shows owner + SMS configured');

-- ---- generic isolation: every tenant table, seen by another salon's owner
reset role;
select tst.ok((select count(*) from public.appointments where salon_id <> (select id from public.salons where slug = 'tst-new')) > 0
              or (select count(*) from public.services where salon_id <> (select id from public.salons where slug = 'tst-new')) > 0,
              'other salons do have data to leak');
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000002', '09120002222@salon.local', '00000000-0000-0000-0000-000000000001');  -- header points at salon 1
do $$
declare t text; n bigint;
begin
  for t in
    select c.relname::text from pg_class c join pg_attribute a on a.attrelid = c.oid
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attname = 'salon_id' and not a.attisdropped
       and has_any_column_privilege('authenticated', c.oid, 'SELECT')
  loop
    execute format('select count(*) from public.%I where salon_id is distinct from public.current_salon_id()', t) into n;
    if n > 0 then raise exception 'ASSERT FAILED: % rows of other salons visible in %', n, t; end if;
  end loop;
end $$;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');

-- ---- deactivation switches the salon off for staff and public ------------
select public.admin_update_salon((select id from public.salons where slug = 'tst-new'), p_active => false);
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000002', '09120002222@salon.local', (select id from public.salons where slug = 'tst-new'));
select tst.ok(public.current_salon_id() is null, 'staff of a deactivated salon resolve to no salon');
reset role;
set role anon;
select tst.as_anon((select id from public.salons where slug = 'tst-new'));
select tst.ok(public.current_salon_id() is null, 'public header of a deactivated salon resolves to nothing');
select tst.ok(not exists (select 1 from public.salons where slug = 'tst-new'), 'deactivated salon not resolvable by slug');
reset role;
update public.salons set active = true where slug = 'tst-new';

-- ---- waitlist: join via RPC, private list ----------------------------------
delete from public.waitlist where customer_phone = '09124443333';
set role anon;
select tst.as_anon();
select tst.ok((public.join_waitlist(public.salon_today() + 1, 'tsvc', null, 'منتظر', '09124443333') ->> 'ok')::boolean, 'visitor joins the waitlist');
select tst.ok((public.join_waitlist(public.salon_today() + 1, 'tsvc', null, 'منتظر', '09124443333') ->> 'already')::boolean, 'joining twice is a no-op');
select tst.ok((public.join_waitlist(public.salon_today() + 1, 'no-such', null, 'x', '09124443333') ->> 'ok')::boolean is false, 'unknown service rejected');
select tst.ok((public.join_waitlist(public.salon_today() - 1, 'tsvc', null, 'x', '09124443333') ->> 'ok')::boolean is false, 'past date rejected');
select tst.expect_error($$select * from public.waitlist$$);
select tst.expect_error($$insert into public.waitlist (id, date, customer_name, customer_phone, service_id) values ('wl-raw', current_date + 1, 'x', '09124443333', 'tsvc')$$);
reset role;
set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok((select count(*) from public.waitlist where customer_phone = '09124443333') = 1, 'staff see the entry');
reset role;
select tst.as_anon();
