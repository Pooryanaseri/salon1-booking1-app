-- v2.43 BI action center: server-side campaign rules, snooze, measured results.
delete from public.sms_messages; delete from public.bi_actions;
delete from public.customers where phone in ('09128880001', '09128880002', '09128880003', '09128880004');
insert into public.customers (salon_id, phone, name, sms_opt_out) values
  ('00000000-0000-0000-0000-000000000001', '09128880001', 'یک', false),
  ('00000000-0000-0000-0000-000000000001', '09128880002', 'دو', false),
  ('00000000-0000-0000-0000-000000000001', '09128880003', 'انصرافی', true),
  ('00000000-0000-0000-0000-000000000001', '09128880004', 'اخیر', false);
-- 09128880004 got a campaign SMS 3 days ago
insert into public.sms_messages (salon_id, to_phone, body, kind, status, sent_at, scheduled_for)
values ('00000000-0000-0000-0000-000000000001', '09128880004', 'قبلی', 'campaign', 'sent', now() - interval '3 days', now() - interval '3 days');

-- not for anonymous visitors or stylists
set role anon; select tst.as_anon();
select tst.expect_error($$select public.queue_campaign('at-risk', 't', 'at_risk', 'x', '[{"phone":"09128880001"}]'::jsonb)$$, 'permission denied');
select tst.expect_error($$select * from public.bi_action_history()$$, 'permission denied');
reset role;

set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok((public.queue_campaign('at-risk', 't', 'at_risk', '', '[{"phone":"09128880001"}]'::jsonb) ->> 'ok')::boolean is false, 'empty body rejected');

create temp table r as select public.queue_campaign(
  'at-risk', 'پیامک بازگشت', 'at_risk', 'سلام {{name}}، {{days}} روزه ندیدیمت — {{salon}}',
  '[{"phone":"09128880001","name":"یک","vars":{"days":"۴۰"}},
    {"phone":"09128880002","name":"دو"},
    {"phone":"09128880002","name":"تکراری"},
    {"phone":"09128880003","name":"انصرافی"},
    {"phone":"09128880004","name":"اخیر"},
    {"phone":"0912"}]'::jsonb,
  now() + interval '1 hour', 14, '{"recipients":6}'::jsonb)::jsonb as res;
select tst.ok((select (res ->> 'ok')::boolean from r), 'campaign queued');
select tst.ok((select (res ->> 'queued')::int from r) = 2, 'only the two eligible phones queued (dup, opt-out, recent, invalid dropped)');
select tst.ok((select (res ->> 'skipped_opt_out')::int = 1 and (res ->> 'skipped_recent')::int = 1 and (res ->> 'skipped_invalid')::int = 1 from r), 'skip counts reported');
reset role;
select tst.ok((select body from public.sms_messages where to_phone = '09128880001' and kind = 'campaign' and status = 'queued') like 'سلام یک، ۴۰ روزه ندیدیمت — %', 'body rendered per customer with salon name');
select tst.ok((select extract(hour from scheduled_for at time zone 'Asia/Tehran') between 9 and 20 from public.sms_messages where to_phone = '09128880002' and status = 'queued'), 'scheduled inside allowed hours');
select tst.ok(exists (select 1 from public.bi_actions where insight_key = 'at-risk' and kind = 'campaign' and campaign_log_id is not null), 'action recorded with its campaign');

-- quiet hours: 23:30 local -> next day 10:00
select tst.ok(
  (public.outside_quiet_hours(((current_date + 1) + time '23:30') at time zone 'Asia/Tehran') at time zone 'Asia/Tehran')
    = (current_date + 2) + time '10:00', 'night send moved to 10:00 next day');
select tst.ok(
  (public.outside_quiet_hours(((current_date + 1) + time '06:00') at time zone 'Asia/Tehran') at time zone 'Asia/Tehran')
    = (current_date + 1) + time '10:00', 'early-morning send moved to 10:00');

-- a second campaign right away skips everyone already contacted (frequency cap)
set role authenticated;
select tst.ok((public.queue_campaign('vip', 'VIP', 'champions_vip', 'x {{name}}', '[{"phone":"09128880001"},{"phone":"09128880002"}]'::jsonb) ->> 'ok')::boolean is false, 'frequency cap: no second campaign within 14 days');
select tst.ok((select count(*) from public.recent_campaign_phones(14)) = 3, 'recently contacted phones listed');

-- snooze / dismiss
select tst.ok((public.record_bi_action('waitlist', 'automation', 'snoozed', 'لیست انتظار', '{}'::jsonb, '{}'::jsonb, 7) ->> 'ok')::boolean, 'snooze recorded');
select tst.ok((select until > now() + interval '6 days' from public.bi_actions where insight_key = 'waitlist'), 'snoozed for 7 days');
select tst.ok((public.record_bi_action('x', 'bogus', 'done') ->> 'ok')::boolean is false, 'bad kind rejected');
reset role;

-- delivery + conversion are measured
update public.sms_messages set status = 'sent', sent_at = now() where to_phone in ('09128880001', '09128880002') and kind = 'campaign' and status = 'queued';
select tst.ok((select successful_count from public.campaign_logs cl join public.bi_actions a on a.campaign_log_id = cl.id where a.insight_key = 'at-risk') = 2, 'delivered SMS counted on the campaign log');
delete from public.appointments where id = 'tst-conv';
insert into public.appointments (id, salon_id, service_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code)
values ('tst-conv', '00000000-0000-0000-0000-000000000001', 'tsvc', 'یک', '09128880001', current_date - 1, 600, 660, 'confirmed', 'CONV01');
update public.appointments set status = 'completed', final_price = 450000 where id = 'tst-conv';
set role authenticated;
select tst.ok((select sms_sent = 2 and conversions = 1 and revenue = 450000 from public.bi_action_history() where insight_key = 'at-risk'), 'history shows sent, conversions and revenue');
select tst.ok((select count(*) from public.bi_action_history()) = 2, 'history lists this salon''s actions');
reset role;
select tst.as_anon();
delete from public.appointments where id = 'tst-conv';
delete from public.sms_messages; delete from public.bi_actions;
