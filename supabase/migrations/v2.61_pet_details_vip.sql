-- v2.61: pet details on every booking, VIP customers, price requests reach the salon.
--
--  1. Pets: age (months, with the date it was given so it can grow), «first
--     grooming?», supplies the animal needs (towel, special shampoo …) plus a
--     free note. A customer must give the breed (a listed breed, «سایر», or typed).
--  2. VIP customers (pet and beauty salons): the manager marks them; they never
--     pay an online deposit and see a VIP label themselves.
--  3. A price request now texts the owner, every manager and the groomers who
--     serve that animal, with the pet's details.
-- Safe to run more than once.

-- ------------------------------------------------------- 1. pet details -----
alter table public.pets add column if not exists age_months int;
alter table public.pets add column if not exists age_set_on date;
alter table public.pets add column if not exists first_grooming boolean;
alter table public.pets add column if not exists supplies text[] not null default '{}';
alter table public.pets add column if not exists supplies_note text not null default '';
alter table public.pets drop constraint if exists pets_age_months_check;
alter table public.pets add constraint pets_age_months_check check (age_months is null or age_months between 0 and 420);

-- One line of pet details for staff messages (breed, age, first visit, supplies).
create or replace function public.pet_details_text(p_pet jsonb)
returns text
language plpgsql immutable set search_path = public as $fn$
declare v_parts text[] := '{}'; v_m int; v_s text;
begin
  if trim(coalesce(p_pet ->> 'breed', '')) <> '' then v_parts := v_parts || ('نژاد: ' || left(trim(p_pet ->> 'breed'), 40)); end if;
  if coalesce(p_pet ->> 'age_months', '') ~ '^[0-9]{1,3}$' then
    v_m := (p_pet ->> 'age_months')::int;
    v_parts := v_parts || ('سن: ' || case when v_m >= 12 then public.fa_digits((v_m / 12)::text) || ' سال' else '' end
                          || case when v_m >= 12 and v_m % 12 > 0 then ' و ' else '' end
                          || case when v_m % 12 > 0 or v_m = 0 then public.fa_digits((v_m % 12)::text) || ' ماه' else '' end);
  end if;
  if p_pet ->> 'first_grooming' = 'true' then v_parts := v_parts || 'اولین آرایش'::text; end if;
  if jsonb_typeof(p_pet -> 'supplies') = 'array' and jsonb_array_length(p_pet -> 'supplies') > 0 then
    select string_agg(left(x, 40), '، ') into v_s from (select jsonb_array_elements_text(p_pet -> 'supplies') x limit 10) t;
    v_parts := v_parts || ('نیاز: ' || v_s);
  end if;
  if trim(coalesce(p_pet ->> 'supplies_note', '')) <> '' then v_parts := v_parts || left(trim(p_pet ->> 'supplies_note'), 120); end if;
  return case when cardinality(v_parts) > 0 then E'\n' || array_to_string(v_parts, ' · ') else '' end;
end;
$fn$;
revoke all on function public.pet_details_text(jsonb) from public, anon, authenticated;

create or replace function public.upsert_pet(p_salon uuid, p_phone text, p_species text, p_pet jsonb)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_weight numeric; v_birth date; v_consent_text text; v_age int; v_first boolean; v_supplies text[];
begin
  -- v2.61: a customer must name the breed (a listed one, «سایر», or typed)
  if not public.is_staff() and trim(coalesce(p_pet ->> 'breed', '')) = '' then
    raise exception 'نژاد حیوان را انتخاب کنید' using errcode = 'P0001';
  end if;
  if coalesce(p_pet ->> 'age_months', '') ~ '^[0-9]{1,3}$' and (p_pet ->> 'age_months')::int between 0 and 420 then
    v_age := (p_pet ->> 'age_months')::int;
  end if;
  if p_pet ->> 'first_grooming' in ('true', 'false') then v_first := (p_pet ->> 'first_grooming')::boolean; end if;
  if jsonb_typeof(p_pet -> 'supplies') = 'array' then
    select array_agg(left(trim(x), 40)) into v_supplies
      from (select jsonb_array_elements_text(p_pet -> 'supplies') x limit 10) t where trim(x) <> '';
  end if;
  if coalesce(p_pet ->> 'weight_kg', '') ~ '^[0-9]{1,3}(\.[0-9]+)?$' then
    v_weight := (p_pet ->> 'weight_kg')::numeric;
    if v_weight <= 0 or v_weight > 150 then v_weight := null; end if;
  end if;
  v_birth := public.try_date(p_pet ->> 'birth_date');
  if v_birth is not null and (v_birth > current_date or v_birth < current_date - interval '35 years') then
    v_birth := null;
  end if;
  if coalesce(p_pet ->> 'consent', '') = 'true' then
    select pet_consent_text into v_consent_text from public.app_settings where salon_id = p_salon;
  end if;
  insert into public.pets as p (salon_id, owner_phone, name, species, breed, size, weight_kg, temperament, vaccine_valid_until, owner_notes,
                                birth_date, consent_at, consent_text, age_months, age_set_on, first_grooming, supplies, supplies_note)
  values (p_salon, p_phone, trim(p_pet ->> 'name'), p_species,
          left(trim(coalesce(p_pet ->> 'breed', '')), 40),
          p_pet ->> 'size', v_weight,
          coalesce(nullif(p_pet ->> 'temperament', ''), 'calm'),
          public.try_date(p_pet ->> 'vaccine_valid_until'),
          left(trim(coalesce(p_pet ->> 'notes', '')), 300),
          v_birth,
          case when v_consent_text is not null then now() end, v_consent_text,
          v_age, case when v_age is not null then current_date end, v_first, coalesce(v_supplies, '{}'),
          left(trim(coalesce(p_pet ->> 'supplies_note', '')), 200))
  on conflict (salon_id, owner_phone, species, lower(name)) do update
     set breed               = coalesce(nullif(excluded.breed, ''), p.breed),
         size                = excluded.size,
         weight_kg           = coalesce(excluded.weight_kg, p.weight_kg),
         temperament         = case when p_pet ? 'temperament' then excluded.temperament else p.temperament end,
         vaccine_valid_until = coalesce(excluded.vaccine_valid_until, p.vaccine_valid_until),
         owner_notes         = coalesce(nullif(excluded.owner_notes, ''), p.owner_notes),
         birth_date          = coalesce(excluded.birth_date, p.birth_date),
         consent_at          = coalesce(excluded.consent_at, p.consent_at),
         consent_text        = coalesce(excluded.consent_text, p.consent_text),
         age_months          = coalesce(excluded.age_months, p.age_months),
         age_set_on          = case when excluded.age_months is not null then excluded.age_set_on else p.age_set_on end,
         first_grooming      = coalesce(excluded.first_grooming, p.first_grooming),
         supplies            = case when p_pet ? 'supplies' then excluded.supplies else p.supplies end,
         supplies_note       = case when p_pet ? 'supplies_note' then excluded.supplies_note else p.supplies_note end
  returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.upsert_pet(uuid, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------- 3. price requests reach the salon ---
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
    select distinct x.ph from (
      select u.phone as ph from public.users u
       where u.salon_id = v_salon and u.role in ('owner', 'manager') and u.active is not false
      union select sa.owner_phone from public.salons sa where sa.id = v_salon
      union select st.phone from public.stylists st                       -- v2.61: the groomers too
       where st.salon_id = v_salon and st.active and st.gender in (p_species, 'pet')
    ) x where x.ph ~ '^09[0-9]{9}$'
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (v_salon, v_phone,
            'درخواست قیمت جدید: ' || v_pet_name || ' (' || case p_species when 'cat' then 'گربه' else 'سگ' end
              || '، ' || public.pet_size_label(v_size) || case when coalesce(p_pet ->> 'breed', '') <> '' then '، ' || left(p_pet ->> 'breed', 40) else '' end
              || ') — ' || v_label || public.pet_details_text(p_pet) || E'\nصاحب: ' || trim(p_customer_name) || ' ' || p_customer_phone || E'\nپاسخ از پنل ← استعلام قیمت',
            'quote_request', 'queued', now());
  end loop;
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;

revoke all on function public.request_quote(text, text, text, jsonb, text[], text, text) from public;
grant execute on function public.request_quote(text, text, text, jsonb, text[], text, text) to anon, authenticated;

-- ------------------------------------------------------- 2. VIP customers ---
alter table public.customers add column if not exists vip boolean not null default false;

create or replace function public.set_customer_vip(p_phone text, p_vip boolean)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'فقط مدیر سالن'); end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{9}$' then return json_build_object('ok', false, 'error', 'شماره نامعتبر است'); end if;
  insert into public.customers (salon_id, phone, vip) values (public.current_salon_id(), p_phone, coalesce(p_vip, false))
  on conflict (salon_id, phone) do update set vip = excluded.vip;
  return json_build_object('ok', true, 'vip', coalesce(p_vip, false));
end;
$fn$;
revoke all on function public.set_customer_vip(text, boolean) from public, anon;
grant execute on function public.set_customer_vip(text, boolean) to authenticated;

-- staff: who is VIP (badges on bookings)
create or replace function public.vip_phones()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(c.phone), '[]'::json) from public.customers c
   where public.is_staff() and c.salon_id = public.current_salon_id() and c.vip;
$fn$;
revoke all on function public.vip_phones() from public, anon;
grant execute on function public.vip_phones() to authenticated;

-- the customer's own view (booking page, «داشبورد من»): yes/no only
create or replace function public.is_vip_customer(p_phone text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(p_phone ~ '^09[0-9]{9}$' and exists (
    select 1 from public.customers c where c.salon_id = public.current_salon_id() and c.phone = p_phone and c.vip), false);
$fn$;
grant execute on function public.is_vip_customer(text) to anon, authenticated;

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
  if exists (select 1 from public.customers c where c.salon_id = new.salon_id and c.phone = new.customer_phone and c.vip) then
    return new; -- v2.61: VIP customers never pay a deposit
  end if;
  select deposit_percent, deposit_min_price, deposit_mode into v_set from public.app_settings where salon_id = new.salon_id;
  if coalesce(v_set.deposit_percent, 0) = 0 or new.final_price < coalesce(v_set.deposit_min_price, 0) then
    return new;
  end if;
  -- v2.50: 'risky' — only customers who missed a visit in the last year
  if coalesce(v_set.deposit_mode, 'all') = 'risky' and not exists (
       select 1 from public.appointments a
        where a.salon_id = new.salon_id and a.customer_phone = new.customer_phone and a.status = 'no_show'
          and a.date >= public.salon_today() - 365) then
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
