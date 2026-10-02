-- ============================================================================
-- Migration v2.38 — fixes from review pass 7 (run after v2.37)
-- ============================================================================
--  1. reschedule_my_booking_with_token didn't check the booking's status:
--     a customer could move a cancelled/completed/no-show booking (bringing
--     it back to life) or turn an unpaid deposit hold into a normal booking
--     without paying. Now only live bookings move.
--  2. cancel_my_booking_with_token likewise cancelled anything — including a
--     completed visit, erasing its revenue/loyalty. Now only live bookings
--     (and unpaid holds) can be cancelled.
--  3. Bookings made from links the salon sent (closure rebooking, waitlist
--     offer, predictive invitation) are exempt from the online deposit: the
--     page behind those links has no payment step, so they'd have expired.
-- ============================================================================

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
  -- v2.38: only a live booking (or an unpaid hold) can be cancelled — not a
  -- completed visit (which would erase revenue/loyalty) or a no-show.
  update public.appointments set status = 'cancelled'
   where id = p_appointment_id
     and status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment');
  if not found then
    return json_build_object('ok', false, 'error', 'این نوبت دیگر قابل لغو نیست');
  end if;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.cancel_my_booking_with_token(text, text) to anon, authenticated;

create or replace function public.create_booking_from_rebooking_token(
  p_token text, p_date date, p_start_min int, p_staff_id text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_rt record; v_svc record; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_end_min int; v_id text; v_code text; v_original bigint; v_svc_discount bigint;
  v_after_svc bigint; v_loyalty_pct int := 0; v_final bigint; v_loyalty json; v_code_bytes bytea;
  v_staff_id text;
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
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price
    ) values (
      v_id, v_rt.salon_id,
      coalesce(nullif(v_rt.customer_name, ''), (select name from public.customers where salon_id = v_rt.salon_id and phone = v_rt.customer_phone), ''),
      v_rt.customer_phone, v_svc.gender, v_rt.service_id, v_staff_id,
      coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'confirmed',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final
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

create or replace function public.hold_for_deposit()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_set record; v_merchant text;
begin
  if new.status not in ('pending', 'confirmed') or new.final_price is null or new.final_price <= 0 then
    return new;
  end if;
  if public.is_staff() then
    return new; -- bookings entered by staff never wait for an online payment
  end if;
  if current_setting('app.skip_deposit', true) = 'on' then
    return new; -- booked from a link the salon sent (see create_booking_from_rebooking_token)
  end if;
  select deposit_percent, deposit_min_price into v_set from public.app_settings where salon_id = new.salon_id;
  if coalesce(v_set.deposit_percent, 0) = 0 or new.final_price < coalesce(v_set.deposit_min_price, 0) then
    return new;
  end if;
  select zarinpal_merchant_id into v_merchant from public.salon_payment_settings where salon_id = new.salon_id;
  if coalesce(v_merchant, '') = '' then
    return new;
  end if;
  new.deposit_amount := greatest(1000, round(new.final_price * v_set.deposit_percent / 100.0)); -- Zarinpal minimum is 1,000 toman
  new.status := 'awaiting_payment';
  return new;
end;
$fn$;

-- 4) current_salon_id() cast request.headers to json directly. After a
--    transaction-local set_config (how PostgREST passes headers) the setting
--    reads back as '' — not NULL — on a reused connection, and ''::json
--    raises, failing whatever called it (RLS checks, column defaults).
create or replace function public.current_salon_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select salon_id from public.users where id = auth.uid()),
    nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-salon-id', '')::uuid
  );
$fn$;
