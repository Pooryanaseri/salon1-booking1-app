-- Migration v2.15 — fix stylist unauthorized-access issues. Idempotent, no
-- data changes. Root causes found: (1) several policies used is_staff()
-- (any active user) where role-specific scoping was needed; (2) two
-- policies checked my_role()='stylist' without is_staff() (active check),
-- so a deactivated stylist account could still act; (3) a stylist's own-
-- booking UPDATE had no field-level limit — could reassign staff_id,
-- change customer_phone/name, price, discounts.

-- 1) appointments SELECT: stylist scoped to own staff_id (was: any signed-
--    in user via is_staff() through no dedicated policy — actually was
--    `using (true)`, open to everyone; anonymous access left as-is here,
--    since replacing it changes the public booking flow's data access
--    pattern, out of scope for this stylist-focused fix — flagged in
--    the summary for a follow-up).
drop policy if exists p_appt_select on public.appointments;
create policy p_appt_select on public.appointments for select using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or auth.uid() is null
);

-- 2) appointments UPDATE: add the missing active-account check to the
--    stylist branch (was my_role()='stylist' alone — a deactivated
--    stylist's still-valid session could act).
drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or auth.uid() is null
) with check (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or (auth.uid() is null and status in ('cancelled', 'rescheduled'))
);

-- 3) Field-level lock for a stylist's own-booking updates (mirrors the
--    existing anonymous-customer lock in the same trigger): a stylist may
--    change status/pending_*/referral_verified on their own bookings, but
--    not reassign staff_id (record ownership), edit customer identity, or
--    change price/discount.
create or replace function public.guard_anonymous_appt_update() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or new.final_price is distinct from old.final_price
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value
       or new.referral_verified is distinct from old.referral_verified then
      raise exception 'این تغییر برای مشتری مجاز نیست — فقط لغو یا جابه‌جایی زمان مجاز است';
    end if;
    insert into public.audit_log (event, actor, detail) values (
      'appointment_self_update', null,
      jsonb_build_object('appointment_id', new.id, 'from_status', old.status, 'to_status', new.status)
    );
  elsif public.my_role() = 'stylist' and not public.is_manager() then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or new.final_price is distinct from old.final_price
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value then
      raise exception 'این تغییر خارج از اختیار آرایشگر است';
    end if;
  end if;
  return new;
end;
$fn$;
-- Trigger definition unchanged — replacing the function body is enough.

-- 4) working_hours / time_offs: add the missing active-account check.
drop policy if exists p_sched_write on public.working_hours;
create policy p_sched_write on public.working_hours for all
  using (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

drop policy if exists p_sched_write on public.time_offs;
create policy p_sched_write on public.time_offs for all
  using (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

-- 5) approved_dates: which days the WHOLE SALON is open for booking is a
--    manager decision, not a per-stylist one — was is_staff() (any active
--    signed-in user, stylist included).
drop policy if exists p_sched_write on public.approved_dates;
create policy p_sched_write on public.approved_dates for all
  using (public.is_manager()) with check (public.is_manager());

-- 6) Back-office tables: was a blanket is_staff() read for every signed-in
--    user. expenses/campaigns/campaign_targets/sms_messages/sms_templates/
--    loyalty_ledger have no legitimate per-stylist scope — accounting,
--    campaigns, SMS log/templates, and the full loyalty ledger are
--    manager-only now.
do $$
declare t text;
begin
  foreach t in array array['expenses','campaigns','campaign_targets','sms_messages','sms_templates','loyalty_ledger'] loop
    execute format('drop policy if exists p_staff_read on public.%I', t);
    execute format('create policy p_staff_read on public.%I for select using (public.is_manager())', t);
  end loop;
end $$;

-- 7) customers: "essential customer info of that same booking" means a
--    stylist may look up a customer they've actually had an appointment
--    with — not the whole customer bank. (Most of the app reads customer
--    name/phone straight off the appointments row, which is already
--    correctly scoped by fix #1 above; this covers the few call sites,
--    like referral-verification at checkout, that query customers
--    directly.)
drop policy if exists p_staff_read on public.customers;
create policy p_staff_read on public.customers for select using (
  public.is_manager()
  or (
    public.is_staff() and public.my_role() = 'stylist'
    and exists (
      select 1 from public.appointments a
      where a.customer_phone = customers.phone and a.staff_id = public.my_stylist_id()
    )
  )
);

-- 8) campaign_logs / campaign_conversions: campaign analytics — manager-only.
drop policy if exists p_campaign_logs_read on public.campaign_logs;
create policy p_campaign_logs_read on public.campaign_logs for select using (public.is_manager());
drop policy if exists p_campaign_logs_write on public.campaign_logs;
create policy p_campaign_logs_write on public.campaign_logs for insert with check (public.is_manager());

drop policy if exists p_campaign_conversions_read on public.campaign_conversions;
create policy p_campaign_conversions_read on public.campaign_conversions for select using (public.is_manager());

-- 9) get_campaign_performance(): tighten from is_staff() to is_manager()
--    (campaigns are manager-only per #8; a stylist could otherwise still
--    read this RPC even without campaign_logs table access, since it's
--    security definer).
create or replace function public.get_campaign_performance(p_template_id text default null)
returns table (
  template_id text, template_label text, segment text,
  total_sent bigint, successful_count bigint,
  total_conversions bigint, conversion_rate numeric,
  attributed_revenue bigint
)
language sql stable security definer set search_path = public as $fn$
  select
    cl.template_id,
    max(cl.template_label) as template_label,
    max(cl.segment) as segment,
    sum(cl.total_sent)::bigint as total_sent,
    sum(cl.successful_count)::bigint as successful_count,
    count(distinct cc.id)::bigint as total_conversions,
    case when sum(cl.successful_count) = 0 then 0::numeric
         else round(count(distinct cc.id)::numeric / sum(cl.successful_count) * 100, 1)
    end as conversion_rate,
    coalesce(sum(a.final_price) filter (where a.status = 'completed'), 0)::bigint as attributed_revenue
  from public.campaign_logs cl
  left join public.campaign_conversions cc on cc.campaign_log_id = cl.id
  left join public.appointments a on a.id = cc.appointment_id
  where public.is_manager()
    and (p_template_id is null or cl.template_id = p_template_id)
  group by cl.template_id
  order by conversion_rate desc;
$fn$;

-- 10) Customer segmentation RPCs: reverts an earlier "open to all staff"
--     change (v2.6) — segment views expose the full customer base's
--     names/phones/spend, which is exactly the "customer bank" this
--     migration restricts. Manager-only now; the appointments-level fix
--     in #1 already gives a stylist their own customers' essential info.
create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  segment text, segment_fa text,
  avg_gap_days numeric, personal_recency_limit int, is_vip boolean
)
language sql stable security definer set search_path = public as $fn$
  with settings as (
    select * from public.customer_segment_settings where id = 1
  ),
  gaps as (
    select
      customer_phone,
      (date - lag(date) over (partition by customer_phone order by date))::int as gap_days
    from public.appointments
    where status = 'completed'
  ),
  avg_gaps as (
    select customer_phone, avg(gap_days)::numeric as avg_gap_days
    from gaps
    where gap_days is not null and gap_days > 0
    group by customer_phone
  ),
  monetary_p80 as (
    select percentile_cont(0.80) within group (order by monetary)::bigint as p80
    from public.customer_rfm_raw
    where frequency > 0
  ),
  scored as (
    select
      raw.*,
      ag.avg_gap_days,
      case
        when coalesce(ag.avg_gap_days, 0) > 0
          then greatest(s.loyal_recency_days, round(ag.avg_gap_days * 1.5)::int)
        else s.loyal_recency_days
      end as personal_recency_limit,
      s.loyal_min_visits,
      mp.p80
    from public.customer_rfm_raw raw
    left join avg_gaps ag on ag.customer_phone = raw.phone
    cross join settings s
    cross join monetary_p80 mp
    where public.is_manager()
  )
  select
    phone, name, sms_opt_out, recency_days, frequency, monetary,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'champions'
      when recency_days >  personal_recency_limit and frequency >= loyal_min_visits then 'at_risk'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'new'
      else 'inactive'
    end as segment,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'مشتریان وفادار'
      when recency_days >  personal_recency_limit and frequency >= loyal_min_visits then 'در خطر ریزش'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'مشتریان جدید'
      else 'غیرفعال'
    end as segment_fa,
    avg_gap_days, personal_recency_limit,
    (recency_days <= personal_recency_limit
       and frequency >= loyal_min_visits
       and monetary >= coalesce(p80, monetary + 1)) as is_vip
  from scored;
$fn$;

create or replace function public.get_customer_category_matrix()
returns table (
  phone text, name text, category text, category_fa text,
  visit_count int, last_visit_days int, line_status text, line_status_fa text
)
language sql stable security definer set search_path = public as $fn$
  with cat_stats as (
    select
      a.customer_phone as phone, c.name, s.category,
      count(a.id)::int as visit_count,
      extract(day from (now() - max(a.date)))::int as last_visit_days
    from public.appointments a
    join public.services s on s.id = a.service_id
    join public.customers c on c.phone = a.customer_phone
    where a.status = 'completed'
    group by a.customer_phone, c.name, s.category
  )
  select
    phone, name, category,
    case category
      when 'hair' then 'مو' when 'beard' then 'ریش' when 'color' then 'رنگ'
      when 'makeup' then 'میکاپ' when 'nails' then 'ناخن' when 'skin' then 'پوست'
      when 'permanent_makeup' then 'خدمات دائم' else category
    end as category_fa,
    visit_count, last_visit_days,
    case when last_visit_days <= 45 then 'active' when last_visit_days <= 90 then 'at_risk' else 'dormant' end as line_status,
    case when last_visit_days <= 45 then 'فعال در این خط خدمت'
         when last_visit_days <= 90 then 'در خطر ریزش در این خط خدمت'
         else 'غیرفعال در این خط خدمت' end as line_status_fa
  from cat_stats
  where public.is_manager()
  order by phone, category;
$fn$;

create or replace function public.preview_customer_segment_distribution(
  p_recency int, p_visits int, p_inactive int
)
returns table (segment text, segment_fa text, customer_count bigint, pct numeric)
language sql stable security definer set search_path = public as $fn$
  with classified as (
    select
      case
        when raw.recency_days <= p_recency and raw.frequency >= p_visits then 'champions'
        when raw.recency_days >  p_recency and raw.frequency >= p_visits then 'at_risk'
        when raw.recency_days <= p_recency and raw.frequency <  p_visits then 'new'
        else 'inactive'
      end as segment
    from public.customer_rfm_raw raw
    where public.is_manager()
  ),
  totals as (select count(*) as n from classified),
  counted as (select segment, count(*) as customer_count from classified group by segment)
  select
    seg.key as segment,
    case seg.key when 'champions' then 'مشتریان وفادار' when 'at_risk' then 'در خطر ریزش'
                 when 'new' then 'مشتریان جدید' else 'غیرفعال' end as segment_fa,
    coalesce(counted.customer_count, 0) as customer_count,
    case when (select n from totals) = 0 then 0
         else round(coalesce(counted.customer_count, 0)::numeric / (select n from totals) * 100, 1)
    end as pct
  from (values ('champions'), ('at_risk'), ('new'), ('inactive')) as seg(key)
  left join counted on counted.segment = seg.key;
$fn$;
