-- Post-visit feedback page (/feedback/:id — no salon header, anonymous).
delete from public.sms_messages; delete from public.appointments; delete from public.feedbacks;
select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 600, 'نظر', '09351116666', 'female') ->> 'id' as a1 \gset
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 2, 720, 'غایب', '09351116667', 'female') ->> 'id' as a2 \gset
reset role;
update public.appointments set status = 'pending_verification' where id in (:'a1', :'a2');

select set_config('request.headers', '', false);  -- the feedback page has no salon context
set role anon;
insert into public.feedbacks (booking_id, rating, tags, comment) values (:'a1', 5, '{}', 'عالی');
select tst.expect_error(format($$insert into public.feedbacks (booking_id, rating, tags, comment) values (%L, 4, '{}', '')$$, :'a1'));
select tst.ok(public.report_appointment_no_show(:'a2') ->> 'ok' = 'true', 'customer reports they did not come');
reset role;
select tst.ok((select salon_id from public.feedbacks where booking_id = :'a1') = '00000000-0000-0000-0000-000000000001', 'feedback filed under the booking''s salon');
select tst.ok((select status from public.appointments where id = :'a1') = 'completed', 'feedback confirms the visit');
select tst.ok((select status from public.appointments where id = :'a2') = 'no_show', 'no-show recorded');
