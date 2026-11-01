-- =============================================================================
--  v2.52 — the men's / women's salon suite
--
--  1. Shop for beauty salons: products for men / women / everyone, and a
--     purchase cost per product (managers only) so the shop's gross profit
--     reaches accounting.
--  2. shop_analytics(): the shop's numbers for BI and accounting (revenue,
--     gross profit, average order, top products, categories, daily series,
--     and how many service customers also buy products).
--  3. Client record (the beauty-salon twin of the pet health record):
--     allergies, hair / skin type, colour formula, patch test date, notes.
--  4. Visit report (before / after photos + note + recommended products)
--     for any booking, not only pets — the SMS and page text follow the
--     salon type.
--  Idempotent; safe to run again.
-- =============================================================================

-- ------------------------------------------------------------- 1. shop ------
alter table public.products add column if not exists audience text not null default 'all';
alter table public.products drop constraint if exists products_audience_check;
alter table public.products add constraint products_audience_check check (audience in ('all', 'men', 'women'));

-- Purchase cost lives apart from products: staff (and get_shop) read products,
-- only managers see what the salon paid.
create table if not exists public.product_costs (
  product_id  uuid primary key references public.products (id) on delete cascade,
  salon_id    uuid not null references public.salons (id) on delete cascade default public.current_salon_id(),
  cost_price  bigint not null check (cost_price between 0 and 10000000000),
  updated_at  timestamptz not null default now()
);
alter table public.product_costs enable row level security;
drop policy if exists p_product_costs_mgr on public.product_costs;
create policy p_product_costs_mgr on public.product_costs for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id()
              and exists (select 1 from public.products p where p.id = product_id and p.salon_id = public.current_salon_id()));
grant select, insert, update, delete on public.product_costs to authenticated;

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
               'variant_group', p.variant_group, 'variant_label', p.variant_label, 'audience', p.audience)
             order by p.sort_order, p.created_at)
        from public.products p where p.salon_id = c.salon_id and p.active), '[]'::json) else '[]'::json end
  )
  from (select public.current_salon_id() as salon_id) c
  left join public.shop_settings ss on ss.salon_id = c.salon_id
  left join public.salon_payment_settings pp on pp.salon_id = c.salon_id
  where c.salon_id is not null;
$fn$;
grant execute on function public.get_shop() to anon, authenticated;

-- --------------------------------------------------- 2. shop analytics -----
create or replace function public.shop_analytics(p_from date, p_to date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    return json_build_object('ok', false, 'error', 'بازهٔ نامعتبر');
  end if;
  return (
    with o as (
      select * from public.orders
       where salon_id = v_salon and status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')
         and (created_at at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::date between p_from and p_to
    ), li as (
      select i.*, p.category, pc.cost_price
        from public.order_items i join o on o.id = i.order_id
        left join public.products p on p.id = i.product_id
        left join public.product_costs pc on pc.product_id = i.product_id
    ), visits as (
      select distinct customer_phone as phone from public.appointments
       where salon_id = v_salon and status = 'completed' and date between p_from and p_to
    ), buyers as (
      select distinct customer_phone as phone from o
    )
    select json_build_object(
      'ok', true,
      'orders', (select count(*) from o),
      'revenue', coalesce((select sum(subtotal - coupon_discount) from o), 0),
      'shipping', coalesce((select sum(shipping_fee) from o), 0),
      'discount', coalesce((select sum(coupon_discount) from o), 0),
      'items', coalesce((select sum(qty) from li), 0),
      'buyers', (select count(*) from buyers),
      'cogs', coalesce((select sum(qty * cost_price) from li where cost_price is not null), 0),
      'revenue_with_cost', coalesce((select sum(qty * unit_price) from li where cost_price is not null), 0),
      'items_revenue', coalesce((select sum(qty * unit_price) from li), 0),
      'visit_customers', (select count(*) from visits),
      'buyers_with_visit', (select count(*) from buyers b join visits v on v.phone = b.phone),
      'top_products', coalesce((
        select json_agg(t order by t.revenue desc) from (
          select name, sum(qty)::int as qty, sum(qty * unit_price) as revenue,
                 case when bool_and(cost_price is not null) then sum(qty * (unit_price - cost_price)) end as profit
            from li group by name order by 3 desc limit 8) t), '[]'::json),
      'by_category', coalesce((
        select json_agg(t order by t.revenue desc) from (
          select coalesce(nullif(category, ''), 'other') as category, sum(qty * unit_price) as revenue
            from li group by 1) t), '[]'::json),
      'daily', coalesce((
        select json_agg(t order by t.date) from (
          select (created_at at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::date as date, sum(subtotal - coupon_discount) as revenue
            from o group by 1) t), '[]'::json)
    )
  );
end;
$fn$;
grant execute on function public.shop_analytics(date, date) to authenticated;

-- ------------------------------------------------------ 3. client record ----
create table if not exists public.client_records (
  salon_id       uuid not null references public.salons (id) on delete cascade default public.current_salon_id(),
  phone          text not null check (phone ~ '^09[0-9]{9}$'),
  allergies      text not null default '' check (length(allergies) <= 300),
  hair_type      text not null default '' check (length(hair_type) <= 60),
  skin_type      text not null default '' check (length(skin_type) <= 60),
  color_formula  text not null default '' check (length(color_formula) <= 400),
  patch_test_at  date,
  notes          text not null default '' check (length(notes) <= 600),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  primary key (salon_id, phone)
);
alter table public.client_records enable row level security;
-- managers: every client; a stylist: clients who have booked with them
drop policy if exists p_client_records_staff on public.client_records;
create policy p_client_records_staff on public.client_records for all
  using (salon_id = public.current_salon_id() and public.is_staff()
         and (public.is_manager() or exists (select 1 from public.appointments a
                where a.salon_id = client_records.salon_id and a.customer_phone = client_records.phone
                  and a.staff_id = public.my_stylist_id())))
  with check (salon_id = public.current_salon_id() and public.is_staff()
         and (public.is_manager() or exists (select 1 from public.appointments a
                where a.salon_id = client_records.salon_id and a.customer_phone = client_records.phone
                  and a.staff_id = public.my_stylist_id())));
grant select, insert, update on public.client_records to authenticated;

create or replace function public.touch_client_record() returns trigger
language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$fn$;
drop trigger if exists trg_client_records_touch on public.client_records;
create trigger trg_client_records_touch before insert or update on public.client_records
  for each row execute function public.touch_client_record();

-- ------------------------------------------------------ 4. visit report -----
-- Same as v2.49, but the SMS names the client's visit when there is no pet.
create or replace function public.save_visit_report(
  p_appt text, p_checks jsonb, p_note text default '', p_photos text[] default '{}',
  p_product_ids uuid[] default '{}', p_send boolean default false
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_checks jsonb := '{}'::jsonb; k text; v_token text; v_link text; v_salon_name text;
        v_photos text[]; v_products uuid[]; v_already timestamptz; v_title text;
begin
  if not public.is_staff() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select * into a from public.appointments where id = p_appt and salon_id = public.current_salon_id();
  if a.id is null or not (public.is_manager() or a.staff_id = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'نوبت پیدا نشد');
  end if;
  if a.pet_name is not null then
    foreach k in array array['fleas', 'ticks', 'skin', 'ears', 'eyes', 'teeth', 'matting', 'nails'] loop
      if coalesce(p_checks ->> k, '') = 'true' then v_checks := v_checks || jsonb_build_object(k, true); end if;
    end loop;
    if coalesce(p_checks ->> 'behavior', '') in ('calm', 'nervous', 'aggressive') then
      v_checks := v_checks || jsonb_build_object('behavior', p_checks ->> 'behavior');
    end if;
  end if;
  if length(coalesce(p_note, '')) > 600 then
    return json_build_object('ok', false, 'error', 'یادداشت طولانی است');
  end if;
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

  if a.pet_id is not null and v_checks ? 'behavior' then
    update public.pets set temperament = v_checks ->> 'behavior', updated_at = now() where id = a.pet_id;
  end if;

  if p_send and a.customer_phone ~ '^09[0-9]{9}$' then
    v_token := encode(gen_random_bytes(18), 'hex');
    update public.pet_visit_reports set token_hash = encode(digest(v_token, 'sha256'), 'hex'), sent_at = now()
     where appointment_id = a.id;
    v_link := public.public_link('/visit?token=' || v_token);
    select name into v_salon_name from public.salons where id = a.salon_id;
    v_title := case when a.pet_name is not null
                    then 'گزارش آرایش ' || coalesce(nullif(a.pet_name, ''), 'حیوان شما')
                    else coalesce(nullif(split_part(trim(a.customer_name), ' ', 1), '') || ' عزیز، گزارش', 'گزارش') || ' نوبت شما' end;
    if v_link is not null then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (a.salon_id, a.customer_phone,
              v_title || ' در ' || v_salon_name
                || case when cardinality(v_photos) > 0 then ' (با عکس قبل و بعد)' else '' end
                || case when cardinality(v_products) > 0 then ' و محصولات پیشنهادی' else '' end || E':\n' || v_link,
              'pet_report', 'queued', now());
    end if;
    return json_build_object('ok', true, 'sent', v_link is not null, 'link', v_link, 'resent', v_already is not null);
  end if;
  return json_build_object('ok', true, 'sent', false);
end;
$fn$;
grant execute on function public.save_visit_report(text, jsonb, text, text[], uuid[], boolean) to authenticated;

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
    'business_type', (select business_type from public.salons where id = r.salon_id),
    'pet_name', a.pet_name, 'customer_first_name', nullif(split_part(trim(a.customer_name), ' ', 1), ''),
    'date', a.date, 'services_label', a.services_label, 'staff_name', a.staff_name,
    'checks', r.checks, 'note', nullif(r.note, ''), 'photos', r.photos,
    'vet_partner', case when v_found then nullif((select pet_vet_partner from public.app_settings where salon_id = r.salon_id), '') end,
    'products', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'price', p.price, 'photo_path', p.photo_path))
                            from public.products p
                            join public.shop_settings ss on ss.salon_id = p.salon_id and ss.enabled
                           where p.id = any (r.product_ids) and p.active), '[]'::json));
end;
$fn$;
grant execute on function public.get_visit_report(text) to anon, authenticated;
