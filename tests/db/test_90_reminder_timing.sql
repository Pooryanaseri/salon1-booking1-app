-- v2.39 reminder timing from the SMS panel.
delete from public.sms_messages; delete from public.appointments;
select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 3, 900, 'یادآوری', '09351117771', 'female') ->> 'id' as a1 \gset
reset role;
select extract(epoch from (select scheduled_for from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued')) as t_before \gset

-- anonymous / staff-less callers can't change it
set role anon;
select tst.expect_error($$select public.set_reminder_hours(1)$$, 'permission denied');
reset role;

-- manager moves reminders to 24h before: the queued one is re-timed
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select tst.ok(public.set_reminder_hours(24) ->> 'ok' = 'true', 'manager sets 24h');
reset role;
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 1, 'one live reminder');
select tst.ok(extract(epoch from (select scheduled_for from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued')) < :t_before, 'reminder moved earlier');
select tst.ok((select reminder_hours_before from public.stylists where id = 'tst1') = 24, 'applied to stylists');

-- off: queued reminders dropped, new bookings get none
set role authenticated;
select tst.ok(public.set_reminder_hours(0) ->> 'ok' = 'true', 'turn off');
reset role;
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a1' and kind = 'reminder' and status = 'queued') = 0, 'off drops queued reminder');
select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 4, 900, 'یادآوری', '09351117772', 'female') ->> 'id' as a2 \gset
reset role;
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a2' and kind = 'reminder') = 0, 'no reminder while off');
select tst.ok((select count(*) from public.sms_messages where appointment_id = :'a2' and kind = 'confirmation') = 1, 'confirmation still sent');

-- back on: upcoming bookings get their reminder again
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select tst.ok(public.set_reminder_hours(3) ->> 'ok' = 'true', 'turn back on');
reset role;
select tst.ok((select count(*) from public.sms_messages where appointment_id in (:'a1', :'a2') and kind = 'reminder' and status = 'queued') = 2, 'reminders re-queued when turned back on');
