-- Migration v2.19 — secure public booking management. Idempotent, no data
-- changes, does not alter or replace any prior migration.
--
-- PROBLEM: phone number alone (get_my_bookings(p_phone)) acted as the only
-- proof of ownership for viewing/cancelling/rescheduling a booking — anyone
-- who knew (or guessed) a real customer's phone number could act as them.
-- Separately, p_appt_insert had `with check (true)` (anyone could insert
-- any row with any price/discount/status) and p_appt_update's anonymous
-- branch had no ownership check at all (any appointment_id could be
-- cancelled/rescheduled by anyone who knew it). Neither appointment_id nor
-- phone number is a secret.
--
-- FIX: OTP-verified ownership. A customer requests a 6-digit code (sent by
-- SMS to their own phone — the actual proof step), verifies it, and
-- receives a random 256-bit access token (well above the 128-bit
-- minimum). That token — never the phone number or appointment_id alone —
-- is what every subsequent booking-management call requires. Only a hash
-- of both the OTP and the token is ever stored; the OTP is generated and
-- returned in plaintext exactly once, to a service-role-only function
-- callable solely from the send-sms Edge Function (never from a browser),
-- which sends it by SMS and returns nothing sensitive to the caller.
--
-- Booking creation, cancellation, and rescheduling now happen through
-- SECURITY DEFINER RPCs that compute price/discount/end_min from the
-- services/loyalty tables server-side — the browser's submitted price,
-- discount, duration, or status are never trusted. A GiST exclusion
-- constraint additionally makes double-booking the same stylist's time
-- impossible at the database level, closing the race-condition window
-- between "slot looked free" and "insert happened".

-- ----------------------------------------------------------------------------
-- 0) Extension needed for the overlap-exclusion constraint below.
-- ----------------------------------------------------------------------------
create extension if not exists btree_gist;

-- ----------------------------------------------------------------------------
-- 1) OTP challenges and access tokens — hash-only, RLS enabled with no
--    policies at all (default-deny for every direct client operation;
--    reachable exclusively through the SECURITY DEFINER functions below).
-- ----------------------------------------------------------------------------
create table if not exists public.booking_otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  otp_hash     text not null,
  salt         text not null,
  attempts     int not null default 0,
  max_attempts int not null default 5,
  consumed     boolean not null default false,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists booking_otp_challenges_phone_idx
  on public.booking_otp_challenges (phone, created_at desc);
alter table public.booking_otp_challenges enable row level security;

create table if not exists public.booking_access_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  phone       text not null,
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists booking_access_tokens_hash_idx
  on public.booking_access_tokens (token_hash);
alter table public.booking_access_tokens enable row level security;

-- ----------------------------------------------------------------------------
-- 2) Overlap prevention at the database level — a GiST exclusion
--    constraint, not application logic. Two active (non-cancelled) rows
--    for the same stylist on the same date can never have overlapping
--    [start_min, end_min + buffer_minutes) ranges, enforced atomically by
--    Postgres itself regardless of how many requests arrive at once.
--    Postgres does not support NOT VALID on exclusion constraints (unlike
--    CHECK/FK constraints), so creation itself is wrapped in an exception
--    handler: if a real deployment already has legacy overlapping rows,
--    this produces a warning instead of aborting the migration — no data
--    is touched or deleted either way, but the constraint won't exist
--    until an operator resolves the conflicting rows and re-runs this
--    block.
-- ----------------------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_no_overlap;
do $$
begin
  alter table public.appointments add constraint appointments_no_overlap
    exclude using gist (
      staff_id with =,
      date with =,
      int4range(start_min, end_min + buffer_minutes) with &&
    ) where (staff_id is not null and status in ('pending', 'confirmed', 'rescheduled'));
exception when others then
  raise warning 'appointments_no_overlap could not be created — likely pre-existing overlapping legacy data (no data was touched or deleted). Resolve conflicting rows and re-run this migration to add the constraint. Detail: %', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 3) appointments_public_slots — drop the id column. It carried no PII, but
--    an appointment id was (until this migration) usable to cancel/
--    reschedule via the old anonymous UPDATE policy; now that ownership
--    requires a verified token instead, the id itself grants nothing, but
--    it's still removed for defense in depth (nothing in the booking flow
--    reads it from this view — start_min/end_min/staff_id/date/buffer_
--    minutes/status is all the availability calculation ever used).
-- ----------------------------------------------------------------------------
drop view if exists public.appointments_public_slots;
create view public.appointments_public_slots as
select staff_id, date, start_min, end_min, buffer_minutes, status
from public.appointments;
grant select on public.appointments_public_slots to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Lock down direct anonymous access to the base table completely.
--    INSERT: was `with check (true)` — anyone could insert any row with any
--    price/status. Now no anon insert policy exists at all; creation is
--    exclusively through create_public_booking() below.
--    UPDATE: the old anonymous branch let anyone who knew an appointment_id
--    cancel/reschedule it — no ownership check. Removed entirely; cancel/
--    reschedule are exclusively through the token-verified RPCs below.
--    Manager/stylist branches (from v2.15) are unchanged.
-- ----------------------------------------------------------------------------
drop policy if exists p_appt_insert on public.appointments;
create policy p_appt_insert on public.appointments for insert with check (public.is_manager() or public.is_staff());

drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
) with check (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
);

-- Explicit base grant for authenticated (manager/stylist) — appointments
-- previously had no explicit grant anywhere in schema.sql, relying
-- entirely on Supabase's implicit default table grants. RLS above still
-- fully governs which rows are visible/writable; this just makes the
-- privilege model self-contained instead of depending on a platform
-- default. anon gets nothing here — no policy grants it direct access.
grant select, insert, update on public.appointments to authenticated;

-- guard_anonymous_appt_update's `if auth.uid() is null` branch is now dead
-- code (no policy grants anon UPDATE anymore) but harmless to leave as-is —
-- it cannot fire without a matching RLS grant, and removing it isn't
-- necessary for correctness. Left untouched to minimize the diff.

-- ----------------------------------------------------------------------------
-- 5) OTP request — service_role ONLY. This is the one place the plaintext
--    OTP exists outside a customer's own phone; it must never be callable
--    by anon/authenticated (no such grant is given), only by the send-sms
--    Edge Function's admin client.
-- ----------------------------------------------------------------------------
create or replace function public.request_booking_otp_internal(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea;
begin
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request:' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  -- Invalidate any still-outstanding code for this phone — only the most
  -- recently requested OTP is ever valid.
  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (phone, otp_hash, salt, expires_at)
  values (p_phone, v_hash, v_salt, now() + interval '5 minutes');

  -- Opportunistic cleanup (same pattern as check_rate_limit) — otherwise
  -- this table grows unbounded forever.
  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
revoke all on function public.request_booking_otp_internal(text) from public, anon, authenticated;
grant execute on function public.request_booking_otp_internal(text) to service_role;

-- ----------------------------------------------------------------------------
-- 6) OTP verification — anon-callable (rate-limited + attempt-limited per
--    challenge). Success consumes the challenge and issues a fresh access
--    token; only its hash is stored, the plaintext is returned exactly
--    once, to the caller who just proved phone ownership.
-- ----------------------------------------------------------------------------
create or replace function public.verify_booking_otp(p_phone text, p_otp text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_challenge record; v_hash text; v_token text; v_token_hash text;
begin
  if p_phone !~ '^09[0-9]{9}$' or p_otp !~ '^[0-9]{6}$' then
    return json_build_object('ok', false, 'error', 'ورودی نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_verify:' || p_phone, 10, 10) then
    return json_build_object('ok', false, 'error', 'تعداد تلاش بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into v_challenge from public.booking_otp_challenges
   where phone = p_phone and consumed = false and expires_at > now()
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

  v_token := encode(gen_random_bytes(32), 'hex'); -- 256 bits
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  insert into public.booking_access_tokens (token_hash, phone, expires_at)
  values (v_token_hash, p_phone, now() + interval '20 minutes');

  if random() < 0.01 then
    delete from public.booking_access_tokens where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'token', v_token, 'expires_in_seconds', 1200);
end;
$fn$;
grant execute on function public.verify_booking_otp(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7) Token → phone resolver, shared by every token-gated RPC below.
--    Rate-limited by the token's own hash (never the raw token, and this
--    never leaks whether a token exists — mismatched/expired/revoked all
--    resolve to the same null).
-- ----------------------------------------------------------------------------
create or replace function public.resolve_booking_token(p_token text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare v_hash text; v_phone text;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  if not public.check_rate_limit('token_use:' || v_hash, 60, 10) then
    return null;
  end if;
  select phone into v_phone from public.booking_access_tokens
   where token_hash = v_hash and revoked = false and expires_at > now();
  return v_phone;
end;
$fn$;
revoke all on function public.resolve_booking_token(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8) Token-gated booking access — replaces get_my_bookings(phone).
-- ----------------------------------------------------------------------------
drop function if exists public.get_my_bookings(text);

create or replace function public.get_my_bookings_with_token(p_token text)
returns setof public.appointments
language plpgsql security definer set search_path = public as $fn$
declare v_phone text;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return;
  end if;
  return query
    select * from public.appointments
    where customer_phone = v_phone
    order by date desc, start_min desc;
end;
$fn$;
grant execute on function public.get_my_bookings_with_token(text) to anon, authenticated;

create or replace function public.cancel_my_booking_with_token(p_token text, p_appointment_id text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_owner text;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  select customer_phone into v_owner from public.appointments where id = p_appointment_id;
  if v_owner is null or v_owner <> v_phone then
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
  v_phone text; v_appt record; v_svc record;
  v_new_end int; v_app_dow int; v_wh record; v_wh_start int; v_wh_end int;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;
  if v_appt is null or v_appt.customer_phone <> v_phone then
    return json_build_object('ok', false, 'error', 'این نوبت متعلق به شما نیست');
  end if;
  if p_new_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_new_date) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = v_appt.service_id;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت مرتبط با این نوبت یافت نشد');
  end if;
  v_new_end := p_new_start_min + v_svc.duration_minutes;

  -- Postgres dow: 0=Sunday..6=Saturday; this app's day_of_week: 0=Saturday..6=Friday.
  v_app_dow := (extract(dow from p_new_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = v_appt.staff_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null;
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

-- Explicit revocation — the revoked column existed from the start and was
-- always checked by resolve_booking_token, but nothing ever set it,
-- so a customer's "log out" only cleared client-side state, not the
-- server-side credential. Found during post-implementation loop testing.
create or replace function public.revoke_booking_token(p_token text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_hash text;
begin
  if p_token is null or length(p_token) < 32 then
    return json_build_object('ok', true); -- nothing to do; don't leak whether a short input "exists"
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  update public.booking_access_tokens set revoked = true where token_hash = v_hash;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.revoke_booking_token(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9) Server-computed booking creation — price, discount, end_min, and
--    initial status are computed here, never accepted from the client.
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
begin
  if p_customer_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    return json_build_object('ok', false, 'error', 'نام لازم است');
  end if;
  if p_customer_gender not in ('female', 'male') then
    return json_build_object('ok', false, 'error', 'جنسیت نامعتبر است');
  end if;
  if not public.check_rate_limit('create_booking:' || p_customer_phone, 10, 30) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — کمی بعد دوباره امتحان کنید');
  end if;
  if p_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_date) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = p_service_id and is_active;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت یافت نشد یا غیرفعال است');
  end if;
  if v_svc.gender <> p_customer_gender then
    return json_build_object('ok', false, 'error', 'این خدمت با جنسیت انتخابی مطابقت ندارد');
  end if;

  if p_staff_id is not null and not exists (select 1 from public.stylists where id = p_staff_id and active) then
    return json_build_object('ok', false, 'error', 'آرایشگر یافت نشد یا غیرفعال است');
  end if;

  v_app_dow := (extract(dow from p_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = p_staff_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null;
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

  -- Price: service's own discount, then the customer's current loyalty-tier
  -- discount stacked on top (same order as the client's v2.17 logic) —
  -- computed here from loyalty_settings/customers, never from client input.
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
      id, customer_name, customer_phone, customer_gender, service_id, staff_id,
      staff_name, date, start_min, end_min, buffer_minutes, status,
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price
    ) values (
      v_id, trim(p_customer_name), p_customer_phone, p_customer_gender, p_service_id, p_staff_id,
      coalesce((select name from public.stylists where id = p_staff_id), ''),
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
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = p_staff_id), '')
  );
end;
$fn$;
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text) to anon, authenticated;
