-- v2.32 function privileges, v2.33 signup guard + salon_id defaults,
-- v2.35 stylist approval.
delete from public.sms_messages;

-- Server-only functions are closed to the public key...
select tst.as_anon();
set role anon;
select tst.expect_error($$select public.request_booking_otp_internal('09351112233', '00000000-0000-0000-0000-000000000001')$$, 'permission denied');
select tst.expect_error($$select public.create_reconciliation_token('00000000-0000-0000-0000-000000000001')$$, 'permission denied');
select tst.expect_error($$select public.create_rebooking_token('00000000-0000-0000-0000-000000000001', '09351112233')$$, 'permission denied');
select tst.expect_error($$select public.run_predictive_rebooking()$$, 'permission denied');
select tst.expect_error($$select public.queue_daily_digests()$$, 'permission denied');
select tst.expect_error($$select public.claim_due_sms(1)$$, 'permission denied');
select tst.expect_error($$select public.customer_loyalty_full('09351112233', '00000000-0000-0000-0000-000000000001')$$, 'permission denied');
select tst.expect_error($$select phone from public.stylists$$, 'permission denied');
select tst.expect_error($$select * from public.salon_payment_settings$$, 'permission denied');
-- ...and the public loyalty lookup reveals nothing personal
select tst.ok((select string_agg(k, ',' order by k) from json_object_keys(public.customer_loyalty('09351112233')) k) = 'discount_percent,found', 'anon loyalty is minimal');
reset role;

-- staff can't get OTPs either; service_role can
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select tst.expect_error($$select public.request_booking_otp_internal('09351112233', '00000000-0000-0000-0000-000000000001')$$, 'permission denied');
-- panel inserts without salon_id land in the caller's salon
insert into public.expenses (id, title, category, amount, date) values ('tst-exp', 'تست', 'supplies', 1000, current_date);
reset role;
select tst.ok((select salon_id from public.expenses where id = 'tst-exp') = '00000000-0000-0000-0000-000000000001', 'salon_id defaulted');
delete from public.expenses where id = 'tst-exp';
set role service_role;
select tst.ok(public.request_booking_otp_internal('09351119999', '00000000-0000-0000-0000-000000000001') ->> 'ok' = 'true', 'service_role gets OTP');
reset role;

-- Nobody can make themselves manager of a salon that has one
delete from public.users where id = '22222222-2222-2222-2222-222222222222';
delete from public.stylists where id = 'tst-self';
insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', '09129990000@salon.local') on conflict do nothing;
select tst.as_user('22222222-2222-2222-2222-222222222222', '09129990000@salon.local');
set role authenticated;
select tst.expect_error($$insert into public.users (id, phone, role, full_name) values ('22222222-2222-2222-2222-222222222222', '09129990000', 'owner', 'x')$$, 'مدیر دارد');
select tst.expect_error($$insert into public.users (id, phone, role, full_name, stylist_id) values ('22222222-2222-2222-2222-222222222222', '09129990000', 'stylist', 'x', 'tst1')$$);
-- self-registered stylist: allowed, but inactive until approved
insert into public.stylists (id, name, gender, phone, active) values ('tst-self', 'غریبه', 'female', '09129990000', true);
insert into public.users (id, phone, full_name, role, stylist_id, active) values ('22222222-2222-2222-2222-222222222222', '09129990000', 'غریبه', 'stylist', 'tst-self', true);
select tst.ok(not public.is_staff(), 'unapproved stylist has no staff rights');
reset role;
select tst.ok((select not active and self_registered from public.stylists where id = 'tst-self'), 'self-registered stylist inactive');
select tst.ok((select count(*) from public.sms_messages where to_phone = '09125550000' and body like '%منتظر تایید%') = 1, 'manager notified');
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
update public.stylists set active = true where id = 'tst-self';
reset role;
select tst.ok((select active from public.users where id = '22222222-2222-2222-2222-222222222222'), 'approval activates the login');
delete from public.users where id = '22222222-2222-2222-2222-222222222222';
delete from public.stylists where id = 'tst-self';
