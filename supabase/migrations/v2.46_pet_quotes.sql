-- ============================================================================
-- Migration v2.46 — price quotes for pet salons (run after v2.45)
-- ============================================================================
--  A groomer prices a visit after seeing what it involves. So:
--   1. The customer sends a request: the animal, the services wanted, a
--      note and a preferred time (request_quote). Customer and manager get
--      an SMS.
--   2. Staff answer from the panel with a price, a duration and optionally
--      the groomer (send_quote) — or decline with a reason.
--   3. The customer gets an SMS with a booking link (a rebooking token tied
--      to the quote) and picks a time; the booking is created at the quoted
--      price and duration. The same quote is in "my dashboard", which can
--      issue a fresh link (my_quote_link).
--  app_settings.pet_quote_mode: 'all' (every pet booking goes through a
--  quote), 'unpriced' (only services with no price for the animal),
--  'off' (direct booking as in v2.44/45).
--  Also: get_available_slots_for_rebooking now uses the same duration as
--  the booking (the animal's size/breed, or the quote) — before, a pet
--  link could offer times its own booking then refused.
-- ============================================================================

alter table public.app_settings add column if not exists pet_quote_mode text not null default 'all';
alter table public.app_settings drop constraint if exists app_settings_pet_quote_mode_check;
alter table public.app_settings add constraint app_settings_pet_quote_mode_check check (pet_quote_mode in ('off', 'unpriced', 'all'));
alter table public.app_settings add column if not exists pet_quote_valid_days int not null default 3;
alter table public.app_settings drop constraint if exists app_settings_pet_quote_valid_days_check;
alter table public.app_settings add constraint app_settings_pet_quote_valid_days_check check (pet_quote_valid_days between 1 and 14);

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote'));

create table if not exists public.quote_requests (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  customer_phone  text not null check (customer_phone ~ '^09[0-9]{9}$'),
  customer_name   text not null default '',
  pet_id          uuid references public.pets (id) on delete set null,
  pet_name        text not null,
  pet_species     text not null check (pet_species in ('dog', 'cat')),
  pet_size        text check (pet_size is null or pet_size in ('small', 'medium', 'large', 'giant')),
  service_ids     text[] not null check (cardinality(service_ids) between 1 and 6),
  services_label  text not null,
  customer_note   text not null default '' check (length(customer_note) <= 500),
  preferred_time  text not null default '' check (length(preferred_time) <= 100),
  status          text not null default 'pending' check (status in ('pending', 'quoted', 'booked', 'declined', 'cancelled')),
  quoted_price    bigint check (quoted_price is null or quoted_price >= 0),
  quoted_duration int check (quoted_duration is null or quoted_duration between 5 and 600),
  quoted_staff_id text,
  quote_note      text not null default '' check (length(quote_note) <= 300),
  quoted_at       timestamptz,
  expires_at      timestamptz,
  appointment_id  text references public.appointments (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists quote_requests_salon_status_idx on public.quote_requests (salon_id, status, created_at desc);
create index if not exists quote_requests_phone_idx on public.quote_requests (salon_id, customer_phone);

alter table public.quote_requests enable row level security;
revoke all on public.quote_requests from anon, authenticated;
grant select on public.quote_requests to authenticated;
drop policy if exists p_quotes_staff_read on public.quote_requests;
create policy p_quotes_staff_read on public.quote_requests for select
  using ((select public.is_staff()) and salon_id = (select public.current_salon_id()));

alter table public.rebooking_tokens drop constraint if exists rebooking_tokens_reason_check;
alter table public.rebooking_tokens add constraint rebooking_tokens_reason_check check (reason in ('closure', 'predictive', 'manual', 'waitlist', 'quote'));
alter table public.rebooking_tokens add column if not exists quote_id uuid references public.quote_requests (id) on delete cascade;
alter table public.appointments add column if not exists quote_id uuid references public.quote_requests (id) on delete set null;
alter table public.appointments add column if not exists services_label text;

-- What a rebooking token books: the service (as priced and timed for this
-- customer's animal, or as quoted) and the animal. One place, so the slot
-- list and the booking always agree.
create or replace function public.rebooking_plan(p_rt public.rebooking_tokens,
  out svc public.services, out pet_id uuid, out pet_name text, out pet_size text, out pet_temper text,
  out quote public.quote_requests)
language plpgsql stable security definer set search_path = public as $fn$
declare v_breed text;
begin
  if p_rt.quote_id is not null then
    select * into quote from public.quote_requests where id = p_rt.quote_id and salon_id = p_rt.salon_id;
    select * into svc from public.services where id = p_rt.service_id and salon_id = p_rt.salon_id;
    if quote.id is null or svc.id is null then
      svc := null;
      return;
    end if;
    pet_id := quote.pet_id; pet_name := quote.pet_name; pet_size := quote.pet_size;
    svc.price := quote.quoted_price;
    svc.duration_minutes := quote.quoted_duration;
    svc.discount_type := 'none'; svc.discount_value := 0; svc.discount_reason := '';
    return;
  end if;
  select * into svc from public.services where id = p_rt.service_id and salon_id = p_rt.salon_id and is_active;
  if svc.id is null then
    svc := null;
    return;
  end if;
  if svc.gender in ('dog', 'cat') then
    select p.id, p.name, p.size, p.breed, p.temperament into pet_id, pet_name, pet_size, v_breed, pet_temper
      from public.pets p
     where p.salon_id = p_rt.salon_id and p.owner_phone = p_rt.customer_phone and p.species = svc.gender
     order by p.last_visit_date desc nulls last, p.created_at desc
     limit 1;
    svc := public.service_for_pet(svc, pet_size, v_breed);
  end if;
end;
$fn$;
revoke all on function public.rebooking_plan(public.rebooking_tokens) from public, anon, authenticated;

create or replace function public.resolve_rebooking_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_rt public.rebooking_tokens; v_plan record;
begin
  select * into v_rt from public.rebooking_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now();
  if v_rt.id is null then
    return json_build_object('ok', false, 'error', 'این لینک منقضی یا نامعتبر است');
  end if;
  select * into v_plan from public.rebooking_plan(v_rt);
  if v_rt.quote_id is not null and ((v_plan.quote).status is distinct from 'quoted' or (v_plan.quote).expires_at <= now()) then
    return json_build_object('ok', false, 'error', 'این پیشنهاد قیمت دیگر معتبر نیست');
  end if;
  return json_build_object(
    'ok', true,
    'salon_id', v_rt.salon_id,
    'salon_name', (select name from public.salons where id = v_rt.salon_id),
    'salon_slug', (select slug from public.salons where id = v_rt.salon_id),
    'customer_name', v_rt.customer_name,
    'service_id', v_rt.service_id,
    'service_name', coalesce((v_plan.quote).services_label, (v_plan.svc).name),
    'staff_id', v_rt.staff_id,
    'staff_name', (select name from public.stylists where id = v_rt.staff_id and salon_id = v_rt.salon_id),
    'reason', v_rt.reason,
    'preferred_date', v_rt.preferred_date,
    -- v2.46: what the booking will cost and take, and the animal
    'price', (v_plan.svc).price,
    'duration', (v_plan.svc).duration_minutes,
    'pet_name', v_plan.pet_name,
    'quote_note', nullif((v_plan.quote).quote_note, ''),
    'quote_expires_at', (v_plan.quote).expires_at,
    'is_quote', v_rt.quote_id is not null
  );
end;
$fn$;
grant execute on function public.resolve_rebooking_token(text) to anon, authenticated;

create or replace function public.get_available_slots_for_rebooking(p_token text, p_date date, p_staff_id text default null)
returns table (start_min int)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_rt public.rebooking_tokens; v_plan record; v_svc public.services; v_wh record; v_app_dow int;
  v_wh_start int; v_wh_end int; v_staff_id text; v_step int; v_t int;
begin
  select * into v_rt from public.rebooking_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now();
  if v_rt.id is null or v_rt.service_id is null then
    return;
  end if;
  if p_date < current_date
     or not exists (select 1 from public.approved_dates where date = p_date and salon_id = v_rt.salon_id)
     or exists (select 1 from public.salon_closures where salon_id = v_rt.salon_id and closure_date = p_date and is_active)
  then
    return;
  end if;
  select * into v_plan from public.rebooking_plan(v_rt);
  v_svc := v_plan.svc;
  if v_svc.id is null then
    return;
  end if;

  v_staff_id := coalesce(p_staff_id, v_rt.staff_id);
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
  -- every half hour (it used to step by the whole service length, so a
  -- two-hour visit could only start at 9, 11, 13 …)
  v_step := least(greatest(15, v_svc.duration_minutes), 30);

  v_t := v_wh_start;
  while v_t + v_svc.duration_minutes <= v_wh_end loop
    if (p_date > public.salon_today() or v_t > extract(hour from (now() at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran')))::int * 60
                                              + extract(minute from (now() at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran')))::int)
       and (v_staff_id is null or not exists (
      select 1 from public.appointments ap
      where ap.salon_id = v_rt.salon_id and ap.staff_id = v_staff_id and ap.date = p_date
        and ap.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment')
        and int4range(ap.start_min, ap.end_min + ap.buffer_minutes) && int4range(v_t, v_t + v_svc.duration_minutes + v_svc.buffer_minutes)
    )) then
      start_min := v_t;
      return next;
    end if;
    v_t := v_t + v_step;
  end loop;
end;
$fn$;
grant execute on function public.get_available_slots_for_rebooking(text, date, text) to anon, authenticated;

create or replace function public.create_booking_from_rebooking_token(
  p_token text, p_date date, p_start_min int, p_staff_id text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_rt public.rebooking_tokens; v_plan record; v_quote public.quote_requests; v_svc public.services; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
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
  -- v2.46: the service as priced/timed for the animal, or as quoted
  select * into v_plan from public.rebooking_plan(v_rt);
  v_svc := v_plan.svc;
  v_quote := v_plan.quote;
  if v_svc.id is null then
    return json_build_object('ok', false, 'error', 'خدمت یافت نشد یا غیرفعال است');
  end if;
  if v_rt.quote_id is not null and (v_quote.status is distinct from 'quoted' or v_quote.expires_at <= now()) then
    return json_build_object('ok', false, 'error', 'این پیشنهاد قیمت دیگر معتبر نیست');
  end if;
  v_pet_id := v_plan.pet_id; v_pet_name := v_plan.pet_name; v_pet_size := v_plan.pet_size; v_pet_temper := v_plan.pet_temper;
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
  if v_svc.price is not null and v_rt.quote_id is null then -- a quoted price is final
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
      pet_id, pet_name, pet_size, extra_charges, quote_id, services_label
    ) values (
      v_id, v_rt.salon_id,
      coalesce(nullif(v_rt.customer_name, ''), (select name from public.customers where salon_id = v_rt.salon_id and phone = v_rt.customer_phone), ''),
      v_rt.customer_phone, v_svc.gender, v_rt.service_id, v_staff_id,
      coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'confirmed',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final,
      v_pet_id, v_pet_name, v_pet_size, v_extras, v_rt.quote_id, v_quote.services_label
    );
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  update public.rebooking_tokens set used_at = now() where id = v_rt.id;
  if v_rt.quote_id is not null then
    update public.quote_requests set status = 'booked', appointment_id = v_id, updated_at = now() where id = v_rt.quote_id;
    update public.rebooking_tokens set used_at = now() where quote_id = v_rt.quote_id and used_at is null;
  end if;

  return json_build_object(
    'ok', true, 'id', v_id, 'tracking_code', v_code, 'final_price', v_final,
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), '')
  );
end;
$fn$;
grant execute on function public.create_booking_from_rebooking_token(text, date, int, text) to anon, authenticated;

-- ------------------------------------------------------------ helpers ------
create or replace function public.fa_money(p bigint)
returns text
language sql immutable as $fn$
  select translate(to_char(p, 'FM999,999,999,999'), '0123456789', '۰۱۲۳۴۵۶۷۸۹');
$fn$;

-- ------------------------------------------------- 1. customer request ----
create or replace function public.request_quote(
  p_customer_name text, p_customer_phone text, p_species text, p_pet jsonb,
  p_service_ids text[], p_note text default '', p_preferred_time text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id(); v_type text; v_salon_name text;
  v_pet_name text; v_size text; v_label text; v_count int; v_pet_id uuid; v_id uuid;
  v_ids text[]; v_phone text;
begin
  if v_salon is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  select business_type, name into v_type, v_salon_name from public.salons where id = v_salon;
  if v_type is distinct from 'pet' then
    return json_build_object('ok', false, 'error', 'این سالن استعلام قیمت ندارد');
  end if;
  if coalesce(p_customer_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    select name into p_customer_name from public.customers where salon_id = v_salon and phone = p_customer_phone;
  end if;
  if coalesce(trim(p_customer_name), '') = '' or length(p_customer_name) > 80 then
    return json_build_object('ok', false, 'error', 'نام لازم است');
  end if;
  if p_species is null or p_species not in ('dog', 'cat') then
    return json_build_object('ok', false, 'error', 'نوع حیوان نامعتبر است');
  end if;
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
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_service_ids, '{}')) x where x is not null;
  if coalesce(cardinality(v_ids), 0) not between 1 and 6 then
    return json_build_object('ok', false, 'error', 'یک تا شش خدمت انتخاب کنید');
  end if;
  select count(*), string_agg(s.name, ' + ' order by s.name) into v_count, v_label
    from public.services s
   where s.salon_id = v_salon and s.id = any (v_ids) and s.is_active and not s.is_addon and s.gender = p_species;
  if v_count <> cardinality(v_ids) then
    return json_build_object('ok', false, 'error', 'خدمت انتخابی یافت نشد');
  end if;
  if length(coalesce(p_note, '')) > 500 or length(coalesce(p_preferred_time, '')) > 100 then
    return json_build_object('ok', false, 'error', 'توضیحات طولانی است');
  end if;
  if not public.check_rate_limit('quote:' || v_salon || ':' || p_customer_phone, 5, 60) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید');
  end if;
  if (select count(*) from public.quote_requests
       where salon_id = v_salon and customer_phone = p_customer_phone and status = 'pending') >= 3 then
    return json_build_object('ok', false, 'error', 'سه درخواست شما در انتظار پاسخ سالن است');
  end if;

  v_pet_id := public.upsert_pet(v_salon, p_customer_phone, p_species, p_pet);
  insert into public.quote_requests (salon_id, customer_phone, customer_name, pet_id, pet_name, pet_species, pet_size,
                                     service_ids, services_label, customer_note, preferred_time)
  values (v_salon, p_customer_phone, trim(p_customer_name), v_pet_id, v_pet_name, p_species, v_size,
          v_ids, v_label, trim(coalesce(p_note, '')), trim(coalesce(p_preferred_time, '')))
  returning id into v_id;

  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (v_salon, p_customer_phone,
          trim(p_customer_name) || ' عزیز، درخواست شما برای ' || v_pet_name || ' (' || v_label || ') در ' || v_salon_name
            || E' ثبت شد.\nقیمت و لینک رزرو به‌زودی برایتان پیامک می‌شود.',
          'quote_request', 'queued', now());
  -- the salon's managers hear about it right away
  for v_phone in
    select distinct u.phone from public.users u
     where u.salon_id = v_salon and u.role in ('owner', 'manager') and u.active is not false and u.phone ~ '^09[0-9]{9}$'
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (v_salon, v_phone,
            'درخواست قیمت جدید: ' || v_pet_name || ' (' || case p_species when 'cat' then 'گربه' else 'سگ' end
              || '، ' || public.pet_size_label(v_size) || case when coalesce(p_pet ->> 'breed', '') <> '' then '، ' || left(p_pet ->> 'breed', 40) else '' end
              || ') — ' || v_label || E'\nصاحب: ' || trim(p_customer_name) || ' ' || p_customer_phone || E'\nپاسخ از پنل ← استعلام قیمت',
            'quote_request', 'queued', now());
  end loop;
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
revoke all on function public.request_quote(text, text, text, jsonb, text[], text, text) from public;
grant execute on function public.request_quote(text, text, text, jsonb, text[], text, text) to anon, authenticated;

-- ------------------------------------------------------ 2. staff answer ----
create or replace function public.send_quote(p_id uuid, p_price bigint, p_duration int, p_staff_id text default null, p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_q public.quote_requests; v_days int; v_token text; v_link text; v_salon_name text; v_body text;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  select * into v_q from public.quote_requests where id = p_id and salon_id = public.current_salon_id() for update;
  if v_q.id is null then
    return json_build_object('ok', false, 'error', 'درخواست پیدا نشد');
  end if;
  if v_q.status not in ('pending', 'quoted') then
    return json_build_object('ok', false, 'error', 'این درخواست بسته شده است');
  end if;
  if p_price is null or p_price < 1000 then
    return json_build_object('ok', false, 'error', 'قیمت را وارد کنید');
  end if;
  if p_duration is null or p_duration not between 5 and 600 then
    return json_build_object('ok', false, 'error', 'مدت باید بین ۵ تا ۶۰۰ دقیقه باشد');
  end if;
  if p_staff_id is not null and not exists (select 1 from public.stylists where id = p_staff_id and salon_id = v_q.salon_id and active) then
    return json_build_object('ok', false, 'error', 'آرایشگر پیدا نشد');
  end if;
  if length(coalesce(p_note, '')) > 300 then
    return json_build_object('ok', false, 'error', 'توضیح طولانی است');
  end if;
  select coalesce(pet_quote_valid_days, 3) into v_days from public.app_settings where salon_id = v_q.salon_id;

  update public.quote_requests
     set status = 'quoted', quoted_price = p_price, quoted_duration = p_duration, quoted_staff_id = p_staff_id,
         quote_note = trim(coalesce(p_note, '')), quoted_at = now(), expires_at = now() + make_interval(days => coalesce(v_days, 3)),
         updated_at = now()
   where id = p_id
  returning * into v_q;

  -- a new price replaces any link sent before
  update public.rebooking_tokens set used_at = now() where quote_id = p_id and used_at is null;
  v_token := public.create_rebooking_token(v_q.salon_id, v_q.customer_phone, v_q.service_ids[1], p_staff_id, 'quote');
  update public.rebooking_tokens set quote_id = p_id, expires_at = v_q.expires_at, customer_name = v_q.customer_name
   where token_hash = encode(digest(v_token, 'sha256'), 'hex');
  v_link := public.public_link('/book?token=' || v_token);

  select name into v_salon_name from public.salons where id = v_q.salon_id;
  v_body := v_q.customer_name || ' عزیز، قیمت ' || v_q.services_label || ' برای ' || v_q.pet_name || ' در ' || v_salon_name || ': '
            || public.fa_money(p_price) || ' تومان (حدود ' || translate(p_duration::text, '0123456789', '۰۱۲۳۴۵۶۷۸۹') || ' دقیقه).'
            || case when coalesce(trim(p_note), '') <> '' then E'\n' || trim(p_note) else '' end
            || E'\n' || case when v_link is not null then 'انتخاب زمان و رزرو: ' || v_link
                             else 'برای رزرو به «داشبورد من» در صفحهٔ سالن بروید.' end
            || E'\nمعتبر تا ' || public.jalali_label((v_q.expires_at at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::date);
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (v_q.salon_id, v_q.customer_phone, v_body, 'quote', 'queued', now());
  return json_build_object('ok', true, 'expires_at', v_q.expires_at, 'link', v_link);
end;
$fn$;
revoke all on function public.send_quote(uuid, bigint, int, text, text) from public, anon;
grant execute on function public.send_quote(uuid, bigint, int, text, text) to authenticated;

create or replace function public.decline_quote(p_id uuid, p_reason text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_q public.quote_requests; v_salon_name text;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  update public.quote_requests set status = 'declined', quote_note = left(trim(coalesce(p_reason, '')), 300), updated_at = now()
   where id = p_id and salon_id = public.current_salon_id() and status in ('pending', 'quoted')
  returning * into v_q;
  if v_q.id is null then
    return json_build_object('ok', false, 'error', 'درخواست باز پیدا نشد');
  end if;
  update public.rebooking_tokens set used_at = now() where quote_id = p_id and used_at is null;
  select name into v_salon_name from public.salons where id = v_q.salon_id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (v_q.salon_id, v_q.customer_phone,
          v_q.customer_name || ' عزیز، ' || v_salon_name || ': متاسفانه برای درخواست ' || v_q.pet_name || ' امکان پذیرش نیست.'
            || case when v_q.quote_note <> '' then E'\n' || v_q.quote_note else '' end,
          'quote', 'queued', now());
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.decline_quote(uuid, text) from public, anon;
grant execute on function public.decline_quote(uuid, text) to authenticated;

-- --------------------------------------------- 3. customer's dashboard ----
create or replace function public.my_quotes_with_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return '[]'::json;
  end if;
  return coalesce((
    select json_agg(json_build_object(
             'id', q.id, 'pet_name', q.pet_name, 'pet_species', q.pet_species, 'services_label', q.services_label,
             'status', case when q.status = 'quoted' and q.expires_at <= now() then 'expired' else q.status end,
             'price', q.quoted_price, 'duration', q.quoted_duration, 'note', nullif(q.quote_note, ''),
             'expires_at', q.expires_at, 'created_at', q.created_at, 'appointment_id', q.appointment_id)
           order by q.created_at desc)
      from public.quote_requests q
     where q.salon_id = v_salon and q.customer_phone = v_phone and q.created_at > now() - interval '60 days'), '[]'::json);
end;
$fn$;
grant execute on function public.my_quotes_with_token(text) to anon, authenticated;

-- A fresh booking link for a quoted price (the SMS link may be lost).
create or replace function public.my_quote_link(p_token text, p_quote_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid; v_q public.quote_requests; v_token text;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  select * into v_q from public.quote_requests where id = p_quote_id and salon_id = v_salon and customer_phone = v_phone;
  if v_q.id is null or v_q.status <> 'quoted' or v_q.expires_at <= now() then
    return json_build_object('ok', false, 'error', 'این پیشنهاد قیمت دیگر معتبر نیست');
  end if;
  update public.rebooking_tokens set used_at = now() where quote_id = v_q.id and used_at is null;
  v_token := public.create_rebooking_token(v_q.salon_id, v_q.customer_phone, v_q.service_ids[1], v_q.quoted_staff_id, 'quote');
  update public.rebooking_tokens set quote_id = v_q.id, expires_at = v_q.expires_at, customer_name = v_q.customer_name
   where token_hash = encode(digest(v_token, 'sha256'), 'hex');
  return json_build_object('ok', true, 'token', v_token);
end;
$fn$;
grant execute on function public.my_quote_link(text, uuid) to anon, authenticated;

create or replace function public.cancel_my_quote(p_token text, p_quote_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid; v_n int;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  update public.quote_requests set status = 'cancelled', updated_at = now()
   where id = p_quote_id and salon_id = v_salon and customer_phone = v_phone and status in ('pending', 'quoted');
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'درخواست باز پیدا نشد');
  end if;
  update public.rebooking_tokens set used_at = now() where quote_id = p_quote_id and used_at is null;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.cancel_my_quote(text, uuid) to anon, authenticated;
