-- v2.29 waitlist offers + attendance links.
delete from public.sms_messages; delete from public.appointments; delete from public.waitlist; delete from public.rebooking_tokens;

select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 600, 'سارا', '09351112233', 'female') ->> 'id' as a1 \gset
reset role;
insert into public.waitlist (id, salon_id, date, customer_name, customer_phone, customer_gender, service_id) values
  ('w1', '00000000-0000-0000-0000-000000000001', public.salon_today() + 2, 'لیلا', '09361110001', 'female', 'tsvc'),
  ('w2', '00000000-0000-0000-0000-000000000001', public.salon_today() + 3, 'دیگر', '09361110003', 'female', 'tsvc');

select substring(body from 'token=([0-9a-f]+)') as tok from public.sms_messages where kind = 'reminder' and appointment_id = :'a1' \gset
set role anon;
select tst.ok(public.get_attendance(:'tok') ->> 'ok' = 'true', 'attendance page resolves');
select tst.ok(public.respond_attendance(:'tok', 'confirmed') ->> 'ok' = 'true', 'customer confirms');
select tst.ok(public.respond_attendance(:'tok', 'declined') ->> 'ok' = 'true', 'customer declines');
select tst.ok(public.respond_attendance(:'tok', 'declined') ->> 'ok' = 'false', 'second decline refused');
reset role;
select tst.ok((select status from public.appointments where id = :'a1') = 'cancelled', 'decline cancels');
select tst.ok((select count(*) from public.sms_messages where kind = 'waitlist_offer' and to_phone = '09361110001') = 1, 'same-day waitlist offered');
select tst.ok((select count(*) from public.sms_messages where kind = 'waitlist_offer' and to_phone = '09361110003') = 0, 'other day not offered');

select substring(body from 'token=([0-9a-f]+)') as wtok from public.sms_messages where kind = 'waitlist_offer' and to_phone = '09361110001' \gset
set role anon;
select tst.ok(public.resolve_rebooking_token(:'wtok') ->> 'reason' = 'waitlist', 'offer link resolves as waitlist');
select tst.ok(public.create_booking_from_rebooking_token(:'wtok', public.salon_today() + 2, 600, 'tst1') ->> 'ok' = 'true', 'waitlisted customer books');
reset role;
select tst.ok(not exists (select 1 from public.waitlist where id = 'w1'), 'booked customer left the waitlist');
select tst.ok((select count(*) from public.sms_messages s join public.appointments a on a.id = s.appointment_id
               where a.customer_phone = '09361110001' and s.kind = 'confirmation') = 1, 'link booking got a confirmation SMS');
