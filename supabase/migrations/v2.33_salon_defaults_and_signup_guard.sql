-- ============================================================================
-- Migration v2.33 — salon_id defaults + self-registration guard (run after v2.32)
-- ============================================================================
-- 1) BUG (since v2.24): every tenant table got `salon_id NOT NULL` but no
--    default, and the app never sends salon_id on insert. So every insert
--    made from the browser failed — adding a service, stylist, expense,
--    time off, working hours, open days, SMS template, a customer joining
--    the waitlist, and owner/stylist self-registration ("ساخت پروفایل
--    ناموفق بود"). The UI showed success because insert errors were only
--    logged. salon_id now defaults to current_salon_id() — the caller's own
--    salon for staff, the page's salon (x-salon-id) for public visitors —
--    which is exactly what each table's RLS check already demands.
--
-- 2) SECURITY: users' self-insert policy (p_users_selfins) checked only
--    id = auth.uid() and the salon — not the role. Anyone could sign up and
--    insert themselves as 'owner'/'manager' of any salon (the "only while no
--    manager exists" rule lived only in the browser). Now enforced here:
--      * owner/manager self-registration only while the salon has none;
--      * stylist self-registration only against a stylists row of the same
--        salon and phone that isn't linked to another account.
--    Managers adding users (p_users_mgr) and server-side inserts are not
--    affected (they aren't self-inserts).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) salon_id defaults
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'salon_id'
       and tb.table_type = 'BASE TABLE' and c.table_name <> 'salons'
  loop
    execute format('alter table public.%I alter column salon_id set default public.current_salon_id()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) Self-registration guard
-- ----------------------------------------------------------------------------
create or replace function public.guard_user_self_insert()
returns trigger
language plpgsql security definer set search_path = public as $fn$
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
    if new.stylist_id is null or not exists (
      select 1 from public.stylists s
       where s.id = new.stylist_id and s.salon_id = new.salon_id and s.phone = new.phone
    ) or exists (
      select 1 from public.users u where u.stylist_id = new.stylist_id and u.salon_id = new.salon_id and u.id <> new.id
    ) then
      raise exception 'پروفایل آرایشگر با این شماره پیدا نشد' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_user_self_insert on public.users;
create trigger trg_guard_user_self_insert
  before insert on public.users
  for each row execute function public.guard_user_self_insert();

-- ----------------------------------------------------------------------------
-- 3) Saving working hours per salon
-- ----------------------------------------------------------------------------
-- The app upserted rows with fixed ids like 'wh-salon-0'. working_hours.id is
-- unique across ALL salons, so a second salon's save collided with the
-- first salon's rows (and was rejected by RLS). This replaces the salon's
-- (or one stylist's) week in one call. SECURITY INVOKER on purpose: the
-- table's RLS (managers; a stylist only for their own staff_id) decides
-- who may write.
create or replace function public.save_working_hours(p_staff_id text, p_hours jsonb)
returns void
language plpgsql set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if v_salon is null then
    raise exception 'salon unknown' using errcode = '42501';
  end if;
  delete from public.working_hours
   where salon_id = v_salon and staff_id is not distinct from p_staff_id;
  insert into public.working_hours (id, salon_id, staff_id, day_of_week, start_time, end_time, is_closed)
  select 'wh-' || substr(md5(gen_random_uuid()::text), 1, 16), v_salon, p_staff_id,
         (h ->> 'day_of_week')::int,
         coalesce(h ->> 'start_time', '09:00'),
         coalesce(h ->> 'end_time', '21:00'),
         coalesce((h ->> 'is_closed')::boolean, false)
    from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) as h;
end;
$fn$;
grant execute on function public.save_working_hours(text, jsonb) to authenticated, service_role;
