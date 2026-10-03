-- ============================================================================
-- Migration v2.43 — BI action center (run after v2.42)
-- ============================================================================
-- The BI tab's "اقدام پیشنهادی" grows from a button into a managed process:
--   * bi_actions — every action the manager approves (or snoozes, or
--     dismisses) is recorded per salon, with the numbers it was based on, so
--     the result can be measured later and the same suggestion isn't repeated
--     on another device.
--   * queue_campaign() — one server-side path for a BI campaign. It enforces
--     what must not depend on the browser: opted-out customers are skipped,
--     nobody gets more than one campaign SMS per N days (default 14), and
--     nothing is sent at night (21:00–09:00 → moved to 10:00). Messages are
--     queued and the cron drain sends them through the salon's own account.
--   * bi_action_history() — each action with its measured outcome: SMS sent,
--     customers who booked within 7 days of the SMS, and their revenue.
--   * The drain re-checks opt-out at send time, and a delivered campaign SMS
--     now counts toward campaign_logs.successful_count by itself.
-- ============================================================================

create table if not exists public.bi_actions (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null default public.current_salon_id() references public.salons(id) on delete cascade,
  insight_key      text not null,
  kind             text not null check (kind in ('campaign', 'automation', 'reminder', 'goto')),
  status           text not null default 'done' check (status in ('done', 'snoozed', 'dismissed')),
  title            text not null default '',
  params           jsonb not null default '{}'::jsonb,
  baseline         jsonb not null default '{}'::jsonb,   -- the metrics the suggestion was based on
  campaign_log_id  text references public.campaign_logs(id) on delete set null,
  until            timestamptz,                          -- snoozed until
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);
create index if not exists bi_actions_salon_created_idx on public.bi_actions (salon_id, created_at desc);
create index if not exists bi_actions_salon_key_idx on public.bi_actions (salon_id, insight_key);
alter table public.bi_actions enable row level security;
drop policy if exists p_bi_actions_read on public.bi_actions;
create policy p_bi_actions_read on public.bi_actions for select
  using (salon_id = (select public.current_salon_id()) and (select public.is_manager()));
drop policy if exists p_bi_actions_write on public.bi_actions;
create policy p_bi_actions_write on public.bi_actions for insert
  with check (salon_id = (select public.current_salon_id()) and (select public.is_manager()));
revoke all on public.bi_actions from anon;
grant select, insert on public.bi_actions to authenticated;

-- Frequency-cap lookups ("did this phone get a campaign SMS lately?").
create index if not exists sms_messages_campaign_phone_idx
  on public.sms_messages (salon_id, to_phone, created_at desc) where kind = 'campaign';

-- ------------------------------------------------------------ helpers ------
/** 10:00 the same/next day when p_at falls in quiet hours (salon local time). */
create or replace function public.outside_quiet_hours(p_at timestamptz)
returns timestamptz
language sql stable set search_path = public as $fn$
  with t as (
    select coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran') as tz
  ), l as (
    select (greatest(p_at, now()) at time zone t.tz) as local_ts, t.tz from t
  )
  select case
    when extract(hour from local_ts) < 9  then (date_trunc('day', local_ts) + interval '10 hours') at time zone tz
    when extract(hour from local_ts) >= 21 then (date_trunc('day', local_ts) + interval '1 day 10 hours') at time zone tz
    else greatest(p_at, now())
  end
  from l;
$fn$;

-- ------------------------------------------------------ queue_campaign -----
-- p_recipients: [{ "phone": "09…", "name": "…", "vars": { … } }, …]
-- p_body: template with {{name}}, {{salon}}, {{days}}, … rendered per person.
create or replace function public.queue_campaign(
  p_insight_key text, p_title text, p_segment text, p_body text, p_recipients jsonb,
  p_send_at timestamptz default null, p_cap_days int default 14, p_baseline jsonb default '{}'::jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_salon_name text;
  v_send_at timestamptz;
  v_campaign_id text := 'cmp-' || substr(md5(gen_random_uuid()::text), 1, 12);
  v_log_id text;
  v_total int; v_opted int; v_recent int; v_invalid int; v_queued int;
begin
  if v_salon is null or not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if coalesce(trim(p_body), '') = '' then
    return json_build_object('ok', false, 'error', 'متن پیامک خالی است');
  end if;
  if length(p_body) > 600 then
    return json_build_object('ok', false, 'error', 'متن پیامک خیلی طولانی است');
  end if;
  if jsonb_typeof(p_recipients) is distinct from 'array' or jsonb_array_length(p_recipients) = 0 then
    return json_build_object('ok', false, 'error', 'گیرنده‌ای انتخاب نشده');
  end if;
  if jsonb_array_length(p_recipients) > 5000 then
    return json_build_object('ok', false, 'error', 'حداکثر ۵۰۰۰ گیرنده در هر ارسال');
  end if;
  select name into v_salon_name from public.salons where id = v_salon;
  v_send_at := public.outside_quiet_hours(coalesce(p_send_at, now()));
  if v_send_at > now() + interval '14 days' then
    return json_build_object('ok', false, 'error', 'زمان ارسال حداکثر ۱۴ روز بعد');
  end if;

  drop table if exists _rcpt;
  create temp table _rcpt on commit drop as
  select distinct on (r.phone) r.phone, r.name, r.vars,
         (r.phone !~ '^09[0-9]{9}$') as invalid,
         coalesce(c.sms_opt_out, false) as opted_out,
         exists (select 1 from public.sms_messages m
                  where m.salon_id = v_salon and m.to_phone = r.phone and m.kind = 'campaign'
                    and m.status in ('queued', 'sending', 'sent', 'delivered')
                    and coalesce(m.sent_at, m.scheduled_for, m.created_at) > now() - make_interval(days => greatest(coalesce(p_cap_days, 14), 0))
                    and coalesce(p_cap_days, 14) > 0) as recent
    from (
      select trim(coalesce(e ->> 'phone', '')) as phone,
             nullif(trim(coalesce(e ->> 'name', '')), '') as name,
             coalesce(e -> 'vars', '{}'::jsonb) as vars
        from jsonb_array_elements(p_recipients) e
    ) r
    left join public.customers c on c.salon_id = v_salon and c.phone = r.phone
   order by r.phone;

  select count(*), count(*) filter (where invalid), count(*) filter (where opted_out and not invalid),
         count(*) filter (where recent and not opted_out and not invalid)
    into v_total, v_invalid, v_opted, v_recent from _rcpt;
  v_queued := v_total - v_invalid - v_opted - v_recent;
  if v_queued <= 0 then
    return json_build_object('ok', false, 'error', 'همهٔ گیرنده‌ها کنار گذاشته شدند (انصراف یا پیامک اخیر)',
                             'skipped_opt_out', v_opted, 'skipped_recent', v_recent, 'skipped_invalid', v_invalid);
  end if;

  insert into public.campaigns (id, salon_id, name, status, targeted_count)
  values (v_campaign_id, v_salon, coalesce(nullif(p_title, ''), 'کمپین'), 'sent', v_queued);
  insert into public.campaign_logs (salon_id, template_id, template_label, segment, total_sent, successful_count, created_by, sent_at)
  values (v_salon, coalesce(nullif(p_segment, ''), 'bi_' || p_insight_key), coalesce(nullif(p_title, ''), 'کمپین'),
          nullif(p_segment, ''), v_queued, 0, auth.uid(), v_send_at)
  returning id into v_log_id;
  insert into public.campaign_targets (salon_id, campaign_id, customer_phone)
  select v_salon, v_campaign_id, phone from _rcpt where not (invalid or opted_out or recent)
  on conflict (campaign_id, customer_phone) do nothing;
  insert into public.sms_messages (salon_id, to_phone, body, kind, campaign_id, campaign_log_id, status, scheduled_for)
  select v_salon, phone,
         public.render_sms(p_body, jsonb_build_object('name', coalesce(name, 'مشتری'), 'salon', coalesce(v_salon_name, '')) || vars),
         'campaign', v_campaign_id, v_log_id, 'queued', v_send_at
    from _rcpt where not (invalid or opted_out or recent);

  insert into public.bi_actions (salon_id, insight_key, kind, title, params, baseline, campaign_log_id)
  values (v_salon, p_insight_key, 'campaign', coalesce(p_title, ''),
          jsonb_build_object('segment', p_segment, 'queued', v_queued, 'send_at', v_send_at, 'body', p_body),
          coalesce(p_baseline, '{}'::jsonb), v_log_id);

  return json_build_object('ok', true, 'queued', v_queued, 'send_at', v_send_at, 'campaign_log_id', v_log_id,
                           'skipped_opt_out', v_opted, 'skipped_recent', v_recent, 'skipped_invalid', v_invalid,
                           'deferred', v_send_at > now() + interval '2 minutes');
end;
$fn$;
revoke all on function public.queue_campaign(text, text, text, text, jsonb, timestamptz, int, jsonb) from public, anon;
grant execute on function public.queue_campaign(text, text, text, text, jsonb, timestamptz, int, jsonb) to authenticated;

-- Phones that got a campaign SMS from this salon in the last p_days — the
-- action wizard shows them as "recently contacted" before sending.
create or replace function public.recent_campaign_phones(p_days int default 14)
returns table (phone text)
language sql stable security definer set search_path = public as $fn$
  select distinct m.to_phone
    from public.sms_messages m
   where public.is_manager()
     and m.salon_id = public.current_salon_id()
     and m.kind = 'campaign'
     and m.status in ('queued', 'sending', 'sent', 'delivered')
     and coalesce(m.sent_at, m.scheduled_for, m.created_at) > now() - make_interval(days => greatest(p_days, 0));
$fn$;
revoke all on function public.recent_campaign_phones(int) from public, anon;
grant execute on function public.recent_campaign_phones(int) to authenticated;

-- ------------------------------------------------- record / snooze ---------
create or replace function public.record_bi_action(p_insight_key text, p_kind text, p_status text,
                                                   p_title text default '', p_params jsonb default '{}'::jsonb,
                                                   p_baseline jsonb default '{}'::jsonb, p_snooze_days int default 7)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_id uuid;
begin
  if v_salon is null or not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_status not in ('done', 'snoozed', 'dismissed') or p_kind not in ('campaign', 'automation', 'reminder', 'goto') then
    return json_build_object('ok', false, 'error', 'درخواست نامعتبر');
  end if;
  insert into public.bi_actions (salon_id, insight_key, kind, status, title, params, baseline, until)
  values (v_salon, left(p_insight_key, 120), p_kind, p_status, left(coalesce(p_title, ''), 200),
          coalesce(p_params, '{}'::jsonb), coalesce(p_baseline, '{}'::jsonb),
          case when p_status = 'snoozed' then now() + make_interval(days => least(greatest(coalesce(p_snooze_days, 7), 1), 90)) end)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
revoke all on function public.record_bi_action(text, text, text, text, jsonb, jsonb, int) from public, anon;
grant execute on function public.record_bi_action(text, text, text, text, jsonb, jsonb, int) to authenticated;

-- ------------------------------------------------------ history + results --
-- Conversions come from campaign_conversions (a booking made within 7 days of
-- the customer's campaign SMS, see track_campaign_conversion); revenue counts
-- only those bookings that were completed.
create or replace function public.bi_action_history(p_limit int default 50)
returns table (
  id uuid, insight_key text, kind text, status text, title text, params jsonb, baseline jsonb,
  until timestamptz, created_at timestamptz, campaign_log_id text,
  sms_queued int, sms_sent int, sms_failed int, conversions int, revenue bigint, measure_until timestamptz
)
language sql stable security definer set search_path = public as $fn$
  select a.id, a.insight_key, a.kind, a.status, a.title, a.params, a.baseline, a.until, a.created_at, a.campaign_log_id,
         coalesce(s.queued, 0), coalesce(s.sent, 0), coalesce(s.failed, 0),
         coalesce(cv.n, 0), coalesce(cv.revenue, 0),
         case when a.campaign_log_id is not null then coalesce(cl.sent_at, a.created_at) + interval '7 days' end
    from public.bi_actions a
    left join public.campaign_logs cl on cl.id = a.campaign_log_id
    left join lateral (
      select count(*) filter (where m.status in ('queued', 'sending'))::int as queued,
             count(*) filter (where m.status in ('sent', 'delivered'))::int as sent,
             count(*) filter (where m.status = 'failed')::int as failed
        from public.sms_messages m where m.campaign_log_id = a.campaign_log_id and m.salon_id = a.salon_id
    ) s on a.campaign_log_id is not null
    left join lateral (
      select count(distinct c.customer_phone)::int as n,
             coalesce(sum(ap.final_price) filter (where ap.status = 'completed'), 0)::bigint as revenue
        from public.campaign_conversions c
        left join public.appointments ap on ap.id = c.appointment_id
       where c.campaign_log_id = a.campaign_log_id and c.salon_id = a.salon_id
    ) cv on a.campaign_log_id is not null
   where public.is_manager() and a.salon_id = public.current_salon_id()
   order by a.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$fn$;
revoke all on function public.bi_action_history(int) from public, anon;
grant execute on function public.bi_action_history(int) to authenticated;

-- --------------------------------------- delivered campaign SMS counted ----
create or replace function public.count_campaign_delivery()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.campaign_log_id is not null and new.status in ('sent', 'delivered')
     and old.status not in ('sent', 'delivered') then
    update public.campaign_logs set successful_count = successful_count + 1 where id = new.campaign_log_id;
  end if;
  return new;
end;
$fn$;
revoke all on function public.count_campaign_delivery() from public, anon, authenticated;
drop trigger if exists trg_count_campaign_delivery on public.sms_messages;
create trigger trg_count_campaign_delivery after update of status on public.sms_messages
  for each row execute function public.count_campaign_delivery();

-- ------------------------------------------------ fair, prioritised queue ---
-- With campaigns queued server-side, one salon's 5000-SMS campaign used to
-- sit in front of every salon's booking confirmations and reminders (the
-- claim took the oldest due rows first). Now: transactional messages first,
-- then campaigns interleaved across salons (each salon's 1st, then each
-- salon's 2nd, …). Exactly-once is kept: candidates are locked with SKIP
-- LOCKED and re-checked before being marked 'sending'.
create or replace function public.claim_due_sms(p_limit integer default 200)
returns setof public.sms_messages
language plpgsql security definer set search_path = public as $fn$
begin
  return query
  with due as (
    select q.id,
           (q.kind = 'campaign') as is_campaign,
           row_number() over (partition by q.salon_id, (q.kind = 'campaign') order by q.scheduled_for, q.id) as turn,
           q.scheduled_for
      from public.sms_messages q
      join public.salons s on s.id = q.salon_id and s.active
     where q.scheduled_for <= now()
       and (q.status = 'queued' or (q.status = 'sending' and q.claimed_at < now() - interval '10 minutes'))
  ), picked as (
    select d.id from due d
     order by d.is_campaign, d.turn, d.scheduled_for
     limit greatest(p_limit, 1)
  ), locked as (
    select m.id from public.sms_messages m
     where m.id in (select id from picked)
       for update skip locked
  )
  update public.sms_messages m
     set status = 'sending', claimed_at = now()
   where m.id in (select id from locked)
     and (m.status = 'queued' or (m.status = 'sending' and m.claimed_at < now() - interval '10 minutes'))
  returning m.*;
end;
$fn$;
revoke all on function public.claim_due_sms(int) from public, anon, authenticated;
grant execute on function public.claim_due_sms(int) to service_role;
