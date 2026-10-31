-- ============================================================================
-- Migration v2.50 — business tools (run after v2.49)
-- ============================================================================
--   1. Revenue beyond bookings: shop sales, packages and gift cards in one
--      report (top products, low stock) — revenue_extras().
--   2. Public salon profile: about, address, map, Instagram, gallery
--      (public bucket "salon-gallery"), hours, rating and reviews.
--   3. Discount codes (booking and/or shop) and gift cards (bought online
--      with the salon's Zarinpal, or sold at the desk; redeemed at checkout).
--   4. Staff commission: % of services, % of packages they sold.
--   6. Packages can be bought online.
--   7. Smart deposit: ask only customers with a recent no-show.
-- ============================================================================

-- ------------------------------------------------------------ 1. revenue --
alter table public.products add column if not exists low_stock_at int not null default 3;
alter table public.products drop constraint if exists products_low_stock_at_check;
alter table public.products add constraint products_low_stock_at_check check (low_stock_at between 0 and 1000);

-- ------------------------------------------------------- 6. packages online --
alter table public.package_purchases add column if not exists status text not null default 'active';
alter table public.package_purchases drop constraint if exists package_purchases_status_check;
alter table public.package_purchases add constraint package_purchases_status_check check (status in ('active', 'awaiting_payment', 'cancelled'));
alter table public.package_purchases add column if not exists sold_by text references public.stylists (id) on delete set null;
alter table public.package_purchases add column if not exists paid_online boolean not null default false;
alter table public.package_purchases add column if not exists payment_ref text;

-- ------------------------------------------------------- 3. coupons/gifts --
create table if not exists public.coupons (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  code          text not null check (code ~ '^[A-Z0-9آ-ی]{3,20}$'),
  percent       int check (percent is null or percent between 1 and 100),
  amount        bigint check (amount is null or amount between 1000 and 100000000),
  scope         text not null default 'both' check (scope in ('booking', 'shop', 'both')),
  min_total     bigint not null default 0 check (min_total >= 0),
  max_uses      int check (max_uses is null or max_uses between 1 and 100000),
  used_count    int not null default 0,
  valid_until   date,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check ((percent is null) <> (amount is null)),
  unique (salon_id, code)
);
alter table public.coupons enable row level security;
drop policy if exists p_coupons_mgr on public.coupons;
create policy p_coupons_mgr on public.coupons for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.coupons to authenticated;

create table if not exists public.coupon_uses (
  coupon_id  uuid not null references public.coupons (id) on delete cascade,
  salon_id   uuid not null references public.salons (id) on delete cascade,
  phone      text not null,
  ref        text not null,
  discount   bigint not null,
  created_at timestamptz not null default now(),
  primary key (coupon_id, phone)
);
alter table public.coupon_uses enable row level security;
drop policy if exists p_coupon_uses_mgr on public.coupon_uses;
create policy p_coupon_uses_mgr on public.coupon_uses for select
  using (public.is_manager() and salon_id = public.current_salon_id());
grant select on public.coupon_uses to authenticated;

alter table public.appointments add column if not exists coupon_code text;
alter table public.appointments add column if not exists coupon_discount bigint;
alter table public.appointments add column if not exists gift_card_amount bigint;
alter table public.orders add column if not exists coupon_code text;
alter table public.orders add column if not exists coupon_discount bigint not null default 0;

create table if not exists public.gift_cards (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  code             text not null,
  amount           bigint not null check (amount between 10000 and 100000000),
  balance          bigint not null check (balance >= 0),
  buyer_name       text not null default '',
  buyer_phone      text not null default '',
  recipient_name   text not null default '',
  recipient_phone  text not null check (recipient_phone ~ '^09[0-9]{9}$'),
  message          text not null default '' check (length(message) <= 200),
  status           text not null default 'active' check (status in ('awaiting_payment', 'active', 'cancelled')),
  sold_at_desk     boolean not null default false,
  payment_ref      text,
  expires_at       date not null,
  created_at       timestamptz not null default now(),
  unique (salon_id, code)
);
alter table public.gift_cards enable row level security;
drop policy if exists p_gift_cards_staff on public.gift_cards;
create policy p_gift_cards_staff on public.gift_cards for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.gift_cards to authenticated;

alter table public.payments add column if not exists gift_card_id uuid references public.gift_cards (id) on delete cascade;
alter table public.payments add column if not exists package_purchase_id uuid references public.package_purchases (id) on delete cascade;
alter table public.payments drop constraint if exists payments_target_check;
alter table public.payments add constraint payments_target_check check (
  (appointment_id is not null)::int + (order_id is not null)::int + (gift_card_id is not null)::int + (package_purchase_id is not null)::int = 1) not valid;

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote', 'order', 'order_staff',
  'pet_update', 'pet_report', 'pet_reminder', 'pet_package', 'gift_card', 'checkin')) not valid;

-- ---------------------------------------------------------- 4. commission --
alter table public.stylists add column if not exists commission_pct int not null default 0;
alter table public.stylists add column if not exists package_commission_pct int not null default 0;
alter table public.stylists drop constraint if exists stylists_commission_check;
alter table public.stylists add constraint stylists_commission_check check (commission_pct between 0 and 100 and package_commission_pct between 0 and 100);

-- --------------------------------------------------------- 7. smart deposit --
alter table public.app_settings add column if not exists deposit_mode text not null default 'all';
alter table public.app_settings drop constraint if exists app_settings_deposit_mode_check;
alter table public.app_settings add constraint app_settings_deposit_mode_check check (deposit_mode in ('all', 'risky'));

-- ---------------------------------------------------------- 2. profile --
create table if not exists public.salon_profiles (
  salon_id     uuid primary key default public.current_salon_id() references public.salons (id) on delete cascade,
  about        text not null default '' check (length(about) <= 1500),
  address      text not null default '' check (length(address) <= 300),
  phone        text not null default '' check (length(phone) <= 20),
  instagram    text not null default '' check (instagram ~ '^[A-Za-z0-9._]{0,30}$'),
  map_url      text not null default '' check (length(map_url) <= 500 and (map_url = '' or map_url ~ '^https://')),
  gallery      text[] not null default '{}' check (cardinality(gallery) <= 24),
  show_reviews boolean not null default true,
  updated_at   timestamptz not null default now()
);
alter table public.salon_profiles enable row level security;
drop policy if exists p_salon_profiles_mgr on public.salon_profiles;
create policy p_salon_profiles_mgr on public.salon_profiles for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update on public.salon_profiles to authenticated;

-- ============================================================================
-- Functions
-- ============================================================================

-- --------------------------------------------------------------- revenue --
create or replace function public.revenue_extras(p_from date, p_to date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  return json_build_object(
    'ok', true,
    'shop_revenue', coalesce((select sum(total) from public.orders o
                               where o.salon_id = v_salon and o.created_at::date between p_from and p_to
                                 and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')), 0),
    'shop_orders', (select count(*) from public.orders o
                     where o.salon_id = v_salon and o.created_at::date between p_from and p_to
                       and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')),
    'packages_revenue', coalesce((select sum(price_paid) from public.package_purchases p
                                   where p.salon_id = v_salon and p.status = 'active' and p.created_at::date between p_from and p_to), 0),
    'packages_count', (select count(*) from public.package_purchases p
                        where p.salon_id = v_salon and p.status = 'active' and p.created_at::date between p_from and p_to),
    'gift_cards_revenue', coalesce((select sum(amount) from public.gift_cards g
                                     where g.salon_id = v_salon and g.status = 'active' and g.created_at::date between p_from and p_to), 0),
    'gift_cards_outstanding', coalesce((select sum(balance) from public.gift_cards g
                                         where g.salon_id = v_salon and g.status = 'active' and g.expires_at >= public.salon_today()), 0),
    'top_products', coalesce((
      select json_agg(t order by t.revenue desc) from (
        select i.name, sum(i.qty)::int as qty, sum(i.qty * i.unit_price) as revenue
          from public.order_items i join public.orders o on o.id = i.order_id
         where o.salon_id = v_salon and o.created_at::date between p_from and p_to
           and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')
         group by i.name order by 3 desc limit 8) t), '[]'::json),
    'low_stock', coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name, 'stock', p.stock) order by p.stock)
        from public.products p
       where p.salon_id = v_salon and p.active and p.stock is not null and p.stock <= p.low_stock_at), '[]'::json));
end;
$fn$;
grant execute on function public.revenue_extras(date, date) to authenticated;

-- --------------------------------------------------------------- profile --
create or replace function public.get_salon_profile()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'name', s.name, 'slug', s.slug, 'business_type', s.business_type,
    'about', coalesce(p.about, ''), 'address', coalesce(p.address, ''), 'phone', coalesce(p.phone, ''),
    'instagram', coalesce(p.instagram, ''), 'map_url', coalesce(p.map_url, ''), 'gallery', coalesce(p.gallery, '{}'),
    'hours', coalesce((select json_agg(json_build_object('day', w.day_of_week, 'start', w.start_time, 'end', w.end_time, 'closed', w.is_closed)
                                       order by w.day_of_week)
                         from public.working_hours w where w.salon_id = s.id and w.staff_id is null), '[]'::json),
    'rating', (select json_build_object('avg', round(avg(f.rating)::numeric, 1), 'count', count(*))
                 from public.feedbacks f where f.salon_id = s.id),
    'reviews', case when coalesce(p.show_reviews, true) then coalesce((
       select json_agg(r) from (
         select f.rating, left(f.comment, 300) as comment, f.created_at::date as date,
                split_part(coalesce(nullif(trim(a.customer_name), ''), 'مشتری'), ' ', 1) as name
           from public.feedbacks f left join public.appointments a on a.id = f.booking_id
          where f.salon_id = s.id and f.rating >= 4 and length(trim(f.comment)) >= 5
          order by f.created_at desc limit 12) r), '[]'::json) else '[]'::json end,
    'shop', coalesce((select enabled from public.shop_settings where salon_id = s.id), false))
  from public.salons s
  left join public.salon_profiles p on p.salon_id = s.id
  where s.id = public.current_salon_id() and s.active;
$fn$;
grant execute on function public.get_salon_profile() to anon, authenticated;

create or replace function public.gallery_write_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.is_manager()
     and split_part(coalesce(p_name, ''), '/', 1) = public.current_salon_id()::text
     and split_part(p_name, '/', 3) = ''
     and split_part(p_name, '/', 2) ~ '^[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$';
$fn$;
revoke all on function public.gallery_write_ok(text) from public;
grant execute on function public.gallery_write_ok(text) to authenticated;

do $do$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage not found — the salon gallery is disabled on this database';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('salon-gallery', 'salon-gallery', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  execute 'drop policy if exists salon_gallery_insert on storage.objects';
  execute $p$create policy salon_gallery_insert on storage.objects for insert to authenticated
           with check (bucket_id = 'salon-gallery' and public.gallery_write_ok(name))$p$;
  execute 'drop policy if exists salon_gallery_delete on storage.objects';
  execute $p$create policy salon_gallery_delete on storage.objects for delete to authenticated
           using (bucket_id = 'salon-gallery' and public.gallery_write_ok(name))$p$;
end
$do$;

-- --------------------------------------------------------------- coupons --
-- What a code is worth on a given total (no side effects).
create or replace function public.coupon_value(p_salon uuid, p_code text, p_scope text, p_total bigint, p_phone text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare c public.coupons; v bigint;
begin
  select * into c from public.coupons
   where salon_id = p_salon and code = upper(trim(coalesce(p_code, ''))) and active;
  if c.id is null or (c.valid_until is not null and c.valid_until < public.salon_today()) then
    return json_build_object('ok', false, 'error', 'کد تخفیف معتبر نیست');
  end if;
  if c.scope <> 'both' and c.scope <> p_scope then
    return json_build_object('ok', false, 'error', case when p_scope = 'shop' then 'این کد برای فروشگاه نیست' else 'این کد برای نوبت نیست' end);
  end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then
    return json_build_object('ok', false, 'error', 'ظرفیت این کد تمام شده است');
  end if;
  if coalesce(p_total, 0) < c.min_total then
    return json_build_object('ok', false, 'error', 'این کد برای خرید بالای ' || public.fa_money(c.min_total) || ' تومان است');
  end if;
  if p_phone is not null and exists (select 1 from public.coupon_uses u where u.coupon_id = c.id and u.phone = p_phone) then
    return json_build_object('ok', false, 'error', 'این کد را قبلاً استفاده کرده‌اید');
  end if;
  v := case when c.percent is not null then round(p_total * c.percent / 100.0) else least(c.amount, p_total) end;
  return json_build_object('ok', true, 'id', c.id, 'code', c.code, 'discount', v, 'percent', c.percent, 'amount', c.amount);
end;
$fn$;
revoke all on function public.coupon_value(uuid, text, text, bigint, text) from public, anon, authenticated;

-- Preview for the booking page / checkout.
create or replace function public.check_coupon(p_code text, p_scope text, p_total bigint, p_phone text default null)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.check_rate_limit('coupon:' || coalesce(public.current_salon_id()::text, '') || ':' || coalesce(p_phone, ''), 20, 10) then
    return json_build_object('ok', false, 'error', 'تعداد تلاش زیاد است؛ کمی بعد دوباره امتحان کنید');
  end if;
  return public.coupon_value(public.current_salon_id(), p_code, p_scope, p_total, nullif(p_phone, ''));
end;
$fn$;
grant execute on function public.check_coupon(text, text, bigint, text) to anon, authenticated;

-- Records a use (call inside the transaction that applies it).
create or replace function public.consume_coupon(p_coupon uuid, p_phone text, p_ref text, p_discount bigint)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  update public.coupons set used_count = used_count + 1
   where id = p_coupon and (max_uses is null or used_count < max_uses);
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  insert into public.coupon_uses (coupon_id, salon_id, phone, ref, discount)
  select p_coupon, salon_id, p_phone, p_ref, p_discount from public.coupons where id = p_coupon
  on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end;
$fn$;
revoke all on function public.consume_coupon(uuid, text, text, bigint) from public, anon, authenticated;

-- A code on a fresh booking (same browser, within 30 minutes; as transport in v2.49).
create or replace function public.apply_booking_coupon(p_appt text, p_phone text, p_code text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v json; v_disc bigint;
begin
  select * into a from public.appointments
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone for update;
  if a.id is null or a.created_at < now() - interval '30 minutes' or a.coupon_code is not null
     or a.status in ('cancelled', 'no_show', 'completed') or a.final_price is null then
    return json_build_object('ok', false, 'error', 'کد تخفیف روی این نوبت قابل استفاده نیست');
  end if;
  v := public.coupon_value(a.salon_id, p_code, 'booking', a.final_price, p_phone);
  if not (v ->> 'ok')::boolean then return v; end if;
  v_disc := least((v ->> 'discount')::bigint, a.final_price);
  if not public.consume_coupon((v ->> 'id')::uuid, p_phone, a.id, v_disc) then
    return json_build_object('ok', false, 'error', 'این کد را قبلاً استفاده کرده‌اید');
  end if;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments
     set coupon_code = v ->> 'code', coupon_discount = v_disc, final_price = final_price - v_disc,
         deposit_amount = case when deposit_amount is not null then least(deposit_amount, greatest(1000, final_price - v_disc)) end
   where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'discount', v_disc, 'final_price', a.final_price - v_disc);
end;
$fn$;
grant execute on function public.apply_booking_coupon(text, text, text) to anon, authenticated;

-- place_order with an optional discount code (replaces the 8-argument version)
drop function if exists public.place_order(text, text, jsonb, text, text, text, text, text);
create or replace function public.place_order(
  p_customer_name text, p_customer_phone text, p_items jsonb,
  p_delivery text, p_payment text,
  p_address text default '', p_postal_code text default '', p_note text default '',
  p_coupon text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_shop json; v_id uuid; v_code text; v_subtotal bigint := 0; v_fee bigint := 0; v_total bigint;
  v_pids uuid[]; v_qtys int[]; r record; v_lines int := 0; v_cp json; v_disc bigint := 0;
begin
  if v_salon is null then
    return json_build_object('ok', false, 'error', 'سالن پیدا نشد');
  end if;
  v_shop := public.get_shop();
  if not (v_shop ->> 'enabled')::boolean then
    return json_build_object('ok', false, 'error', 'فروشگاه این سالن فعال نیست');
  end if;
  if coalesce(p_customer_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  p_customer_name := trim(coalesce(p_customer_name, ''));
  if p_customer_name = '' or length(p_customer_name) > 80 then
    return json_build_object('ok', false, 'error', 'نام لازم است');
  end if;
  if p_delivery = 'pickup' and not (v_shop ->> 'pickup')::boolean
     or p_delivery = 'shipping' and not (v_shop ->> 'shipping')::boolean
     or p_delivery is null or p_delivery not in ('pickup', 'shipping') then
    return json_build_object('ok', false, 'error', 'روش تحویل در دسترس نیست');
  end if;
  if p_payment = 'online' and not (v_shop ->> 'online')::boolean
     or p_payment = 'cash' and not (v_shop ->> 'cash')::boolean
     or p_payment is null or p_payment not in ('online', 'cash') then
    return json_build_object('ok', false, 'error', 'روش پرداخت در دسترس نیست');
  end if;
  p_address := trim(coalesce(p_address, ''));
  p_postal_code := translate(trim(coalesce(p_postal_code, '')), '۰۱۲۳۴۵۶۷۸۹', '0123456789');
  if p_delivery = 'shipping' and length(p_address) < 10 then
    return json_build_object('ok', false, 'error', 'آدرس کامل را وارد کنید');
  end if;
  if length(p_address) > 400 or length(coalesce(p_note, '')) > 400 or p_postal_code !~ '^([0-9]{10})?$' then
    return json_build_object('ok', false, 'error', 'آدرس، کد پستی یا توضیحات نامعتبر است');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    return json_build_object('ok', false, 'error', 'سبد خرید خالی است');
  end if;
  if not public.check_rate_limit('order:' || v_salon || ':' || p_customer_phone, 6, 60) then
    return json_build_object('ok', false, 'error', 'تعداد سفارش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید');
  end if;

  perform public.expire_unpaid_orders(v_salon);
  if (select count(*) from public.orders
       where salon_id = v_salon and customer_phone = p_customer_phone and status = 'awaiting_payment') >= 3 then
    return json_build_object('ok', false, 'error', 'چند سفارش پرداخت‌نشده دارید — اول آن‌ها را پرداخت یا لغو کنید');
  end if;

  begin
    select array_agg(pid order by pid), array_agg(qty order by pid) into v_pids, v_qtys
      from (select (e ->> 'product_id')::uuid as pid, sum((e ->> 'qty')::int)::int as qty
              from jsonb_array_elements(p_items) e group by 1) x;
  exception when others then
    return json_build_object('ok', false, 'error', 'سبد خرید نامعتبر است');
  end;
  if array_position(v_pids, null) is not null or exists (select 1 from unnest(v_qtys) q where q is null or q < 1) then
    return json_build_object('ok', false, 'error', 'سبد خرید نامعتبر است');
  end if;
  if exists (select 1 from unnest(v_qtys) q where q > 50) then
    return json_build_object('ok', false, 'error', 'حداکثر ۵۰ عدد از هر کالا');
  end if;

  for r in
    select p.id, p.name, p.price, p.stock, p.active, l.qty
      from unnest(v_pids, v_qtys) as l(pid, qty)
      join public.products p on p.id = l.pid and p.salon_id = v_salon
     order by p.id
       for update of p
  loop
    if not r.active then
      return json_build_object('ok', false, 'error', 'یکی از کالاها دیگر موجود نیست — سبد را به‌روز کنید', 'refresh', true);
    end if;
    if r.stock is not null and r.stock < r.qty then
      return json_build_object('ok', false,
        'error', case when r.stock = 0 then '«' || r.name || '» تمام شده است'
                      else 'از «' || r.name || '» فقط ' || public.fa_digits(r.stock::text) || ' عدد موجود است' end,
        'refresh', true);
    end if;
    v_subtotal := v_subtotal + r.price * r.qty;
    v_lines := v_lines + 1;
  end loop;
  if v_lines <> cardinality(v_pids) then
    return json_build_object('ok', false, 'error', 'یکی از کالاها دیگر موجود نیست — سبد را به‌روز کنید', 'refresh', true);
  end if;

  if nullif(trim(coalesce(p_coupon, '')), '') is not null then
    v_cp := public.coupon_value(v_salon, p_coupon, 'shop', v_subtotal, p_customer_phone);
    if not (v_cp ->> 'ok')::boolean then return v_cp; end if;
    v_disc := least((v_cp ->> 'discount')::bigint, v_subtotal);
  end if;

  if p_delivery = 'shipping' then
    v_fee := (v_shop ->> 'shipping_fee')::bigint;
    if (v_shop ->> 'free_shipping_over')::bigint > 0 and v_subtotal >= (v_shop ->> 'free_shipping_over')::bigint then
      v_fee := 0;
    end if;
  end if;
  v_total := v_subtotal - v_disc + v_fee;
  if p_payment = 'online' and v_total < 1000 then
    return json_build_object('ok', false, 'error', 'مبلغ برای پرداخت آنلاین خیلی کم است');
  end if;
  v_code := public.new_order_code(v_salon);

  insert into public.orders (salon_id, code, customer_name, customer_phone, delivery, address, postal_code, customer_note,
                             subtotal, shipping_fee, total, payment_method, status, coupon_code, coupon_discount)
  values (v_salon, v_code, p_customer_name, p_customer_phone, p_delivery,
          case when p_delivery = 'shipping' then p_address else '' end,
          case when p_delivery = 'shipping' then p_postal_code else '' end,
          trim(coalesce(p_note, '')), v_subtotal, v_fee, v_total, p_payment,
          case when p_payment = 'online' then 'awaiting_payment' else 'pending' end,
          v_cp ->> 'code', v_disc)
  returning id into v_id;

  if v_disc > 0 and not public.consume_coupon((v_cp ->> 'id')::uuid, p_customer_phone, v_id::text, v_disc) then
    raise exception 'coupon race' using errcode = 'P0001';
  end if;

  insert into public.order_items (order_id, salon_id, product_id, name, unit_price, qty)
  select v_id, v_salon, p.id, p.name, p.price, l.qty
    from unnest(v_pids, v_qtys) as l(pid, qty) join public.products p on p.id = l.pid;
  update public.products p set stock = p.stock - l.qty, updated_at = now()
    from unnest(v_pids, v_qtys) as l(pid, qty) where p.id = l.pid and p.stock is not null;

  if p_payment = 'cash' then
    perform public.notify_new_order(v_id);
  end if;
  return json_build_object('ok', true, 'id', v_id, 'code', v_code, 'subtotal', v_subtotal, 'discount', v_disc,
                           'shipping_fee', v_fee, 'total', v_total, 'status',
                           case when p_payment = 'online' then 'awaiting_payment' else 'pending' end);
end;
$fn$;
grant execute on function public.place_order(text, text, jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ------------------------------------------------------------ gift cards --
create or replace function public.new_gift_code(p_salon uuid)
returns text
language plpgsql volatile security definer set search_path = public as $fn$
declare v text; alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  loop
    v := 'G';
    for i in 1..8 loop
      v := v || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.gift_cards where salon_id = p_salon and code = v);
  end loop;
  return v;
end;
$fn$;
revoke all on function public.new_gift_code(uuid) from public, anon, authenticated;

create or replace function public.gift_card_activated(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare g public.gift_cards; v_salon_name text; v_link text;
begin
  select * into g from public.gift_cards where id = p_id;
  select name into v_salon_name from public.salons where id = g.salon_id;
  v_link := public.public_link('/' || (select slug from public.salons where id = g.salon_id));
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (g.salon_id, g.recipient_phone,
          coalesce(nullif(g.recipient_name, ''), 'دوست عزیز') || '، ' || coalesce(nullif(g.buyer_name, ''), 'یکی از دوستانتان')
            || ' برایتان کارت هدیهٔ ' || public.fa_money(g.amount) || ' تومانی ' || v_salon_name || ' فرستاده 🎁'
            || case when g.message <> '' then E'\n«' || g.message || '»' else '' end
            || E'\nکد: ' || g.code || ' — اعتبار تا ' || public.jalali_label(g.expires_at)
            || case when v_link is not null then E'\n' || v_link else '' end,
          'gift_card', 'queued', now());
  if g.buyer_phone ~ '^09[0-9]{9}$' and g.buyer_phone <> g.recipient_phone then
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (g.salon_id, g.buyer_phone, 'کارت هدیهٔ شما برای ' || coalesce(nullif(g.recipient_name, ''), g.recipient_phone)
              || ' ارسال شد. ' || v_salon_name, 'gift_card', 'queued', now());
  end if;
end;
$fn$;
revoke all on function public.gift_card_activated(uuid) from public, anon, authenticated;

-- Customer buys a gift card online (pays through the payment function).
create or replace function public.create_gift_card(
  p_amount bigint, p_buyer_name text, p_buyer_phone text, p_recipient_name text, p_recipient_phone text, p_message text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_id uuid;
begin
  if v_salon is null then return json_build_object('ok', false, 'error', 'سالن پیدا نشد'); end if;
  if coalesce((select zarinpal_merchant_id from public.salon_payment_settings where salon_id = v_salon), '') = '' then
    return json_build_object('ok', false, 'error', 'خرید آنلاین کارت هدیه در این سالن فعال نیست');
  end if;
  if coalesce(p_amount, 0) not between 50000 and 50000000 then
    return json_build_object('ok', false, 'error', 'مبلغ کارت هدیه بین ۵۰ هزار تا ۵۰ میلیون تومان است');
  end if;
  if coalesce(p_buyer_phone, '') !~ '^09[0-9]{9}$' or coalesce(p_recipient_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  if length(coalesce(p_message, '')) > 200 or length(coalesce(p_buyer_name, '')) > 80 or length(coalesce(p_recipient_name, '')) > 80 then
    return json_build_object('ok', false, 'error', 'متن طولانی است');
  end if;
  if not public.check_rate_limit('gift:' || v_salon || ':' || p_buyer_phone, 5, 60) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست‌ها زیاد است');
  end if;
  insert into public.gift_cards (salon_id, code, amount, balance, buyer_name, buyer_phone, recipient_name, recipient_phone, message, status, expires_at)
  values (v_salon, public.new_gift_code(v_salon), p_amount, p_amount, trim(coalesce(p_buyer_name, '')), p_buyer_phone,
          trim(coalesce(p_recipient_name, '')), p_recipient_phone, trim(coalesce(p_message, '')), 'awaiting_payment',
          public.salon_today() + 365)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', p_amount);
end;
$fn$;
grant execute on function public.create_gift_card(bigint, text, text, text, text, text) to anon, authenticated;

-- Staff sell one at the desk (paid in cash/card there).
create or replace function public.issue_gift_card(p_amount bigint, p_recipient_phone text, p_recipient_name text default '', p_buyer_name text default '', p_message text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_id uuid; v_code text;
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if coalesce(p_amount, 0) not between 10000 and 100000000 then
    return json_build_object('ok', false, 'error', 'مبلغ نامعتبر است');
  end if;
  if coalesce(p_recipient_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  v_code := public.new_gift_code(v_salon);
  insert into public.gift_cards (salon_id, code, amount, balance, buyer_name, recipient_name, recipient_phone, message, status, sold_at_desk, expires_at)
  values (v_salon, v_code, p_amount, p_amount, left(trim(coalesce(p_buyer_name, '')), 80), left(trim(coalesce(p_recipient_name, '')), 80),
          p_recipient_phone, left(trim(coalesce(p_message, '')), 200), 'active', true, public.salon_today() + 365)
  returning id into v_id;
  perform public.gift_card_activated(v_id);
  return json_build_object('ok', true, 'id', v_id, 'code', v_code);
end;
$fn$;
grant execute on function public.issue_gift_card(bigint, text, text, text, text) to authenticated;

create or replace function public.confirm_gift_card_payment(p_id uuid, p_ref text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare g public.gift_cards;
begin
  select * into g from public.gift_cards where id = p_id for update;
  if g.id is null then return 'missing'; end if;
  if g.status = 'active' then return 'already'; end if;
  update public.gift_cards set status = 'active', payment_ref = p_ref where id = g.id;
  perform public.gift_card_activated(g.id);
  return 'confirmed';
end;
$fn$;
revoke all on function public.confirm_gift_card_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_gift_card_payment(uuid, text) to service_role;

-- Balance check (anyone holding the code).
create or replace function public.gift_card_balance(p_code text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare g public.gift_cards;
begin
  if not public.check_rate_limit('giftbal:' || coalesce(public.current_salon_id()::text, ''), 60, 10) then
    return json_build_object('ok', false, 'error', 'تعداد تلاش زیاد است');
  end if;
  select * into g from public.gift_cards
   where salon_id = public.current_salon_id() and code = upper(trim(coalesce(p_code, ''))) and status = 'active';
  if g.id is null then return json_build_object('ok', false, 'error', 'کارت هدیه پیدا نشد'); end if;
  return json_build_object('ok', true, 'balance', g.balance, 'expires_at', g.expires_at, 'expired', g.expires_at < public.salon_today());
end;
$fn$;
grant execute on function public.gift_card_balance(text) to anon, authenticated;

-- Staff pay (part of) a visit with a gift card.
create or replace function public.redeem_gift_card(p_code text, p_appt text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare g public.gift_cards; a public.appointments; v_amt bigint;
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into a from public.appointments where id = p_appt and salon_id = public.current_salon_id() for update;
  if a.id is null or not (public.is_manager() or a.staff_id = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  if a.gift_card_amount is not null then return json_build_object('ok', false, 'error', 'برای این نوبت قبلاً کارت هدیه استفاده شده'); end if;
  if coalesce(a.final_price, 0) <= 0 then return json_build_object('ok', false, 'error', 'مبلغی برای پرداخت نیست'); end if;
  select * into g from public.gift_cards
   where salon_id = a.salon_id and code = upper(trim(coalesce(p_code, ''))) and status = 'active' for update;
  if g.id is null or g.expires_at < public.salon_today() or g.balance <= 0 then
    return json_build_object('ok', false, 'error', 'کارت هدیه معتبر نیست یا اعتبارش تمام شده');
  end if;
  v_amt := least(g.balance, a.final_price);
  update public.gift_cards set balance = balance - v_amt where id = g.id;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments set gift_card_amount = v_amt, final_price = final_price - v_amt where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'used', v_amt, 'balance', g.balance - v_amt, 'final_price', a.final_price - v_amt);
end;
$fn$;
grant execute on function public.redeem_gift_card(text, text) to authenticated;

-- ----------------------------------------------------- packages online --
create or replace function public.buy_package_online(p_package uuid, p_phone text, p_name text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare k public.pet_packages; v_id uuid; v_salon uuid := public.current_salon_id();
begin
  if coalesce((select zarinpal_merchant_id from public.salon_payment_settings where salon_id = v_salon), '') = '' then
    return json_build_object('ok', false, 'error', 'خرید آنلاین بسته فعال نیست — در سالن بخرید');
  end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  select * into k from public.pet_packages where id = p_package and salon_id = v_salon and active;
  if k.id is null then return json_build_object('ok', false, 'error', 'بسته پیدا نشد'); end if;
  if not public.check_rate_limit('pkg:' || v_salon || ':' || p_phone, 5, 60) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست‌ها زیاد است');
  end if;
  insert into public.package_purchases (salon_id, package_id, package_name, service_id, customer_phone, customer_name,
                                        sessions_total, sessions_left, price_paid, expires_at, status, paid_online)
  values (v_salon, k.id, k.name, k.service_id, p_phone, left(trim(coalesce(p_name, '')), 80), k.sessions, k.sessions, k.price,
          public.salon_today() + k.valid_days, 'awaiting_payment', true)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'price', k.price);
end;
$fn$;
grant execute on function public.buy_package_online(uuid, text, text) to anon, authenticated;

create or replace function public.confirm_package_payment(p_id uuid, p_ref text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare p public.package_purchases; v_salon_name text; v_k public.pet_packages;
begin
  select * into p from public.package_purchases where id = p_id for update;
  if p.id is null then return 'missing'; end if;
  if p.status = 'active' then return 'already'; end if;
  select * into v_k from public.pet_packages where id = p.package_id;
  update public.package_purchases
     set status = 'active', payment_ref = p_ref,
         expires_at = public.salon_today() + coalesce(v_k.valid_days, (p.expires_at - p.created_at::date))
   where id = p.id;
  select name into v_salon_name from public.salons where id = p.salon_id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (p.salon_id, p.customer_phone,
          'بستهٔ «' || p.package_name || '» (' || public.fa_digits(p.sessions_total::text) || ' جلسه) در ' || v_salon_name || ' فعال شد.',
          'pet_package', 'queued', now());
  return 'confirmed';
end;
$fn$;
revoke all on function public.confirm_package_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_package_payment(uuid, text) to service_role;

-- sold_by for desk sales + only active purchases count
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
                                        sessions_total, sessions_left, price_paid, expires_at, sold_by)
  values (k.salon_id, k.id, k.name, k.service_id, p_phone, left(trim(coalesce(p_name, '')), 80), k.sessions, k.sessions, k.price, v_exp,
          public.my_stylist_id())
  returning id into v_id;
  select name into v_salon_name from public.salons where id = k.salon_id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (k.salon_id, p_phone,
          'بستهٔ «' || k.name || '» (' || public.fa_digits(k.sessions::text) || ' جلسه) در ' || v_salon_name || ' برای شما فعال شد.'
            || E'\nاعتبار تا ' || public.jalali_label(v_exp),
          'pet_package', 'queued', now());
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
grant execute on function public.sell_package(uuid, text, text) to authenticated;

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
  if pu.id is null or pu.status <> 'active' or pu.customer_phone <> a.customer_phone or pu.service_id <> a.service_id then
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
     where p.salon_id = v_salon and p.customer_phone = v_phone and p.status = 'active'
       and p.expires_at >= public.salon_today() - 30), '[]'::json);
end;
$fn$;
grant execute on function public.my_packages_with_token(text) to anon, authenticated;

-- unpaid online purchases (gift cards, packages) are dropped after a day
create or replace function public.expire_unpaid_purchases()
returns int
language plpgsql security definer set search_path = public as $fn$
declare n1 int; n2 int;
begin
  update public.gift_cards set status = 'cancelled' where status = 'awaiting_payment' and created_at < now() - interval '1 day';
  get diagnostics n1 = row_count;
  update public.package_purchases set status = 'cancelled' where status = 'awaiting_payment' and created_at < now() - interval '1 day';
  get diagnostics n2 = row_count;
  return n1 + n2;
end;
$fn$;
revoke all on function public.expire_unpaid_purchases() from public, anon, authenticated;
grant execute on function public.expire_unpaid_purchases() to service_role;

-- ------------------------------------------------------------ commission --
create or replace function public.commission_report(p_from date, p_to date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_me text := public.my_stylist_id();
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(x order by x.total_commission desc) from (
      select s.id, s.name, s.commission_pct, s.package_commission_pct,
             coalesce(a.cnt, 0) as services_count,
             coalesce(a.revenue, 0) as services_revenue,
             round(coalesce(a.revenue, 0) * s.commission_pct / 100.0)::bigint as services_commission,
             coalesce(k.cnt, 0) as packages_count,
             coalesce(k.revenue, 0) as packages_revenue,
             round(coalesce(k.revenue, 0) * s.package_commission_pct / 100.0)::bigint as packages_commission,
             round(coalesce(a.revenue, 0) * s.commission_pct / 100.0)::bigint
               + round(coalesce(k.revenue, 0) * s.package_commission_pct / 100.0)::bigint as total_commission
        from public.stylists s
        left join lateral (
          select count(*) as cnt,
                 -- the service itself: pick-up fees are not the groomer's work
                 sum(coalesce(ap.final_price, 0) - coalesce(ap.transport_fee, 0)) as revenue
            from public.appointments ap
           where ap.salon_id = v_salon and ap.staff_id = s.id and ap.status = 'completed'
             and ap.date between p_from and p_to) a on true
        left join lateral (
          select count(*) as cnt, sum(pp.price_paid) as revenue
            from public.package_purchases pp
           where pp.salon_id = v_salon and pp.sold_by = s.id and pp.status = 'active'
             and pp.created_at::date between p_from and p_to) k on true
       where s.salon_id = v_salon and (public.is_manager() or s.id = v_me)) x), '[]'::json));
end;
$fn$;
grant execute on function public.commission_report(date, date) to authenticated;

-- --------------------------------------------------------- smart deposit --
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

drop function if exists public.deposit_terms();
create or replace function public.deposit_terms()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'enabled', coalesce(s.deposit_percent, 0) > 0 and coalesce(p.zarinpal_merchant_id, '') <> '',
    'percent', coalesce(s.deposit_percent, 0),
    'min_price', coalesce(s.deposit_min_price, 0),
    'mode', coalesce(s.deposit_mode, 'all'),
    'online', coalesce(p.zarinpal_merchant_id, '') <> ''
  )
  from (select public.current_salon_id() as salon_id) c
  left join public.app_settings s on s.salon_id = c.salon_id
  left join public.salon_payment_settings p on p.salon_id = c.salon_id;
$fn$;
grant execute on function public.deposit_terms() to anon, authenticated;
