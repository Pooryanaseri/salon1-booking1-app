-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 5: customer-facing
-- RPCs — OTP/token family, booking creation, loyalty, referrals)
-- ============================================================================
-- Everything in this file was, before this migration, keyed by phone
-- number ALONE with no salon awareness at all — meaning a customer who
-- has booked at two different salons on this platform would see BOTH
-- salons' appointments merged together in "داشبورد من" at either one,
-- and a booking's price/loyalty tier could be computed from the wrong
-- salon's settings. Every function below now threads salon_id through
-- every lookup, insert, and ownership check.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- resolve_booking_token: now returns (phone, salon_id) together instead of
-- a bare phone string, so every function built on it can verify BOTH that
-- the token belongs to this phone AND that the booking being acted on
-- belongs to the SAME salon the token was issued for.
-- ----------------------------------------------------------------------------
drop function if exists public.resolve_booking_token(text);
create function public.resolve_booking_token(p_token text)
returns table (phone text, salon_id uuid)
language plpgsql security definer set search_path = public as $fn$
declare v_hash text;
begin
  if p_token is null or length(p_token) < 32 then
    return;
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  if not public.check_rate_limit('token_use:' || v_hash, 60, 10) then
    return;
  end if;
  return query
    select t.phone, t.salon_id from public.booking_access_tokens t
     where t.token_hash = v_hash and t.revoked = false and t.expires_at > now();
end;
$fn$;
revoke all on function public.resolve_booking_token(text) from public, anon, authenticated;

-- request_booking_otp_internal: service_role only (the Edge Function's
-- admin client). Now takes the salon explicitly, since the caller here
-- has no session of its own to derive one from — the Edge Function
-- resolves it from the request the frontend sends (see delivery notes).
create or replace function public.request_booking_otp_internal(p_phone text, p_salon_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea;
begin
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if p_salon_id is null or not exists (select 1 from public.salons where id = p_salon_id and active) then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request:' || p_salon_id || ':' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and salon_id = p_salon_id and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (salon_id, phone, otp_hash, salt, expires_at)
  values (p_salon_id, p_phone, v_hash, v_salt, now() + interval '5 minutes');

  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
-- The old (text)-only signature (and any grants on it) is removed
-- entirely by the drop below — no separate revoke needed, and a revoke
-- targeting a signature that may already be gone (on a second run of
-- this migration) would itself fail without IF EXISTS.
drop function if exists public.request_booking_otp_internal(text);
grant execute on function public.request_booking_otp_internal(text, uuid) to service_role;

-- verify_booking_otp: anon-callable — salon derived from current_salon_id()
-- (the x-salon-id header), matching every other public-path function.
create or replace function public.verify_booking_otp(p_phone text, p_otp text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_challenge record; v_hash text; v_token text; v_token_hash text; v_salon_id uuid;
begin
  if p_phone !~ '^09[0-9]{9}$' or p_otp !~ '^[0-9]{6}$' then
    return json_build_object('ok', false, 'error', 'ورودی نامعتبر است');
  end if;
  v_salon_id := public.current_salon_id();
  if v_salon_id is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_verify:' || v_salon_id || ':' || p_phone, 10, 10) then
    return json_build_object('ok', false, 'error', 'تعداد تلاش بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into v_challenge from public.booking_otp_challenges
   where phone = p_phone and salon_id = v_salon_id and consumed = false and expires_at > now()
   order by created_at desc limit 1;

  if v_challenge is null then
    return json_build_object('ok', false, 'error', 'کدی یافت نشد یا منقضی شده — دوباره درخواست کنید');
  end if;
  if v_challenge.attempts >= v_challenge.max_attempts then
    update public.booking_otp_challenges set consumed = true where id = v_challenge.id;
    return json_build_object('ok', false, 'error', 'تعداد تلاش‌های مجاز تمام شد — دوباره درخواست کنید');
  end if;

  v_hash := encode(digest(p_otp || v_challenge.salt, 'sha256'), 'hex');
  if v_hash <> v_challenge.otp_hash then
    update public.booking_otp_challenges set attempts = attempts + 1 where id = v_challenge.id;
    return json_build_object('ok', false, 'error', 'کد اشتباه است');
  end if;

  update public.booking_otp_challenges set consumed = true where id = v_challenge.id;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  insert into public.booking_access_tokens (salon_id, token_hash, phone, expires_at)
  values (v_salon_id, v_token_hash, p_phone, now() + interval '20 minutes');

  if random() < 0.01 then
    delete from public.booking_access_tokens where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'token', v_token, 'expires_in_seconds', 1200);
end;
$fn$;
grant execute on function public.verify_booking_otp(text, text) to anon, authenticated;

-- Token-gated booking access, now filtering by the resolved (phone, salon_id) pair.
create or replace function public.get_my_bookings_with_token(p_token text)
returns setof public.appointments
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_salon_id uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon_id from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return;
  end if;
  return query
    select * from public.appointments
    where customer_phone = v_phone and salon_id = v_salon_id
    order by date desc, start_min desc;
end;
$fn$;
grant execute on function public.get_my_bookings_with_token(text) to anon, authenticated;

create or replace function public.cancel_my_booking_with_token(p_token text, p_appointment_id text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_salon_id uuid; v_owner text; v_owner_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon_id from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  select customer_phone, salon_id into v_owner, v_owner_salon from public.appointments where id = p_appointment_id;
  if v_owner is null or v_owner <> v_phone or v_owner_salon <> v_salon_id then
    return json_build_object('ok', false, 'error', 'این نوبت متعلق به شما نیست');
  end if;
  update public.appointments set status = 'cancelled' where id = p_appointment_id;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.cancel_my_booking_with_token(text, text) to anon, authenticated;

create or replace function public.reschedule_my_booking_with_token(
  p_token text, p_appointment_id text, p_new_date date, p_new_start_min int
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_phone text; v_salon_id uuid; v_appt record; v_svc record;
  v_new_end int; v_app_dow int; v_wh record; v_wh_start int; v_wh_end int;
begin
  select r.phone, r.salon_id into v_phone, v_salon_id from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;
  if v_appt is null or v_appt.customer_phone <> v_phone or v_appt.salon_id <> v_salon_id then
    return json_build_object('ok', false, 'error', 'این نوبت متعلق به شما نیست');
  end if;
  if p_new_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_new_date and salon_id = v_salon_id) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = v_appt.service_id and salon_id = v_salon_id;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت مرتبط با این نوبت یافت نشد');
  end if;
  v_new_end := p_new_start_min + v_svc.duration_minutes;

  v_app_dow := (extract(dow from p_new_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = v_appt.staff_id and salon_id = v_salon_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null and salon_id = v_salon_id;
  end if;
  if v_wh is null or v_wh.is_closed then
    return json_build_object('ok', false, 'error', 'در این روز سالن یا آرایشگر تعطیل است');
  end if;
  v_wh_start := split_part(v_wh.start_time, ':', 1)::int * 60 + split_part(v_wh.start_time, ':', 2)::int;
  v_wh_end := split_part(v_wh.end_time, ':', 1)::int * 60 + split_part(v_wh.end_time, ':', 2)::int;
  if p_new_start_min < v_wh_start or v_new_end > v_wh_end then
    return json_build_object('ok', false, 'error', 'خارج از ساعات کاری است');
  end if;

  begin
    update public.appointments
       set date = p_new_date, start_min = p_new_start_min, end_min = v_new_end,
           status = 'rescheduled', pending_date = null, pending_start_min = null, pending_end_min = null
     where id = p_appointment_id;
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.reschedule_my_booking_with_token(text, text, date, int) to anon, authenticated;

-- request_booking_otp_test: salon derived from current_salon_id(); reads
-- the now-per-salon app_settings row for that salon's own test-mode flag.
create or replace function public.request_booking_otp_test(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea; v_test_mode boolean; v_salon_id uuid;
begin
  v_salon_id := public.current_salon_id();
  if v_salon_id is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  select sms_test_mode into v_test_mode from public.app_settings where salon_id = v_salon_id;
  if not coalesce(v_test_mode, false) then
    return json_build_object('ok', false, 'error', 'حالت تست فعال نیست');
  end if;
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request_test:' || v_salon_id || ':' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and salon_id = v_salon_id and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (salon_id, phone, otp_hash, salt, expires_at)
  values (v_salon_id, p_phone, v_hash, v_salt, now() + interval '5 minutes');

  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'test_otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
grant execute on function public.request_booking_otp_test(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- customer_loyalty / redeem_loyalty_reward / apply_referral — every
-- customers/loyalty_settings/loyalty_ledger lookup now salon-scoped.
-- ----------------------------------------------------------------------------
create or replace function public.customer_loyalty(p_phone text)
returns json language plpgsql stable security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int; v_salon_id uuid;
begin
  v_salon_id := public.current_salon_id();
  select * into ls from public.loyalty_settings where salon_id = v_salon_id;
  select * into c from public.customers where phone = p_phone and salon_id = v_salon_id;
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
        from (select * from public.loyalty_ledger where customer_phone = p_phone and salon_id = v_salon_id
               order by created_at desc limit 30) l
    ), '[]'::json),
    'referrals', coalesce((
      select json_agg(json_build_object('name', r.name, 'phone', r.phone, 'total_visits', r.total_visits, 'joined_at', r.created_at) order by r.created_at desc)
        from public.customers r where r.referred_by = p_phone and r.salon_id = v_salon_id
    ), '[]'::json)
  );
end $fn$;
grant execute on function public.customer_loyalty(text) to anon, authenticated;

create or replace function public.redeem_loyalty_reward(p_phone text)
returns json language plpgsql security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int; v_salon_id uuid;
begin
  if not (public.is_manager() or public.my_role() = 'stylist') then
    return json_build_object('ok', false, 'error', 'اجازهٔ این کار را ندارید');
  end if;
  v_salon_id := public.current_salon_id();
  select * into ls from public.loyalty_settings where salon_id = v_salon_id;
  select * into c from public.customers where phone = p_phone and salon_id = v_salon_id;
  if c is null then return json_build_object('ok', false, 'error', 'مشتری پیدا نشد'); end if;

  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  if disc < ls.max_discount then
    return json_build_object('ok', false, 'error', 'مشتری هنوز به سقف تخفیف نرسیده');
  end if;
  if c.loyalty_points <= 0 then
    return json_build_object('ok', false, 'error', 'امتیازی برای استفاده نیست');
  end if;

  insert into public.loyalty_ledger (salon_id, customer_phone, delta, reason) values (v_salon_id, p_phone, -c.loyalty_points, 'redeemed');
  update public.customers set loyalty_points = 0 where phone = p_phone and salon_id = v_salon_id;

  return json_build_object('ok', true, 'redeemed_discount_percent', disc);
end $fn$;
grant execute on function public.redeem_loyalty_reward(text) to authenticated;

create or replace function public.apply_referral(p_new_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $fn$
declare referrer record; v_salon_id uuid;
begin
  v_salon_id := public.current_salon_id();
  if v_salon_id is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if not public.check_rate_limit('apply_referral:' || v_salon_id || ':' || coalesce(p_new_phone, ''), 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into referrer from public.customers where referral_code = upper(p_code) and salon_id = v_salon_id;
  if referrer is null then return json_build_object('ok', false, 'error', 'کد معرف پیدا نشد'); end if;
  if referrer.phone = p_new_phone then return json_build_object('ok', false, 'error', 'کد معرف خودتان قابل استفاده نیست'); end if;
  if exists (select 1 from public.customers where phone = p_new_phone and salon_id = v_salon_id and referred_by is not null) then
    return json_build_object('ok', false, 'error', 'قبلاً از کد معرف استفاده کرده‌اید');
  end if;
  if not exists (select 1 from public.customers where phone = p_new_phone and salon_id = v_salon_id) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;

  update public.customers set referred_by = referrer.phone where phone = p_new_phone and salon_id = v_salon_id;

  return json_build_object('ok', true);
end $fn$;
grant execute on function public.apply_referral(text, text) to anon, authenticated;

-- customers.referral_code was globally unique — widen to per-salon, since
-- two independent salons on the platform have no reason to share a single
-- code namespace across all 300+ of them.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'customers_referral_code_key') then
    alter table public.customers drop constraint customers_referral_code_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customers_salon_referral_code_key') then
    alter table public.customers add constraint customers_salon_referral_code_key unique (salon_id, referral_code);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- create_public_booking — the core public booking flow. Salon derived
-- from current_salon_id() (the x-salon-id header); every lookup and the
-- appointments insert itself now scoped to it.
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
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text) to anon, authenticated;
