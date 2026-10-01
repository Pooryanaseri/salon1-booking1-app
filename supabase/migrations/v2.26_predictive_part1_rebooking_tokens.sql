-- ============================================================================
-- Migration v2.26 — Predictive Autopilot (part 1 of 3): rebooking token
-- system (the shared mechanism behind Feature 2, used by both Feature 1's
-- closure-cancellation SMS and Feature 3's predictive re-engagement SMS)
-- ============================================================================
-- SECURITY DESIGN NOTE (deliberate departure from the spec's literal URL
-- shape): the spec's example URL is
--   /book?service_id={service_id}&client_id={client_id}&preferred_dates=...&token={secure_token}
-- Putting client_id and service_id in the URL ALONGSIDE the token invites
-- exactly the bug this changes: if the booking-creation step ever reads
-- customer identity from client_id instead of from the verified token,
-- anyone can edit the URL and book — or worse, directly CONFIRM a
-- booking — as a different customer, with zero verification. The actual
-- link this migration generates (see create_rebooking_token and its
-- callers in parts 2-3) carries ONLY the opaque token:
--   /book?token={secure_token}
-- service_id/staff_id/customer_phone are still available to the frontend
-- for pre-filling the page (via resolve_rebooking_token below), but they
-- come FROM the token's own resolution, server-side — never from a URL
-- parameter the client could edit. The actual write
-- (create_booking_from_rebooking_token, part 2) takes ONLY a token and a
-- chosen date/time; it has no customer_phone or service_id parameter at
-- all, so there is nothing for a tampered URL to override.
-- ============================================================================

create table if not exists public.rebooking_tokens (
  id               bigint generated always as identity primary key,
  salon_id         uuid not null references public.salons(id) on delete cascade,
  token_hash       text not null unique,
  customer_phone   text not null,
  customer_name    text not null default '',
  service_id       text references public.services(id) on delete set null,
  staff_id         text references public.stylists(id) on delete set null,
  reason           text not null default 'manual' check (reason in ('closure', 'predictive', 'manual')),
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists rebooking_tokens_salon_idx on public.rebooking_tokens (salon_id);
alter table public.rebooking_tokens enable row level security;
-- No policies at all — reachable only through the SECURITY DEFINER
-- functions below, same pattern as every other token table in this app.

create or replace function public.create_rebooking_token(
  p_salon_id uuid, p_customer_phone text, p_service_id text default null,
  p_staff_id text default null, p_reason text default 'manual'
)
returns text
language plpgsql security definer set search_path = public as $fn$
declare v_token text; v_hash text; v_name text;
begin
  select name into v_name from public.customers where salon_id = p_salon_id and phone = p_customer_phone;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_token, 'sha256'), 'hex');
  insert into public.rebooking_tokens (salon_id, token_hash, customer_phone, customer_name, service_id, staff_id, reason, expires_at)
  values (p_salon_id, v_hash, p_customer_phone, coalesce(v_name, ''), p_service_id, p_staff_id, p_reason, now() + interval '14 days');
  if random() < 0.02 then
    delete from public.rebooking_tokens where expires_at < now() - interval '30 days';
  end if;
  return v_token;
end;
$fn$;
-- Not granted to anon/authenticated directly — only ever called FROM
-- another SECURITY DEFINER function (handle_closure_announcement, the
-- predictive cron function), never by a client request. A manager-facing
-- "send a rebooking link manually" action would call it the same way
-- these do, through a thin wrapper RPC with its own manager/tenant check
-- — not by granting this one directly, to keep the single-use/expiry
-- bookkeeping in one place.

-- ----------------------------------------------------------------------------
-- resolve_rebooking_token — what the /book page calls on load to find out
-- what it's actually offering (salon, suggested service/staff, the
-- customer's own name for a personalized greeting) — all derived from the
-- token, never echoed back from whatever the client happened to pass in
-- the URL.
-- ----------------------------------------------------------------------------
create or replace function public.resolve_rebooking_token(p_token text)
returns json
language sql stable security definer set search_path = public as $fn$
  select case when rt.id is null then json_build_object('ok', false, 'error', 'این لینک منقضی یا نامعتبر است')
    else json_build_object(
      'ok', true,
      'salon_id', rt.salon_id,
      'salon_name', s.name,
      'salon_slug', s.slug,
      'customer_name', rt.customer_name,
      'service_id', rt.service_id,
      'service_name', svc.name,
      'staff_id', rt.staff_id,
      'staff_name', st.name
    )
  end
  from (select 1) as dummy
  left join public.rebooking_tokens rt
    on rt.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   and rt.used_at is null and rt.expires_at > now()
  left join public.salons s on s.id = rt.salon_id
  left join public.services svc on svc.id = rt.service_id and svc.salon_id = rt.salon_id
  left join public.stylists st on st.id = rt.staff_id and st.salon_id = rt.salon_id;
$fn$;
grant execute on function public.resolve_rebooking_token(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- create_booking_from_rebooking_token — the actual write. Deliberately
-- takes ONLY the token plus scheduling choices (date, time, optional
-- staff override) — no customer_phone, no service_id parameter at all.
-- Everything identity-bearing comes from resolving the token itself, so
-- there is no field here a tampered request could override to book (or
-- worse, instantly CONFIRM) as someone else. Mirrors create_public_
-- booking's own validation (closures, working hours, exclusion handling)
-- but sets status = 'confirmed' directly — the token already represents a
-- verified, pre-existing customer relationship, so skipping the manual
-- review step a brand-new anonymous booking would need is a reasonable,
-- bounded exception, not a general bypass.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- get_available_slots_for_rebooking — what the /book page calls once the
-- customer picks a date, to show real open time slots (in
-- service-duration-sized steps) for the token's salon/service/staff.
-- Read-only; reuses the same working-hours/closure/overlap rules
-- create_booking_from_rebooking_token itself enforces on write, so what's
-- offered here is always actually bookable.
-- ----------------------------------------------------------------------------
create or replace function public.get_available_slots_for_rebooking(p_token text, p_date date, p_staff_id text default null)
returns table (start_min int)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_rt record; v_svc record; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_staff_id text; v_step int; v_t int;
begin
  select * into v_rt from public.rebooking_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now();
  if v_rt is null or v_rt.service_id is null then
    return;
  end if;
  if p_date < current_date
     or not exists (select 1 from public.approved_dates where date = p_date and salon_id = v_rt.salon_id)
     or exists (select 1 from public.salon_closures where salon_id = v_rt.salon_id and closure_date = p_date and is_active)
  then
    return;
  end if;

  v_staff_id := coalesce(p_staff_id, v_rt.staff_id);
  select * into v_svc from public.services where id = v_rt.service_id and salon_id = v_rt.salon_id and is_active;
  if v_svc is null then
    return;
  end if;

  v_app_dow := (extract(dow from p_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = v_staff_id and salon_id = v_rt.salon_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null and salon_id = v_rt.salon_id;
  end if;
  if v_wh is null or v_wh.is_closed then
    return;
  end if;
  v_wh_start := split_part(v_wh.start_time, ':', 1)::int * 60 + split_part(v_wh.start_time, ':', 2)::int;
  v_wh_end := split_part(v_wh.end_time, ':', 1)::int * 60 + split_part(v_wh.end_time, ':', 2)::int;
  v_step := greatest(15, v_svc.duration_minutes);

  v_t := v_wh_start;
  while v_t + v_svc.duration_minutes <= v_wh_end loop
    if v_staff_id is null or not exists (
      select 1 from public.appointments ap
      where ap.salon_id = v_rt.salon_id and ap.staff_id = v_staff_id and ap.date = p_date
        and ap.status in ('pending', 'confirmed', 'rescheduled')
        and int4range(ap.start_min, ap.end_min + ap.buffer_minutes) && int4range(v_t, v_t + v_svc.duration_minutes + v_svc.buffer_minutes)
    ) then
      start_min := v_t;
      return next;
    end if;
    v_t := v_t + v_step;
  end loop;
end;
$fn$;
grant execute on function public.get_available_slots_for_rebooking(text, date, text) to anon, authenticated;
