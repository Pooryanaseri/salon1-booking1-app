-- v2.28 digests + rolling window, v2.30 closures.
delete from public.sms_messages; delete from public.appointments; delete from public.salon_closures;

select tst.as_anon();
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 1, 600, 'سارا', '09351112233', 'female');
select public.create_public_booking('tsvc', null,   public.salon_today() + 1, 720, 'الهام', '09351112244', 'female');
reset role;

select public.queue_daily_digests(public.salon_today() + 1) as d1 \gset
select tst.ok((:'d1'::json ->> 'staff')::int = 1 and (:'d1'::json ->> 'managers')::int = 1, 'one stylist + one manager digest');
select tst.ok((select body from public.sms_messages where kind = 'daily_digest' and to_phone = '09125550000') like '%بدون آرایشگر%', 'manager digest flags unassigned booking');
select public.queue_daily_digests(public.salon_today() + 1) as d2 \gset
select tst.ok((:'d2'::json ->> 'staff')::int = 0 and (:'d2'::json ->> 'managers')::int = 0, 'digest is idempotent');

select tst.ok((select count(*) from public.approved_dates where salon_id = '00000000-0000-0000-0000-000000000001' and date between public.salon_today() and public.salon_today() + 29) = 30, '30-day window open');

-- closure: cancels pending too, removes the day, window doesn't reopen it
update public.app_settings set auto_confirm_bookings = false where salon_id = '00000000-0000-0000-0000-000000000001';
set role anon;
select public.create_public_booking('tsvc', 'tst1', public.salon_today() + 5, 600, 'پریا', '09351119999', 'female') ->> 'id' as p1 \gset
reset role;
update public.app_settings set auto_confirm_bookings = true where salon_id = '00000000-0000-0000-0000-000000000001';
select tst.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select tst.ok(public.handle_closure_announcement('00000000-0000-0000-0000-000000000001', public.salon_today() + 5, 'maintenance', '') ->> 'ok' = 'true', 'closure announced');
reset role;
select tst.ok((select status from public.appointments where id = :'p1') = 'cancelled_by_salon', 'pending booking cancelled by closure');
select public.open_booking_window();
select tst.ok(not exists (select 1 from public.approved_dates where salon_id = '00000000-0000-0000-0000-000000000001' and date = public.salon_today() + 5), 'closed day stays closed');
select tst.as_anon();
set role anon;
select tst.ok(public.create_public_booking('tsvc', 'tst1', public.salon_today() + 5, 700, 'تست', '09351118888', 'female') ->> 'ok' = 'false', 'booking on closed day refused');
reset role;
update public.salon_closures set is_active = false where closure_date = public.salon_today() + 5;
select tst.ok(exists (select 1 from public.approved_dates where salon_id = '00000000-0000-0000-0000-000000000001' and date = public.salon_today() + 5), 'revoked closure reopens day');
