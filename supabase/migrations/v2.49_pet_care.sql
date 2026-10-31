-- ============================================================================
-- Migration v2.49 — pet care extras (run after v2.48)
-- ============================================================================
--   1. Live grooming status (arrived → bathing → grooming → ready); "ready"
--      texts the owner.
--   2. Visit report: before/after photos + a health checklist (fleas, ticks,
--      skin, ears, …) + recommended shop products, sent to the owner as a
--      link (/visit?token=…) and kept in the pet's history.
--   3. Daily reminders: vaccine about to expire, "time for the next groom"
--      (per-pet cycle), pet birthday. Vaccine-card photo on the pet profile.
--   4. Digital consent for risky pets (aggressive / senior), or for all.
--   5. Pick-up & drop-off service with a flat fee.
--   6. Prepaid packages (e.g. 4 baths) sold at the desk, used visit by visit.
--   7. (client) several pets in one visit, back to back.
--   8. (via 2) product recommendations link to the shop.
--   9. (via 3) birthday greeting with the salon's own offer text.
--  10. Capacity: at most N large/giant dogs at the same time.
-- ============================================================================

-- ------------------------------------------------------------------ columns --
alter table public.appointments add column if not exists groom_stage text;
alter table public.appointments drop constraint if exists appointments_groom_stage_check;
alter table public.appointments add constraint appointments_groom_stage_check
  check (groom_stage is null or groom_stage in ('arrived', 'bathing', 'grooming', 'ready'));
alter table public.appointments add column if not exists groom_stage_at timestamptz;
alter table public.appointments add column if not exists transport_address text;
alter table public.appointments add column if not exists transport_fee bigint;
alter table public.appointments add column if not exists package_purchase_id uuid;

alter table public.pets add column if not exists birth_date date;
alter table public.pets add column if not exists groom_every_days int;
alter table public.pets drop constraint if exists pets_groom_every_days_check;
alter table public.pets add constraint pets_groom_every_days_check check (groom_every_days is null or groom_every_days between 7 and 365);
alter table public.pets add column if not exists vaccine_card_path text;
alter table public.pets add column if not exists vaccine_reminded_for date;
alter table public.pets add column if not exists cycle_reminded_for date;
alter table public.pets add column if not exists birthday_reminded_year int;
alter table public.pets add column if not exists consent_at timestamptz;
alter table public.pets add column if not exists consent_text text;

alter table public.app_settings add column if not exists pet_ready_sms boolean not null default true;
alter table public.app_settings add column if not exists pet_reminders_enabled boolean not null default true;
alter table public.app_settings add column if not exists pet_cycle_days int not null default 42;
alter table public.app_settings drop constraint if exists app_settings_pet_cycle_days_check;
alter table public.app_settings add constraint app_settings_pet_cycle_days_check check (pet_cycle_days between 7 and 365);
alter table public.app_settings add column if not exists pet_birthday_message text not null default '';
alter table public.app_settings add column if not exists pet_consent_mode text not null default 'risky';
alter table public.app_settings drop constraint if exists app_settings_pet_consent_mode_check;
alter table public.app_settings add constraint app_settings_pet_consent_mode_check check (pet_consent_mode in ('off', 'risky', 'always'));
alter table public.app_settings add column if not exists pet_consent_text text not null default
  'صحت اطلاعات حیوان را تایید می‌کنم. در صورت گره‌خوردگی شدید، تراشیدن موها و در صورت لزوم استفاده از پوزه‌بند را می‌پذیرم. مسئولیت بیماری‌های پنهان یا حساسیت‌هایی که اعلام نشده‌اند با سالن نیست.';
alter table public.app_settings add column if not exists pet_transport_enabled boolean not null default false;
alter table public.app_settings add column if not exists pet_transport_fee bigint not null default 0;
alter table public.app_settings add column if not exists pet_transport_area text not null default '';
alter table public.app_settings add column if not exists pet_large_capacity int;
alter table public.app_settings drop constraint if exists app_settings_pet_large_capacity_check;
alter table public.app_settings add constraint app_settings_pet_large_capacity_check check (pet_large_capacity is null or pet_large_capacity between 1 and 20);

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote', 'order', 'order_staff',
  'pet_update', 'pet_report', 'pet_reminder', 'pet_package'));

-- the booking page needs sizes to respect the large-dog capacity
create or replace view public.appointments_public_slots as
  select staff_id, date, start_min, end_min, buffer_minutes, status, pet_size
    from public.appointments
   where salon_id = public.current_salon_id()
     and date >= public.salon_today() - 1;
grant select on public.appointments_public_slots to anon, authenticated;

-- What the booking page needs to know (public, no secrets).
create or replace function public.pet_care_settings()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'consent_mode', coalesce(s.pet_consent_mode, 'risky'),
    'consent_text', coalesce(s.pet_consent_text, ''),
    'transport_enabled', coalesce(s.pet_transport_enabled, false),
    'transport_fee', coalesce(s.pet_transport_fee, 0),
    'transport_area', coalesce(s.pet_transport_area, ''),
    'large_capacity', s.pet_large_capacity)
  from (select public.current_salon_id() as salon_id) c
  left join public.app_settings s on s.salon_id = c.salon_id
  where c.salon_id is not null;
$fn$;
grant execute on function public.pet_care_settings() to anon, authenticated;

-- ----------------------------------------------- 4/9. pets: birthday, consent --
create or replace function public.upsert_pet(p_salon uuid, p_phone text, p_species text, p_pet jsonb)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_weight numeric; v_birth date; v_consent_text text;
begin
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
                                birth_date, consent_at, consent_text)
  values (p_salon, p_phone, trim(p_pet ->> 'name'), p_species,
          left(trim(coalesce(p_pet ->> 'breed', '')), 40),
          p_pet ->> 'size', v_weight,
          coalesce(nullif(p_pet ->> 'temperament', ''), 'calm'),
          public.try_date(p_pet ->> 'vaccine_valid_until'),
          left(trim(coalesce(p_pet ->> 'notes', '')), 300),
          v_birth,
          case when v_consent_text is not null then now() end, v_consent_text)
  on conflict (salon_id, owner_phone, species, lower(name)) do update
     set breed               = coalesce(nullif(excluded.breed, ''), p.breed),
         size                = excluded.size,
         weight_kg           = coalesce(excluded.weight_kg, p.weight_kg),
         temperament         = case when p_pet ? 'temperament' then excluded.temperament else p.temperament end,
         vaccine_valid_until = coalesce(excluded.vaccine_valid_until, p.vaccine_valid_until),
         owner_notes         = coalesce(nullif(excluded.owner_notes, ''), p.owner_notes),
         birth_date          = coalesce(excluded.birth_date, p.birth_date),
         consent_at          = coalesce(excluded.consent_at, p.consent_at),
         consent_text        = coalesce(excluded.consent_text, p.consent_text)
  returning id into v_id;
  return v_id;
end;
$fn$;
revoke all on function public.upsert_pet(uuid, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------ 1. grooming status --
create or replace function public.set_groom_stage(p_appt text, p_stage text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_send boolean; v_salon_name text;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  if p_stage is not null and p_stage not in ('arrived', 'bathing', 'grooming', 'ready') then
    return json_build_object('ok', false, 'error', 'مرحلهٔ نامعتبر');
  end if;
  select * into a from public.appointments where id = p_appt and salon_id = public.current_salon_id() for update;
  if a.id is null or not (public.is_manager() or a.staff_id = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  if a.status in ('cancelled', 'no_show') then
    return json_build_object('ok', false, 'error', 'این نوبت لغو شده است');
  end if;
  update public.appointments set groom_stage = p_stage, groom_stage_at = now() where id = a.id;
  select coalesce(s.pet_ready_sms, true), sa.name into v_send, v_salon_name
    from public.salons sa left join public.app_settings s on s.salon_id = sa.id where sa.id = a.salon_id;
  if p_stage = 'ready' and a.groom_stage is distinct from 'ready' and v_send and a.customer_phone ~ '^09[0-9]{9}$' then
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (a.salon_id, a.customer_phone,
            coalesce(nullif(a.pet_name, ''), 'حیوان شما') || ' آمادهٔ تحویل است 🐾' || E'\n' || v_salon_name
              || case when a.transport_address is not null then E'\nبه‌زودی به آدرس شما آورده می‌شود.' else '' end,
            'pet_update', 'queued', now());
  end if;
  return json_build_object('ok', true, 'stage', p_stage);
end;
$fn$;
grant execute on function public.set_groom_stage(text, text) to authenticated;

-- ------------------------------------------- 2/8. visit report + photos --
create table if not exists public.pet_visit_reports (
  appointment_id text primary key references public.appointments (id) on delete cascade,
  salon_id       uuid not null references public.salons (id) on delete cascade,
  pet_id         uuid references public.pets (id) on delete set null,
  checks         jsonb not null default '{}'::jsonb,
  note           text not null default '' check (length(note) <= 600),
  photos         text[] not null default '{}' check (cardinality(photos) <= 8),
  product_ids    uuid[] not null default '{}' check (cardinality(product_ids) <= 4),
  token_hash     text unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  sent_at        timestamptz
);
create index if not exists pet_visit_reports_pet_idx on public.pet_visit_reports (pet_id, created_at desc);
alter table public.pet_visit_reports enable row level security;
drop policy if exists p_visit_reports_staff on public.pet_visit_reports;
create policy p_visit_reports_staff on public.pet_visit_reports for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.pet_visit_reports to authenticated;

-- checks: {"fleas": bool, "ticks": bool, "skin": bool, "ears": bool, "eyes": bool,
--          "teeth": bool, "matting": bool, "nails": bool, "behavior": "calm|nervous|aggressive"}
create or replace function public.save_visit_report(
  p_appt text, p_checks jsonb, p_note text default '', p_photos text[] default '{}',
  p_product_ids uuid[] default '{}', p_send boolean default false
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_checks jsonb := '{}'::jsonb; k text; v_token text; v_link text; v_salon_name text;
        v_photos text[]; v_products uuid[]; v_already timestamptz;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select * into a from public.appointments where id = p_appt and salon_id = public.current_salon_id();
  if a.id is null or not (public.is_manager() or a.staff_id = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  foreach k in array array['fleas', 'ticks', 'skin', 'ears', 'eyes', 'teeth', 'matting', 'nails'] loop
    if coalesce(p_checks ->> k, '') = 'true' then v_checks := v_checks || jsonb_build_object(k, true); end if;
  end loop;
  if coalesce(p_checks ->> 'behavior', '') in ('calm', 'nervous', 'aggressive') then
    v_checks := v_checks || jsonb_build_object('behavior', p_checks ->> 'behavior');
  end if;
  if length(coalesce(p_note, '')) > 600 then
    return json_build_object('ok', false, 'error', 'یادداشت طولانی است');
  end if;
  -- only photos of this visit, uploaded to this salon's folder
  select coalesce(array_agg(x), '{}') into v_photos
    from unnest(coalesce(p_photos, '{}')) x
   where x ~ ('^' || a.salon_id || '/' || a.id || '/(before|after)-[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$');
  if cardinality(v_photos) > 8 then
    return json_build_object('ok', false, 'error', 'حداکثر ۸ عکس');
  end if;
  select coalesce(array_agg(p.id), '{}') into v_products
    from public.products p where p.id = any (coalesce(p_product_ids, '{}')) and p.salon_id = a.salon_id and p.active;
  if cardinality(v_products) > 4 then
    return json_build_object('ok', false, 'error', 'حداکثر ۴ محصول پیشنهادی');
  end if;

  select sent_at into v_already from public.pet_visit_reports where appointment_id = a.id;
  insert into public.pet_visit_reports as r (appointment_id, salon_id, pet_id, checks, note, photos, product_ids)
  values (a.id, a.salon_id, a.pet_id, v_checks, trim(coalesce(p_note, '')), v_photos, v_products)
  on conflict (appointment_id) do update
     set checks = excluded.checks, note = excluded.note, photos = excluded.photos,
         product_ids = excluded.product_ids, updated_at = now();

  -- the groomer's behaviour note keeps the pet profile current
  if a.pet_id is not null and v_checks ? 'behavior' then
    update public.pets set temperament = v_checks ->> 'behavior', updated_at = now() where id = a.pet_id;
  end if;

  if p_send and a.customer_phone ~ '^09[0-9]{9}$' then
    v_token := encode(gen_random_bytes(18), 'hex');
    update public.pet_visit_reports set token_hash = encode(digest(v_token, 'sha256'), 'hex'), sent_at = now()
     where appointment_id = a.id;
    v_link := public.public_link('/visit?token=' || v_token);
    select name into v_salon_name from public.salons where id = a.salon_id;
    if v_link is not null then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (a.salon_id, a.customer_phone,
              'گزارش آرایش ' || coalesce(nullif(a.pet_name, ''), 'حیوان شما') || ' در ' || v_salon_name
                || case when cardinality(v_photos) > 0 then ' (با عکس قبل و بعد)' else '' end || E':\n' || v_link,
              'pet_report', 'queued', now());
    end if;
    return json_build_object('ok', true, 'sent', v_link is not null, 'link', v_link, 'resent', v_already is not null);
  end if;
  return json_build_object('ok', true, 'sent', false);
end;
$fn$;
grant execute on function public.save_visit_report(text, jsonb, text, text[], uuid[], boolean) to authenticated;

-- The owner's report page (anyone holding the link; valid 180 days).
create or replace function public.get_visit_report(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare r public.pet_visit_reports; a public.appointments;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{36}$' then
    return json_build_object('ok', false);
  end if;
  select * into r from public.pet_visit_reports where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and sent_at > now() - interval '180 days';
  if r.appointment_id is null then
    return json_build_object('ok', false);
  end if;
  select * into a from public.appointments where id = r.appointment_id;
  return json_build_object(
    'ok', true,
    'salon_name', (select name from public.salons where id = r.salon_id),
    'salon_slug', (select slug from public.salons where id = r.salon_id),
    'pet_name', a.pet_name, 'date', a.date, 'services_label', a.services_label,
    'checks', r.checks, 'note', nullif(r.note, ''), 'photos', r.photos,
    'products', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'price', p.price, 'photo_path', p.photo_path))
                            from public.products p
                            join public.shop_settings ss on ss.salon_id = p.salon_id and ss.enabled
                           where p.id = any (r.product_ids) and p.active), '[]'::json));
end;
$fn$;
grant execute on function public.get_visit_report(text) to anon, authenticated;

-- Customer dashboard: the reports of their pets.
create or replace function public.my_visit_reports_with_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then return '[]'::json; end if;
  return coalesce((
    select json_agg(json_build_object('appointment_id', r.appointment_id, 'pet_name', a.pet_name, 'date', a.date,
                                      'checks', r.checks, 'note', nullif(r.note, ''), 'photos', r.photos)
                    order by a.date desc)
      from public.pet_visit_reports r join public.appointments a on a.id = r.appointment_id
     where r.salon_id = v_salon and a.customer_phone = v_phone and r.sent_at is not null
       and r.sent_at > now() - interval '365 days'), '[]'::json);
end;
$fn$;
grant execute on function public.my_visit_reports_with_token(text) to anon, authenticated;

-- Photos: public bucket, unguessable file names, only this salon's staff write.
create or replace function public.pet_photo_write_ok(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon text := split_part(coalesce(p_name, ''), '/', 1); v_folder text := split_part(coalesce(p_name, ''), '/', 2);
        v_file text := split_part(coalesce(p_name, ''), '/', 3);
begin
  if not public.is_staff() or v_salon <> coalesce(public.current_salon_id()::text, '-') or split_part(p_name, '/', 4) <> '' then
    return false;
  end if;
  if v_folder = 'vaccine' then
    return v_file ~ '^[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$';
  end if;
  return v_file ~ '^(before|after)-[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$'
     and exists (select 1 from public.appointments a
                  where a.id = v_folder and a.salon_id = v_salon::uuid
                    and (public.is_manager() or a.staff_id = public.my_stylist_id()));
end;
$fn$;
revoke all on function public.pet_photo_write_ok(text) from public;
grant execute on function public.pet_photo_write_ok(text) to authenticated;

do $do$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage not found — pet photos are disabled on this database';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('pet-photos', 'pet-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists pet_photos_insert on storage.objects';
  execute $p$create policy pet_photos_insert on storage.objects for insert to authenticated
           with check (bucket_id = 'pet-photos' and public.pet_photo_write_ok(name))$p$;
  execute 'drop policy if exists pet_photos_delete on storage.objects';
  execute $p$create policy pet_photos_delete on storage.objects for delete to authenticated
           using (bucket_id = 'pet-photos' and public.pet_photo_write_ok(name))$p$;
end
$do$;

-- --------------------------------------------- 3/9. daily care reminders --
create or replace function public.pet_care_reminders()
returns int
language plpgsql security definer set search_path = public as $fn$
declare r record; v_n int := 0; v_today date; v_link text; v_tz text;
begin
  for r in
    select p.*, sa.name as salon_name, sa.slug, coalesce(s.pet_cycle_days, 42) as cycle_days,
           coalesce(s.pet_birthday_message, '') as birthday_message, public.salon_today() as today
      from public.pets p
      join public.salons sa on sa.id = p.salon_id and sa.active and sa.business_type = 'pet'
      left join public.app_settings s on s.salon_id = p.salon_id
     where coalesce(s.pet_reminders_enabled, true)
       and (p.vaccine_valid_until is not null or p.last_visit_date is not null or p.birth_date is not null)
     limit 20000
  loop
    v_today := r.today;
    -- vaccine expires within a week (once per expiry date)
    if r.vaccine_valid_until between v_today and v_today + 7 and r.vaccine_reminded_for is distinct from r.vaccine_valid_until then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (r.salon_id, r.owner_phone,
              'یادآوری ' || r.salon_name || ': اعتبار واکسن ' || r.name || ' تا ' || public.jalali_label(r.vaccine_valid_until)
                || ' است. لطفاً برای تمدید آن اقدام کنید 💉',
              'pet_reminder', 'queued', now());
      update public.pets set vaccine_reminded_for = r.vaccine_valid_until where id = r.id;
      v_n := v_n + 1;
    end if;
    -- next groom due (once per visit), unless already booked or nudged recently
    if r.last_visit_date is not null
       and r.last_visit_date + coalesce(r.groom_every_days, r.cycle_days) between v_today - 6 and v_today
       and r.cycle_reminded_for is distinct from r.last_visit_date
       and not exists (select 1 from public.appointments a
                        where a.salon_id = r.salon_id and a.customer_phone = r.owner_phone and a.date >= v_today
                          and a.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment'))
       and not exists (select 1 from public.sms_messages m
                        where m.salon_id = r.salon_id and m.to_phone = r.owner_phone
                          and m.created_at > now() - interval '5 days'
                          and (m.kind = 'predictive_rebooking' or (m.kind = 'pet_reminder' and m.body like '%وقت آرایش%'))) then
      v_link := public.public_link('/' || r.slug);
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (r.salon_id, r.owner_phone,
              'وقت آرایش ' || r.name || ' رسیده 🐾 از آخرین نوبت ' || public.fa_digits((v_today - r.last_visit_date)::text) || ' روز گذشته.'
                || case when v_link is not null then E'\nرزرو: ' || v_link else '' end || E'\n' || r.salon_name,
              'pet_reminder', 'queued', now());
      update public.pets set cycle_reminded_for = r.last_visit_date where id = r.id;
      v_n := v_n + 1;
    end if;
    -- birthday
    if r.birth_date is not null and to_char(r.birth_date, 'MM-DD') = to_char(v_today, 'MM-DD')
       and r.birthday_reminded_year is distinct from extract(year from v_today)::int then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (r.salon_id, r.owner_phone,
              'تولد ' || r.name || ' مبارک! 🎂🐾' || case when r.birthday_message <> '' then E'\n' || left(r.birthday_message, 200) else '' end
                || E'\n' || r.salon_name,
              'pet_reminder', 'queued', now());
      update public.pets set birthday_reminded_year = extract(year from v_today)::int where id = r.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$fn$;
revoke all on function public.pet_care_reminders() from public, anon, authenticated;
grant execute on function public.pet_care_reminders() to service_role;

-- ------------------------------------------------- 5. pick-up & drop-off --
-- The appointment update guard (v2.24) blocks price changes by customers and stylists. A
-- server function that computed the price itself marks its own transaction
-- as trusted (not reachable from the API: set_config isn't exposed).
-- v2.49: at "انجام شد" a groomer may add add-on charges (v2.45) — the price
-- may grow by exactly the charges appended, or be set when it was decided
-- in the salon. Lowering a price stays a manager's job.
create or replace function public.stylist_checkout_ok(o public.appointments, n public.appointments)
returns boolean
language sql immutable as $fn$
  select n.status = 'completed'
     and coalesce(n.extra_charges, '[]'::jsonb) @> coalesce(o.extra_charges, '[]'::jsonb)
     and n.final_price is not null
     and (
       (o.final_price is null and n.final_price >= 0)
       or n.final_price - o.final_price =
            coalesce((select sum((x ->> 'amount')::bigint) from jsonb_array_elements(coalesce(n.extra_charges, '[]'::jsonb)) x), 0)
          - coalesce((select sum((x ->> 'amount')::bigint) from jsonb_array_elements(coalesce(o.extra_charges, '[]'::jsonb)) x), 0)
     )
     and jsonb_array_length(coalesce(n.extra_charges, '[]'::jsonb)) >= jsonb_array_length(coalesce(o.extra_charges, '[]'::jsonb));
$fn$;

create or replace function public.guard_anonymous_appt_update() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  -- v2.49: a server function that computed the change itself marks its own
  -- transaction as trusted (set_config is not reachable from the API).
  if coalesce(current_setting('app.trusted_rpc', true), '') = 'on' then
    return new;
  end if;
  if auth.uid() is null then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or new.final_price is distinct from old.final_price
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value
       or new.referral_verified is distinct from old.referral_verified then
      raise exception 'این تغییر برای مشتری مجاز نیست — فقط لغو یا جابه‌جایی زمان مجاز است';
    end if;
    insert into public.audit_log (salon_id, event, actor, detail) values (
      new.salon_id, 'appointment_self_update', null,
      jsonb_build_object('appointment_id', new.id, 'from_status', old.status, 'to_status', new.status)
    );
  elsif public.my_role() = 'stylist' and not public.is_manager() then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or (new.final_price is distinct from old.final_price and not public.stylist_checkout_ok(old, new))
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value then
      raise exception 'این تغییر خارج از اختیار آرایشگر است';
    end if;
  end if;
  return new;
end;
$fn$;

-- Called right after booking by the same browser: the booking id (random,
-- only returned to the booker) plus the phone prove it is theirs.
create or replace function public.request_pet_transport(p_appt text, p_phone text, p_address text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_enabled boolean; v_fee bigint;
begin
  select coalesce(pet_transport_enabled, false), coalesce(pet_transport_fee, 0) into v_enabled, v_fee
    from public.app_settings where salon_id = public.current_salon_id();
  if not coalesce(v_enabled, false) then
    return json_build_object('ok', false, 'error', 'سرویس رفت‌وبرگشت فعال نیست');
  end if;
  if length(trim(coalesce(p_address, ''))) < 10 or length(p_address) > 300 then
    return json_build_object('ok', false, 'error', 'آدرس کامل را وارد کنید');
  end if;
  select * into a from public.appointments
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone for update;
  if a.id is null or a.created_at < now() - interval '30 minutes' or a.transport_address is not null
     or a.status in ('cancelled', 'no_show') or a.pet_id is null then
    return json_build_object('ok', false, 'error', 'امکان افزودن سرویس به این نوبت نیست');
  end if;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments
     set transport_address = trim(p_address), transport_fee = v_fee,
         extra_charges = case when v_fee > 0 then coalesce(extra_charges, '[]'::jsonb)
                                 || jsonb_build_array(jsonb_build_object('label', 'سرویس رفت‌وبرگشت', 'amount', v_fee))
                              else extra_charges end,
         final_price = case when final_price is not null then final_price + v_fee else final_price end
   where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'fee', v_fee);
end;
$fn$;
grant execute on function public.request_pet_transport(text, text, text) to anon, authenticated;

-- ----------------------------------------------------------- 6. packages --
create table if not exists public.pet_packages (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  service_id  text not null references public.services (id) on delete cascade,
  sessions    int not null check (sessions between 2 and 50),
  price       bigint not null check (price between 1000 and 10000000000),
  valid_days  int not null default 180 check (valid_days between 14 and 730),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.pet_packages enable row level security;
drop policy if exists p_pet_packages_mgr on public.pet_packages;
create policy p_pet_packages_mgr on public.pet_packages for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_pet_packages_staff_read on public.pet_packages;
create policy p_pet_packages_staff_read on public.pet_packages for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.pet_packages to authenticated;

create table if not exists public.package_purchases (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  package_id      uuid references public.pet_packages (id) on delete set null,
  package_name    text not null,
  service_id      text not null,
  customer_phone  text not null check (customer_phone ~ '^09[0-9]{9}$'),
  customer_name   text not null default '',
  sessions_total  int not null,
  sessions_left   int not null check (sessions_left >= 0),
  price_paid      bigint not null,
  expires_at      date not null,
  created_at      timestamptz not null default now()
);
create index if not exists package_purchases_phone_idx on public.package_purchases (salon_id, customer_phone);
alter table public.package_purchases enable row level security;
drop policy if exists p_package_purchases_staff on public.package_purchases;
create policy p_package_purchases_staff on public.package_purchases for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.package_purchases to authenticated;
alter table public.appointments drop constraint if exists appointments_package_purchase_fk;
alter table public.appointments add constraint appointments_package_purchase_fk
  foreign key (package_purchase_id) references public.package_purchases (id) on delete set null;

-- Public: packages on offer (shown on the booking page).
create or replace function public.get_pet_packages()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('id', k.id, 'name', k.name, 'service_name', s.name, 'sessions', k.sessions,
                                             'price', k.price, 'valid_days', k.valid_days, 'single_price', s.price)
                           order by k.price), '[]'::json)
    from public.pet_packages k join public.services s on s.id = k.service_id
   where k.salon_id = public.current_salon_id() and k.active;
$fn$;
grant execute on function public.get_pet_packages() to anon, authenticated;

create or replace function public.sell_package(p_package uuid, p_phone text, p_name text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare k public.pet_packages; v_id uuid; v_salon_name text; v_exp date;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  select * into k from public.pet_packages where id = p_package and salon_id = public.current_salon_id() and active;
  if k.id is null then
    return json_build_object('ok', false, 'error', 'بسته پیدا نشد');
  end if;
  v_exp := public.salon_today() + k.valid_days;
  insert into public.package_purchases (salon_id, package_id, package_name, service_id, customer_phone, customer_name,
                                        sessions_total, sessions_left, price_paid, expires_at)
  values (k.salon_id, k.id, k.name, k.service_id, p_phone, left(trim(coalesce(p_name, '')), 80), k.sessions, k.sessions, k.price, v_exp)
  returning id into v_id;
  select name into v_salon_name from public.salons where id = k.salon_id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (k.salon_id, p_phone,
          'بستهٔ «' || k.name || '» (' || public.fa_digits((k.sessions)::text) || ' جلسه) در ' || v_salon_name || ' برای شما فعال شد.'
            || E'\nاعتبار تا ' || public.jalali_label(v_exp),
          'pet_package', 'queued', now());
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
grant execute on function public.sell_package(uuid, text, text) to authenticated;

-- Use one session for a visit: the service itself is covered, add-ons are not.
create or replace function public.use_package_session(p_purchase uuid, p_appt text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare pu public.package_purchases; a public.appointments; v_extras bigint;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select * into a from public.appointments where id = p_appt and salon_id = public.current_salon_id() for update;
  if a.id is null or not (public.is_manager() or a.staff_id = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  if a.package_purchase_id is not null then
    return json_build_object('ok', false, 'error', 'برای این نوبت قبلاً از بسته استفاده شده');
  end if;
  select * into pu from public.package_purchases where id = p_purchase and salon_id = a.salon_id for update;
  if pu.id is null or pu.customer_phone <> a.customer_phone or pu.service_id <> a.service_id then
    return json_build_object('ok', false, 'error', 'این بسته برای این نوبت نیست');
  end if;
  if pu.sessions_left <= 0 or pu.expires_at < public.salon_today() then
    return json_build_object('ok', false, 'error', 'بسته تمام یا منقضی شده');
  end if;
  update public.package_purchases set sessions_left = sessions_left - 1 where id = pu.id;
  select coalesce(sum((x ->> 'amount')::bigint), 0) into v_extras from jsonb_array_elements(coalesce(a.extra_charges, '[]'::jsonb)) x;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments set package_purchase_id = pu.id, final_price = v_extras where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'left', pu.sessions_left - 1, 'final_price', v_extras);
end;
$fn$;
grant execute on function public.use_package_session(uuid, text) to authenticated;

create or replace function public.my_packages_with_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then return '[]'::json; end if;
  return coalesce((
    select json_agg(json_build_object('id', p.id, 'name', p.package_name, 'left', p.sessions_left, 'total', p.sessions_total,
                                      'expires_at', p.expires_at) order by p.expires_at)
      from public.package_purchases p
     where p.salon_id = v_salon and p.customer_phone = v_phone and p.expires_at >= public.salon_today() - 30), '[]'::json);
end;
$fn$;
grant execute on function public.my_packages_with_token(text) to anon, authenticated;

-- ----------------------------------------------- 10. large-dog capacity --
create or replace function public.check_pet_capacity()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_cap int; v_busy int;
begin
  if new.pet_size is null or new.pet_size not in ('large', 'giant')
     or new.status not in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.date = new.date and old.start_min = new.start_min and old.end_min = new.end_min
     and old.pet_size is not distinct from new.pet_size
     and old.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment') then
    return new;
  end if;
  select pet_large_capacity into v_cap from public.app_settings where salon_id = new.salon_id;
  if v_cap is null then
    return new;
  end if;
  select count(*) into v_busy
    from public.appointments a
   where a.salon_id = new.salon_id and a.date = new.date and a.id <> new.id
     and a.pet_size in ('large', 'giant')
     and a.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment')
     and a.start_min < new.end_min and a.end_min > new.start_min;
  if v_busy >= v_cap then
    raise exception 'ظرفیت سگ‌های بزرگ در این ساعت پر است' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_check_pet_capacity on public.appointments;
create trigger trg_check_pet_capacity before insert or update of date, start_min, end_min, status, pet_size on public.appointments
  for each row execute function public.check_pet_capacity();
