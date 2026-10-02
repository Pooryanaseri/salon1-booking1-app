-- v2.37 online deposit.
delete from public.sms_messages; delete from public.payments; delete from public.appointments;
update public.app_settings set deposit_percent = 20, deposit_min_price = 300000 where salon_id = '00000000-0000-0000-0000-000000000001';
insert into public.salon_payment_settings (salon_id, zarinpal_merchant_id)
values ('00000000-0000-0000-0000-000000000001', '00000000-1111-2222-3333-444444444444')
on conflict (salon_id) do update set zarinpal_merchant_id = excluded.zarinpal_merchant_id;

select tst.as_anon();
set role anon;
select tst.ok((public.deposit_terms() ->> 'enabled')::boolean, 'deposit terms public');
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 600, 'سارا', '09351112233', 'female') as r \gset
select tst.ok(:'r'::json ->> 'status' = 'awaiting_payment' and (:'r'::json ->> 'deposit_amount')::int = 90000, 'held for 20% deposit');
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 600, 'دیگری', '09351112299', 'female') ->> 'ok' = 'false', 'hold blocks the slot');
reset role;
select (:'r'::json ->> 'id') as a1 \gset
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1') = 0, 'no SMS before payment');

update public.appointments set status = 'confirmed', deposit_paid_at = now(), deposit_ref = 'ZP1' where id = :'a1';
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'confirmation') = 1, 'paid -> confirmation');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 1, 'paid -> reminder');

set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 4, 600, 'نیلو', '09351112244', 'female') ->> 'id' as a2 \gset
reset role;
update public.appointments set created_at = now() - interval '25 minutes' where id = :'a2';
select public.expire_unpaid_bookings();
select tst.ok((select status from public.appointments where id = :'a2') = 'cancelled', 'unpaid hold released');
update public.appointments set status = 'confirmed', deposit_paid_at = now(), deposit_ref = 'ZP2' where id = :'a2' and status in ('awaiting_payment', 'cancelled');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a2' and kind = 'confirmation') = 1, 'late payment still confirms + notifies');

update public.app_settings set deposit_percent = 0 where salon_id = '00000000-0000-0000-0000-000000000001';
