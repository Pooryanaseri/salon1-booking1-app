-- ============================================================================
-- Migration v2.35 — self-registered stylists wait for the manager (after v2.34)
-- ============================================================================
-- Stylist self-registration is open to anyone with the salon's address (by
-- design: the manager doesn't have to create accounts). Until now such a
-- stranger became an active stylist immediately: listed on the public
-- booking page, able to log in, and — through customer_loyalty's staff
-- branch — able to look up any customer's full record by phone.
--
-- Now:
--   * a stylists row created by a non-manager (the self-registration path)
--     starts inactive and is marked self_registered; every owner/manager
--     gets one SMS ("… is waiting for your approval");
--   * the matching users row starts inactive too, so the person can't log
--     in yet (the app says "waiting for the salon manager");
--   * turning the stylist on in Panel → Stylists activates the login as
--     well (and turning them off blocks it) — one switch;
--   * a stylist the manager added beforehand (with their phone) is trusted:
--     linking to it on sign-up needs no approval;
--   * customer_loyalty's full record is for managers only, not stylists.
-- ============================================================================

alter table public.stylists add column if not exists self_registered boolean not null default false;

create or replace function public.guard_stylist_self_registration()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_mgr record; v_salon_name text;
begin
  -- Manager/panel inserts and server-side inserts are trusted as-is.
  if auth.uid() is null or public.is_manager() then
    return new;
  end if;

  new.self_registered := true;
  new.active := false;

  select name into v_salon_name from public.salons where id = new.salon_id;
  for v_mgr in
    select u.phone from public.users u
     where u.salon_id = new.salon_id and u.active and u.role in ('owner', 'manager')
       and u.phone ~ '^09[0-9]{9}$'
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (new.salon_id, v_mgr.phone,
            coalesce(v_salon_name, 'سالن') || ': آرایشگر جدید «' || coalesce(nullif(trim(new.name), ''), 'بدون نام') || '» ('
              || coalesce(new.phone, '') || ') ثبت‌نام کرد و منتظر تایید شماست — پنل مدیریت ← آرایشگرها',
            'custom', 'queued', now());
  end loop;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_stylist_self_registration on public.stylists;
create trigger trg_guard_stylist_self_registration
  before insert on public.stylists
  for each row execute function public.guard_stylist_self_registration();

-- The account inherits the stylist profile's approval state on sign-up.
create or replace function public.guard_user_self_insert()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_st record;
begin
  -- Only the app's own sign-up path (a user creating their own profile).
  if auth.uid() is null or new.id <> auth.uid() then
    return new;
  end if;

  if new.role in ('owner', 'manager') then
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
    -- A profile the manager created is trusted; a self-registered one waits.
    if v_st.self_registered and not v_st.active then
      new.active := false;
    end if;
  end if;
  return new;
end;
$fn$;

-- One switch in the panel: the stylist's listing AND their login.
create or replace function public.sync_stylist_login_with_active()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.active is distinct from old.active then
    update public.users
       set active = new.active
     where stylist_id = new.id and salon_id = new.salon_id and role = 'stylist';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_sync_stylist_login_with_active on public.stylists;
create trigger trg_sync_stylist_login_with_active
  after update of active on public.stylists
  for each row execute function public.sync_stylist_login_with_active();

-- Full customer record: managers only (stylists don't need other customers').
create or replace function public.customer_loyalty(p_phone text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_full json;
begin
  v_full := public.customer_loyalty_full(p_phone, public.current_salon_id());
  if public.is_manager() then
    return v_full;
  end if;
  return json_build_object(
    'found', coalesce((v_full ->> 'found')::boolean, false),
    'discount_percent', coalesce((v_full ->> 'discount_percent')::int, 0)
  );
end;
$fn$;

-- Functions created after v2.32 start closed; these are trigger functions
-- (no direct grants needed) except customer_loyalty, re-granted here.
grant execute on function public.customer_loyalty(text) to anon, authenticated;
