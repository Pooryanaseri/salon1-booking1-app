-- Migration v2.23 — fix two real contradictions in customer segmentation
-- (تنظیمات دسته‌بندی مشتریان). Idempotent, no data changes, does not
-- modify any earlier migration.
--
-- CONTRADICTION 1: inactive_after_days (UI label: "روز عدم مراجعه برای
-- «غیرفعال»") was collected from the manager, validated (must be greater
-- than loyal_recency_days), and saved to customer_segment_settings — but
-- was NEVER referenced in either get_customer_rfm_segments() or
-- preview_customer_segment_distribution()'s actual classification logic.
-- "inactive" was just the leftover bucket for anyone not
-- champions/at_risk/new, entirely determined by loyal_recency_days and
-- loyal_min_visits. Changing this setting had zero effect on results —
-- confirmed directly in the SQL: preview_customer_segment_distribution
-- even had a code comment acknowledging "it isn't referenced further in
-- this query."
--
-- FIX: inactive_after_days now genuinely separates "در خطر ریزش"
-- (at_risk — lapsed, but still within the grace window, and was
-- previously loyal — worth a win-back campaign) from "غیرفعال" (inactive
-- — lapsed beyond the grace window, regardless of how loyal they were
-- before, OR was never loyal to begin with). champions/new are unchanged.
--
-- CONTRADICTION 2: get_customer_rfm_segments() computes a PERSONALIZED
-- recency threshold per customer (adjusted upward for customers whose own
-- average gap between visits is naturally longer than the salon default —
-- v2.11's "personal_recency_limit"), but preview_customer_segment_
-- distribution() classified against the FLAT p_recency parameter only,
-- with no personalization at all. This meant the preview could show
-- meaningfully different numbers than what actually happens after saving
-- (e.g. customers whose natural visit cadence is longer than the salon
-- default would be undercounted as champions in the preview, and
-- overcounted as at_risk/inactive).
--
-- FIX: preview now computes the exact same avg_gap_days-based
-- personalization as the live function, using the hypothetical
-- (p_recency, p_visits, p_inactive) parameters instead of the saved
-- settings row — so what the preview shows is what saving will produce.

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
      s.inactive_after_days,
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
    where public.is_manager()
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
