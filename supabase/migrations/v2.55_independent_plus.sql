-- =============================================================================
--  v2.55 — independent stylists, part 2
--
--  1. Product sales per stylist: orders get a seller (by default the stylist
--     who last served that client in the past 60 days; the manager can
--     change it). Contracts get product_commission_pct, credited to the
--     stylist in the month's statement.
--  2. Own prices: when the contract allows it, a stylist sets their own price
--     per service; the booking page shows it and apply_stylist_price() puts
--     it on the fresh booking.
--  3. Private clients: clients who only ever came to an independent stylist
--     with private_clients on are left out of the salon's marketing SMS
--     (campaigns, freed-slot offers).
--  Idempotent; safe to run again.
-- =============================================================================

alter table public.stylist_contracts add column if not exists product_commission_pct numeric(5, 2) not null default 0;
alter table public.stylist_contracts drop constraint if exists stylist_contracts_product_pct_check;
alter table public.stylist_contracts add constraint stylist_contracts_product_pct_check check (product_commission_pct between 0 and 100);
alter table public.stylist_contracts add column if not exists own_prices boolean not null default false;
alter table public.stylist_contracts add column if not exists private_clients boolean not null default false;

-- ------------------------------------------------------ 1. product sales ----
alter table public.orders add column if not exists sold_by text references public.stylists (id) on delete set null;
create index if not exists orders_sold_by_idx on public.orders (salon_id, sold_by, created_at);

create or replace function public.default_order_seller()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.sold_by is null then
    select a.staff_id into new.sold_by
      from public.appointments a
     where a.salon_id = new.salon_id and a.customer_phone = new.customer_phone and a.status = 'completed'
       and a.staff_id is not null and a.date >= public.salon_today() - 60
     order by a.date desc, a.start_min desc limit 1;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_default_order_seller on public.orders;
create trigger trg_default_order_seller before insert on public.orders
  for each row execute function public.default_order_seller();

create or replace function public.set_order_seller(p_order uuid, p_stylist text)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_stylist is not null and not exists (select 1 from public.stylists where id = p_stylist and salon_id = public.current_salon_id()) then
    return json_build_object('ok', false, 'error', 'آرایشگر پیدا نشد');
  end if;
  update public.orders set sold_by = p_stylist where id = p_order and salon_id = public.current_salon_id();
  return json_build_object('ok', found);
end;
$fn$;
grant execute on function public.set_order_seller(uuid, text) to authenticated;

-- The statement, now with product sales and the stylist's commission on them
-- (the salon always holds shop money, so the commission is the stylist's credit).
create or replace function public.stylist_statement(p_stylist text, p_month date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  c public.stylist_contracts; t record; v_name text;
  v_share bigint; v_rent bigint; v_held bigint; v_charges bigint; v_credits bigint; v_to_salon bigint; v_to_stylist bigint; v_balance bigint;
  v_products bigint; v_product_comm bigint;
begin
  if not public.is_staff() or not (public.is_manager() or p_stylist = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select name into v_name from public.stylists where id = p_stylist and salon_id = v_salon;
  if v_name is null then return json_build_object('ok', false, 'error', 'آرایشگر پیدا نشد'); end if;
  c := public.contract_on(p_stylist, v_to);
  if c.id is null or c.kind = 'employee' then
    return json_build_object('ok', true, 'stylist_id', p_stylist, 'name', v_name, 'month', v_from, 'kind', coalesce(c.kind, 'employee'));
  end if;
  select * into t from public.stylist_takings(v_salon, p_stylist, v_from, v_to);
  v_share := round(t.gross * c.service_share_pct / 100.0);
  v_rent := case when c.kind in ('rent', 'hybrid') then c.rent_amount else 0 end;
  v_held := case when c.collector = 'salon' then t.gross else t.online + t.gift + t.pkg end;
  select coalesce(sum(o.subtotal - o.coupon_discount), 0) into v_products
    from public.orders o
   where o.salon_id = v_salon and o.sold_by = p_stylist
     and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')
     and (o.created_at at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::date between v_from and v_to;
  v_product_comm := round(v_products * c.product_commission_pct / 100.0);
  select coalesce(sum(amount) filter (where kind = 'charge'), 0), coalesce(sum(amount) filter (where kind = 'credit'), 0),
         coalesce(sum(amount) filter (where kind = 'paid_to_salon'), 0), coalesce(sum(amount) filter (where kind = 'paid_to_stylist'), 0)
    into v_charges, v_credits, v_to_salon, v_to_stylist
    from public.stylist_ledger where salon_id = v_salon and stylist_id = p_stylist and month = v_from;
  v_balance := v_held - v_share - v_rent - v_charges + v_credits + v_product_comm - v_to_stylist + v_to_salon;
  return json_build_object('ok', true, 'stylist_id', p_stylist, 'name', v_name, 'month', v_from,
    'kind', c.kind, 'collector', c.collector, 'service_share_pct', c.service_share_pct, 'rent_amount', c.rent_amount,
    'product_commission_pct', c.product_commission_pct,
    'visits', t.visits, 'gross', t.gross, 'online', t.online, 'gift', t.gift, 'pkg', t.pkg,
    'held_by_salon', v_held, 'held_by_stylist', t.gross - v_held,
    'salon_share', v_share, 'rent', v_rent, 'charges', v_charges, 'credits', v_credits,
    'product_sales', v_products, 'product_commission', v_product_comm,
    'paid_to_salon', v_to_salon, 'paid_to_stylist', v_to_stylist,
    'stylist_net', t.gross - v_share - v_rent - v_charges + v_credits + v_product_comm,
    'balance', v_balance,
    'ledger', coalesce((select json_agg(json_build_object('id', id, 'kind', kind, 'amount', amount, 'label', label, 'created_at', created_at) order by created_at)
                          from public.stylist_ledger where salon_id = v_salon and stylist_id = p_stylist and month = v_from), '[]'::json));
end;
$fn$;
grant execute on function public.stylist_statement(text, date) to authenticated;

-- --------------------------------------------------------- 2. own prices ----
create table if not exists public.stylist_prices (
  salon_id    uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  stylist_id  text not null references public.stylists (id) on delete cascade,
  service_id  text not null references public.services (id) on delete cascade,
  price       bigint not null check (price between 1000 and 10000000000),
  updated_at  timestamptz not null default now(),
  primary key (stylist_id, service_id)
);
alter table public.stylist_prices enable row level security;
-- yes/no only: may this stylist set their own prices today? (no contract details leak)
create or replace function public.stylist_own_prices(p_stylist text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce((public.contract_on(p_stylist, public.salon_today())).own_prices, false);
$fn$;
grant execute on function public.stylist_own_prices(text) to authenticated;
revoke all on function public.contract_on(text, date) from public, anon, authenticated;

-- managers always; a stylist only for themself and only when the contract allows it
drop policy if exists p_stylist_prices_rw on public.stylist_prices;
create policy p_stylist_prices_rw on public.stylist_prices for all
  using (salon_id = public.current_salon_id() and public.is_staff()
         and (public.is_manager() or (stylist_id = public.my_stylist_id() and public.stylist_own_prices(stylist_id))))
  with check (salon_id = public.current_salon_id() and public.is_staff()
         and exists (select 1 from public.services v where v.id = service_id and v.salon_id = public.current_salon_id())
         and (public.is_manager() or (stylist_id = public.my_stylist_id() and public.stylist_own_prices(stylist_id))));
grant select, insert, update, delete on public.stylist_prices to authenticated;

create or replace function public.get_stylist_prices()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('stylist_id', p.stylist_id, 'service_id', p.service_id, 'price', p.price)), '[]'::json)
    from public.stylist_prices p
   where p.salon_id = public.current_salon_id()
     and coalesce((public.contract_on(p.stylist_id, public.salon_today())).own_prices, false);
$fn$;
grant execute on function public.get_stylist_prices() to anon, authenticated;

-- Right after a booking (like the discount code): the stylist's own price.
create or replace function public.apply_stylist_price(p_appt text, p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_price bigint;
begin
  select * into a from public.appointments
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone for update;
  if a.id is null or a.created_at < now() - interval '30 minutes' or a.final_price is null or a.staff_id is null
     or a.status in ('cancelled', 'no_show', 'completed') or a.coupon_code is not null or a.offpeak_discount is not null then
    return json_build_object('ok', false);
  end if;
  select p.price into v_price from public.stylist_prices p
   where p.stylist_id = a.staff_id and p.service_id = a.service_id
     and coalesce((public.contract_on(p.stylist_id, public.salon_today())).own_prices, false);
  if v_price is null or v_price = coalesce(a.original_price, a.final_price) then return json_build_object('ok', false); end if;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments
     set final_price = greatest(0, final_price + (v_price - coalesce(original_price, final_price))),
         original_price = v_price,
         deposit_amount = case when deposit_amount is not null
                               then least(deposit_amount, greatest(1000, final_price + (v_price - coalesce(original_price, final_price)))) end
   where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'price', v_price,
    'final_price', greatest(0, a.final_price + (v_price - coalesce(a.original_price, a.final_price))));
end;
$fn$;
grant execute on function public.apply_stylist_price(text, text) to anon, authenticated;

-- ---------------------------------------------------- 3. private clients ----
create or replace function public.is_private_client(p_salon uuid, p_phone text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
           select 1 from public.appointments a
            where a.salon_id = p_salon and a.customer_phone = p_phone and a.status = 'completed'
              and coalesce((public.contract_on(a.staff_id, public.salon_today())).private_clients, false))
     and not exists (
           select 1 from public.appointments a
            where a.salon_id = p_salon and a.customer_phone = p_phone and a.status = 'completed'
              and not coalesce((public.contract_on(a.staff_id, public.salon_today())).private_clients, false));
$fn$;
revoke all on function public.is_private_client(uuid, text) from public, anon, authenticated;
grant execute on function public.is_private_client(uuid, text) to service_role;

create or replace function public.skip_private_marketing()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.kind in ('campaign', 'slot_offer') and public.is_private_client(new.salon_id, new.to_phone) then
    return null; -- an independent stylist's own client: no salon marketing
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_skip_private_marketing on public.sms_messages;
create trigger trg_skip_private_marketing before insert on public.sms_messages
  for each row execute function public.skip_private_marketing();

-- For the panel's campaign sender (it sends through the SMS Edge Function).
create or replace function public.private_client_phones()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(distinct a.customer_phone), '[]'::json)
    from public.appointments a
   where public.is_manager() and a.salon_id = public.current_salon_id() and a.status = 'completed'
     and public.is_private_client(a.salon_id, a.customer_phone);
$fn$;
grant execute on function public.private_client_phones() to authenticated;
