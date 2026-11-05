-- v2.68: consultation requests for beauty salons (women's and men's).
--
-- Like the pet salon's price quote (v2.46), but for people:
--   1. On the booking page the customer picks «مشاوره و تعیین قیمت»: the
--      services they are interested in, a few questions about their hair /
--      skin (length, texture, condition, last colouring, treatments,
--      sensitivity), the result they want, optional photos, name and phone
--      (request_consultation).
--   2. The salon's managers, owner and the stylists of that section get an
--      SMS with the details; the request shows in the panel
--      («نوبت‌ها ← مشاوره و قیمت»).
--   3. A stylist or the manager sets the price, duration and stylist
--      (send_quote, as for pets). The customer gets an SMS with a link to pick
--      a time at that price; the same request is in «داشبورد من».
-- The same quote_requests table, booking link and photo bucket are used;
-- kind = 'consult' marks these, and the animal columns stay empty.
-- app_settings.consult_enabled turns the option off for a salon.
-- Safe to run more than once.

-- ------------------------------------------------------------ 1. schema ----
alter table public.quote_requests add column if not exists kind text not null default 'pet';
alter table public.quote_requests add column if not exists customer_gender text;
alter table public.quote_requests add column if not exists details jsonb not null default '{}'::jsonb;
alter table public.quote_requests alter column pet_name drop not null;
alter table public.quote_requests alter column pet_species drop not null;
alter table public.quote_requests drop constraint if exists quote_requests_kind_check;
alter table public.quote_requests add constraint quote_requests_kind_check check (
  (kind = 'pet' and pet_species in ('dog', 'cat'))
  or (kind = 'consult' and pet_species is null and pet_name is null and customer_gender in ('female', 'male')));
alter table public.quote_requests drop constraint if exists quote_requests_details_check;
alter table public.quote_requests add constraint quote_requests_details_check check (length(details::text) <= 2000);

alter table public.app_settings add column if not exists consult_enabled boolean not null default true;

-- ------------------------------------------------- 2. details as text -------
-- One readable line for SMS (the panel formats the same keys itself).
create or replace function public.consult_details_text(p jsonb)
returns text
language sql immutable set search_path = public as $fn$
  select coalesce(nullif(concat_ws(' · ',
    nullif(concat_ws('، ',
      case p ->> 'hair_length' when 'short' then 'موی کوتاه' when 'medium' then 'موی متوسط' when 'long' then 'موی بلند' when 'very_long' then 'موی خیلی بلند' end,
      case p ->> 'hair_texture' when 'straight' then 'صاف' when 'wavy' then 'موج‌دار' when 'curly' then 'فر' end,
      case p ->> 'hair_condition' when 'healthy' then 'سالم' when 'dry' then 'خشک' when 'damaged' then 'آسیب‌دیده' when 'very_damaged' then 'خیلی آسیب‌دیده' end), ''),
    case p ->> 'last_color' when 'none' then 'بدون رنگ قبلی' when 'lt3' then 'رنگ/دکلره کمتر از ۳ ماه پیش'
                            when '3to6' then 'رنگ/دکلره ۳ تا ۶ ماه پیش' when 'gt6' then 'رنگ/دکلره بیش از ۶ ماه پیش' end,
    case p ->> 'skin' when 'normal' then 'پوست معمولی' when 'oily' then 'پوست چرب' when 'dry' then 'پوست خشک' when 'sensitive' then 'پوست حساس' end,
    nullif('خدمات قبلی: ' || nullif(trim(p ->> 'treatments'), ''), ''),
    nullif('حساسیت: ' || nullif(trim(p ->> 'allergy'), ''), ''),
    nullif('نتیجهٔ دلخواه: ' || nullif(trim(p ->> 'goal'), ''), '')), ''), '');
$fn$;

-- ------------------------------------------------- 3. customer request ------
create or replace function public.request_consultation(
  p_customer_name text, p_customer_phone text, p_gender text, p_service_ids text[],
  p_details jsonb default '{}', p_note text default '', p_preferred_time text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id(); v_type text; v_salon_name text; v_enabled boolean;
  v_label text; v_count int; v_id uuid; v_ids text[]; v_phone text; v_details jsonb; v_text text;
begin
  if v_salon is null then return json_build_object('ok', false, 'error', 'سالن نامعتبر است'); end if;
  select business_type, name into v_type, v_salon_name from public.salons where id = v_salon;
  select coalesce(consult_enabled, true) into v_enabled from public.app_settings where salon_id = v_salon;
  if v_type = 'pet' or v_enabled is false then
    return json_build_object('ok', false, 'error', 'این سالن درخواست مشاوره ندارد');
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
  if p_gender is null or p_gender not in ('female', 'male') then
    return json_build_object('ok', false, 'error', 'بخش (زنانه / مردانه) را انتخاب کنید');
  end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_service_ids, '{}')) x where x is not null;
  if coalesce(cardinality(v_ids), 0) not between 1 and 6 then
    return json_build_object('ok', false, 'error', 'یک تا شش خدمت انتخاب کنید');
  end if;
  select count(*), string_agg(s.name, ' + ' order by s.name) into v_count, v_label
    from public.services s
   where s.salon_id = v_salon and s.id = any (v_ids) and s.is_active and not s.is_addon and s.gender = p_gender;
  if v_count <> cardinality(v_ids) then return json_build_object('ok', false, 'error', 'خدمت انتخابی یافت نشد'); end if;

  -- only the known questions, each with an allowed answer
  v_details := jsonb_strip_nulls(jsonb_build_object(
    'hair_length', case when p_details ->> 'hair_length' in ('short', 'medium', 'long', 'very_long') then p_details ->> 'hair_length' end,
    'hair_texture', case when p_details ->> 'hair_texture' in ('straight', 'wavy', 'curly') then p_details ->> 'hair_texture' end,
    'hair_condition', case when p_details ->> 'hair_condition' in ('healthy', 'dry', 'damaged', 'very_damaged') then p_details ->> 'hair_condition' end,
    'last_color', case when p_details ->> 'last_color' in ('none', 'lt3', '3to6', 'gt6') then p_details ->> 'last_color' end,
    'skin', case when p_details ->> 'skin' in ('normal', 'oily', 'dry', 'sensitive') then p_details ->> 'skin' end,
    'treatments', nullif(left(trim(coalesce(p_details ->> 'treatments', '')), 120), ''),
    'allergy', nullif(left(trim(coalesce(p_details ->> 'allergy', '')), 150), ''),
    'goal', nullif(left(trim(coalesce(p_details ->> 'goal', '')), 300), '')));
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

  insert into public.quote_requests (salon_id, customer_phone, customer_name, kind, customer_gender, details, pet_name, pet_species,
                                     service_ids, services_label, customer_note, preferred_time)
  values (v_salon, p_customer_phone, trim(p_customer_name), 'consult', p_gender, v_details, null, null,
          v_ids, v_label, trim(coalesce(p_note, '')), trim(coalesce(p_preferred_time, '')))
  returning id into v_id;

  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (v_salon, p_customer_phone,
          trim(p_customer_name) || ' عزیز، درخواست مشاورهٔ شما (' || v_label || ') در ' || v_salon_name
            || E' ثبت شد.\nقیمت و لینک رزرو به‌زودی برایتان پیامک می‌شود.',
          'quote_request', 'queued', now());
  v_text := public.consult_details_text(v_details);
  for v_phone in
    select distinct x.ph from (
      select u.phone as ph from public.users u
       where u.salon_id = v_salon and u.role in ('owner', 'manager') and u.active is not false
      union select sa.owner_phone from public.salons sa where sa.id = v_salon
      union select st.phone from public.stylists st where st.salon_id = v_salon and st.active and st.gender = p_gender
    ) x where x.ph ~ '^09[0-9]{9}$'
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (v_salon, v_phone,
            'درخواست مشاوره (' || case p_gender when 'male' then 'مردانه' else 'زنانه' end || '): ' || v_label
              || case when v_text <> '' then E'\n' || v_text else '' end
              || E'\nمشتری: ' || trim(p_customer_name) || ' ' || p_customer_phone || E'\nپاسخ از پنل ← نوبت‌ها ← مشاوره و قیمت',
            'quote_request', 'queued', now());
  end loop;
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
revoke all on function public.request_consultation(text, text, text, text[], jsonb, text, text) from public;
grant execute on function public.request_consultation(text, text, text, text[], jsonb, text, text) to anon, authenticated;

-- ------------------------------------- 4. staff answer: wording for people ---
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

  update public.rebooking_tokens set used_at = now() where quote_id = p_id and used_at is null;
  v_token := public.create_rebooking_token(v_q.salon_id, v_q.customer_phone, v_q.service_ids[1], p_staff_id, 'quote');
  update public.rebooking_tokens set quote_id = p_id, expires_at = v_q.expires_at, customer_name = v_q.customer_name
   where token_hash = encode(digest(v_token, 'sha256'), 'hex');
  v_link := public.public_link('/book?token=' || v_token);

  select name into v_salon_name from public.salons where id = v_q.salon_id;
  v_body := v_q.customer_name || ' عزیز، قیمت ' || v_q.services_label
            || case when coalesce(v_q.pet_name, '') <> '' then ' برای ' || v_q.pet_name else '' end
            || ' در ' || v_salon_name || ': '
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
          v_q.customer_name || ' عزیز، ' || v_salon_name || ': متاسفانه برای درخواست '
            || coalesce(nullif(v_q.pet_name, ''), v_q.services_label) || ' امکان پذیرش نیست.'
            || case when v_q.quote_note <> '' then E'\n' || v_q.quote_note else '' end,
          'quote', 'queued', now());
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.decline_quote(uuid, text) from public, anon;
grant execute on function public.decline_quote(uuid, text) to authenticated;

-- ---------------------------------------------- 5. «داشبورد من» -------------
-- volatile: resolve_booking_token records the use (v2.59)
create or replace function public.my_quotes_with_token(p_token text)
returns json
language plpgsql volatile security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return '[]'::json;
  end if;
  return coalesce((
    select json_agg(json_build_object(
             'id', q.id, 'kind', q.kind, 'pet_name', q.pet_name, 'pet_species', q.pet_species, 'services_label', q.services_label,
             'status', case when q.status = 'quoted' and q.expires_at <= now() then 'expired' else q.status end,
             'price', q.quoted_price, 'duration', q.quoted_duration, 'note', nullif(q.quote_note, ''),
             'expires_at', q.expires_at, 'created_at', q.created_at, 'appointment_id', q.appointment_id)
           order by q.created_at desc)
      from public.quote_requests q
     where q.salon_id = v_salon and q.customer_phone = v_phone and q.created_at > now() - interval '60 days'), '[]'::json);
end;
$fn$;
grant execute on function public.my_quotes_with_token(text) to anon, authenticated;
