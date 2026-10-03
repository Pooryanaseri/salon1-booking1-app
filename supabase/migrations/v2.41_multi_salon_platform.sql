-- ============================================================================
-- Migration v2.41 — running many salons on one installation (run after v2.40)
-- ============================================================================
-- 1. Platform admin: a small set of accounts (platform_admins) that can create
--    salons, bind each to its owner's phone, and activate/deactivate them —
--    no SQL needed per salon. Bootstrap the first admin once (INSTALL.md).
-- 2. Owner binding: a salon created by the admin carries owner_phone; only
--    that phone can register as its manager. Before this, whoever signed up
--    first at a fresh salon's address became its owner.
-- 3. Deactivated salons are off for everyone: current_salon_id() resolves
--    only active salons, so public booking AND the staff panel stop.
-- 4. Each salon's own SMS account (provider, API key, sender line). The key
--    is write-only from the app; only the Edge Functions (service role) read it.
-- 5. Waitlist: an anonymous visitor could read every salon's waitlist (names,
--    phones), and the public "join waitlist" write never worked (the client's
--    upsert needs UPDATE, which anon doesn't have). Joining now goes through
--    join_waitlist(); only staff can read the list.
-- 6. Feedback rows take their salon from the booking, not the request header.
-- ============================================================================

-- ---------------------------------------------------------------- salons ----
alter table public.salons add column if not exists owner_phone text;
alter table public.salons drop constraint if exists salons_owner_phone_check;
alter table public.salons add constraint salons_owner_phone_check check (owner_phone is null or owner_phone ~ '^09[0-9]{9}$');

-- Public pages need id/slug/name only; owner_phone stays private.
revoke select on public.salons from anon, authenticated;
grant select (id, slug, name, active, created_at) on public.salons to anon, authenticated;

-- ------------------------------------------------------ platform admins ----
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$fn$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ------------------------------------------- active salons only (tenancy) ---
create or replace function public.current_salon_id()
returns uuid
language sql stable security definer set search_path = public as $fn$
  select s.id
    from public.salons s
   where s.active
     and s.id = coalesce(
       (select salon_id from public.users where id = auth.uid()),
       nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-salon-id', '')::uuid
     );
$fn$;

-- ------------------------------------------------ owner phone binding ------
create or replace function public.guard_user_self_insert()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_st record; v_owner_phone text;
begin
  -- Only the app's own sign-up path (a user creating their own profile).
  if auth.uid() is null or new.id <> auth.uid() then
    return new;
  end if;

  if new.role in ('owner', 'manager') then
    select owner_phone into v_owner_phone from public.salons where id = new.salon_id;
    if v_owner_phone is not null then
      -- v2.41: salons created from the platform panel name their owner.
      if new.phone is distinct from v_owner_phone then
        raise exception 'این شماره به‌عنوان مدیر این سالن ثبت نشده است' using errcode = '42501';
      end if;
      new.role := 'owner';
    end if;
    if exists (
      select 1 from public.users u
       where u.salon_id = new.salon_id and u.role in ('owner', 'manager') and u.id <> new.id
    ) then
      raise exception 'این سالن قبلاً مدیر دارد — برای دسترسی مدیریتی از مدیر فعلی بخواهید'
        using errcode = '42501';
    end if;
  elsif new.role = 'stylist' then
    select * into v_st from public.stylists s
     where s.id = new.stylist_id and s.salon_id = new.salon_id and s.phone = new.phone;
    if v_st.id is null or exists (
      select 1 from public.users u where u.stylist_id = new.stylist_id and u.salon_id = new.salon_id and u.id <> new.id
    ) then
      raise exception 'پروفایل آرایشگر با این شماره پیدا نشد' using errcode = '42501';
    end if;
    if v_st.self_registered and not v_st.active then
      new.active := false;
    end if;
  end if;
  return new;
end;
$fn$;

-- --------------------------------------------- per-salon SMS account -------
create table if not exists public.salon_sms_settings (
  salon_id   uuid primary key references public.salons(id) on delete cascade,
  provider   text not null check (provider in ('kavenegar', 'melipayamak')),
  api_key    text not null,
  sender     text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.salon_sms_settings enable row level security;
revoke all on public.salon_sms_settings from public, anon, authenticated;
-- (no policies: only the service role — the Edge Functions — reads it)

-- -------------------------------------------------------- admin RPCs -------
create or replace function public.admin_create_salon(p_slug text, p_name text, p_owner_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_slug text := lower(trim(coalesce(p_slug, ''))); v_id uuid;
begin
  if not public.is_platform_admin() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
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

  insert into public.salons (slug, name, owner_phone) values (v_slug, trim(p_name), p_owner_phone)
  returning id into v_id;
  -- trg_provision_salon_defaults adds app/loyalty/segment settings; open the
  -- booking window right away so the salon is bookable once it has hours.
  return json_build_object('ok', true, 'id', v_id, 'slug', v_slug);
end;
$fn$;

create or replace function public.admin_update_salon(p_id uuid, p_name text default null, p_owner_phone text default null, p_active boolean default null)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_owner_phone is not null and p_owner_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شمارهٔ موبایل مدیر نامعتبر است');
  end if;
  update public.salons
     set name = coalesce(nullif(trim(p_name), ''), name),
         owner_phone = coalesce(p_owner_phone, owner_phone),
         active = coalesce(p_active, active)
   where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'سالن پیدا نشد');
  end if;
  return json_build_object('ok', true);
end;
$fn$;

-- One row per salon with what the platform owner needs to run 300+ of them:
-- is it set up, is it used, is its SMS working.
create or replace function public.admin_list_salons()
returns table (
  id uuid, slug text, name text, active boolean, owner_phone text, created_at timestamptz,
  owner_registered boolean, stylists int, services int,
  bookings_30d int, completed_30d int, last_booking_date date,
  sms_configured boolean, sms_sent_30d int, sms_failed_30d int
)
language sql stable security definer set search_path = public as $fn$
  select s.id, s.slug, s.name, s.active, s.owner_phone, s.created_at,
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

create or replace function public.get_sms_account()
returns json
language sql stable security definer set search_path = public as $fn$
  select case when not public.is_manager() then json_build_object('ok', false)
  else coalesce(
    (select json_build_object('ok', true, 'configured', true, 'provider', provider, 'sender', sender,
                              'key_hint', right(api_key, 4), 'updated_at', updated_at)
       from public.salon_sms_settings where salon_id = public.current_salon_id()),
    json_build_object('ok', true, 'configured', false))
  end;
$fn$;

-- p_api_key empty = keep the saved key (change provider line/sender only).
create or replace function public.set_sms_account(p_provider text, p_api_key text, p_sender text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_key text := nullif(trim(coalesce(p_api_key, '')), '');
begin
  if not public.is_manager() or v_salon is null then
    return json_build_object('ok', false, 'error', 'دسترسی مجاز نیست');
  end if;
  if p_provider = 'none' then
    delete from public.salon_sms_settings where salon_id = v_salon;
    return json_build_object('ok', true, 'configured', false);
  end if;
  if p_provider not in ('kavenegar', 'melipayamak') then
    return json_build_object('ok', false, 'error', 'سرویس پیامک نامعتبر است');
  end if;
  if v_key is not null and length(v_key) < 8 then
    return json_build_object('ok', false, 'error', 'کلید API نامعتبر به نظر می‌رسد');
  end if;
  if v_key is null and not exists (select 1 from public.salon_sms_settings where salon_id = v_salon) then
    return json_build_object('ok', false, 'error', 'کلید API لازم است');
  end if;
  update public.salon_sms_settings
     set provider = p_provider, api_key = coalesce(v_key, api_key),
         sender = coalesce(trim(p_sender), ''), updated_at = now()
   where salon_id = v_salon;
  if not found then
    insert into public.salon_sms_settings (salon_id, provider, api_key, sender)
    values (v_salon, p_provider, v_key, coalesce(trim(p_sender), ''));
  end if;
  insert into public.audit_log (salon_id, actor, event, detail)
  values (v_salon, auth.uid(), 'sms_account_updated', jsonb_build_object('provider', p_provider));
  return json_build_object('ok', true, 'configured', true);
end;
$fn$;

-- ---------------------------------------------------------- waitlist -------
drop policy if exists p_wait_select on public.waitlist;
create policy p_wait_select on public.waitlist for select using (salon_id = public.current_salon_id() and public.is_staff());
drop policy if exists p_wait_insert on public.waitlist;
create policy p_wait_insert on public.waitlist for insert with check (salon_id = public.current_salon_id() and public.is_staff());
revoke insert, select, update, delete on public.waitlist from anon;

create or replace function public.join_waitlist(p_date date, p_service_id text, p_staff_id text,
                                                p_name text, p_phone text, p_gender text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_staff_name text;
begin
  if v_salon is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شمارهٔ موبایل نامعتبر است');
  end if;
  if coalesce(trim(p_name), '') = '' or length(p_name) > 80 then
    return json_build_object('ok', false, 'error', 'نام را وارد کنید');
  end if;
  if p_date is null or p_date < public.salon_today() or p_date > public.salon_today() + 90 then
    return json_build_object('ok', false, 'error', 'تاریخ نامعتبر است');
  end if;
  if not exists (select 1 from public.services where id = p_service_id and salon_id = v_salon and is_active) then
    return json_build_object('ok', false, 'error', 'خدمت پیدا نشد');
  end if;
  if p_staff_id is not null then
    select name into v_staff_name from public.stylists where id = p_staff_id and salon_id = v_salon and active;
    if v_staff_name is null then
      return json_build_object('ok', false, 'error', 'آرایشگر پیدا نشد');
    end if;
  end if;
  if not public.check_rate_limit('waitlist:' || p_phone, 10, 60) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید');
  end if;
  -- Same person, same day/service/stylist: already on the list.
  if exists (select 1 from public.waitlist w
              where w.salon_id = v_salon and w.customer_phone = p_phone and w.date = p_date
                and w.service_id = p_service_id and w.staff_id is not distinct from p_staff_id) then
    return json_build_object('ok', true, 'already', true);
  end if;

  insert into public.waitlist (id, salon_id, date, customer_name, customer_phone, customer_gender, service_id, staff_id, staff_name)
  values ('wl-' || encode(gen_random_bytes(8), 'hex'), v_salon, p_date, trim(p_name), p_phone,
          coalesce(nullif(p_gender, ''), (select gender from public.services where id = p_service_id), 'female'),
          p_service_id, p_staff_id, coalesce(v_staff_name, ''));
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.join_waitlist(date, text, text, text, text, text) from public;
grant execute on function public.join_waitlist(date, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------- feedbacks ------
create or replace function public.feedback_salon_from_booking()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  select salon_id into new.salon_id from public.appointments where id = new.booking_id;
  if new.salon_id is null then
    raise exception 'نوبت پیدا نشد' using errcode = '23503';
  end if;
  return new;
end;
$fn$;
revoke all on function public.feedback_salon_from_booking() from public, anon, authenticated;
drop trigger if exists trg_feedback_salon on public.feedbacks;
create trigger trg_feedback_salon before insert on public.feedbacks
  for each row execute function public.feedback_salon_from_booking();

-- ------------------------------------------------------------ grants -------
revoke all on function public.admin_create_salon(text, text, text) from public, anon;
revoke all on function public.admin_update_salon(uuid, text, text, boolean) from public, anon;
revoke all on function public.admin_list_salons() from public, anon;
revoke all on function public.get_sms_account() from public, anon;
revoke all on function public.set_sms_account(text, text, text) from public, anon;
grant execute on function public.admin_create_salon(text, text, text) to authenticated;
grant execute on function public.admin_update_salon(uuid, text, text, boolean) to authenticated;
grant execute on function public.admin_list_salons() to authenticated;
grant execute on function public.get_sms_account() to authenticated;
grant execute on function public.set_sms_account(text, text, text) to authenticated;

-- Sign-up pre-check for the manager form, so a wrong number is rejected
-- before an auth account is created (an orphaned account would block that
-- phone later). Answers only yes/no for the caller's own number.
create or replace function public.can_register_manager(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_owner text;
begin
  if v_salon is null then
    return json_build_object('ok', false, 'error', 'سالن نامعتبر است');
  end if;
  if not public.check_rate_limit('can_register_manager:' || coalesce(p_phone, ''), 10, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید');
  end if;
  if exists (select 1 from public.users where salon_id = v_salon and role in ('owner', 'manager')) then
    return json_build_object('ok', false, 'error', 'برای این سالن قبلاً یک مدیر ثبت‌نام کرده — وارد شوید');
  end if;
  select owner_phone into v_owner from public.salons where id = v_salon;
  if v_owner is not null and v_owner is distinct from p_phone then
    return json_build_object('ok', false, 'error', 'این شماره به‌عنوان مدیر این سالن ثبت نشده است');
  end if;
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.can_register_manager(text) from public;
grant execute on function public.can_register_manager(text) to anon, authenticated;
