-- Migration v2.18 — implements the improvement ideas noted in v2.17:
-- rate limiting on public RPCs, a feedback/NPS stats RPC for BI, and
-- pagination limits on queries that fetch the full customer base.
-- Idempotent, no data changes.

-- ----------------------------------------------------------------------------
-- 1) Lightweight rate limiting — a small event log + a checker function.
--    Not a general-purpose limiter; scoped to the two public RPCs that are
--    reachable with no login and take a phone number as their natural key
--    (get_my_bookings: enumeration risk; apply_referral: farming risk).
--    Internal bookkeeping only — RLS enabled with no policies, so it's
--    reachable exclusively through check_rate_limit() (security definer).
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id bigserial primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_bucket_idx on public.rate_limit_events (bucket, created_at);
alter table public.rate_limit_events enable row level security;

create or replace function public.check_rate_limit(p_bucket text, p_max_calls int, p_window_minutes int)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare recent_count int;
begin
  select count(*) into recent_count from public.rate_limit_events
   where bucket = p_bucket and created_at >= now() - (p_window_minutes || ' minutes')::interval;
  if recent_count >= p_max_calls then
    return false;
  end if;
  insert into public.rate_limit_events (bucket, created_at) values (p_bucket, now());
  -- Opportunistic cleanup instead of a separate cron job — low-probability
  -- so it doesn't add latency to most calls.
  if random() < 0.01 then
    delete from public.rate_limit_events where created_at < now() - interval '1 day';
  end if;
  return true;
end;
$fn$;
grant execute on function public.check_rate_limit(text, int, int) to anon, authenticated;

-- get_my_bookings: was `language sql stable` (no side effects) — adding a
-- rate-limit check means an insert now happens on every call, so this can
-- no longer be declared stable.
create or replace function public.get_my_bookings(p_phone text)
returns setof public.appointments
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.check_rate_limit('get_my_bookings:' || coalesce(p_phone, ''), 20, 10) then
    raise exception 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید';
  end if;
  return query
    select * from public.appointments
    where p_phone ~ '^09[0-9]{9}$' and customer_phone = p_phone
    order by date desc, start_min desc;
end;
$fn$;
grant execute on function public.get_my_bookings(text) to anon, authenticated;

create or replace function public.apply_referral(p_new_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $fn$
declare referrer record;
begin
  if not public.check_rate_limit('apply_referral:' || coalesce(p_new_phone, ''), 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into referrer from public.customers where referral_code = upper(p_code);
  if referrer is null then return json_build_object('ok', false, 'error', 'کد معرف پیدا نشد'); end if;
  if referrer.phone = p_new_phone then return json_build_object('ok', false, 'error', 'کد معرف خودتان قابل استفاده نیست'); end if;
  if exists (select 1 from public.customers where phone = p_new_phone and referred_by is not null) then
    return json_build_object('ok', false, 'error', 'قبلاً از کد معرف استفاده کرده‌اید');
  end if;
  if not exists (select 1 from public.customers where phone = p_new_phone) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;

  update public.customers set referred_by = referrer.phone where phone = p_new_phone;

  return json_build_object('ok', true);
end $fn$;
grant execute on function public.apply_referral(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) Feedback stats for BI (v2.14's feedbacks table was collected but never
--    surfaced anywhere). Manager-only, matching the "salon-wide reports
--    blocked for stylist" rule from v2.15 — also tightens v2.14's original
--    read policy (is_staff()) to match, for the same reason: feedback read
--    is a quality metric across every stylist's bookings, not scoped to
--    one's own.
-- ----------------------------------------------------------------------------
drop policy if exists p_feedback_read on public.feedbacks;
create policy p_feedback_read on public.feedbacks for select using (public.is_manager());

create or replace function public.get_feedback_stats()
returns table (
  total_count bigint, avg_rating numeric,
  rating_1 bigint, rating_2 bigint, rating_3 bigint, rating_4 bigint, rating_5 bigint
)
language sql stable security definer set search_path = public as $fn$
  select
    count(*)::bigint as total_count,
    round(avg(rating)::numeric, 2) as avg_rating,
    count(*) filter (where rating = 1)::bigint as rating_1,
    count(*) filter (where rating = 2)::bigint as rating_2,
    count(*) filter (where rating = 3)::bigint as rating_3,
    count(*) filter (where rating = 4)::bigint as rating_4,
    count(*) filter (where rating = 5)::bigint as rating_5
  from public.feedbacks
  where public.is_manager();
$fn$;
grant execute on function public.get_feedback_stats() to authenticated;

-- ----------------------------------------------------------------------------
-- 3) Pagination/limits on full-customer-base reads, so these stay fast as
--    the customer list grows. 500 is a generous cap for a single salon;
--    revisit with real cursor-based pagination if a deployment ever
--    exceeds it.
-- ----------------------------------------------------------------------------
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
  from scored
  order by monetary desc
  limit 500;
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
  order by phone, category
  limit 2000; -- ~500 customers × ~4 category lines each, typical upper bound
$fn$;
