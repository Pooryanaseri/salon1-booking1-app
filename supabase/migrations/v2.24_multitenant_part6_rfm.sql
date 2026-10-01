-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 6: customer
-- segmentation RPCs)
-- ============================================================================
-- customer_rfm_raw joined customers to appointments by customer_phone
-- alone, with no salon_id match — since the same phone number can now be
-- a genuinely different customer at two different salons (part 2), this
-- join could attribute salon B's appointments to salon A's customer row
-- sharing that phone number. get_customer_rfm_segments() and
-- preview_customer_segment_distribution() both also read
-- customer_segment_settings via the old `where id = 1` singleton pattern,
-- which no longer exists after part 4 re-keyed that table on salon_id.
-- ============================================================================

drop view if exists public.customer_rfm_raw;
create view public.customer_rfm_raw as
select
  c.salon_id,
  c.phone,
  c.name,
  c.sms_opt_out,
  coalesce(extract(day from (now() - max(a.date)))::int, 9999) as recency_days,
  count(a.id) as frequency,
  coalesce(sum(a.final_price), 0) as monetary
from public.customers c
left join public.appointments a
  on a.customer_phone = c.phone and a.salon_id = c.salon_id and a.status = 'completed'
group by c.salon_id, c.phone, c.name, c.sms_opt_out;

create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  segment text, segment_fa text,
  avg_gap_days numeric, personal_recency_limit int, is_vip boolean
)
language sql stable security definer set search_path = public as $fn$
  with settings as (
    select * from public.customer_segment_settings where salon_id = public.current_salon_id()
  ),
  gaps as (
    select
      customer_phone, salon_id,
      (date - lag(date) over (partition by customer_phone, salon_id order by date))::int as gap_days
    from public.appointments
    where status = 'completed' and salon_id = public.current_salon_id()
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
    where frequency > 0 and salon_id = public.current_salon_id()
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
      s.inactive_after_days,
      mp.p80
    from public.customer_rfm_raw raw
    left join avg_gaps ag on ag.customer_phone = raw.phone
    cross join settings s
    cross join monetary_p80 mp
    where public.is_manager() and raw.salon_id = public.current_salon_id()
  )
  select
    phone, name, sms_opt_out, recency_days, frequency, monetary,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'champions'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'new'
      when recency_days >  personal_recency_limit and recency_days <= inactive_after_days
           and frequency >= loyal_min_visits then 'at_risk'
      else 'inactive'
    end as segment,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'مشتریان وفادار'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'مشتریان جدید'
      when recency_days >  personal_recency_limit and recency_days <= inactive_after_days
           and frequency >= loyal_min_visits then 'در خطر ریزش'
      else 'غیرفعال'
    end as segment_fa,
    avg_gap_days, personal_recency_limit,
    (recency_days <= personal_recency_limit
       and frequency >= loyal_min_visits
       and monetary >= coalesce(p80, monetary + 1)) as is_vip
  from scored
  order by monetary desc
  limit 500;
$fn$;

create or replace function public.preview_customer_segment_distribution(
  p_recency int, p_visits int, p_inactive int
)
returns table (segment text, segment_fa text, customer_count bigint, pct numeric)
language sql stable security definer set search_path = public as $fn$
  with gaps as (
    select
      customer_phone, salon_id,
      (date - lag(date) over (partition by customer_phone, salon_id order by date))::int as gap_days
    from public.appointments
    where status = 'completed' and salon_id = public.current_salon_id()
  ),
  avg_gaps as (
    select customer_phone, avg(gap_days)::numeric as avg_gap_days
    from gaps
    where gap_days is not null and gap_days > 0
    group by customer_phone
  ),
  with_limit as (
    select
      raw.recency_days, raw.frequency,
      case
        when coalesce(ag.avg_gap_days, 0) > 0
          then greatest(p_recency, round(ag.avg_gap_days * 1.5)::int)
        else p_recency
      end as personal_limit
    from public.customer_rfm_raw raw
    left join avg_gaps ag on ag.customer_phone = raw.phone
    where public.is_manager() and raw.salon_id = public.current_salon_id()
  ),
  classified as (
    select
      case
        when recency_days <= personal_limit and frequency >= p_visits then 'champions'
        when recency_days <= personal_limit and frequency <  p_visits then 'new'
        when recency_days >  personal_limit and recency_days <= p_inactive
             and frequency >= p_visits then 'at_risk'
        else 'inactive'
      end as segment
    from with_limit
  ),
  totals as (select count(*) as n from classified),
  counted as (
    select segment, count(*) as customer_count
    from classified
    group by segment
  )
  select
    seg.key as segment,
    case seg.key
      when 'champions' then 'مشتریان وفادار'
      when 'at_risk'   then 'در خطر ریزش'
      when 'new'       then 'مشتریان جدید'
      else                  'غیرفعال'
    end as segment_fa,
    coalesce(counted.customer_count, 0) as customer_count,
    case when (select n from totals) = 0 then 0
         else round(coalesce(counted.customer_count, 0)::numeric / (select n from totals) * 100, 1)
    end as pct
  from (values ('champions'), ('at_risk'), ('new'), ('inactive')) as seg(key)
  left join counted on counted.segment = seg.key;
$fn$;
