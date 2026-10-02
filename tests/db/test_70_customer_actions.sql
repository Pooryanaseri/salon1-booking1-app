-- v2.38: customer token actions only touch live bookings; salon-sent
-- links skip the deposit.
delete from public.sms_messages; delete from public.payments; delete from public.appointments; delete from public.rebooking_tokens;

-- a completed visit and a live booking for the same customer
select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 600, 'سارا', '09351115555', 'female') ->> 'id' as live \gset
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 600, 'سارا', '09351115555', 'female') ->> 'id' as done \gset
reset role;
update public.appointments set status = 'completed' where id = :'done';

-- log in like "my dashboard": OTP (server) -> verify (customer) -> token
set role service_role;
select public.request_booking_otp_internal('09351115555', '00000000-0000-0000-0000-000000000001') ->> 'otp' as otp \gset
reset role;
select tst.as_anon();
set role anon;
select public.verify_booking_otp('09351115555', :'otp') ->> 'token' as tok \gset
select tst.ok(public.cancel_my_booking_with_token(:'tok', :'done') ->> 'ok' = 'false', 'completed visit cannot be cancelled');
select tst.ok(public.reschedule_my_booking_with_token(:'tok', :'done', public.salon_today() + 6, 600) ->> 'ok' = 'false', 'completed visit cannot be rescheduled');
select tst.ok(public.reschedule_my_booking_with_token(:'tok', :'live', public.salon_today() + 6, 660) ->> 'ok' = 'true', 'live booking can move');
select tst.ok(public.cancel_my_booking_with_token(:'tok', :'live') ->> 'ok' = 'true', 'live booking can be cancelled');
select tst.ok(public.reschedule_my_booking_with_token(:'tok', :'live', public.salon_today() + 7, 600) ->> 'ok' = 'false', 'cancelled booking cannot be revived');
reset role;
select tst.ok((select status from public.appointments where id = :'done') = 'completed', 'completed visit untouched');

-- unpaid deposit hold can't be turned into a booking by rescheduling,
-- and a salon-sent link books without a deposit
update public.app_settings set deposit_percent = 20, deposit_min_price = 0 where salon_id = '00000000-0000-0000-0000-000000000001';
insert into public.salon_payment_settings (salon_id, zarinpal_merchant_id)
values ('00000000-0000-0000-0000-000000000001', '00000000-1111-2222-3333-444444444444')
on conflict (salon_id) do update set zarinpal_merchant_id = excluded.zarinpal_merchant_id;
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 8, 600, 'سارا', '09351115555', 'female') ->> 'id' as held \gset
select tst.ok(public.reschedule_my_booking_with_token(:'tok', :'held', public.salon_today() + 9, 600) ->> 'ok' = 'false', 'unpaid hold cannot be rescheduled into a booking');
reset role;
set role service_role;
select public.create_rebooking_token('00000000-0000-0000-0000-000000000001', '09351115555', 'tsvc', 'tst1', 'manual') as rtok \gset
reset role;
set role anon;
select tst.ok(public.create_booking_from_rebooking_token(:'rtok', public.salon_today() + 10, 600, 'tst1') ->> 'ok' = 'true', 'link booking ok');
reset role;
select tst.ok((select status from public.appointments where date = public.salon_today() + 10 and customer_phone = '09351115555') = 'confirmed', 'salon-sent link skips the deposit');
update public.app_settings set deposit_percent = 0 where salon_id = '00000000-0000-0000-0000-000000000001';
