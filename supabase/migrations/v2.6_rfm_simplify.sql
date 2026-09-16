-- ============================================================================
--  Migration v2.6 — simpler, stylist-accessible customer segmentation
--  Run AFTER schema.sql + earlier migrations. Idempotent.
--
--  Two changes to get_customer_rfm_segments():
--  1. Opened to any active staff member (was manager-only) — a stylist
--     deciding who to follow up with needs this as much as the owner does.
--  2. Simplified from 6 overlapping segments down to 4 clean, actionable
--     ones. The old "نیازمند توجه" / "در خطر ریزش" split and the
--     "پتانسیل وفاداری" catch-all get merged into whichever real category
--     they're closest to — the follow-up message was the same either way.
-- ============================================================================

create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  r_score int, f_score int, m_score int,
  segment text, segment_fa text
)
language sql stable security definer set search_path = public as $fn$
  with scored as (
    select
      raw.*,
      case when raw.recency_days <= 30  then 4
           when raw.recency_days <= 60  then 3
           when raw.recency_days <= 120 then 2
           else 1 end as r_score,
      case when raw.frequency >= 8 then 4
           when raw.frequency >= 4 then 3
           when raw.frequency >= 2 then 2
           else 1 end as f_score,
      ntile(4) over (order by raw.monetary asc) as m_score
    from public.customer_rfm_raw raw
    where public.is_staff()
  )
  select
    phone, name, sms_opt_out, recency_days, frequency, monetary, r_score, f_score, m_score,
    case
      when r_score >= 3 and f_score >= 3 then 'champions'
      when r_score <= 2 and f_score >= 3 then 'at_risk'
      when r_score >= 3 and f_score < 3  then 'new'
      else 'inactive'
    end as segment,
    case
      when r_score >= 3 and f_score >= 3 then 'مشتریان وفادار'
      when r_score <= 2 and f_score >= 3 then 'در خطر ریزش'
      when r_score >= 3 and f_score < 3  then 'مشتریان جدید'
      else 'غیرفعال'
    end as segment_fa
  from scored;
$fn$;
grant execute on function public.get_customer_rfm_segments() to authenticated;
