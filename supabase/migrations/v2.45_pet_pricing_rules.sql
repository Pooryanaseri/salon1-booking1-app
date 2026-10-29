-- ============================================================================
-- Migration v2.45 — pet salon pricing rules (run after v2.44)
-- ============================================================================
--  Shaped by a real groomer's price list:
--  1. Breed prices — services.breed_pricing {"چاو چاو": {"price":…, "duration":…}}
--     overrides the size price for that breed (spacing, ZWNJ and Arabic ی/ک
--     don't matter when matching). A service with no base price and only
--     breed prices reads "price announced in salon" for other breeds.
--  2. Size thresholds per salon — app_settings.pet_size_limits (kg upper
--     bounds of small / medium / large; default 5 / 15 / 30).
--  3. Aggression surcharge — app_settings.pet_aggressive_surcharge_percent;
--     a booking for an aggressive animal gets it as an extra charge.
--  4. Extra charges — appointments.extra_charges [{label, amount}], included
--     in final_price. Services marked is_addon (e.g. detangling per half
--     hour) can't be booked online; staff add them when completing a visit.
--  5. New starter menu for pet salons, modelled on that price list.
-- ============================================================================

alter table public.services add column if not exists breed_pricing jsonb not null default '{}'::jsonb;
alter table public.services drop constraint if exists services_breed_pricing_check;
alter table public.services add constraint services_breed_pricing_check check (jsonb_typeof(breed_pricing) = 'object');
alter table public.services add column if not exists is_addon boolean not null default false;

alter table public.app_settings add column if not exists pet_size_limits int[] not null default '{5,15,30}';
alter table public.app_settings drop constraint if exists app_settings_pet_size_limits_check;
alter table public.app_settings add constraint app_settings_pet_size_limits_check check (
  array_length(pet_size_limits, 1) = 3 and pet_size_limits[1] > 0
  and pet_size_limits[1] < pet_size_limits[2] and pet_size_limits[2] < pet_size_limits[3] and pet_size_limits[3] <= 150);
alter table public.app_settings add column if not exists pet_aggressive_surcharge_percent int not null default 0;
alter table public.app_settings drop constraint if exists app_settings_pet_aggressive_surcharge_percent_check;
alter table public.app_settings add constraint app_settings_pet_aggressive_surcharge_percent_check check (pet_aggressive_surcharge_percent between 0 and 100);

alter table public.appointments add column if not exists extra_charges jsonb not null default '[]'::jsonb;
alter table public.appointments drop constraint if exists appointments_extra_charges_check;
alter table public.appointments add constraint appointments_extra_charges_check check (jsonb_typeof(extra_charges) = 'array');

-- "چاو چاو" = "چاوچاو" = "چاو‌چاو"; Arabic ي/ك typed on some keyboards = Persian ی/ک.
create or replace function public.norm_breed(p text)
returns text
language sql immutable as $fn$
  select regexp_replace(translate(lower(coalesce(p, '')), 'يكۀة', 'یکهه'), E'[[:space:]‌‍_-]+', '', 'g');
$fn$;

-- Size price/duration, then the breed's own price/duration on top.
create or replace function public.service_for_pet(p_svc public.services, p_size text, p_breed text)
returns public.services
language plpgsql stable as $fn$
declare v public.services := public.service_at_size(p_svc, p_size); v_key text; v_tier jsonb; v_norm text := public.norm_breed(p_breed);
begin
  if v_norm = '' or p_svc.breed_pricing is null then
    return v;
  end if;
  for v_key, v_tier in select key, value from jsonb_each(p_svc.breed_pricing) loop
    if public.norm_breed(v_key) = v_norm and jsonb_typeof(v_tier) = 'object' then
      if jsonb_typeof(v_tier -> 'price') = 'number' and (v_tier ->> 'price')::numeric >= 0 then
        v.price := round((v_tier ->> 'price')::numeric)::bigint;
      end if;
      if jsonb_typeof(v_tier -> 'duration') = 'number' and (v_tier ->> 'duration')::numeric between 5 and 600 then
        v.duration_minutes := round((v_tier ->> 'duration')::numeric)::int;
      end if;
      exit;
    end if;
  end loop;
  return v;
end;
$fn$;

-- The aggression surcharge for a price (after the service's own discount), or 0.
create or replace function public.pet_surcharge(p_salon uuid, p_temperament text, p_price bigint)
returns bigint
language sql stable security definer set search_path = public as $fn$
  select case when p_temperament = 'aggressive' and p_price is not null and p_price > 0
              then round(p_price * coalesce((select pet_aggressive_surcharge_percent from public.app_settings where salon_id = p_salon), 0) / 100.0)::bigint
              else 0 end;
$fn$;
revoke all on function public.pet_surcharge(uuid, text, bigint) from public, anon, authenticated;

create or replace function public.create_public_booking(
  p_service_id text, p_staff_id text, p_date date, p_start_min int,
  p_customer_name text, p_customer_phone text, p_customer_gender text,
  p_referral_code text default null,
  p_pet jsonb default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_svc public.services; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_end_min int; v_id text; v_code text; v_original bigint; v_svc_discount bigint;
  v_after_svc bigint; v_loyalty_pct int := 0; v_final bigint; v_loyalty json; v_code_bytes bytea;
  v_salon_id uuid;
  v_status text; v_deposit bigint;
  v_extra bigint := 0; v_extras jsonb := '[]'::jsonb;
  v_type text; v_pet_id uuid; v_pet_name text; v_size text; v_vacc date; v_require_vacc boolean;
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
  -- v2.44: the sections depend on the salon's type (female/male or dog/cat).
  select business_type into v_type from public.salons where id = v_salon_id;
  if p_customer_gender is null or not (p_customer_gender = any (public.salon_sections(v_salon_id))) then
    return json_build_object('ok', false, 'error', case when v_type = 'pet' then 'نوع حیوان نامعتبر است' else 'جنسیت نامعتبر است' end);
  end if;
  if v_type = 'pet' then
    v_pet_name := nullif(trim(coalesce(p_pet ->> 'name', '')), '');
    v_size := p_pet ->> 'size';
    if v_pet_name is null or length(v_pet_name) > 40 then
      return json_build_object('ok', false, 'error', 'نام حیوان را وارد کنید');
    end if;
    if v_size is null or v_size not in ('small', 'medium', 'large', 'giant') then
      return json_build_object('ok', false, 'error', 'جثهٔ حیوان را انتخاب کنید');
    end if;
    if coalesce(p_pet ->> 'temperament', 'calm') not in ('calm', 'nervous', 'aggressive') then
      return json_build_object('ok', false, 'error', 'رفتار حیوان نامعتبر است');
    end if;
    v_vacc := public.try_date(p_pet ->> 'vaccine_valid_until');
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
  if v_svc.is_addon then
    return json_build_object('ok', false, 'error', 'این خدمت فقط در سالن اضافه می‌شود');
  end if;
  if v_svc.gender <> p_customer_gender then
    return json_build_object('ok', false, 'error', case when v_type = 'pet' then 'این خدمت برای این حیوان نیست' else 'این خدمت با جنسیت انتخابی مطابقت ندارد' end);
  end if;
  v_svc := public.service_for_pet(v_svc, v_size, p_pet ->> 'breed'); -- v2.45: size, then breed
  if v_type = 'pet' then
    select pet_require_vaccination into v_require_vacc from public.app_settings where salon_id = v_salon_id;
    if coalesce(v_require_vacc, false) and (v_vacc is null or v_vacc < p_date) then
      return json_build_object('ok', false, 'error', 'این سالن کارت واکسن معتبر تا روز نوبت را لازم می‌داند — تاریخ اعتبار واکسن را وارد کنید');
    end if;
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
  -- v2.45: the salon's aggression surcharge, recorded as an extra charge
  if v_final is not null then
    v_extra := public.pet_surcharge(v_salon_id, case when v_type = 'pet' then coalesce(p_pet ->> 'temperament', 'calm') end, v_after_svc);
    if v_extra > 0 then
      v_extras := jsonb_build_array(jsonb_build_object('label', 'حیوان پرخاشگر', 'amount', v_extra));
      v_final := v_final + v_extra;
    end if;
  end if;

  v_id := 'apt-' || substr(md5(gen_random_uuid()::text), 1, 16);
  v_code_bytes := gen_random_bytes(4);
  v_code := 'MN-' || lpad((
    ((get_byte(v_code_bytes, 0)::bigint << 24) | (get_byte(v_code_bytes, 1)::bigint << 16)
     | (get_byte(v_code_bytes, 2)::bigint << 8) | get_byte(v_code_bytes, 3)::bigint) % 90000 + 10000
  )::text, 5, '0');

  if v_type = 'pet' then
    v_pet_id := public.upsert_pet(v_salon_id, p_customer_phone, p_customer_gender, p_pet);
  end if;

  begin
    insert into public.appointments (
      id, salon_id, customer_name, customer_phone, customer_gender, service_id, staff_id,
      staff_name, date, start_min, end_min, buffer_minutes, status,
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price,
      pet_id, pet_name, pet_size, extra_charges
    ) values (
      v_id, v_salon_id, trim(p_customer_name), p_customer_phone, p_customer_gender, p_service_id, p_staff_id,
      coalesce((select name from public.stylists where id = p_staff_id and salon_id = v_salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'pending',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final,
      v_pet_id, v_pet_name, v_size, v_extras
    )
    returning status, deposit_amount into v_status, v_deposit; -- after the auto-confirm / deposit triggers
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  if p_referral_code is not null and length(trim(p_referral_code)) > 0 then
    perform public.apply_referral(p_customer_phone, p_referral_code);
  end if;

  return json_build_object(
    'ok', true, 'id', v_id, 'tracking_code', v_code, 'final_price', v_final,
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = p_staff_id and salon_id = v_salon_id), ''),
    'status', v_status, 'deposit_amount', v_deposit, 'extra_charges', v_extras
  );
end;
$fn$;
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text, jsonb) to anon, authenticated;

create or replace function public.reschedule_my_booking_with_token(
  p_token text, p_appointment_id text, p_new_date date, p_new_start_min int
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_phone text; v_salon_id uuid; v_appt record; v_svc public.services;
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
  -- v2.38: only a live booking can move. Without this, a customer could
  -- "reschedule" a cancelled / completed / no-show booking back to life, or
  -- an unpaid deposit hold into a normal booking without paying.
  if v_appt.status not in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed') then
    return json_build_object('ok', false, 'error', 'این نوبت دیگر قابل تغییر نیست');
  end if;
  if p_new_date < public.salon_today() then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_new_date and salon_id = v_salon_id) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = v_appt.service_id and salon_id = v_salon_id;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت مرتبط با این نوبت یافت نشد');
  end if;
  v_svc := public.service_for_pet(v_svc, v_appt.pet_size, (select breed from public.pets where id = v_appt.pet_id)); -- v2.44: pet bookings keep their size's duration
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

create or replace function public.create_booking_from_rebooking_token(
  p_token text, p_date date, p_start_min int, p_staff_id text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_rt record; v_svc public.services; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_end_min int; v_id text; v_code text; v_original bigint; v_svc_discount bigint;
  v_after_svc bigint; v_loyalty_pct int := 0; v_final bigint; v_loyalty json; v_code_bytes bytea;
  v_staff_id text;
  v_pet_id uuid; v_pet_name text; v_pet_size text; v_pet_breed text; v_pet_temper text;
  v_extra bigint := 0; v_extras jsonb := '[]'::jsonb;
begin
  select * into v_rt from public.rebooking_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now();
  if v_rt is null then
    return json_build_object('ok', false, 'error', 'این لینک منقضی یا نامعتبر است');
  end if;
  if v_rt.service_id is null then
    return json_build_object('ok', false, 'error', 'این لینک برای خدمت مشخصی نیست');
  end if;
  if p_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_date and salon_id = v_rt.salon_id) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;
  if exists (select 1 from public.salon_closures where salon_id = v_rt.salon_id and closure_date = p_date and is_active) then
    return json_build_object('ok', false, 'error', 'سالن در این روز تعطیل است');
  end if;

  -- Staff can be the one the customer originally had, or a different one
  -- the customer actively chooses on the booking page — either way it's
  -- just "who performs the service", not an identity field, so it's safe
  -- to accept as a direct parameter (validated against this same salon).
  v_staff_id := coalesce(p_staff_id, v_rt.staff_id);
  select * into v_svc from public.services where id = v_rt.service_id and salon_id = v_rt.salon_id and is_active;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت یافت نشد یا غیرفعال است');
  end if;
  -- v2.44: a pet salon's link books the customer's animal of that species
  -- (most recently groomed first), priced and timed for its size.
  if v_svc.gender in ('dog', 'cat') then
    select p.id, p.name, p.size, p.breed, p.temperament into v_pet_id, v_pet_name, v_pet_size, v_pet_breed, v_pet_temper
      from public.pets p
     where p.salon_id = v_rt.salon_id and p.owner_phone = v_rt.customer_phone and p.species = v_svc.gender
     order by p.last_visit_date desc nulls last, p.created_at desc
     limit 1;
    v_svc := public.service_for_pet(v_svc, v_pet_size, v_pet_breed);
  end if;
  if v_staff_id is not null and not exists (select 1 from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id and active) then
    return json_build_object('ok', false, 'error', 'آرایشگر یافت نشد یا غیرفعال است');
  end if;

  v_app_dow := (extract(dow from p_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = v_staff_id and salon_id = v_rt.salon_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null and salon_id = v_rt.salon_id;
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
    v_loyalty := public.customer_loyalty(v_rt.customer_phone);
    if (v_loyalty->>'found')::boolean then
      v_loyalty_pct := coalesce((v_loyalty->>'discount_percent')::int, 0);
    end if;
  end if;
  v_final := case when v_svc.price is null then null
                  else greatest(0, v_after_svc - round(v_after_svc * v_loyalty_pct / 100.0)) end;
  -- v2.45: the salon's aggression surcharge, recorded as an extra charge
  if v_final is not null then
    v_extra := public.pet_surcharge(v_rt.salon_id, v_pet_temper, v_after_svc);
    if v_extra > 0 then
      v_extras := jsonb_build_array(jsonb_build_object('label', 'حیوان پرخاشگر', 'amount', v_extra));
      v_final := v_final + v_extra;
    end if;
  end if;

  v_id := 'apt-' || substr(md5(gen_random_uuid()::text), 1, 16);
  v_code_bytes := gen_random_bytes(4);
  v_code := 'MN-' || lpad((
    ((get_byte(v_code_bytes, 0)::bigint << 24) | (get_byte(v_code_bytes, 1)::bigint << 16)
     | (get_byte(v_code_bytes, 2)::bigint << 8) | get_byte(v_code_bytes, 3)::bigint) % 90000 + 10000
  )::text, 5, '0');

  -- v2.38: links the salon itself sent (closure rebooking, waitlist offer,
  -- predictive invitation) never wait for an online deposit — the page
  -- behind them has no payment step. Transaction-local flag read by
  -- hold_for_deposit().
  perform set_config('app.skip_deposit', 'on', true);

  begin
    insert into public.appointments (
      id, salon_id, customer_name, customer_phone, customer_gender, service_id, staff_id,
      staff_name, date, start_min, end_min, buffer_minutes, status,
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price,
      pet_id, pet_name, pet_size, extra_charges
    ) values (
      v_id, v_rt.salon_id,
      coalesce(nullif(v_rt.customer_name, ''), (select name from public.customers where salon_id = v_rt.salon_id and phone = v_rt.customer_phone), ''),
      v_rt.customer_phone, v_svc.gender, v_rt.service_id, v_staff_id,
      coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'confirmed',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final,
      v_pet_id, v_pet_name, v_pet_size, v_extras
    );
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  update public.rebooking_tokens set used_at = now() where id = v_rt.id;

  return json_build_object(
    'ok', true, 'id', v_id, 'tracking_code', v_code, 'final_price', v_final,
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), '')
  );
end;
$fn$;
grant execute on function public.create_booking_from_rebooking_token(text, date, int, text) to anon, authenticated;

-- ------------------------------------------------ starter pet menu ---------
-- Modelled on a working groomer's price list (toman). Sizes follow the
-- salon's thresholds (default: small under 5 kg). "اصلاح کامل" has no base
-- price — other breeds read "price announced in salon" — and breed prices
-- for Pomeranian and Chow Chow. Detangling is an add-on staff add per half
-- hour when completing the visit.
create or replace function public.seed_pet_services(p_salon uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if exists (select 1 from public.services where salon_id = p_salon) then
    return;
  end if;
  insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, size_pricing, breed_pricing, is_addon)
  select 'svc-' || encode(gen_random_bytes(6), 'hex'), p_salon, s.name, s.species, s.category, s.duration, s.price, s.tiers::jsonb, s.breeds::jsonb, s.addon
    from (values
      ('کوتاهی ناخن', 'dog', 'nails_pet', 15, 200000::bigint, '{}', '{}', false),
      ('تخلیهٔ کیسهٔ مقعدی', 'dog', 'hygiene', 15, 200000, '{}', '{}', false),
      ('شستشو (حمام)', 'dog', 'bath', 90, 1800000,
       '{"small":{"price":500000,"duration":45},"medium":{"price":700000,"duration":60},"large":{"price":1800000,"duration":90}}', '{}', false),
      ('اصلاح ساده با موزر', 'dog', 'grooming', 90, 1300000,
       '{"small":{"price":900000,"duration":60},"medium":{"price":900000,"duration":75},"large":{"price":1300000,"duration":90}}', '{}', false),
      ('اصلاح ساده با قیچی', 'dog', 'grooming', 90, 1000000,
       '{"medium":{"price":1000000,"duration":90},"large":{"price":1500000,"duration":120}}', '{}', false),
      ('اصلاح کامل + حمام', 'dog', 'grooming', 150, null,
       '{}', '{"پامرانین":{"price":1900000,"duration":120},"پامر":{"price":1900000,"duration":120},"چاو چاو":{"price":3500000,"duration":180}}', false),
      ('گره‌زدایی (هر نیم ساعت)', 'dog', 'addon', 30, 350000, '{}', '{}', true),
      ('کوتاهی ناخن', 'cat', 'nails_pet', 15, 200000, '{}', '{}', false),
      ('تخلیهٔ کیسهٔ مقعدی', 'cat', 'hygiene', 15, 200000, '{}', '{}', false),
      ('شستشو (حمام) گربه', 'cat', 'bath', 60, 800000, '{}', '{}', false),
      ('شیو سادهٔ گربه', 'cat', 'grooming', 60, 900000, '{}', '{}', false),
      ('گره‌زدایی (هر نیم ساعت)', 'cat', 'addon', 30, 350000, '{}', '{}', true)
    ) as s(name, species, category, duration, price, tiers, breeds, addon);
end;
$fn$;
revoke all on function public.seed_pet_services(uuid) from public, anon, authenticated;
