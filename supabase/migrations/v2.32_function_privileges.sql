-- ============================================================================
-- Migration v2.32 — function privileges (SECURITY — run after v2.31)
-- ============================================================================
-- PostgreSQL lets PUBLIC execute every new function, and Supabase's default
-- privileges also grant every new function in `public` to anon and
-- authenticated. Several functions documented as "server only" were never
-- revoked, so anyone holding the public anon key could call them over
-- /rest/v1/rpc:
--   * request_booking_otp_internal(phone, salon) → returns the plaintext
--     login code for ANY phone → full access to that customer's bookings
--     (view / cancel / reschedule);
--   * create_reconciliation_token(salon) → the owner's reconciliation link:
--     customer names/phones, and marking visits completed (which awards
--     loyalty points) or no-show;
--   * create_rebooking_token(...) + resolve_rebooking_token → the name on
--     file for any phone number;
--   * run_predictive_rebooking(), transition_elapsed_appointments(),
--     archive_stale_pending_verifications() → scheduler jobs on demand.
-- Separately, customer_loyalty(phone) was callable anonymously and returned
-- the customer's name, referral code, points history and the NAMES AND
-- PHONES of everyone they had referred — for any number typed in.
--
-- Fix: execute is revoked from everyone on every function in `public`
-- (including future ones), then granted back by intent:
--   service_role  → everything (Edge Functions, cron);
--   anon + authenticated → RLS/view helpers and the public token-based pages;
--   authenticated → staff RPCs (each also checks is_manager()/is_staff()).
-- customer_loyalty is split: staff get the full record; anonymous callers
-- get only {found, discount_percent, ...}; customers get their own full
-- record after OTP via get_my_loyalty_with_token(token).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) customer_loyalty: full view for staff / the verified customer only
-- ----------------------------------------------------------------------------
create or replace function public.customer_loyalty_full(p_phone text, p_salon_id uuid)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int;
begin
  select * into ls from public.loyalty_settings where salon_id = p_salon_id;
  select * into c from public.customers where phone = p_phone and salon_id = p_salon_id;
  if c is null or ls is null then
    return json_build_object('found', false, 'points', 0, 'discount_percent', 0, 'history', '[]'::json, 'referrals', '[]'::json);
  end if;
  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  return json_build_object(
    'found', true,
    'name', c.name,
    'points', c.loyalty_points,
    'total_visits', c.total_visits,
    'referral_code', c.referral_code,
    'discount_percent', disc,
    'max_discount', ls.max_discount,
    'at_cap', disc >= ls.max_discount,
    'points_to_next_tier', greatest(ls.points_per_tier - (c.loyalty_points % greatest(ls.points_per_tier, 1)), 0),
    'history', coalesce((
      select json_agg(json_build_object('delta', l.delta, 'reason', l.reason, 'at', l.created_at) order by l.created_at desc)
        from (select * from public.loyalty_ledger where customer_phone = p_phone and salon_id = p_salon_id
               order by created_at desc limit 30) l
    ), '[]'::json),
    'referrals', coalesce((
      select json_agg(json_build_object('name', r.name, 'phone', r.phone, 'total_visits', r.total_visits, 'joined_at', r.created_at) order by r.created_at desc)
        from public.customers r where r.referred_by = p_phone and r.salon_id = p_salon_id
    ), '[]'::json)
  );
end;
$fn$;

create or replace function public.customer_loyalty(p_phone text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_full json;
begin
  v_full := public.customer_loyalty_full(p_phone, public.current_salon_id());
  if public.is_staff() then
    return v_full;
  end if;
  -- Anonymous: only what the booking page needs to price the booking.
  return json_build_object(
    'found', coalesce((v_full ->> 'found')::boolean, false),
    'discount_percent', coalesce((v_full ->> 'discount_percent')::int, 0)
  );
end;
$fn$;

create or replace function public.get_my_loyalty_with_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_phone text; v_salon_id uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon_id from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('found', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  return public.customer_loyalty_full(v_phone, v_salon_id);
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 2) create_public_booking — same as v2.26, plus the name fallback above
-- ----------------------------------------------------------------------------
create or replace function public.create_public_booking(
  p_service_id text, p_staff_id text, p_date date, p_start_min int,
  p_customer_name text, p_customer_phone text, p_customer_gender text,
  p_referral_code text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_svc record; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_end_min int; v_id text; v_code text; v_original bigint; v_svc_discount bigint;
  v_after_svc bigint; v_loyalty_pct int := 0; v_final bigint; v_loyalty json; v_code_bytes bytea;
  v_salon_id uuid;
begin
  v_salon_id := public.current_salon_id();
  if v_salon_id is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if p_customer_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  -- v2.32: a returning customer's name is no longer sent to the browser
  -- (customer_loyalty is PII-free for anonymous callers), so an empty name
  -- falls back to the one already on file for this phone.
  if coalesce(trim(p_customer_name), '') = '' then
    select name into p_customer_name from public.customers where salon_id = v_salon_id and phone = p_customer_phone;
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    return json_build_object('ok', false, 'error', 'نام لازم است');
  end if;
  if p_customer_gender not in ('female', 'male') then
    return json_build_object('ok', false, 'error', 'جنسیت نامعتبر است');
  end if;
  if not public.check_rate_limit('create_booking:' || v_salon_id || ':' || p_customer_phone, 10, 30) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — کمی بعد دوباره امتحان کنید');
  end if;
  if p_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_date and salon_id = v_salon_id) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;
  if exists (select 1 from public.salon_closures where salon_id = v_salon_id and closure_date = p_date and is_active) then
    return json_build_object('ok', false, 'error', 'سالن در این روز تعطیل است');
  end if;

  select * into v_svc from public.services where id = p_service_id and salon_id = v_salon_id and is_active;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت یافت نشد یا غیرفعال است');
  end if;
  if v_svc.gender <> p_customer_gender then
    return json_build_object('ok', false, 'error', 'این خدمت با جنسیت انتخابی مطابقت ندارد');
  end if;

  if p_staff_id is not null and not exists (select 1 from public.stylists where id = p_staff_id and salon_id = v_salon_id and active) then
    return json_build_object('ok', false, 'error', 'آرایشگر یافت نشد یا غیرفعال است');
  end if;

  v_app_dow := (extract(dow from p_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = p_staff_id and salon_id = v_salon_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null and salon_id = v_salon_id;
  end if;
  if v_wh is null or v_wh.is_closed then
    return json_build_object('ok', false, 'error', 'در این روز سالن یا آرایشگر تعطیل است');
  end if;
  v_wh_start := split_part(v_wh.start_time, ':', 1)::int * 60 + split_part(v_wh.start_time, ':', 2)::int;
  v_wh_end := split_part(v_wh.end_time, ':', 1)::int * 60 + split_part(v_wh.end_time, ':', 2)::int;
  v_end_min := p_start_min + v_svc.duration_minutes;
  if p_start_min < v_wh_start or v_end_min > v_wh_end then
    return json_build_object('ok', false, 'error', 'خارج از ساعات کاری است');
  end if;

  v_original := coalesce(v_svc.price, 0);
  v_svc_discount := case
    when v_svc.discount_type = 'percent' then round(v_original * v_svc.discount_value / 100.0)
    when v_svc.discount_type = 'fixed' then v_svc.discount_value
    else 0
  end;
  v_after_svc := greatest(0, v_original - v_svc_discount);
  if v_svc.price is not null then
    v_loyalty := public.customer_loyalty(p_customer_phone);
    if (v_loyalty->>'found')::boolean then
      v_loyalty_pct := coalesce((v_loyalty->>'discount_percent')::int, 0);
    end if;
  end if;
  v_final := case when v_svc.price is null then null
                  else greatest(0, v_after_svc - round(v_after_svc * v_loyalty_pct / 100.0)) end;

  v_id := 'apt-' || substr(md5(gen_random_uuid()::text), 1, 16);
  v_code_bytes := gen_random_bytes(4);
  v_code := 'MN-' || lpad((
    ((get_byte(v_code_bytes, 0)::bigint << 24) | (get_byte(v_code_bytes, 1)::bigint << 16)
     | (get_byte(v_code_bytes, 2)::bigint << 8) | get_byte(v_code_bytes, 3)::bigint) % 90000 + 10000
  )::text, 5, '0');

  begin
    insert into public.appointments (
      id, salon_id, customer_name, customer_phone, customer_gender, service_id, staff_id,
      staff_name, date, start_min, end_min, buffer_minutes, status,
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price
    ) values (
      v_id, v_salon_id, trim(p_customer_name), p_customer_phone, p_customer_gender, p_service_id, p_staff_id,
      coalesce((select name from public.stylists where id = p_staff_id and salon_id = v_salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'pending',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final
    );
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  if p_referral_code is not null and length(trim(p_referral_code)) > 0 then
    perform public.apply_referral(p_customer_phone, p_referral_code);
  end if;

  return json_build_object(
    'ok', true, 'id', v_id, 'tracking_code', v_code, 'final_price', v_final,
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = p_staff_id and salon_id = v_salon_id), '')
  );
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 3) Privileges
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Future functions start closed too (Supabase creates them as postgres /
-- supabase_admin; skip roles that don't exist, e.g. on plain Postgres).
do $$
declare r text;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated', r);
    end if;
  end loop;
end $$;

grant execute on all functions in schema public to service_role;

-- Used inside RLS policies / views, i.e. evaluated with the caller's rights.
grant execute on function
  public.current_salon_id(), public.is_staff(), public.is_manager(), public.my_role(), public.my_stylist_id(),
  public.appointment_status_for_feedback(text), public.salon_today()
to anon, authenticated;

-- Public pages: booking form, "my dashboard" (OTP token), SMS-link pages.
grant execute on function
  public.create_public_booking(text, text, date, int, text, text, text, text),
  public.customer_loyalty(text),
  public.apply_referral(text, text),
  public.report_appointment_no_show(text),
  public.verify_booking_otp(text, text),
  public.request_booking_otp_test(text),
  public.get_my_bookings_with_token(text),
  public.get_my_loyalty_with_token(text),
  public.cancel_my_booking_with_token(text, text),
  public.reschedule_my_booking_with_token(text, text, date, int),
  public.revoke_booking_token(text),
  public.resolve_rebooking_token(text),
  public.get_available_slots_for_rebooking(text, date, text),
  public.create_booking_from_rebooking_token(text, date, int, text),
  public.resolve_reconciliation_token(text),
  public.get_reconciliation_queue(text),
  public.submit_reconciliation_batch(text, jsonb),
  public.get_attendance(text),
  public.respond_attendance(text, text)
to anon, authenticated;

-- Staff panel (each of these also checks is_manager()/is_staff() inside).
grant execute on function
  public.handle_closure_announcement(uuid, date, text, text),
  public.open_my_booking_window(),
  public.inactive_customers(int),
  public.get_customer_rfm_segments(),
  public.get_customer_category_matrix(),
  public.get_campaign_performance(text),
  public.get_feedback_stats(),
  public.preview_customer_segment_distribution(int, int, int),
  public.redeem_loyalty_reward(text)
to authenticated;

-- ----------------------------------------------------------------------------
-- 4) Stylists' personal phone numbers are staff-only. The public booking
--    page reads names/sections only (src/lib/api.js bootstrap); staff load
--    full rows after login (fetchStaffData).
-- ----------------------------------------------------------------------------
revoke select on public.stylists from anon;
grant select (id, salon_id, name, gender, active, reminder_hours_before, created_at) on public.stylists to anon;
