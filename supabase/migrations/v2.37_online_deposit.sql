-- ============================================================================
-- Migration v2.37 — optional online deposit via Zarinpal (run after v2.36)
-- ============================================================================
-- Off by default. A manager turns it on in Panel → ساعات کاری → پیش‌پرداخت
-- آنلاین by entering the salon's own Zarinpal merchant ID, a percentage, and
-- the minimum service price it applies to. Then, for a qualifying booking
-- made by a customer (not by staff):
--   1. the booking is created as 'awaiting_payment' — it holds its slot
--      (same overlap rule as confirmed bookings) but sends no SMS yet;
--   2. the customer pays deposit_amount on Zarinpal (Edge Function
--      `payment`, which talks to Zarinpal with the merchant ID server-side);
--   3. on return, the Edge Function verifies the payment with Zarinpal and
--      only then confirms the booking — which sends the confirmation,
--      stylist notice and reminder exactly as for any confirmed booking;
--   4. unpaid holds are released after 20 minutes (expire_unpaid_bookings,
--      scheduled in cron.sql).
-- The rest (final price minus deposit) is paid at the salon as before.
-- Refunds (e.g. a paid customer cancels) are done by the salon from its
-- Zarinpal panel; the booking shows the deposit and Zarinpal reference.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Settings and the merchant ID (the latter readable by managers only)
-- ----------------------------------------------------------------------------
alter table public.app_settings add column if not exists deposit_percent   int    not null default 0;
alter table public.app_settings add column if not exists deposit_min_price bigint not null default 0;
alter table public.app_settings drop constraint if exists app_settings_deposit_percent_check;
alter table public.app_settings add constraint app_settings_deposit_percent_check check (deposit_percent between 0 and 100);

create table if not exists public.salon_payment_settings (
  salon_id             uuid primary key references public.salons (id) on delete cascade default public.current_salon_id(),
  zarinpal_merchant_id text not null default '',
  updated_at           timestamptz not null default now()
);
alter table public.salon_payment_settings enable row level security;
drop policy if exists p_payment_settings_mgr on public.salon_payment_settings;
create policy p_payment_settings_mgr on public.salon_payment_settings for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update on public.salon_payment_settings to authenticated;

-- ----------------------------------------------------------------------------
-- 2) Appointment status + deposit columns
-- ----------------------------------------------------------------------------
alter table public.appointments add column if not exists deposit_amount  bigint;
alter table public.appointments add column if not exists deposit_paid_at timestamptz;
alter table public.appointments add column if not exists deposit_ref     text;

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in (
    'pending','confirmed','cancelled','rescheduled','completed','no_show',
    'reschedule_proposed','pending_verification','archived_unconfirmed',
    'cancelled_by_salon','awaiting_payment'
  ));

-- An unpaid hold must block the slot like a booking does (and a staff
-- reschedule proposal keeps its original slot too — it already did in the
-- app, now also in the database).
alter table public.appointments drop constraint if exists appointments_no_overlap;
alter table public.appointments add constraint appointments_no_overlap
  exclude using gist (staff_id with =, date with =, int4range(start_min, end_min + buffer_minutes) with &&)
  where (staff_id is not null and status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment'));

-- ----------------------------------------------------------------------------
-- 3) Hold qualifying customer bookings for payment
-- ----------------------------------------------------------------------------
-- Runs after trg_auto_confirm_new_appointment (triggers fire in name order).
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

drop trigger if exists trg_hold_for_deposit on public.appointments;
create trigger trg_hold_for_deposit
  before insert on public.appointments
  for each row execute function public.hold_for_deposit();

-- ----------------------------------------------------------------------------
-- 4) Booking SMS wait for the payment
-- ----------------------------------------------------------------------------
create or replace function public.send_new_booking_messages(p_appt public.appointments)
returns void
language plpgsql security definer set search_path = public as $fn$
declare v_staff_phone text; v_digest boolean; v_service text;
begin
  if p_appt.customer_phone ~ '^09[0-9]{9}$' then
    insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
    values (p_appt.salon_id, p_appt.customer_phone, public.booking_sms_text(p_appt, 'confirmation'),
            'confirmation', p_appt.id, 'queued', now());
  end if;

  if p_appt.staff_id is not null then
    select phone into v_staff_phone from public.stylists where id = p_appt.staff_id and salon_id = p_appt.salon_id;
    select staff_daily_digest into v_digest from public.app_settings where salon_id = p_appt.salon_id;
    if v_staff_phone ~ '^09[0-9]{9}$' and (not coalesce(v_digest, false) or p_appt.date = public.salon_today()) then
      select name into v_service from public.services where id = p_appt.service_id and salon_id = p_appt.salon_id;
      insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
      values (p_appt.salon_id, v_staff_phone,
              'نوبت جدید: ' || coalesce(nullif(trim(p_appt.customer_name), ''), 'مشتری') || ' — ' || coalesce(v_service, 'خدمت')
                || E'\n' || public.jalali_label(p_appt.date) || ' ساعت ' || public.fa_clock(p_appt.start_min),
              'staff_new_booking', p_appt.id, 'queued', now());
    end if;
  end if;
end;
$fn$;
revoke all on function public.send_new_booking_messages(public.appointments) from public, anon, authenticated;

create or replace function public.queue_new_booking_messages()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'awaiting_payment' then
    return new; -- nothing goes out until the deposit is paid
  end if;
  perform public.send_new_booking_messages(new);
  perform public.requeue_reminder(new);
  return new;
end;
$fn$;

-- Deposit paid → confirmed: the messages a normal booking got at creation.
-- (The reminder is queued by sync_reminder_on_change on the same update.)
create or replace function public.on_deposit_settled()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  -- Keyed on the payment itself, so it also covers a hold that expired while
  -- the customer was still paying (cancelled → confirmed).
  if new.deposit_paid_at is not null and old.deposit_paid_at is null and new.status in ('pending', 'confirmed') then
    perform public.send_new_booking_messages(new);
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_on_deposit_settled on public.appointments;
create trigger trg_on_deposit_settled
  after update of status, deposit_paid_at on public.appointments
  for each row execute function public.on_deposit_settled();

-- ----------------------------------------------------------------------------
-- 5) Payments ledger (written by the `payment` Edge Function only)
-- ----------------------------------------------------------------------------
create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  appointment_id text not null references public.appointments (id) on delete cascade,
  amount_rial    bigint not null,
  authority      text unique,
  status         text not null default 'requested' check (status in ('requested', 'paid', 'failed', 'expired', 'refund_needed')),
  ref_id         text,
  card_pan       text,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz
);
create index if not exists payments_appointment_idx on public.payments (appointment_id);
alter table public.payments enable row level security;
drop policy if exists p_payments_read on public.payments;
create policy p_payments_read on public.payments for select
  using (public.is_manager() and salon_id = public.current_salon_id());
grant select on public.payments to authenticated;

-- ----------------------------------------------------------------------------
-- 6) Release unpaid holds
-- ----------------------------------------------------------------------------
create or replace function public.expire_unpaid_bookings()
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_n int;
begin
  with gone as (
    update public.appointments
       set status = 'cancelled'
     where status = 'awaiting_payment' and created_at < now() - interval '20 minutes'
    returning id
  )
  select count(*) into v_n from gone;
  update public.payments set status = 'expired'
   where status = 'requested' and created_at < now() - interval '20 minutes';
  return v_n;
end;
$fn$;
revoke all on function public.expire_unpaid_bookings() from public, anon, authenticated;
grant execute on function public.expire_unpaid_bookings() to service_role;

-- ----------------------------------------------------------------------------
-- 7) What the booking page needs to know
-- ----------------------------------------------------------------------------
-- Deposit terms for the current salon (the merchant ID itself stays private).
create or replace function public.deposit_terms()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'enabled', coalesce(s.deposit_percent, 0) > 0 and coalesce(p.zarinpal_merchant_id, '') <> '',
    'percent', coalesce(s.deposit_percent, 0),
    'min_price', coalesce(s.deposit_min_price, 0)
  )
  from (select public.current_salon_id() as salon_id) c
  left join public.app_settings s on s.salon_id = c.salon_id
  left join public.salon_payment_settings p on p.salon_id = c.salon_id;
$fn$;
grant execute on function public.deposit_terms() to anon, authenticated;

-- create_public_booking — as in v2.32, but also returns the stored status
-- (confirmed / pending / awaiting_payment) and the deposit amount.
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
  v_status text; v_deposit bigint;
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
    'status', v_status, 'deposit_amount', v_deposit
  );
end;
$fn$;
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text) to anon, authenticated;
