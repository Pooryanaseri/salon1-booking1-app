-- v2.42: SQL reminder sweep, inactive salons send nothing, RLS still holds.
delete from public.sms_messages;
delete from public.appointments where id = 'tst-sweep';
insert into public.appointments (id, salon_id, service_id, staff_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code)
select 'tst-sweep', '00000000-0000-0000-0000-000000000001', 'tsvc', 'tst1', 'سویپ', '09126660001',
       (v)::date, extract(hour from v)::int * 60 + extract(minute from v)::int,
       extract(hour from v)::int * 60 + extract(minute from v)::int + 30, 'confirmed', 'SWEEP1'
  from (select (now() at time zone 'Asia/Tehran') + interval '90 minutes' as v) x
 where extract(hour from v) < 23;  -- keep the slot inside the day

-- Pretend the booking-time reminder got lost (e.g. created before v2.31).
delete from public.sms_messages where appointment_id = 'tst-sweep';
select tst.ok(public.queue_due_reminders() = (select count(*)::int from public.appointments where id = 'tst-sweep'), 'sweep queues the missing reminder');
select tst.ok(public.queue_due_reminders() = 0, 'second sweep queues nothing');
select tst.ok((select count(*) from public.sms_messages where appointment_id = 'tst-sweep' and kind = 'reminder' and status = 'queued')
              = (select count(*) from public.appointments where id = 'tst-sweep'), 'exactly one queued reminder');

-- Deactivated salon: queue dropped, claim skips it.
update public.salons set active = false where id = '00000000-0000-0000-0000-000000000001';
select tst.ok(not exists (select 1 from public.sms_messages where appointment_id = 'tst-sweep' and status = 'queued'), 'deactivation drops queued SMS');
insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
values ('00000000-0000-0000-0000-000000000001', '09126660001', 'x', 'custom', 'queued', now() - interval '1 minute');
select tst.ok(not exists (select 1 from public.claim_due_sms(50)), 'inactive salon''s queue is not claimed');
select tst.ok(public.queue_due_reminders() = 0, 'inactive salon gets no sweep reminders');
update public.salons set active = true where id = '00000000-0000-0000-0000-000000000001';
select tst.ok(exists (select 1 from public.claim_due_sms(50)), 'claimed again once active');

delete from public.sms_messages;
delete from public.appointments where id = 'tst-sweep';
