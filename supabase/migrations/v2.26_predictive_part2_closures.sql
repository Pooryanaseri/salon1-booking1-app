-- ============================================================================
-- Migration v2.26 — Predictive Autopilot (part 1 of 3): Smart Absence &
-- Holiday Management (Zero-Touch Closure)
-- ============================================================================
-- A closure needs to do TWO things, not just one: cancel appointments that
-- already exist on that date, AND stop NEW bookings from being made on it.
-- The spec's own text only describes the first half explicitly — this
-- migration implements both, since a closure that still lets customers
-- book fresh appointments on the "closed" day would be a logical
-- contradiction, not a smaller version of the feature.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) New terminal status: cancelled_by_salon — distinct from a customer's
--    own cancellation, so analytics/reporting can tell the two apart (a
--    salon-initiated cancellation is a service failure worth tracking
--    separately from a customer changing their mind). Revenue eligibility
--    is unaffected either way (isRevenueEligible only ever allows
--    'completed' — see v2.25), and this status is excluded from the
--    overlap-prevention exclusion constraint exactly like 'cancelled'
--    already is (see the update to appointments_no_overlap below — it
--    only ever covered pending/confirmed/rescheduled, so a cancelled_by_
--    salon row was never going to block a new booking in that slot;
--    no constraint change needed there specifically, confirmed by reading
--    it again here).
-- ----------------------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in (
    'pending','confirmed','cancelled','rescheduled','completed','no_show',
    'reschedule_proposed','pending_verification','archived_unconfirmed',
    'cancelled_by_salon'
  ));

-- ----------------------------------------------------------------------------
-- 2) salon_closures — richer than approved_dates (which is just a plain
--    open/closed flag): a reason, a note, and independent of whether the
--    date was ever marked "open" in the first place.
-- ----------------------------------------------------------------------------
create table if not exists public.salon_closures (
  id            text primary key default 'clo-' || substr(md5(gen_random_uuid()::text), 1, 12),
  salon_id      uuid not null references public.salons(id) on delete cascade,
  closure_date  date not null,
  closure_type  text not null check (closure_type in ('holiday', 'maintenance', 'personal_leave')),
  notes         text not null default '',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (salon_id, closure_date)
);
create index if not exists salon_closures_salon_date_idx on public.salon_closures (salon_id, closure_date) where is_active;

alter table public.salon_closures enable row level security;
drop policy if exists p_closures_read on public.salon_closures;
create policy p_closures_read on public.salon_closures for select
  using (salon_id = public.current_salon_id());
drop policy if exists p_closures_write on public.salon_closures;
create policy p_closures_write on public.salon_closures for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select on public.salon_closures to anon, authenticated;
grant insert, update, delete on public.salon_closures to authenticated;

-- ----------------------------------------------------------------------------
-- 3) handle_closure_announcement — marks the date closed, cancels every
--    affected confirmed/rescheduled appointment, and QUEUES a rebooking
--    SMS for each (via sms_messages, picked up by cron-reminders' existing
--    DRAIN step — this RPC runs inside the database and has no way to
--    call an SMS provider directly, so it queues rather than sends; see
--    part 2 for the rebooking-token/link generation it uses per message).
-- ----------------------------------------------------------------------------
create or replace function public.handle_closure_announcement(
  p_salon_id uuid, p_closure_date date, p_closure_type text, p_notes text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_appt record;
  v_affected int := 0;
  v_reason_note text;
  v_token text;
  v_body text;
  v_salon_name text;
begin
  if not (public.is_manager() and p_salon_id = public.current_salon_id()) then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_closure_type not in ('holiday', 'maintenance', 'personal_leave') then
    return json_build_object('ok', false, 'error', 'نوع تعطیلی نامعتبر است');
  end if;

  insert into public.salon_closures (salon_id, closure_date, closure_type, notes, is_active)
  values (p_salon_id, p_closure_date, p_closure_type, coalesce(p_notes, ''), true)
  on conflict (salon_id, closure_date) do update
    set closure_type = excluded.closure_type, notes = excluded.notes, is_active = true;

  select name into v_salon_name from public.salons where id = p_salon_id;
  v_reason_note := case p_closure_type
    when 'holiday' then ''
    else ' (تعطیلی ناگهانی به دلیل ' || case p_closure_type when 'maintenance' then 'تعمیرات' else 'مرخصی' end || ')'
  end;

  for v_appt in
    select * from public.appointments
     where salon_id = p_salon_id and date = p_closure_date
       and status in ('confirmed', 'rescheduled')
  loop
    update public.appointments set status = 'cancelled_by_salon' where id = v_appt.id;
    v_affected := v_affected + 1;

    -- A single-use rebooking token (part 1) tied to this customer's own
    -- phone and service — never the raw phone/service in the SMS URL
    -- itself, only an opaque token the frontend/RPC resolve server-side.
    v_token := public.create_rebooking_token(p_salon_id, v_appt.customer_phone, v_appt.service_id, v_appt.staff_id, 'closure');

    v_body := coalesce(v_salon_name, 'سالن') || ': متاسفانه نوبت شما در این تاریخ به دلیل تعطیلی لغو شد' || v_reason_note || '. '
      || 'برای رزرو زمان جدید لمس کنید: '
      || coalesce(current_setting('app.base_url', true), '') || '/book?token=' || v_token;

    insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
    values (p_salon_id, v_appt.customer_phone, v_body, 'cancellation', v_appt.id, 'queued', now());
  end loop;

  return json_build_object('ok', true, 'affected_appointments', v_affected);
end;
$fn$;
grant execute on function public.handle_closure_announcement(uuid, date, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) Integration: create_public_booking must also refuse a date that has
--    an active closure — otherwise closing a day cancels existing bookings
--    but silently lets new ones land on the very same date, which isn't a
--    smaller version of "closed", it's a contradiction of it.
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
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text) to anon, authenticated;
