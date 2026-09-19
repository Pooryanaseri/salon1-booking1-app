-- ============================================================================
--  Migration v2.11 — advanced segmentation: personalized churn, VIP tiering,
--  category-level matrix
--  Run AFTER schema.sql + earlier migrations (through v2.10). Idempotent.
--
--  Three additions, all read-only analytics — no existing table's data is
--  modified, and no existing RPC's CALLERS need to change:
--
--  1. Personalized churn: get_customer_rfm_segments() now classifies
--     recency against a PER-CUSTOMER threshold (their own average gap
--     between completed visits × 1.5, floored at the salon-wide
--     loyal_recency_days setting) instead of one flat number for everyone.
--     A customer who naturally returns every ~90 days shouldn't be flagged
--     "at risk" at day 61 just because the salon default is 60.
--
--  2. VIP tiering: within the "champions" segment, customers whose total
--     completed spend is at or above the 80th percentile (among customers
--     with at least one completed visit) get is_vip = true.
--
--  3. Category matrix: a new function, get_customer_category_matrix(),
--     giving a per-customer × per-service-category view of how recently
--     they were last seen for THAT category specifically (a customer who
--     is a hair-color regular but hasn't had a facial in 8 months looks
--     very different line by line vs. as one blended average).
--
--  Backward compatibility: get_customer_rfm_segments()'s existing columns
--  (phone, name, sms_opt_out, recency_days, frequency, monetary, segment,
--  segment_fa) are unchanged in name, type, and meaning — segment still
--  returns exactly the same 4 values as before ('champions','at_risk',
--  'new','inactive'). Three columns are ADDED (avg_gap_days, personal_
--  recency_limit, is_vip); any existing caller that reads the old columns
--  by name keeps working untouched. DROP is required before CREATE OR
--  REPLACE here because Postgres cannot alter a function's return-table
--  shape in place (adding columns hits the same 42P16 "invalid table
--  definition" error as removing them would) — every aggregate below is
--  explicitly cast to the exact declared output type for the same reason
--  (count()/sum() default to bigint, avg()/percentile_cont() default to
--  numeric or double precision — left uncast, small differences between
--  what the query produces and what the RETURNS TABLE clause declares are
--  exactly what trips 42P16).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. get_customer_rfm_segments() — personalized recency + VIP tiering
-- ----------------------------------------------------------------------------
drop function if exists public.get_customer_rfm_segments();

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
  -- Gap between each customer's own consecutive completed visits (in days).
  -- date - date in Postgres yields a plain integer day count directly, no
  -- interval arithmetic/extraction needed.
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
  -- 80th percentile of total completed spend, among customers who have at
  -- least one completed visit (frequency = 0 customers would just drag an
  -- all-customer percentile down toward zero without meaning anything).
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
    where public.is_staff()
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
    avg_gap_days,
    personal_recency_limit,
    -- VIP only means anything within "champions" — being a big spender who
    -- hasn't been back in a year doesn't make someone a VIP champion, it
    -- makes them a high-value at_risk/inactive customer instead.
    (recency_days <= personal_recency_limit
       and frequency >= loyal_min_visits
       and monetary >= coalesce(p80, monetary + 1)) as is_vip
  from scored;
$fn$;
grant execute on function public.get_customer_rfm_segments() to authenticated;

-- ----------------------------------------------------------------------------
-- 2. get_customer_category_matrix() — per-customer × per-service-category
--    recency, so "hair regular who's overdue for skincare" is visible at a
--    glance instead of buried inside one blended recency number.
-- ----------------------------------------------------------------------------
create or replace function public.get_customer_category_matrix()
returns table (
  phone text, name text, category text, category_fa text,
  visit_count int, last_visit_days int, line_status text, line_status_fa text
)
language sql stable security definer set search_path = public as $fn$
  with cat_stats as (
    select
      a.customer_phone as phone,
      c.name,
      s.category,
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
      when 'hair'             then 'مو'
      when 'beard'             then 'ریش'
      when 'color'             then 'رنگ'
      when 'makeup'            then 'میکاپ'
      when 'nails'             then 'ناخن'
      when 'skin'              then 'پوست'
      when 'permanent_makeup'  then 'خدمات دائم'
      else category
    end as category_fa,
    visit_count, last_visit_days,
    case
      when last_visit_days <= 45 then 'active'
      when last_visit_days <= 90 then 'at_risk'
      else 'dormant'
    end as line_status,
    case
      when last_visit_days <= 45 then 'فعال در این خط خدمت'
      when last_visit_days <= 90 then 'در خطر ریزش در این خط خدمت'
      else 'غیرفعال در این خط خدمت'
    end as line_status_fa
  from cat_stats
  where public.is_staff()
  order by phone, category;
$fn$;
grant execute on function public.get_customer_category_matrix() to authenticated;
