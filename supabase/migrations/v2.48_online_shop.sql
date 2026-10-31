-- ============================================================================
-- Migration v2.48 — online shop (run after v2.47)
-- ============================================================================
--  Every salon (beauty or pet) can switch on a small shop next to booking:
--   - shop_settings: on/off, pickup at the salon, shipping (fee, free above,
--     area note), and whether pay-at-delivery is allowed. Online payment uses
--     the salon's own Zarinpal merchant (v2.37); without one the shop falls
--     back to paying at pickup / delivery.
--   - products (+ public Storage bucket "shop-photos" for their pictures,
--     path <salon_id>/<file>, only that salon's managers can write).
--   - orders + order_items. Prices, shipping and stock are computed here,
--     never trusted from the browser. Stock is reserved when the order is
--     placed; an online order unpaid after 20 minutes is cancelled and its
--     stock released (expire_unpaid_orders, cron every 5 minutes).
--   - SMS to the customer and the salon's managers (kinds order /
--     order_staff); the customer follows orders from the dashboard.
-- ============================================================================

-- ---------------------------------------------------------------- settings --
create table if not exists public.shop_settings (
  salon_id           uuid primary key references public.salons (id) on delete cascade default public.current_salon_id(),
  enabled            boolean not null default false,
  pickup_enabled     boolean not null default true,
  pickup_address     text    not null default '' check (length(pickup_address) <= 300),
  shipping_enabled   boolean not null default false,
  shipping_fee       bigint  not null default 0 check (shipping_fee between 0 and 100000000),
  free_shipping_over bigint  not null default 0 check (free_shipping_over between 0 and 10000000000),
  shipping_area      text    not null default '' check (length(shipping_area) <= 200),
  cash_enabled       boolean not null default false,
  note               text    not null default '' check (length(note) <= 300),
  updated_at         timestamptz not null default now()
);
alter table public.shop_settings enable row level security;
drop policy if exists p_shop_settings_mgr on public.shop_settings;
create policy p_shop_settings_mgr on public.shop_settings for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update on public.shop_settings to authenticated;

-- ---------------------------------------------------------------- products --
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salons (id) on delete cascade default public.current_salon_id(),
  name        text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 600),
  category    text not null default '' check (length(category) <= 30),
  price       bigint not null check (price between 1000 and 10000000000),
  stock       int check (stock is null or stock between 0 and 100000),   -- null = not tracked
  active      boolean not null default true,
  photo_path  text check (photo_path is null or length(photo_path) <= 200),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_salon_idx on public.products (salon_id, active, sort_order);
alter table public.products enable row level security;
drop policy if exists p_products_mgr on public.products;
create policy p_products_mgr on public.products for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_products_staff_read on public.products;
create policy p_products_staff_read on public.products for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.products to authenticated;

-- ------------------------------------------------------------------ orders --
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  code            text not null,
  customer_name   text not null,
  customer_phone  text not null,
  delivery        text not null check (delivery in ('pickup', 'shipping')),
  address         text not null default '',
  postal_code     text not null default '',
  customer_note   text not null default '',
  subtotal        bigint not null,
  shipping_fee    bigint not null default 0,
  total           bigint not null,
  payment_method  text not null check (payment_method in ('online', 'cash')),
  status          text not null default 'pending'
                  check (status in ('awaiting_payment', 'pending', 'confirmed', 'ready', 'shipped', 'delivered', 'cancelled')),
  paid_at         timestamptz,
  payment_ref     text,
  refund_needed   boolean not null default false,
  staff_note      text not null default '',
  cancel_reason   text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (salon_id, code)
);
create index if not exists orders_salon_idx on public.orders (salon_id, created_at desc);
create index if not exists orders_phone_idx on public.orders (salon_id, customer_phone);
create index if not exists orders_unpaid_idx on public.orders (created_at) where status = 'awaiting_payment';
alter table public.orders enable row level security;
drop policy if exists p_orders_staff_read on public.orders;
create policy p_orders_staff_read on public.orders for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.orders to authenticated;

create table if not exists public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id) on delete cascade,
  salon_id    uuid not null references public.salons (id) on delete cascade,
  product_id  uuid references public.products (id) on delete set null,
  name        text not null,
  unit_price  bigint not null,
  qty         int not null check (qty between 1 and 50)
);
create index if not exists order_items_order_idx on public.order_items (order_id);
alter table public.order_items enable row level security;
drop policy if exists p_order_items_staff_read on public.order_items;
create policy p_order_items_staff_read on public.order_items for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.order_items to authenticated;

-- payments now pay for either a booking deposit or a shop order
alter table public.payments add column if not exists order_id uuid references public.orders (id) on delete cascade;
alter table public.payments alter column appointment_id drop not null;
alter table public.payments drop constraint if exists payments_target_check;
alter table public.payments add constraint payments_target_check
  check ((appointment_id is null) <> (order_id is null)) not valid;
create index if not exists payments_order_idx on public.payments (order_id) where order_id is not null;

-- SMS kinds
alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote', 'order', 'order_staff')) not valid;

-- ------------------------------------------------------------- the store ----
-- Everything the storefront needs, in one call. The merchant ID stays private.
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
               'price', p.price, 'stock', p.stock, 'photo_path', p.photo_path)
             order by p.sort_order, p.created_at)
        from public.products p where p.salon_id = c.salon_id and p.active), '[]'::json) else '[]'::json end
  )
  from (select public.current_salon_id() as salon_id) c
  left join public.shop_settings ss on ss.salon_id = c.salon_id
  left join public.salon_payment_settings pp on pp.salon_id = c.salon_id
  where c.salon_id is not null;
$fn$;
grant execute on function public.get_shop() to anon, authenticated;

-- Short human-friendly order number, unique per salon.
create or replace function public.new_order_code(p_salon uuid)
returns text
language plpgsql volatile security definer set search_path = public as $fn$
declare v text;
begin
  loop
    v := (100000 + floor(random() * 900000))::int::text;
    exit when not exists (select 1 from public.orders where salon_id = p_salon and code = v);
  end loop;
  return v;
end;
$fn$;
revoke all on function public.new_order_code(uuid) from public, anon, authenticated;

create or replace function public.order_delivery_label(o public.orders)
returns text
language sql immutable as $fn$
  select case when o.delivery = 'shipping' then 'ارسال به آدرس' else 'تحویل در سالن' end;
$fn$;

-- Text messages for a placed order (cash right away, online after payment).
create or replace function public.notify_new_order(p_order uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare o public.orders; v_salon_name text; v_items text; v_count int; v_phone text;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null then return; end if;
  select name into v_salon_name from public.salons where id = o.salon_id;
  select string_agg(i.name || case when i.qty > 1 then ' ×' || i.qty else '' end, '، ' order by i.name), sum(i.qty)
    into v_items, v_count from public.order_items i where i.order_id = o.id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (o.salon_id, o.customer_phone,
          o.customer_name || ' عزیز، سفارش ' || o.code || ' در ' || v_salon_name || ' ثبت شد'
            || case when o.paid_at is not null then ' و پرداخت شد' else '' end || E'.\n'
            || 'مبلغ: ' || public.fa_money(o.total) || ' تومان — ' || public.order_delivery_label(o)
            || case when o.paid_at is null then ' (پرداخت هنگام تحویل)' else '' end
            || E'\nخبر آماده‌شدن یا ارسال را پیامک می‌کنیم.',
          'order', 'queued', now());
  for v_phone in
    select distinct u.phone from public.users u
     where u.salon_id = o.salon_id and u.role in ('owner', 'manager') and u.active is not false and u.phone ~ '^09[0-9]{9}$'
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (o.salon_id, v_phone,
            'سفارش جدید ' || o.code || ': ' || left(v_items, 120) || E'\n'
              || public.fa_money(o.total) || ' تومان، ' || case when o.paid_at is not null then 'پرداخت‌شده' else 'پرداخت هنگام تحویل' end
              || '، ' || public.order_delivery_label(o) || E'\n'
              || o.customer_name || ' ' || o.customer_phone || E'\nپنل ← فروشگاه',
            'order_staff', 'queued', now());
  end loop;
end;
$fn$;
revoke all on function public.notify_new_order(uuid) from public, anon, authenticated;

-- Give reserved stock back (cancel / expiry).
create or replace function public.release_order_stock(p_order uuid)
returns void
language sql security definer set search_path = public as $fn$
  update public.products p set stock = p.stock + x.qty, updated_at = now()
    from (select product_id, sum(qty)::int as qty from public.order_items where order_id = p_order and product_id is not null group by product_id) x
   where p.id = x.product_id and p.stock is not null;
$fn$;
revoke all on function public.release_order_stock(uuid) from public, anon, authenticated;

-- Reserve stock for an order's items again; false (nothing changed) if any is short.
create or replace function public.reserve_order_stock(p_order uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  for r in
    select x.product_id, x.qty, p.stock
      from (select product_id, sum(qty)::int as qty from public.order_items where order_id = p_order and product_id is not null group by product_id) x
      join public.products p on p.id = x.product_id
     order by x.product_id
       for update of p
  loop
    if r.stock is not null and r.stock < r.qty then
      return false;
    end if;
  end loop;
  update public.products p set stock = p.stock - x.qty, updated_at = now()
    from (select product_id, sum(qty)::int as qty from public.order_items where order_id = p_order and product_id is not null group by product_id) x
   where p.id = x.product_id and p.stock is not null;
  return true;
end;
$fn$;
revoke all on function public.reserve_order_stock(uuid) from public, anon, authenticated;

-- Online orders not paid within 20 minutes (must match the payment function).
create or replace function public.expire_unpaid_orders(p_salon uuid default null)
returns int
language plpgsql security definer set search_path = public as $fn$
declare r record; v_n int := 0;
begin
  for r in
    select id from public.orders
     where status = 'awaiting_payment' and created_at < now() - interval '20 minutes'
       and (p_salon is null or salon_id = p_salon)
     order by created_at
     limit 500
       for update skip locked
  loop
    update public.orders set status = 'cancelled', cancel_reason = 'expired', updated_at = now() where id = r.id;
    perform public.release_order_stock(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;
revoke all on function public.expire_unpaid_orders(uuid) from public, anon, authenticated;
grant execute on function public.expire_unpaid_orders(uuid) to service_role;

-- ------------------------------------------------------------ place order ---
-- p_items: [{"product_id": "...", "qty": 2}, ...]
create or replace function public.place_order(
  p_customer_name text, p_customer_phone text, p_items jsonb,
  p_delivery text, p_payment text,
  p_address text default '', p_postal_code text default '', p_note text default ''
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_shop json; v_id uuid; v_code text; v_subtotal bigint := 0; v_fee bigint := 0; v_total bigint;
  v_pids uuid[]; v_qtys int[]; r record; v_lines int := 0;
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

  -- validate lines (merge duplicates) before touching anything
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

  -- lock the products, check availability and stock, price server-side
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
                      else 'از «' || r.name || '» فقط ' || r.stock || ' عدد موجود است' end,
        'refresh', true);
    end if;
    v_subtotal := v_subtotal + r.price * r.qty;
    v_lines := v_lines + 1;
  end loop;
  if v_lines <> cardinality(v_pids) then
    return json_build_object('ok', false, 'error', 'یکی از کالاها دیگر موجود نیست — سبد را به‌روز کنید', 'refresh', true);
  end if;

  if p_delivery = 'shipping' then
    v_fee := (v_shop ->> 'shipping_fee')::bigint;
    if (v_shop ->> 'free_shipping_over')::bigint > 0 and v_subtotal >= (v_shop ->> 'free_shipping_over')::bigint then
      v_fee := 0;
    end if;
  end if;
  v_total := v_subtotal + v_fee;
  v_code := public.new_order_code(v_salon);

  insert into public.orders (salon_id, code, customer_name, customer_phone, delivery, address, postal_code, customer_note,
                             subtotal, shipping_fee, total, payment_method, status)
  values (v_salon, v_code, p_customer_name, p_customer_phone, p_delivery,
          case when p_delivery = 'shipping' then p_address else '' end,
          case when p_delivery = 'shipping' then p_postal_code else '' end,
          trim(coalesce(p_note, '')), v_subtotal, v_fee, v_total, p_payment,
          case when p_payment = 'online' then 'awaiting_payment' else 'pending' end)
  returning id into v_id;

  insert into public.order_items (order_id, salon_id, product_id, name, unit_price, qty)
  select v_id, v_salon, p.id, p.name, p.price, l.qty
    from unnest(v_pids, v_qtys) as l(pid, qty) join public.products p on p.id = l.pid;
  update public.products p set stock = p.stock - l.qty, updated_at = now()
    from unnest(v_pids, v_qtys) as l(pid, qty) where p.id = l.pid and p.stock is not null;

  if p_payment = 'cash' then
    perform public.notify_new_order(v_id);
  end if;
  return json_build_object('ok', true, 'id', v_id, 'code', v_code, 'subtotal', v_subtotal,
                           'shipping_fee', v_fee, 'total', v_total, 'status',
                           case when p_payment = 'online' then 'awaiting_payment' else 'pending' end);
end;
$fn$;
grant execute on function public.place_order(text, text, jsonb, text, text, text, text, text) to anon, authenticated;

-- Called by the payment Edge Function (service role) after Zarinpal verify.
-- → 'confirmed' | 'already' | 'refund' (paid, but the order expired and the
--   stock is gone — the salon refunds)
create or replace function public.confirm_order_payment(p_order uuid, p_ref text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then return 'refund'; end if;
  if o.paid_at is not null then return 'already'; end if;
  if o.status = 'cancelled' then
    if o.cancel_reason <> 'expired' or not public.reserve_order_stock(o.id) then
      update public.orders set paid_at = now(), payment_ref = p_ref, refund_needed = true, updated_at = now() where id = o.id;
      return 'refund';
    end if;
  elsif o.status <> 'awaiting_payment' then
    update public.orders set paid_at = now(), payment_ref = p_ref, updated_at = now() where id = o.id;
    return 'already';
  end if;
  update public.orders set status = 'pending', cancel_reason = '', paid_at = now(), payment_ref = p_ref, updated_at = now()
   where id = o.id;
  perform public.notify_new_order(o.id);
  return 'confirmed';
end;
$fn$;
revoke all on function public.confirm_order_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_order_payment(uuid, text) to service_role;

-- ------------------------------------------------------------ staff side ----
create or replace function public.set_order_status(p_order uuid, p_status text, p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare o public.orders; v_salon_name text; v_body text; v_note text := trim(coalesce(p_note, ''));
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select * into o from public.orders where id = p_order and salon_id = public.current_salon_id() for update;
  if o.id is null then
    return json_build_object('ok', false, 'error', 'سفارش پیدا نشد');
  end if;
  if length(v_note) > 300 then
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
         refund_needed = refund_needed or (p_status = 'cancelled' and paid_at is not null)
   where id = o.id;
  if p_status = 'cancelled' then
    perform public.release_order_stock(o.id);
  end if;

  select name into v_salon_name from public.salons where id = o.salon_id;
  v_body := case p_status
    when 'ready' then o.customer_name || ' عزیز، سفارش ' || o.code || ' آمادهٔ تحویل در ' || v_salon_name || ' است.'
                      || case when o.paid_at is null then E'\nمبلغ قابل پرداخت: ' || public.fa_money(o.total) || ' تومان' else '' end
    when 'shipped' then o.customer_name || ' عزیز، سفارش ' || o.code || ' از ' || v_salon_name || ' ارسال شد.'
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
grant execute on function public.set_order_status(uuid, text, text) to authenticated;

-- The salon refunded a paid, cancelled order from its Zarinpal panel.
create or replace function public.mark_order_refunded(p_order uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  update public.orders set refund_needed = false, staff_note = trim(staff_note || ' (مبلغ بازگردانده شد)'), updated_at = now()
   where id = p_order and salon_id = public.current_salon_id() and refund_needed;
  return json_build_object('ok', found);
end;
$fn$;
grant execute on function public.mark_order_refunded(uuid) to authenticated;

-- --------------------------------------------------------- customer side ----
create or replace function public.order_json(o public.orders)
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'delivery', o.delivery, 'address', o.address,
    'subtotal', o.subtotal, 'shipping_fee', o.shipping_fee, 'total', o.total,
    'payment_method', o.payment_method, 'paid', o.paid_at is not null, 'refund_needed', o.refund_needed,
    'cancel_reason', nullif(o.cancel_reason, ''), 'staff_note', nullif(o.staff_note, ''), 'created_at', o.created_at,
    'items', coalesce((select json_agg(json_build_object('name', i.name, 'qty', i.qty, 'unit_price', i.unit_price) order by i.name)
                         from public.order_items i where i.order_id = o.id), '[]'::json));
$fn$;
revoke all on function public.order_json(public.orders) from public, anon, authenticated;

create or replace function public.my_orders_with_token(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return '[]'::json;
  end if;
  return coalesce((
    select json_agg(public.order_json(o) order by o.created_at desc)
      from public.orders o
     where o.salon_id = v_salon and o.customer_phone = v_phone and o.created_at > now() - interval '120 days'
       and not (o.status = 'cancelled' and o.cancel_reason = 'expired' and o.paid_at is null)), '[]'::json);
end;
$fn$;
grant execute on function public.my_orders_with_token(text) to anon, authenticated;

create or replace function public.cancel_my_order(p_token text, p_order uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_salon uuid; o public.orders; v_phone_mgr text;
begin
  select r.phone, r.salon_id into v_phone, v_salon from public.resolve_booking_token(p_token) r;
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  select * into o from public.orders where id = p_order and salon_id = v_salon and customer_phone = v_phone for update;
  if o.id is null or o.status not in ('awaiting_payment', 'pending') or o.paid_at is not null then
    return json_build_object('ok', false, 'error', 'این سفارش دیگر قابل لغو نیست — با سالن تماس بگیرید');
  end if;
  update public.orders set status = 'cancelled', cancel_reason = 'لغو توسط مشتری', updated_at = now() where id = o.id;
  perform public.release_order_stock(o.id);
  if o.status = 'pending' then
    for v_phone_mgr in
      select distinct u.phone from public.users u
       where u.salon_id = o.salon_id and u.role in ('owner', 'manager') and u.active is not false and u.phone ~ '^09[0-9]{9}$'
    loop
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (o.salon_id, v_phone_mgr, 'سفارش ' || o.code || ' را مشتری (' || o.customer_name || ') لغو کرد.', 'order_staff', 'queued', now());
    end loop;
  end if;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.cancel_my_order(text, uuid) to anon, authenticated;

-- ------------------------------------------------------- product photos -----
create or replace function public.shop_photo_write_ok(p_name text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.is_manager()
     and split_part(coalesce(p_name, ''), '/', 1) = public.current_salon_id()::text
     and split_part(p_name, '/', 3) = ''
     and split_part(p_name, '/', 2) ~ '^[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$';
$fn$;
revoke all on function public.shop_photo_write_ok(text) from public;
grant execute on function public.shop_photo_write_ok(text) to authenticated;

do $do$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage not found — product photos are disabled on this database';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('shop-photos', 'shop-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists shop_photos_insert on storage.objects';
  execute $p$create policy shop_photos_insert on storage.objects for insert to authenticated
           with check (bucket_id = 'shop-photos' and public.shop_photo_write_ok(name))$p$;
  execute 'drop policy if exists shop_photos_delete on storage.objects';
  execute $p$create policy shop_photos_delete on storage.objects for delete to authenticated
           using (bucket_id = 'shop-photos' and public.shop_photo_write_ok(name))$p$;
end
$do$;
