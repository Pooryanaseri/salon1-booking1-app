-- ============================================================================
-- Migration v2.40 — salon scoping for four older functions (run after v2.39)
-- ============================================================================
-- These SECURITY DEFINER functions predate multi-tenancy (v2.24) and were
-- never given a salon filter. Because they bypass RLS, a manager of one
-- salon could read every salon's data through them:
--   * inactive_customers(days)        — names + phones of other salons' customers
--   * get_customer_category_matrix()  — other salons' customers + visit history
--   * get_campaign_performance()      — campaign stats mixed across salons
--   * track_campaign_conversion       — (trigger) could credit a booking to
--                                       another salon's campaign SMS sent to
--                                       the same phone number
-- Same signatures and result columns as before; only the filters change.
-- ============================================================================

create or replace function public.inactive_customers(p_days int default 60)
returns table (phone text, name text, gender text, last_booking_at timestamptz, days_since int, total_visits int)
language sql stable security definer set search_path = public as $fn$
  select c.phone, c.name, c.gender, c.last_booking_at,
         extract(day from now() - c.last_booking_at)::int, c.total_visits
    from public.customers c
   where public.is_manager()
     and c.salon_id = public.current_salon_id()
     and c.sms_opt_out = false
     and c.last_booking_at is not null
     and c.last_booking_at < now() - make_interval(days => p_days)
   order by c.last_booking_at asc;
$fn$;
revoke all on function public.inactive_customers(int) from public, anon;
grant execute on function public.inactive_customers(int) to authenticated;

create or replace function public.get_customer_category_matrix()
returns table (phone text, name text, category text, category_fa text, visit_count int,
               last_visit_days int, line_status text, line_status_fa text)
language sql stable security definer set search_path = public as $fn$
  with cat_stats as (
    select
      a.customer_phone as phone, c.name, s.category,
      count(a.id)::int as visit_count,
      extract(day from (now() - max(a.date)))::int as last_visit_days
    from public.appointments a
    join public.services s on s.id = a.service_id and s.salon_id = a.salon_id
    join public.customers c on c.phone = a.customer_phone and c.salon_id = a.salon_id
    where a.status = 'completed'
      and a.salon_id = public.current_salon_id()
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
revoke all on function public.get_customer_category_matrix() from public, anon;
grant execute on function public.get_customer_category_matrix() to authenticated;

create or replace function public.get_campaign_performance(p_template_id text default null)
returns table (template_id text, template_label text, segment text, total_sent bigint,
               successful_count bigint, total_conversions bigint, conversion_rate numeric,
               attributed_revenue bigint)
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
    and cl.salon_id = public.current_salon_id()
    and (p_template_id is null or cl.template_id = p_template_id)
  group by cl.template_id
  order by conversion_rate desc;
$fn$;
revoke all on function public.get_campaign_performance(text) from public, anon;
grant execute on function public.get_campaign_performance(text) to authenticated;

create or replace function public.track_campaign_conversion()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare matched_sms record;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  -- Most recent campaign SMS this salon sent to this phone in the last 7 days.
  select sm.id as sms_id, sm.campaign_log_id, sm.sent_at
    into matched_sms
    from public.sms_messages sm
   where sm.to_phone = new.customer_phone
     and sm.salon_id = new.salon_id
     and sm.campaign_log_id is not null
     and sm.status in ('sent', 'delivered')
     and sm.sent_at >= now() - interval '7 days'
   order by sm.sent_at desc
   limit 1;

  if matched_sms.campaign_log_id is not null then
    insert into public.campaign_conversions
      (salon_id, campaign_log_id, customer_phone, appointment_id, sms_message_id, converted_at, days_to_convert)
    values (
      new.salon_id, matched_sms.campaign_log_id, new.customer_phone, new.id, matched_sms.sms_id, now(),
      greatest(0, extract(day from (now() - matched_sms.sent_at))::int)
    )
    on conflict (appointment_id) do nothing;
  end if;

  return new;
end;
$fn$;
revoke all on function public.track_campaign_conversion() from public, anon, authenticated;
