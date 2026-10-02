-- v2.34 one sender per SMS, v2.36 client error log, v2.33 working hours.
delete from public.sms_messages;
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
select '00000000-0000-0000-0000-000000000001', '0912000000' || g, 'm' || g, 'custom', 'queued', now() - interval '1 minute' from generate_series(1, 5) g;
select tst.ok((select count(*) from public.claim_due_sms(3)) = 3, 'first claim');
select tst.ok((select count(*) from public.claim_due_sms(10)) = 2, 'second claim gets the rest');
select tst.ok((select count(*) from public.claim_due_sms(10)) = 0, 'nothing claimed twice');

select tst.as_anon();
set role anon;
select public.log_client_error('runtime', 'TypeError: test', 'at x', '/book', 'UA');
select public.log_client_error('runtime', 'TypeError: test', 'at x', '/book', 'UA');
select tst.expect_error($$select * from public.client_errors$$, 'permission denied');
reset role;
select tst.ok((select occurrences from public.client_errors where message = 'TypeError: test') = 2, 'repeats merged');

select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select public.save_working_hours(null, '[{"day_of_week":0,"start_time":"10:00","end_time":"18:00","is_closed":false}]');
reset role;
select tst.ok((select start_time from public.working_hours where salon_id = '00000000-0000-0000-0000-000000000001' and staff_id is null and day_of_week = 0) = '10:00', 'working hours saved per salon');
-- restore the full week for the tests after this one
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select public.save_working_hours(null, (select jsonb_agg(jsonb_build_object('day_of_week', d, 'start_time', '09:00', 'end_time', '20:00', 'is_closed', false)) from generate_series(0, 6) d));
reset role;
select tst.ok((select count(*) from public.working_hours where salon_id = '00000000-0000-0000-0000-000000000001' and staff_id is null and not is_closed) = 7, 'full week restored');
