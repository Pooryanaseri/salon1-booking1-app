-- ============================================================================
-- Migration v2.44 — pet grooming salons (run after v2.43)
-- ============================================================================
--  A salon is now one of two kinds, set by the platform admin:
--    beauty — as before: female / male sections.
--    pet    — a dog & cat grooming salon: dog / cat sections.
--  The existing "section" column (services.gender, appointments.
--  customer_gender, stylists.gender) carries the new values, so the booking,
--  scheduling, waitlist and reporting machinery works unchanged. Groomers
--  can be dog-only, cat-only, or "pet" (both).
--
--  1. salons.business_type; section helpers.
--  2. pets — one profile per animal (owner phone, species, breed, size,
--     weight, temperament, vaccination, notes for and from the groomer).
--  3. services.size_pricing — price and duration per size (small … giant);
--     anything not set falls back to the service's base price/duration.
--  4. appointments.pet_id / pet_name / pet_size — the animal and the size
--     the booking was priced for.
--  5. create_public_booking takes the pet (p_pet jsonb): validates it,
--     upserts the profile, prices and times the booking for its size, and
--     enforces the salon's "valid vaccination required" setting.
--     Reschedule and salon-sent booking links keep the size-based duration.
--  6. SMS: {{pet}} variable, pet wording for the default texts, and the
--     groomer's new-booking SMS names the animal and flags an aggressive one.
--  7. Admin: create a pet salon (with starter dog/cat services), type in
--     the salon list, change type while the salon has no bookings.
-- ============================================================================

-- ------------------------------------------------------ 1. salon type ------
alter table public.salons add column if not exists business_type text not null default 'beauty';
alter table public.salons drop constraint if exists salons_business_type_check;
alter table public.salons add constraint salons_business_type_check check (business_type in ('beauty', 'pet'));
grant select (business_type) on public.salons to anon, authenticated;

-- Sections are stored in the existing gender columns.
alter table public.services drop constraint if exists services_gender_check;
alter table public.services add constraint services_gender_check check (gender in ('female', 'male', 'dog', 'cat'));
alter table public.appointments drop constraint if exists appointments_customer_gender_check;
alter table public.appointments add constraint appointments_customer_gender_check check (customer_gender in ('female', 'male', 'dog', 'cat'));
alter table public.customers drop constraint if exists customers_gender_check;
alter table public.customers add constraint customers_gender_check check (gender in ('female', 'male', 'dog', 'cat'));
alter table public.stylists drop constraint if exists stylists_gender_check;
alter table public.stylists add constraint stylists_gender_check check (gender in ('female', 'male', 'dog', 'cat', 'pet'));

create or replace function public.salon_sections(p_salon uuid)
returns text[]
language sql stable security definer set search_path = public as $fn$
  select case when business_type = 'pet' then array['dog', 'cat'] else array['female', 'male'] end
    from public.salons where id = p_salon;
$fn$;
revoke all on function public.salon_sections(uuid) from public, anon, authenticated;

alter table public.app_settings add column if not exists pet_require_vaccination boolean not null default false;

-- --------------------------------------------------------- 2. pets ---------
create table if not exists public.pets (
  id                  uuid primary key default gen_random_uuid(),
  salon_id            uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  owner_phone         text not null check (owner_phone ~ '^09[0-9]{9}$'),
  name                text not null check (length(trim(name)) between 1 and 40),
  species             text not null check (species in ('dog', 'cat')),
  breed               text not null default '' check (length(breed) <= 40),
  size                text not null default 'medium' check (size in ('small', 'medium', 'large', 'giant')),
  weight_kg           numeric(5, 1) check (weight_kg is null or (weight_kg > 0 and weight_kg <= 150)),
  temperament         text not null default 'calm' check (temperament in ('calm', 'nervous', 'aggressive')),
  vaccine_valid_until date,
  owner_notes         text not null default '' check (length(owner_notes) <= 300),
  grooming_notes      text not null default '' check (length(grooming_notes) <= 1000),
  last_visit_date     date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists pets_owner_name_uidx on public.pets (salon_id, owner_phone, species, lower(name));
create index if not exists pets_salon_owner_idx on public.pets (salon_id, owner_phone);

alter table public.pets enable row level security;
revoke all on public.pets from anon;
grant select, insert, update, delete on public.pets to authenticated;

drop policy if exists p_pets_mgr on public.pets;
create policy p_pets_mgr on public.pets for all
  using ((select public.is_manager()) and salon_id = (select public.current_salon_id()))
  with check ((select public.is_manager()) and salon_id = (select public.current_salon_id()));
-- A groomer sees, and can add notes to, the animals of customers they serve.
drop policy if exists p_pets_staff_read on public.pets;
create policy p_pets_staff_read on public.pets for select
  using (salon_id = (select public.current_salon_id())
         and exists (select 1 from public.appointments a
                      where a.salon_id = pets.salon_id and a.customer_phone = pets.owner_phone
                        and a.staff_id = (select public.my_stylist_id())));
drop policy if exists p_pets_staff_update on public.pets;
create policy p_pets_staff_update on public.pets for update
  using (salon_id = (select public.current_salon_id())
         and exists (select 1 from public.appointments a
                      where a.salon_id = pets.salon_id and a.customer_phone = pets.owner_phone
                        and a.staff_id = (select public.my_stylist_id())))
  with check (salon_id = (select public.current_salon_id()));

create or replace function public.touch_pet()
returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  new.name := trim(new.name);
  new.breed := trim(new.breed);
  return new;
end;
$fn$;
drop trigger if exists trg_touch_pet on public.pets;
create trigger trg_touch_pet before insert or update on public.pets
  for each row execute function public.touch_pet();

-- ------------------------------------------------- 3. size pricing ---------
alter table public.services add column if not exists size_pricing jsonb not null default '{}'::jsonb;
alter table public.services drop constraint if exists services_size_pricing_check;
alter table public.services add constraint services_size_pricing_check check (jsonb_typeof(size_pricing) = 'object');

-- The service as booked for an animal of this size: price and duration
-- from size_pricing when set there, otherwise the service's own.
create or replace function public.service_at_size(p_svc public.services, p_size text)
returns public.services
language plpgsql immutable as $fn$
declare v_tier jsonb;
begin
  if p_size is null or p_svc.size_pricing is null then
    return p_svc;
  end if;
  v_tier := p_svc.size_pricing -> p_size;
  if jsonb_typeof(v_tier) = 'object' then
    if jsonb_typeof(v_tier -> 'price') = 'number' and (v_tier ->> 'price')::numeric >= 0 then
      p_svc.price := round((v_tier ->> 'price')::numeric)::bigint;
    end if;
    if jsonb_typeof(v_tier -> 'duration') = 'number' and (v_tier ->> 'duration')::numeric between 5 and 600 then
      p_svc.duration_minutes := round((v_tier ->> 'duration')::numeric)::int;
    end if;
  end if;
  return p_svc;
end;
$fn$;

-- ------------------------------------------- 4. pet on the booking ---------
alter table public.appointments add column if not exists pet_id uuid references public.pets (id) on delete set null;
alter table public.appointments add column if not exists pet_name text;
alter table public.appointments add column if not exists pet_size text;
alter table public.appointments drop constraint if exists appointments_pet_size_check;
alter table public.appointments add constraint appointments_pet_size_check check (pet_size is null or pet_size in ('small', 'medium', 'large', 'giant'));
create index if not exists appointments_pet_idx on public.appointments (pet_id) where pet_id is not null;

-- The pet must belong to the booking's salon; name/size are snapshotted so
-- the booking keeps what it was priced for if the profile changes later.
create or replace function public.appointment_pet_snapshot()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_pet record;
begin
  if new.pet_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.pet_id is not distinct from old.pet_id then
    return new;
  end if;
  select name, size, salon_id into v_pet from public.pets where id = new.pet_id;
  if v_pet.salon_id is distinct from new.salon_id then
    raise exception 'pet does not belong to this salon' using errcode = '42501';
  end if;
  new.pet_name := coalesce(new.pet_name, v_pet.name);
  new.pet_size := coalesce(new.pet_size, v_pet.size);
  return new;
end;
$fn$;
drop trigger if exists trg_appointment_pet_snapshot on public.appointments;
create trigger trg_appointment_pet_snapshot before insert or update of pet_id on public.appointments
  for each row execute function public.appointment_pet_snapshot();

create or replace function public.pet_last_visit()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.pet_id is not null and new.status = 'completed' and old.status is distinct from 'completed' then
    update public.pets set last_visit_date = greatest(coalesce(last_visit_date, new.date), new.date) where id = new.pet_id;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_pet_last_visit on public.appointments;
create trigger trg_pet_last_visit after update of status on public.appointments
  for each row execute function public.pet_last_visit();

create or replace function public.try_date(p text)
returns date
language plpgsql immutable as $fn$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return p::date;
exception when others then
  return null;
end;
$fn$;

-- Creates or refreshes the profile a public booking names. Fields the form
-- left empty keep what is on file; the groomer's notes are never touched.
create or replace function public.upsert_pet(p_salon uuid, p_phone text, p_species text, p_pet jsonb)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_weight numeric;
begin
  if coalesce(p_pet ->> 'weight_kg', '') ~ '^[0-9]{1,3}(\.[0-9]+)?$' then
    v_weight := (p_pet ->> 'weight_kg')::numeric;
    if v_weight <= 0 or v_weight > 150 then v_weight := null; end if;
  end if;
  insert into public.pets as p (salon_id, owner_phone, name, species, breed, size, weight_kg, temperament, vaccine_valid_until, owner_notes)
  values (p_salon, p_phone, trim(p_pet ->> 'name'), p_species,
          left(trim(coalesce(p_pet ->> 'breed', '')), 40),
          p_pet ->> 'size', v_weight,
          coalesce(nullif(p_pet ->> 'temperament', ''), 'calm'),
          public.try_date(p_pet ->> 'vaccine_valid_until'),
          left(trim(coalesce(p_pet ->> 'notes', '')), 300))
  on conflict (salon_id, owner_phone, species, lower(name)) do update
     set breed               = coalesce(nullif(excluded.breed, ''), p.breed),
         size                = excluded.size,
         weight_kg           = coalesce(excluded.weight_kg, p.weight_kg),
         temperament         = case when p_pet ? 'temperament' then excluded.temperament else p.temperament end,
         vaccine_valid_until = coalesce(excluded.vaccine_valid_until, p.vaccine_valid_until),
         owner_notes         = coalesce(nullif(excluded.owner_notes, ''), p.owner_notes)
  returning id into v_id;
  return v_id;
end;
$fn$;
revoke all on function public.upsert_pet(uuid, text, text, jsonb) from public, anon, authenticated;

-- -------------------------------------------- 5. booking functions ---------
drop function if exists public.create_public_booking(text, text, date, int, text, text, text, text);

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
  if v_svc.gender <> p_customer_gender then
    return json_build_object('ok', false, 'error', case when v_type = 'pet' then 'این خدمت برای این حیوان نیست' else 'این خدمت با جنسیت انتخابی مطابقت ندارد' end);
  end if;
  v_svc := public.service_at_size(v_svc, v_size); -- price and duration for the animal's size
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
      pet_id, pet_name, pet_size
    ) values (
      v_id, v_salon_id, trim(p_customer_name), p_customer_phone, p_customer_gender, p_service_id, p_staff_id,
      coalesce((select name from public.stylists where id = p_staff_id and salon_id = v_salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'pending',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final,
      v_pet_id, v_pet_name, v_size
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
  v_svc := public.service_at_size(v_svc, v_appt.pet_size); -- v2.44: pet bookings keep their size's duration
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
  v_pet_id uuid; v_pet_name text; v_pet_size text;
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
    select p.id, p.name, p.size into v_pet_id, v_pet_name, v_pet_size
      from public.pets p
     where p.salon_id = v_rt.salon_id and p.owner_phone = v_rt.customer_phone and p.species = v_svc.gender
     order by p.last_visit_date desc nulls last, p.created_at desc
     limit 1;
    v_svc := public.service_at_size(v_svc, v_pet_size);
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
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price,
      pet_id, pet_name, pet_size
    ) values (
      v_id, v_rt.salon_id,
      coalesce(nullif(v_rt.customer_name, ''), (select name from public.customers where salon_id = v_rt.salon_id and phone = v_rt.customer_phone), ''),
      v_rt.customer_phone, v_svc.gender, v_rt.service_id, v_staff_id,
      coalesce((select name from public.stylists where id = v_staff_id and salon_id = v_rt.salon_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'confirmed',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final,
      v_pet_id, v_pet_name, v_pet_size
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

-- ---------------------------------------------------------- 6. SMS ---------
create or replace function public.pet_size_label(p_size text)
returns text
language sql immutable as $fn$
  select case p_size when 'small' then 'کوچک' when 'medium' then 'متوسط' when 'large' then 'بزرگ' when 'giant' then 'خیلی بزرگ' else '' end;
$fn$;

create or replace function public.booking_sms_text(p_appt public.appointments, p_kind text)
returns text
language plpgsql stable security definer set search_path = public as $fn$
declare v_tpl text; v_service text; v_salon text; v_pet boolean := coalesce(p_appt.pet_name, '') <> '';
begin
  select body into v_tpl from public.sms_templates
   where salon_id = p_appt.salon_id and kind = p_kind and body <> ''
   order by is_default desc, created_at limit 1;
  v_tpl := coalesce(v_tpl, case
    when p_kind = 'confirmation' and v_pet then E'{{name}} عزیز، نوبت {{pet}} در {{salon}} ثبت شد.\nخدمت: {{service}}\nتاریخ: {{date}} ساعت {{time}}\nکد پیگیری: {{code}}'
    when p_kind = 'reminder' and v_pet     then E'{{name}} عزیز، یادآوری نوبت {{pet}} در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما و {{pet}} هستیم.'
    when p_kind = 'confirmation'           then E'{{name}} عزیز، نوبت شما در {{salon}} ثبت شد.\nخدمت: {{service}}\nتاریخ: {{date}} ساعت {{time}}\nکد پیگیری: {{code}}'
    when p_kind = 'reminder'               then E'{{name}} عزیز، یادآوری نوبت شما در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما هستیم.'
  end);
  select name into v_service from public.services where id = p_appt.service_id and salon_id = p_appt.salon_id;
  select name into v_salon from public.salons where id = p_appt.salon_id;
  return public.render_sms(v_tpl, jsonb_build_object(
    'name',    coalesce(nullif(trim(p_appt.customer_name), ''), 'مشتری'),
    'pet',     coalesce(nullif(trim(p_appt.pet_name), ''), case when p_appt.customer_gender = 'cat' then 'گربهٔ شما' when p_appt.customer_gender = 'dog' then 'سگ شما' else '' end),
    'service', coalesce(v_service, 'خدمت'),
    'date',    public.jalali_label(p_appt.date),
    'time',    public.fa_clock(p_appt.start_min),
    'stylist', coalesce(nullif(p_appt.staff_name, ''), 'بدون آرایشگر مشخص'),
    'code',    coalesce(p_appt.tracking_code, ''),
    'salon',   coalesce(v_salon, 'سالن')
  ));
end;
$fn$;
revoke all on function public.booking_sms_text(public.appointments, text) from public, anon, authenticated;

create or replace function public.send_new_booking_messages(p_appt public.appointments)
returns void
language plpgsql security definer set search_path = public as $fn$
declare v_staff_phone text; v_digest boolean; v_service text; v_pet record; v_who text;
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
      v_who := coalesce(nullif(trim(p_appt.customer_name), ''), 'مشتری');
      if p_appt.pet_id is not null then
        select species, breed, temperament into v_pet from public.pets where id = p_appt.pet_id;
        v_who := coalesce(p_appt.pet_name, '') || ' ('
          || case v_pet.species when 'cat' then 'گربه' else 'سگ' end
          || case when coalesce(v_pet.breed, '') <> '' then '، ' || v_pet.breed else '' end
          || '، ' || public.pet_size_label(p_appt.pet_size) || ') — صاحب: ' || v_who
          || case v_pet.temperament when 'aggressive' then E'\n⚠ پرخاشگر — با احتیاط' when 'nervous' then E'\nمضطرب — آرام برخورد شود' else '' end;
      end if;
      insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
      values (p_appt.salon_id, v_staff_phone,
              'نوبت جدید: ' || v_who || ' — ' || coalesce(v_service, 'خدمت')
                || E'\n' || public.jalali_label(p_appt.date) || ' ساعت ' || public.fa_clock(p_appt.start_min),
              'staff_new_booking', p_appt.id, 'queued', now());
    end if;
  end if;
end;
$fn$;
revoke all on function public.send_new_booking_messages(public.appointments) from public, anon, authenticated;

-- --------------------------------------------------------- 7. admin --------
-- Starter dog & cat menu for a new pet salon, priced per size. The manager
-- edits prices and durations in the services tab.
create or replace function public.seed_pet_services(p_salon uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if exists (select 1 from public.services where salon_id = p_salon) then
    return;
  end if;
  insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, size_pricing)
  select 'svc-' || encode(gen_random_bytes(6), 'hex'), p_salon, s.name, s.species, s.category, s.duration, s.price, s.tiers::jsonb
    from (values
      ('حمام و سشوار', 'dog', 'bath', 60, 450000,
       '{"small":{"price":350000,"duration":45},"medium":{"price":450000,"duration":60},"large":{"price":600000,"duration":90},"giant":{"price":800000,"duration":120}}'),
      ('اصلاح کامل (حمام + کوتاهی + ناخن)', 'dog', 'grooming', 120, 900000,
       '{"small":{"price":700000,"duration":90},"medium":{"price":900000,"duration":120},"large":{"price":1200000,"duration":150},"giant":{"price":1500000,"duration":180}}'),
      ('کوتاهی ناخن', 'dog', 'nails_pet', 15, 150000, '{}'),
      ('تمیز کردن گوش و دندان', 'dog', 'hygiene', 20, 200000, '{}'),
      ('حمام گربه', 'cat', 'bath', 60, 500000,
       '{"small":{"price":450000,"duration":45},"medium":{"price":500000,"duration":60},"large":{"price":600000,"duration":75}}'),
      ('اصلاح کامل گربه', 'cat', 'grooming', 90, 900000,
       '{"small":{"price":800000,"duration":75},"medium":{"price":900000,"duration":90},"large":{"price":1100000,"duration":105}}'),
      ('کوتاهی ناخن گربه', 'cat', 'nails_pet', 15, 150000, '{}')
    ) as s(name, species, category, duration, price, tiers);
end;
$fn$;
revoke all on function public.seed_pet_services(uuid) from public, anon, authenticated;

drop function if exists public.admin_create_salon(text, text, text);
create or replace function public.admin_create_salon(p_slug text, p_name text, p_owner_phone text, p_business_type text default 'beauty')
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_slug text := lower(trim(coalesce(p_slug, ''))); v_id uuid; v_type text := coalesce(nullif(p_business_type, ''), 'beauty');
begin
  if not public.is_platform_admin() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if v_type not in ('beauty', 'pet') then
    return json_build_object('ok', false, 'error', 'نوع سالن نامعتبر است');
  end if;
  if v_slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    return json_build_object('ok', false, 'error', 'آدرس فقط حروف کوچک انگلیسی، عدد و خط تیره');
  end if;
  if v_slug in ('admin', 'feedback', 'book', 'confirm', 'payment', 'reconcile', 'api', 'assets', 'default-new') then
    return json_build_object('ok', false, 'error', 'این آدرس رزرو شده است');
  end if;
  if coalesce(trim(p_name), '') = '' then
    return json_build_object('ok', false, 'error', 'نام سالن لازم است');
  end if;
  if coalesce(p_owner_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شمارهٔ موبایل مدیر نامعتبر است');
  end if;
  if exists (select 1 from public.salons where slug = v_slug) then
    return json_build_object('ok', false, 'error', 'این آدرس قبلاً استفاده شده');
  end if;

  insert into public.salons (slug, name, owner_phone, business_type) values (v_slug, trim(p_name), p_owner_phone, v_type)
  returning id into v_id;
  if v_type = 'pet' then
    perform public.seed_pet_services(v_id);
  end if;
  return json_build_object('ok', true, 'id', v_id, 'slug', v_slug);
end;
$fn$;
revoke all on function public.admin_create_salon(text, text, text, text) from public, anon;
grant execute on function public.admin_create_salon(text, text, text, text) to authenticated;

drop function if exists public.admin_update_salon(uuid, text, text, boolean);
create or replace function public.admin_update_salon(p_id uuid, p_name text default null, p_owner_phone text default null,
                                                     p_active boolean default null, p_business_type text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_old text;
begin
  if not public.is_platform_admin() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_owner_phone is not null and p_owner_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شمارهٔ موبایل مدیر نامعتبر است');
  end if;
  select business_type into v_old from public.salons where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'سالن پیدا نشد');
  end if;
  if p_business_type is not null and p_business_type <> v_old then
    if p_business_type not in ('beauty', 'pet') then
      return json_build_object('ok', false, 'error', 'نوع سالن نامعتبر است');
    end if;
    -- Services, staff and bookings are all keyed to the sections of the
    -- type; switching is only safe before the salon is in use.
    if exists (select 1 from public.appointments where salon_id = p_id) then
      return json_build_object('ok', false, 'error', 'این سالن نوبت ثبت‌شده دارد؛ نوع آن قابل تغییر نیست');
    end if;
    delete from public.services where salon_id = p_id and gender <> all (case when p_business_type = 'pet' then array['dog', 'cat'] else array['female', 'male'] end);
  end if;
  update public.salons
     set name = coalesce(nullif(trim(p_name), ''), name),
         owner_phone = coalesce(p_owner_phone, owner_phone),
         active = coalesce(p_active, active),
         business_type = coalesce(p_business_type, business_type)
   where id = p_id;
  if p_business_type = 'pet' and v_old <> 'pet' then
    perform public.seed_pet_services(p_id);
  end if;
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.admin_update_salon(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.admin_update_salon(uuid, text, text, boolean, text) to authenticated;

drop function if exists public.admin_list_salons();
create or replace function public.admin_list_salons()
returns table (
  id uuid, slug text, name text, active boolean, owner_phone text, created_at timestamptz, business_type text,
  owner_registered boolean, stylists int, services int,
  bookings_30d int, completed_30d int, last_booking_date date,
  sms_configured boolean, sms_sent_30d int, sms_failed_30d int
)
language sql stable security definer set search_path = public as $fn$
  select s.id, s.slug, s.name, s.active, s.owner_phone, s.created_at, s.business_type,
         exists (select 1 from public.users u where u.salon_id = s.id and u.role in ('owner', 'manager')),
         (select count(*)::int from public.stylists t where t.salon_id = s.id and t.active),
         (select count(*)::int from public.services v where v.salon_id = s.id and v.is_active),
         (select count(*)::int from public.appointments a where a.salon_id = s.id and a.date >= current_date - 30),
         (select count(*)::int from public.appointments a where a.salon_id = s.id and a.date >= current_date - 30 and a.status = 'completed'),
         (select max(a.date) from public.appointments a where a.salon_id = s.id),
         exists (select 1 from public.salon_sms_settings x where x.salon_id = s.id),
         (select count(*)::int from public.sms_messages m where m.salon_id = s.id and m.created_at >= now() - interval '30 days' and m.status in ('sent', 'delivered')),
         (select count(*)::int from public.sms_messages m where m.salon_id = s.id and m.created_at >= now() - interval '30 days' and m.status = 'failed')
    from public.salons s
   where public.is_platform_admin()
   order by s.created_at desc;
$fn$;
revoke all on function public.admin_list_salons() from public, anon;
grant execute on function public.admin_list_salons() to authenticated;
