-- v2.28 auto-confirm, v2.31 server-owned booking SMS, jalali rendering.
delete from public.sms_messages; delete from public.payments; delete from public.appointments; delete from public.waitlist;

select tst.ok(public.jalali_label('2026-03-21') = '۱ فروردین ۱۴۰۵', 'jalali nowruz');
select tst.ok(public.jalali_label('2026-10-02') = '۱۰ مهر ۱۴۰۵', 'jalali mehr');
select tst.ok(public.jalali_label('2025-03-20') = '۳۰ اسفند ۱۴۰۳', 'jalali leap-year end');

select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 600, 'سارا', '09351112233', 'female') as r1 \gset
select tst.ok((:'r1'::json ->> 'ok')::boolean, 'public booking succeeds');
select tst.ok(:'r1'::json ->> 'status' = 'confirmed', 'auto-confirmed and status returned');
-- the same slot is refused
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 600, 'دیگری', '09351112299', 'female') ->> 'ok' = 'false', 'double booking refused');
reset role;

select (:'r1'::json ->> 'id') as a1 \gset
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'confirmation') = 1, 'confirmation queued');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 1, 'reminder queued');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'staff_new_booking') = 0, 'later day: covered by digest, no instant stylist SMS');
select tst.ok((select body from public.sms_messages where appointment_id = :'a1' and kind = 'reminder') like '%/confirm?token=%', 'reminder carries attendance link');

-- moving the booking re-queues the reminder for the new time
update public.appointments set start_min = 840, end_min = 900, status = 'rescheduled' where id = :'a1';
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 1, 'one live reminder after move');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'cancelled') = 1, 'old reminder cancelled');
-- cancelling clears it
update public.appointments set status = 'cancelled' where id = :'a1';
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 0, 'no reminder after cancel');

-- manual confirmation mode
update public.app_settings set auto_confirm_bookings = false where salon_id = '00000000-0000-0000-0000-000000000001';
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 600, 'مریم', '09351112266', 'female') ->> 'status' as st \gset
reset role;
select tst.ok(:'st' = 'pending', 'manual mode keeps pending');
update public.app_settings set auto_confirm_bookings = true where salon_id = '00000000-0000-0000-0000-000000000001';

-- returning customer can book without sending their name
set role anon;
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 4, 600, '', '09351112233', 'female') ->> 'ok' = 'true', 'known customer books without name');
reset role;
select tst.ok((select customer_name from public.appointments where date = public.salon_today() + 4 and customer_phone = '09351112233') = 'سارا', 'server filled in the name on file');
