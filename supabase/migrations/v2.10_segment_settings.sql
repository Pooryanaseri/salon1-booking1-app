-- ============================================================================
--  Migration v2.10 — configurable customer segmentation (manager-only)
--  Run AFTER schema.sql + earlier migrations. Idempotent.
--
--  Replaces the fixed R/F-score grid in get_customer_rfm_segments() with a
--  single, manager-configurable singleton (mirroring the existing
--  loyalty_settings id=1 pattern exactly) and direct threshold comparisons.
--  Recency and frequency are now computed strictly from `completed`
--  appointments (previously recency came from customers.last_booking_at,
--  which could reflect a booking that was later cancelled or no-showed).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. customer_segment_settings — singleton, same shape as loyalty_settings
-- ----------------------------------------------------------------------------
create table if not exists public.customer_segment_settings (
  id                   int primary key default 1 check (id = 1),
  loyal_recency_days   int not null default 60  check (loyal_recency_days between 1 and 365),
  loyal_min_visits     int not null default 4   check (loyal_min_visits between 1 and 100),
  inactive_after_days  int not null default 120 check (inactive_after_days > loyal_recency_days),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id)
);
insert into public.customer_segment_settings (id) values (1) on conflict (id) do nothing;

alter table public.customer_segment_settings enable row level security;

drop policy if exists p_segment_settings_read on public.customer_segment_settings;
create policy p_segment_settings_read on public.customer_segment_settings
  for select using (public.is_staff() or public.is_manager());

drop policy if exists p_segment_settings_write on public.customer_segment_settings;
create policy p_segment_settings_write on public.customer_segment_settings
  for update using (public.is_manager()) with check (public.is_manager());

grant select, update on public.customer_segment_settings to authenticated;

-- ----------------------------------------------------------------------------
-- 2. customer_rfm_raw — recency/frequency now computed strictly from
--    completed appointments (was: customers.last_booking_at / total_visits,
--    which could include bookings that never actually happened).
-- ----------------------------------------------------------------------------
create or replace view public.customer_rfm_raw as
select
  c.phone,
  c.name,
  c.sms_opt_out,
  coalesce(extract(day from (now() - max(a.date)))::int, 9999) as recency_days,
  count(a.id) as frequency,
  coalesce(sum(a.final_price), 0) as monetary
from public.customers c
left join public.appointments a
  on a.customer_phone = c.phone and a.status = 'completed'
group by c.phone, c.name, c.sms_opt_out;

-- ----------------------------------------------------------------------------
-- 3. get_customer_rfm_segments() — direct threshold classification, reading
--    live from customer_segment_settings. Return signature drops the old
--    r_score/f_score/m_score columns (meaningless under direct thresholds;
--    nothing in the frontend reads them) — DROP is required first since
--    CREATE OR REPLACE cannot change a function's return columns.
-- ----------------------------------------------------------------------------
drop function if exists public.get_customer_rfm_segments();

create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  segment text, segment_fa text
)
language sql stable security definer set search_path = public as $fn$
  with settings as (
    select * from public.customer_segment_settings where id = 1
  )
  select
    raw.phone, raw.name, raw.sms_opt_out, raw.recency_days, raw.frequency, raw.monetary,
    case
      when raw.recency_days <= s.loyal_recency_days and raw.frequency >= s.loyal_min_visits then 'champions'
      when raw.recency_days >  s.loyal_recency_days and raw.frequency >= s.loyal_min_visits then 'at_risk'
      when raw.recency_days <= s.loyal_recency_days and raw.frequency <  s.loyal_min_visits then 'new'
      else 'inactive'
    end as segment,
    case
      when raw.recency_days <= s.loyal_recency_days and raw.frequency >= s.loyal_min_visits then 'مشتریان وفادار'
      when raw.recency_days >  s.loyal_recency_days and raw.frequency >= s.loyal_min_visits then 'در خطر ریزش'
      when raw.recency_days <= s.loyal_recency_days and raw.frequency <  s.loyal_min_visits then 'مشتریان جدید'
      else 'غیرفعال'
    end as segment_fa
  from public.customer_rfm_raw raw, settings s
  where public.is_staff();
$fn$;
grant execute on function public.get_customer_rfm_segments() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. preview_customer_segment_distribution() — same classification logic
--    against HYPOTHETICAL thresholds passed as parameters, so a manager can
--    see the effect of a change before saving it. Reads live customer data
--    but never writes anything.
-- ----------------------------------------------------------------------------
create or replace function public.preview_customer_segment_distribution(
  p_recency int, p_visits int, p_inactive int
)
returns table (segment text, segment_fa text, customer_count bigint, pct numeric)
language sql stable security definer set search_path = public as $fn$
  -- p_inactive is accepted for parameter symmetry with the 3-field settings
  -- form (and to leave room for a future "hibernating beyond N days" split),
  -- but the current 4-way classification below is fully determined by the
  -- recency/visits crossover alone, matching get_customer_rfm_segments()
  -- exactly — it isn't referenced further in this query.
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
grant execute on function public.preview_customer_segment_distribution(int, int, int) to authenticated;
