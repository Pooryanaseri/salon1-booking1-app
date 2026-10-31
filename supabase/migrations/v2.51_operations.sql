-- ============================================================================
-- Migration v2.51 — operations (run after v2.50)
-- ============================================================================
--   8. Pet health record: allergies, medications, vet; weight history;
--      the salon's partner vet suggested in a report with findings.
--   9. Shop: product variants (same group, different size/weight) and a
--      shipment tracking code + carrier.
--  10. Supplies inventory (shampoo, colour, …) with low-stock alerts;
--      purchases are booked as expenses.
--  11. Check-in: staff scan the customer's QR (tracking code).
--  12. Branches: one owner, several salons, switch from the panel and a
--      combined summary.
--  13. Security: two-step login (TOTP via Supabase Auth) is honoured by the
--      role checks; daily backups of each salon's data (last 7 kept).
-- ============================================================================

-- ---------------------------------------------------------- 8. pet health --
alter table public.pets add column if not exists allergies   text not null default '';
alter table public.pets add column if not exists medications text not null default '';
alter table public.pets add column if not exists vet_name    text not null default '';
alter table public.pets add column if not exists vet_phone   text not null default '';
alter table public.pets drop constraint if exists pets_health_len_check;
alter table public.pets add constraint pets_health_len_check
  check (length(allergies) <= 300 and length(medications) <= 300 and length(vet_name) <= 80 and length(vet_phone) <= 20);
alter table public.app_settings add column if not exists pet_vet_partner text not null default '';

create table if not exists public.pet_weights (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  pet_id     uuid not null references public.pets (id) on delete cascade,
  date       date not null,
  kg         numeric(5, 1) not null check (kg > 0 and kg <= 150),
  created_at timestamptz not null default now(),
  unique (pet_id, date)
);
alter table public.pet_weights enable row level security;
drop policy if exists p_pet_weights_staff on public.pet_weights;
create policy p_pet_weights_staff on public.pet_weights for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.pet_weights to authenticated;

create or replace function public.record_pet_weight(p_pet uuid, p_kg numeric)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_kg is null or p_kg <= 0 or p_kg > 150 then return json_build_object('ok', false, 'error', 'وزن نامعتبر است'); end if;
  if not exists (select 1 from public.pets where id = p_pet and salon_id = v_salon) then
    return json_build_object('ok', false, 'error', 'حیوان پیدا نشد');
  end if;
  insert into public.pet_weights (salon_id, pet_id, date, kg) values (v_salon, p_pet, public.salon_today(), round(p_kg, 1))
  on conflict (pet_id, date) do update set kg = excluded.kg;
  update public.pets set weight_kg = round(p_kg, 1), updated_at = now() where id = p_pet;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.record_pet_weight(uuid, numeric) to authenticated;

-- the owner's report shows the partner vet when something was found
create or replace function public.get_visit_report(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare r public.pet_visit_reports; a public.appointments; v_found boolean;
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
  v_found := exists (select 1 from jsonb_object_keys(r.checks) k where k <> 'behavior');
  return json_build_object(
    'ok', true,
    'salon_name', (select name from public.salons where id = r.salon_id),
    'salon_slug', (select slug from public.salons where id = r.salon_id),
    'pet_name', a.pet_name, 'date', a.date, 'services_label', a.services_label,
    'checks', r.checks, 'note', nullif(r.note, ''), 'photos', r.photos,
    'vet_partner', case when v_found then nullif((select pet_vet_partner from public.app_settings where salon_id = r.salon_id), '') end,
    'products', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'price', p.price, 'photo_path', p.photo_path))
                            from public.products p
                            join public.shop_settings ss on ss.salon_id = p.salon_id and ss.enabled
                           where p.id = any (r.product_ids) and p.active), '[]'::json));
end;
$fn$;
grant execute on function public.get_visit_report(text) to anon, authenticated;

-- ------------------------------------------------- 9. variants + tracking --
alter table public.products add column if not exists variant_group text not null default '';
alter table public.products add column if not exists variant_label text not null default '';
alter table public.products drop constraint if exists products_variant_len_check;
alter table public.products add constraint products_variant_len_check check (length(variant_group) <= 80 and length(variant_label) <= 40);
alter table public.orders add column if not exists tracking_code text not null default '';
alter table public.orders add column if not exists carrier text not null default '';

create or replace function public.get_shop()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'enabled', coalesce(ss.enabled, false),
    'pickup', coalesce(ss.pickup_enabled, true) or not coalesce(ss.shipping_enabled, false),
    'pickup_address', coalesce(ss.pickup_address, ''),
    'shipping', coalesce(ss.shipping_enabled, false),
    'shipping_fee', coalesce(ss.shipping_fee, 0),
    'free_shipping_over', coalesce(ss.free_shipping_over, 0),
    'shipping_area', coalesce(ss.shipping_area, ''),
    'note', coalesce(ss.note, ''),
    'online', coalesce(pp.zarinpal_merchant_id, '') <> '',
    'cash', coalesce(ss.cash_enabled, false) or coalesce(pp.zarinpal_merchant_id, '') = '',
    'products', case when coalesce(ss.enabled, false) then coalesce((
      select json_agg(json_build_object(
               'id', p.id, 'name', p.name, 'description', p.description, 'category', p.category,
               'price', p.price, 'stock', p.stock, 'photo_path', p.photo_path,
               'variant_group', p.variant_group, 'variant_label', p.variant_label)
             order by p.sort_order, p.created_at)
        from public.products p where p.salon_id = c.salon_id and p.active), '[]'::json) else '[]'::json end
  )
  from (select public.current_salon_id() as salon_id) c
  left join public.shop_settings ss on ss.salon_id = c.salon_id
  left join public.salon_payment_settings pp on pp.salon_id = c.salon_id
  where c.salon_id is not null;
$fn$;
grant execute on function public.get_shop() to anon, authenticated;

-- set_order_status with a tracking code (replaces the 3-argument version)
drop function if exists public.set_order_status(uuid, text, text);
create or replace function public.set_order_status(p_order uuid, p_status text, p_note text default '',
                                                   p_tracking_code text default '', p_carrier text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare o public.orders; v_salon_name text; v_body text; v_note text := trim(coalesce(p_note, ''));
        v_track text := trim(coalesce(p_tracking_code, '')); v_carrier text := trim(coalesce(p_carrier, ''));
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select * into o from public.orders where id = p_order and salon_id = public.current_salon_id() for update;
  if o.id is null then
    return json_build_object('ok', false, 'error', 'سفارش پیدا نشد');
  end if;
  if length(v_note) > 300 or length(v_track) > 40 or length(v_carrier) > 40 then
    return json_build_object('ok', false, 'error', 'توضیح طولانی است');
  end if;
  if o.status in ('delivered', 'cancelled') then
    return json_build_object('ok', false, 'error', 'این سفارش بسته شده است');
  end if;
  if o.status = 'awaiting_payment' and p_status <> 'cancelled' then
    return json_build_object('ok', false, 'error', 'این سفارش هنوز پرداخت نشده');
  end if;
  if p_status not in ('confirmed', 'ready', 'shipped', 'delivered', 'cancelled')
     or p_status = 'ready' and o.delivery <> 'pickup'
     or p_status = 'shipped' and o.delivery <> 'shipping' then
    return json_build_object('ok', false, 'error', 'وضعیت نامعتبر است');
  end if;
  if p_status = 'cancelled' and v_note = '' then
    return json_build_object('ok', false, 'error', 'دلیل لغو را بنویسید');
  end if;

  update public.orders
     set status = p_status, updated_at = now(),
         staff_note = case when p_status <> 'cancelled' and v_note <> '' then v_note else staff_note end,
         cancel_reason = case when p_status = 'cancelled' then v_note else cancel_reason end,
         refund_needed = refund_needed or (p_status = 'cancelled' and paid_at is not null),
         tracking_code = case when p_status = 'shipped' and v_track <> '' then v_track else tracking_code end,
         carrier = case when p_status = 'shipped' and v_carrier <> '' then v_carrier else carrier end
   where id = o.id;
  if p_status = 'cancelled' then
    perform public.release_order_stock(o.id);
  end if;

  select name into v_salon_name from public.salons where id = o.salon_id;
  v_body := case p_status
    when 'ready' then o.customer_name || ' عزیز، سفارش ' || o.code || ' آمادهٔ تحویل در ' || v_salon_name || ' است.'
                      || case when o.paid_at is null then E'\nمبلغ قابل پرداخت: ' || public.fa_money(o.total) || ' تومان' else '' end
    when 'shipped' then o.customer_name || ' عزیز، سفارش ' || o.code || ' از ' || v_salon_name || ' ارسال شد.'
                      || case when v_track <> '' then E'\nکد رهگیری' || case when v_carrier <> '' then ' (' || v_carrier || ')' else '' end || ': ' || v_track else '' end
    when 'cancelled' then o.customer_name || ' عزیز، سفارش ' || o.code || ' در ' || v_salon_name || ' لغو شد.'
                      || E'\nدلیل: ' || v_note
                      || case when o.paid_at is not null then E'\nمبلغ پرداختی به حسابتان برگردانده می‌شود.' else '' end
    else null end;
  if v_body is not null then
    if p_status <> 'cancelled' and v_note <> '' then
      v_body := v_body || E'\n' || v_note;
    end if;
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (o.salon_id, o.customer_phone, v_body, 'order', 'queued', now());
  end if;
  return json_build_object('ok', true, 'status', p_status);
end;
$fn$;
grant execute on function public.set_order_status(uuid, text, text, text, text) to authenticated;

create or replace function public.order_json(o public.orders)
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'delivery', o.delivery, 'address', o.address,
    'subtotal', o.subtotal, 'shipping_fee', o.shipping_fee, 'total', o.total, 'discount', o.coupon_discount,
    'payment_method', o.payment_method, 'paid', o.paid_at is not null, 'refund_needed', o.refund_needed,
    'cancel_reason', nullif(o.cancel_reason, ''), 'staff_note', nullif(o.staff_note, ''), 'created_at', o.created_at,
    'tracking_code', nullif(o.tracking_code, ''), 'carrier', nullif(o.carrier, ''),
    'items', coalesce((select json_agg(json_build_object('name', i.name, 'qty', i.qty, 'unit_price', i.unit_price) order by i.name)
                         from public.order_items i where i.order_id = o.id), '[]'::json));
$fn$;
revoke all on function public.order_json(public.orders) from public, anon, authenticated;

-- ----------------------------------------------------------- 10. supplies --
create table if not exists public.supplies (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 60),
  unit       text not null default 'عدد' check (length(unit) <= 15),
  qty        numeric(10, 2) not null default 0,
  low_at     numeric(10, 2) not null default 1 check (low_at >= 0),
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (salon_id, name)
);
alter table public.supplies enable row level security;
drop policy if exists p_supplies_mgr on public.supplies;
create policy p_supplies_mgr on public.supplies for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_supplies_staff_read on public.supplies;
create policy p_supplies_staff_read on public.supplies for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.supplies to authenticated;

create table if not exists public.supply_moves (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  supply_id  uuid not null references public.supplies (id) on delete cascade,
  delta      numeric(10, 2) not null,
  kind       text not null check (kind in ('purchase', 'use', 'adjust')),
  cost       bigint,
  note       text not null default '',
  by_user    uuid,
  created_at timestamptz not null default now()
);
create index if not exists supply_moves_supply_idx on public.supply_moves (supply_id, created_at desc);
alter table public.supply_moves enable row level security;
drop policy if exists p_supply_moves_staff on public.supply_moves;
create policy p_supply_moves_staff on public.supply_moves for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.supply_moves to authenticated;

-- purchase (manager; booked as an expense), use (any staff), adjust (manager)
create or replace function public.supply_move(p_supply uuid, p_kind text, p_qty numeric, p_cost bigint default null, p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare s public.supplies; v_delta numeric;
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_kind not in ('purchase', 'use', 'adjust') or (p_kind in ('purchase', 'adjust') and not public.is_manager()) then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  if p_qty is null or p_qty < 0 or p_qty > 100000 or (p_kind <> 'adjust' and p_qty = 0) then
    return json_build_object('ok', false, 'error', 'مقدار نامعتبر است');
  end if;
  select * into s from public.supplies where id = p_supply and salon_id = public.current_salon_id() for update;
  if s.id is null then return json_build_object('ok', false, 'error', 'قلم پیدا نشد'); end if;
  v_delta := case p_kind when 'purchase' then p_qty when 'use' then -p_qty else p_qty - s.qty end;
  if s.qty + v_delta < 0 then return json_build_object('ok', false, 'error', 'موجودی کافی نیست'); end if;
  update public.supplies set qty = qty + v_delta, updated_at = now() where id = s.id;
  insert into public.supply_moves (salon_id, supply_id, delta, kind, cost, note, by_user)
  values (s.salon_id, s.id, v_delta, p_kind, case when p_kind = 'purchase' then p_cost end, left(coalesce(p_note, ''), 200), auth.uid());
  if p_kind = 'purchase' and coalesce(p_cost, 0) > 0 then
    insert into public.expenses (id, salon_id, title, category, amount, date, note)
    values ('exp-' || substr(md5(gen_random_uuid()::text), 1, 12), s.salon_id, 'خرید ' || s.name, 'supplies', p_cost,
            public.salon_today(), public.fa_digits(trim(to_char(p_qty, 'FM999999990.##'))) || ' ' || s.unit);
  end if;
  return json_build_object('ok', true, 'qty', s.qty + v_delta, 'low', s.qty + v_delta <= s.low_at);
end;
$fn$;
grant execute on function public.supply_move(uuid, text, numeric, bigint, text) to authenticated;

-- ------------------------------------------------------------ 11. check-in --
alter table public.appointments add column if not exists checked_in_at timestamptz;

create or replace function public.check_in(p_code text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_code text := coalesce(p_code, '');
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  -- a QR may carry a link (…?code=MN-12345); keep the code itself
  if v_code ~* '[?&]code=' then v_code := substring(v_code from '(?i)[?&]code=([^&#]+)'); end if;
  v_code := upper(regexp_replace(translate(v_code, '۰۱۲۳۴۵۶۷۸۹', '0123456789'), '[^A-Za-z0-9-]', '', 'g'));
  select * into a from public.appointments
   where salon_id = public.current_salon_id() and upper(tracking_code) = v_code and date = public.salon_today()
     and status in ('pending', 'confirmed', 'rescheduled', 'awaiting_payment')
   order by start_min limit 1 for update;
  if a.id is null then
    return json_build_object('ok', false, 'error', 'نوبت امروز با این کد پیدا نشد');
  end if;
  update public.appointments
     set checked_in_at = coalesce(checked_in_at, now()),
         groom_stage = case when pet_name is not null and groom_stage is null then 'arrived' else groom_stage end,
         groom_stage_at = case when pet_name is not null and groom_stage is null then now() else groom_stage_at end
   where id = a.id;
  return json_build_object('ok', true, 'id', a.id, 'customer_name', a.customer_name, 'pet_name', a.pet_name,
                           'start_min', a.start_min, 'staff_id', a.staff_id, 'already', a.checked_in_at is not null);
end;
$fn$;
grant execute on function public.check_in(text) to authenticated;

-- ------------------------------------------------------------ 12. branches --
create table if not exists public.user_branches (
  user_id    uuid not null references public.users (id) on delete cascade,
  salon_id   uuid not null references public.salons (id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  primary key (user_id, salon_id)
);
alter table public.user_branches enable row level security;
drop policy if exists p_user_branches_self on public.user_branches;
create policy p_user_branches_self on public.user_branches for select using (user_id = auth.uid());
grant select on public.user_branches to authenticated;

-- Platform admin: give a salon's owner access to another salon as a branch.
create or replace function public.admin_link_branch(p_owner_phone text, p_branch_slug text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare u public.users; v_branch uuid;
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into u from public.users where phone = p_owner_phone and role in ('owner', 'manager');
  if u.id is null then return json_build_object('ok', false, 'error', 'مدیری با این شماره پیدا نشد'); end if;
  select id into v_branch from public.salons where slug = lower(trim(p_branch_slug));
  if v_branch is null then return json_build_object('ok', false, 'error', 'سالن پیدا نشد'); end if;
  insert into public.user_branches (user_id, salon_id, role) values (u.id, u.salon_id, u.role) on conflict do nothing;
  insert into public.user_branches (user_id, salon_id, role) values (u.id, v_branch, 'owner') on conflict do nothing;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.admin_link_branch(text, text) to authenticated;

create or replace function public.my_branches()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('salon_id', s.id, 'name', s.name, 'slug', s.slug,
                                             'current', s.id = (select salon_id from public.users where id = auth.uid()))
                           order by s.name), '[]'::json)
    from public.user_branches b join public.salons s on s.id = b.salon_id and s.active
   where b.user_id = auth.uid();
$fn$;
grant execute on function public.my_branches() to authenticated;

create or replace function public.switch_branch(p_salon uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare b public.user_branches;
begin
  select * into b from public.user_branches where user_id = auth.uid() and salon_id = p_salon;
  if b.user_id is null or not exists (select 1 from public.salons where id = p_salon and active) then
    return json_build_object('ok', false, 'error', 'این شعبه در دسترس شما نیست');
  end if;
  update public.users set salon_id = p_salon, role = b.role, stylist_id = null where id = auth.uid();
  return json_build_object('ok', true, 'slug', (select slug from public.salons where id = p_salon));
end;
$fn$;
grant execute on function public.switch_branch(uuid) to authenticated;

-- One line per branch: today's bookings, this month's completed revenue.
create or replace function public.branches_summary()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object(
           'salon_id', s.id, 'name', s.name,
           'today', (select count(*) from public.appointments a where a.salon_id = s.id and a.date = public.salon_today()
                       and a.status not in ('cancelled', 'no_show')),
           'month_revenue', coalesce((select sum(a.final_price) from public.appointments a where a.salon_id = s.id
                                        and a.status = 'completed' and a.date >= date_trunc('month', public.salon_today())::date), 0),
           'month_orders', coalesce((select sum(o.total) from public.orders o where o.salon_id = s.id
                                       and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')
                                       and o.created_at >= date_trunc('month', now())), 0))
         order by s.name), '[]'::json)
    from public.user_branches b join public.salons s on s.id = b.salon_id and s.active
   where b.user_id = auth.uid();
$fn$;
grant execute on function public.branches_summary() to authenticated;

-- ----------------------------------------------------- 13a. two-step login --
-- When a staff member has turned on a TOTP factor (Supabase Auth MFA), a
-- password-only session (aal1) no longer counts as staff anywhere.
create or replace function public.mfa_ok()
returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare n int;
begin
  if auth.uid() is null or to_regclass('auth.mfa_factors') is null then
    return true;
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then
    return true;
  end if;
  execute 'select count(*) from auth.mfa_factors where user_id = $1 and status = ''verified''' into n using auth.uid();
  return n = 0;
end;
$fn$;
grant execute on function public.mfa_ok() to anon, authenticated;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $fn$
  select role from public.users where id = auth.uid() and public.mfa_ok();
$fn$;

-- A signed-in caller with no staff row got NULL here, and `if not
-- public.is_manager()` (NOT NULL is not true) let them through. Signed-in
-- callers now always get true/false. Server-side jobs (no auth.uid())
-- keep the old behaviour that system maintenance relies on.
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $fn$
  select case when auth.uid() is null then public.my_role() in ('owner', 'manager')
              else coalesce(public.my_role() in ('owner', 'manager'), false) end;
$fn$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce((select active from public.users where id = auth.uid()), false) and public.mfa_ok();
$fn$;

-- --------------------------------------------------------- 13b. backups --
create table if not exists public.salon_backups (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  created_at timestamptz not null default now(),
  size_bytes int not null default 0,
  data       jsonb not null
);
create index if not exists salon_backups_salon_idx on public.salon_backups (salon_id, created_at desc);
alter table public.salon_backups enable row level security;
-- rows are read through my_backups()/get_backup() only (the data column is large)
revoke all on public.salon_backups from anon, authenticated;

create or replace function public.backup_salon(p_salon uuid)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare v_data jsonb := '{}'::jsonb; t text; v_rows jsonb; v_id uuid;
begin
  foreach t in array array['services', 'stylists', 'working_hours', 'customers', 'appointments', 'expenses', 'pets',
                           'products', 'orders', 'order_items', 'pet_packages', 'package_purchases', 'gift_cards',
                           'coupons', 'supplies', 'feedbacks', 'app_settings', 'shop_settings', 'salon_profiles'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x where x.salon_id = $1', t)
         into v_rows using p_salon;
      v_data := v_data || jsonb_build_object(t, v_rows);
    end if;
  end loop;
  v_data := v_data || jsonb_build_object('_meta', jsonb_build_object('salon_id', p_salon, 'created_at', now(), 'version', 'v2.51'));
  insert into public.salon_backups (salon_id, size_bytes, data) values (p_salon, octet_length(v_data::text), v_data)
  returning id into v_id;
  -- keep the newest 7
  delete from public.salon_backups where salon_id = p_salon and id not in (
    select id from public.salon_backups where salon_id = p_salon order by created_at desc limit 7);
  return v_id;
end;
$fn$;
revoke all on function public.backup_salon(uuid) from public, anon, authenticated;

create or replace function public.backup_all_salons()
returns int
language plpgsql security definer set search_path = public as $fn$
declare r record; n int := 0;
begin
  for r in select id from public.salons where active loop
    perform public.backup_salon(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$fn$;
revoke all on function public.backup_all_salons() from public, anon, authenticated;
grant execute on function public.backup_all_salons() to service_role;

create or replace function public.my_backups()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('id', id, 'created_at', created_at, 'size_bytes', size_bytes) order by created_at desc), '[]'::json)
    from public.salon_backups where salon_id = public.current_salon_id() and public.is_manager();
$fn$;
grant execute on function public.my_backups() to authenticated;

create or replace function public.backup_now()
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if exists (select 1 from public.salon_backups where salon_id = public.current_salon_id() and created_at > now() - interval '10 minutes') then
    return json_build_object('ok', false, 'error', 'نسخهٔ پشتیبان چند دقیقه پیش گرفته شده');
  end if;
  return json_build_object('ok', true, 'id', public.backup_salon(public.current_salon_id()));
end;
$fn$;
grant execute on function public.backup_now() to authenticated;

create or replace function public.get_backup(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $fn$
  select data from public.salon_backups where id = p_id and salon_id = public.current_salon_id() and public.is_manager();
$fn$;
grant execute on function public.get_backup(uuid) to authenticated;
