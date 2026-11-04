-- v2.66: pay the subscription (or an SMS pack, or an upgrade) by card-to-card
-- transfer, approved by the platform owner — until an online gateway is licensed.
--
--   1. The platform owner enters a card number / holder / Sheba in /admin and
--      turns «کارت‌به‌کارت» on (plus a mobile number for notices).
--   2. The salon manager picks a tier, sees the exact amount and the card,
--      transfers, and submits the bank's tracking number and the last 4
--      digits of their own card.
--   3. The platform owner gets an SMS, checks the account and approves or
--      rejects in /admin. Approving does exactly what an online payment does
--      (extend, tier, seats, SMS). The salon manager gets an SMS either way.
--   4. While a submitted payment waits (48 hours at most), the salon is not locked.
-- Online payment keeps working alongside once a merchant id is set.
-- Safe to run more than once.

-- ------------------------------------------------------------ 1. schema ----
alter table public.platform_settings add column if not exists card_enabled boolean not null default false;
alter table public.platform_settings add column if not exists card_number text not null default '';
alter table public.platform_settings add column if not exists card_holder text not null default '';
alter table public.platform_settings add column if not exists card_sheba text not null default '';
alter table public.platform_settings add column if not exists owner_mobile text not null default '';
alter table public.platform_settings drop constraint if exists platform_settings_card_check;
alter table public.platform_settings add constraint platform_settings_card_check check (
  (card_number = '' or card_number ~ '^[0-9]{16}$')
  and length(card_holder) <= 60
  and (card_sheba = '' or card_sheba ~ '^IR[0-9]{24}$')
  and (owner_mobile = '' or owner_mobile ~ '^09[0-9]{9}$')
  and (not card_enabled or (card_number <> '' and card_holder <> '')));

alter table public.plan_invoices add column if not exists method text not null default 'online';
alter table public.plan_invoices add column if not exists card_ref text not null default '';
alter table public.plan_invoices add column if not exists card_last4 text not null default '';
alter table public.plan_invoices add column if not exists submitted_at timestamptz;
alter table public.plan_invoices add column if not exists review_note text not null default '';
alter table public.plan_invoices drop constraint if exists plan_invoices_method_check;
alter table public.plan_invoices add constraint plan_invoices_method_check check (method in ('online', 'card'));
alter table public.plan_invoices drop constraint if exists plan_invoices_status_check;
alter table public.plan_invoices add constraint plan_invoices_status_check
  check (status in ('awaiting_payment', 'submitted', 'paid', 'rejected', 'cancelled'));
create index if not exists plan_invoices_salon_status_idx on public.plan_invoices (salon_id, status);

-- --------------------------------------------- 2. one price for both ways ---
-- What an invoice of this kind costs and grants, with the same checks the
-- online path has always made. Nothing is written here.
create or replace function public.plan_invoice_draft(p_salon uuid, p_kind text, p_plan text, p_months int, p_seats int, p_count int)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_amount bigint; v_seats int; v_max int; v_n int; q json; ps public.platform_settings;
begin
  if p_kind = 'plan' then
    v_seats := public.plan_seats_for(p_plan, p_seats, p_salon);
    v_amount := public.plan_price(p_plan, p_months, v_seats);
    if v_amount is null then return json_build_object('ok', false, 'error', 'پلن نامعتبر است'); end if;
    if v_amount < 1000 then return json_build_object('ok', false, 'error', 'این پلن رایگان است'); end if;
    select max_stylists into v_max from public.platform_plans where id = p_plan;
    v_n := public.active_stylist_count(p_salon);
    if coalesce(v_seats, v_max) is not null and v_n > coalesce(v_seats, v_max) then
      return json_build_object('ok', false, 'error',
        'این اشتراک برای ' || public.fa_digits(coalesce(v_seats, v_max)::text) || ' آرایشگر است و سالن ' || public.fa_digits(v_n::text)
        || ' آرایشگر فعال دارد — سطح بالاتری انتخاب کنید یا آرایشگرهای اضافه را غیرفعال کنید');
    end if;
    return json_build_object('ok', true, 'kind', 'plan', 'plan', p_plan, 'months', p_months, 'amount', v_amount,
                             'seats', v_seats, 'sms', public.plan_sms(p_plan, p_months));
  elsif p_kind = 'upgrade' then
    if not exists (select 1 from public.platform_plans where id = p_plan and active) then
      return json_build_object('ok', false, 'error', 'پلن نامعتبر است');
    end if;
    q := public.upgrade_quote(p_salon, p_plan, p_seats);
    if not (q ->> 'ok')::boolean then return q; end if;
    return json_build_object('ok', true, 'kind', 'upgrade', 'plan', p_plan, 'months', 0, 'amount', (q ->> 'amount')::bigint,
                             'seats', (q ->> 'seats')::int, 'sms', (q ->> 'sms')::int);
  elsif p_kind = 'sms' then
    select * into ps from public.platform_settings;
    if not (p_count = any (ps.sms_packs)) then return json_build_object('ok', false, 'error', 'بستهٔ پیامک نامعتبر است'); end if;
    v_amount := p_count::bigint * ps.sms_price;
    if v_amount < 1000 then return json_build_object('ok', false, 'error', 'قیمت پیامک تعیین نشده است'); end if;
    return json_build_object('ok', true, 'kind', 'sms', 'plan', null, 'months', 0, 'amount', v_amount, 'seats', null, 'sms', p_count);
  end if;
  return json_build_object('ok', false, 'error', 'نوع پرداخت نامعتبر است');
end;
$fn$;
revoke all on function public.plan_invoice_draft(uuid, text, text, int, int, int) from public, anon, authenticated;

create or replace function public.new_plan_invoice(p_kind text, p_plan text, p_months int, p_seats int, p_count int, p_method text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); d json; v_id uuid; ps public.platform_settings;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into ps from public.platform_settings;
  if p_method = 'online' and coalesce(ps.zarinpal_merchant_id, '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین اشتراک فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  if p_method = 'card' and not coalesce(ps.card_enabled, false) then
    return json_build_object('ok', false, 'error', 'پرداخت کارت‌به‌کارت فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  if p_method = 'card' and (select count(*) from public.plan_invoices where salon_id = v_salon and method = 'card'
                              and status in ('awaiting_payment', 'submitted')) >= 5 then
    return json_build_object('ok', false, 'error', 'چند پرداخت باز دارید — اول همان‌ها را کامل کنید یا منتظر تایید بمانید');
  end if;
  d := public.plan_invoice_draft(v_salon, p_kind, p_plan, p_months, p_seats, p_count);
  if not (d ->> 'ok')::boolean then return d; end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount, kind, seats, sms_count, method)
  values (v_salon, d ->> 'plan', (d ->> 'months')::int, (d ->> 'amount')::bigint, p_kind, (d ->> 'seats')::int, (d ->> 'sms')::int, p_method)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', (d ->> 'amount')::bigint);
end;
$fn$;
revoke all on function public.new_plan_invoice(text, text, int, int, int, text) from public, anon, authenticated;

-- the online entry points (unchanged for the app and the payment function)
create or replace function public.create_plan_invoice(p_plan text, p_months int, p_seats int)
returns json language plpgsql security definer set search_path = public as $fn$
begin return public.new_plan_invoice('plan', p_plan, p_months, p_seats, null, 'online'); end;
$fn$;
create or replace function public.create_upgrade_invoice(p_plan text, p_seats int)
returns json language plpgsql security definer set search_path = public as $fn$
begin return public.new_plan_invoice('upgrade', p_plan, 0, p_seats, null, 'online'); end;
$fn$;
create or replace function public.create_sms_invoice(p_count int)
returns json language plpgsql security definer set search_path = public as $fn$
begin return public.new_plan_invoice('sms', null, 0, null, p_count, 'online'); end;
$fn$;

-- the card-to-card entry point: returns the invoice and where to transfer
create or replace function public.create_card_invoice(p_kind text, p_plan text, p_months int, p_seats int, p_count int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare r json; ps public.platform_settings;
begin
  r := public.new_plan_invoice(p_kind, p_plan, coalesce(p_months, 0), p_seats, p_count, 'card');
  if not (r ->> 'ok')::boolean then return r; end if;
  select * into ps from public.platform_settings;
  return json_build_object('ok', true, 'id', r ->> 'id', 'amount', (r ->> 'amount')::bigint,
                           'card_number', ps.card_number, 'card_holder', ps.card_holder, 'card_sheba', ps.card_sheba);
end;
$fn$;
revoke all on function public.create_card_invoice(text, text, int, int, int) from public, anon;
grant execute on function public.create_card_invoice(text, text, int, int, int) to authenticated;

-- ------------------------------------------- 3. the salon says "I paid" -----
create or replace function public.submit_card_payment(p_id uuid, p_ref text, p_last4 text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare i public.plan_invoices; v_ref text := regexp_replace(translate(coalesce(p_ref, ''), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'), '\s', '', 'g');
        v_last4 text := translate(coalesce(p_last4, ''), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789');
        ps public.platform_settings; s public.salons;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into i from public.plan_invoices where id = p_id and salon_id = public.current_salon_id() for update;
  if i.id is null or i.method <> 'card' then return json_build_object('ok', false, 'error', 'پرداخت پیدا نشد'); end if;
  if i.status not in ('awaiting_payment', 'rejected') then return json_build_object('ok', false, 'error', 'این پرداخت قبلاً ثبت شده است'); end if;
  if v_ref !~ '^[0-9A-Za-z]{4,30}$' then return json_build_object('ok', false, 'error', 'شمارهٔ پیگیری را درست وارد کنید'); end if;
  if v_last4 !~ '^[0-9]{4}$' then return json_build_object('ok', false, 'error', '۴ رقم آخر کارت خود را وارد کنید'); end if;
  update public.plan_invoices set status = 'submitted', card_ref = v_ref, card_last4 = v_last4, submitted_at = now(), review_note = ''
   where id = i.id;
  select * into ps from public.platform_settings;
  select * into s from public.salons where id = i.salon_id;
  if coalesce(ps.owner_mobile, '') <> '' then
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (i.salon_id, ps.owner_mobile,
            'کارت‌به‌کارت جدید: «' || s.name || '» ' || public.fa_digits(to_char(i.amount, 'FM999,999,999,999')) || ' تومان، پیگیری '
            || public.fa_digits(v_ref) || '، کارت ****' || public.fa_digits(v_last4) || '. برای تایید: /admin ← اشتراک و درآمد',
            'plan', 'queued', now());
  end if;
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.submit_card_payment(uuid, text, text) from public, anon;
grant execute on function public.submit_card_payment(uuid, text, text) to authenticated;

-- What the salon's subscription card shows: how to pay by card and its own recent card payments.
create or replace function public.my_card_payments()
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare ps public.platform_settings;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into ps from public.platform_settings;
  return json_build_object('ok', true,
    'enabled', coalesce(ps.card_enabled, false),
    'card_number', case when ps.card_enabled then ps.card_number else '' end,
    'card_holder', case when ps.card_enabled then ps.card_holder else '' end,
    'card_sheba', case when ps.card_enabled then ps.card_sheba else '' end,
    'invoices', coalesce((
      select json_agg(json_build_object('id', i.id, 'kind', i.kind, 'plan_name', p.name, 'months', i.months, 'amount', i.amount,
                                        'sms_count', i.sms_count, 'status', i.status, 'card_ref', i.card_ref, 'review_note', i.review_note,
                                        'created_at', i.created_at) order by i.created_at desc)
        from (select * from public.plan_invoices where salon_id = public.current_salon_id() and method = 'card'
                and (status in ('awaiting_payment', 'submitted', 'rejected') or created_at > now() - interval '30 days')
              order by created_at desc limit 6) i
        left join public.platform_plans p on p.id = i.plan_id), '[]'::json));
end;
$fn$;
revoke all on function public.my_card_payments() from public, anon;
grant execute on function public.my_card_payments() to authenticated;

-- ----------------------------------------------- 4. the owner reviews ------
create or replace function public.admin_card_payments()
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object('id', i.id, 'salon', s.name, 'slug', s.slug, 'kind', i.kind, 'plan_name', p.name,
                                      'months', i.months, 'amount', i.amount, 'sms_count', i.sms_count, 'status', i.status,
                                      'card_ref', i.card_ref, 'card_last4', i.card_last4, 'submitted_at', i.submitted_at,
                                      'paid_at', i.paid_at, 'review_note', i.review_note)
                    order by (i.status = 'submitted') desc, coalesce(i.submitted_at, i.created_at) desc)
      from public.plan_invoices i
      join public.salons s on s.id = i.salon_id
      left join public.platform_plans p on p.id = i.plan_id
     where i.method = 'card' and (i.status = 'submitted' or coalesce(i.paid_at, i.submitted_at) > now() - interval '30 days')), '[]'::json));
end;
$fn$;
revoke all on function public.admin_card_payments() from public, anon;
grant execute on function public.admin_card_payments() to authenticated;

-- Approving does what a verified online payment does; the salon is told by SMS.
create or replace function public.confirm_plan_payment(p_id uuid, p_ref text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare i public.plan_invoices;
begin
  select * into i from public.plan_invoices where id = p_id for update;
  if i.id is null or i.status not in ('awaiting_payment', 'submitted') then return; end if;
  update public.plan_invoices set status = 'paid', paid_at = now(), ref = coalesce(p_ref, '') where id = i.id;
  if i.kind = 'plan' then
    perform public.extend_salon_plan(i.salon_id, i.plan_id, i.months);
    update public.salons set plan_seats = case when i.seats is not null and i.seats > coalesce((select max_stylists from public.platform_plans where id = i.plan_id), 0)
                                               then i.seats end
     where id = i.salon_id;
  elsif i.kind = 'upgrade' then
    update public.salons set plan_id = i.plan_id,
           plan_seats = case when i.seats is not null and i.seats > coalesce((select max_stylists from public.platform_plans where id = i.plan_id), 0)
                             then i.seats end
     where id = i.salon_id;
  end if;
  update public.salons set sms_balance = sms_balance + coalesce(i.sms_count, 0) where id = i.salon_id;
end;
$fn$;
revoke all on function public.confirm_plan_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_plan_payment(uuid, text) to service_role;

create or replace function public.admin_review_card_payment(p_id uuid, p_approve boolean, p_note text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare i public.plan_invoices; s public.salons; v_note text := left(trim(coalesce(p_note, '')), 200);
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into i from public.plan_invoices where id = p_id and method = 'card' for update;
  if i.id is null or i.status <> 'submitted' then return json_build_object('ok', false, 'error', 'این پرداخت منتظر تایید نیست'); end if;
  select * into s from public.salons where id = i.salon_id;
  if p_approve then
    perform public.confirm_plan_payment(i.id, 'card:' || i.card_ref);
    if s.owner_phone ~ '^09[0-9]{9}$' then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (s.id, s.owner_phone, 'پرداخت کارت‌به‌کارت «' || s.name || '» تایید شد'
              || case when i.kind = 'sms' then ' و ' || public.fa_digits(i.sms_count::text) || ' پیامک به حساب سالن اضافه شد.'
                      else ' و اشتراک فعال است. سپاس از همراهی شما.' end, 'plan', 'queued', now());
    end if;
  else
    if v_note = '' then return json_build_object('ok', false, 'error', 'دلیل رد را بنویسید'); end if;
    update public.plan_invoices set status = 'rejected', review_note = v_note where id = i.id;
    if s.owner_phone ~ '^09[0-9]{9}$' then
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (s.id, s.owner_phone, 'پرداخت کارت‌به‌کارت «' || s.name || '» تایید نشد: ' || v_note
              || '. برای اصلاح: پنل ← تنظیمات سالن ← پروفایل و امنیت.', 'plan', 'queued', now());
    end if;
  end if;
  return json_build_object('ok', true);
end;
$fn$;
revoke all on function public.admin_review_card_payment(uuid, boolean, text) from public, anon;
grant execute on function public.admin_review_card_payment(uuid, boolean, text) to authenticated;

-- ------------------------- 5. no lock while a submitted payment is checked ---
create or replace function public.subscription_state(p_salon uuid)
returns text
language sql stable security definer set search_path = public as $fn$
  select case
           when not coalesce(ps.enforce_subscription, false) or s.plan_expires_at is null then 'active'
           when public.salon_today() <= s.plan_expires_at then 'active'
           when public.salon_today() <= s.plan_expires_at + ps.grace_days then 'grace'
           when exists (select 1 from public.plan_invoices i where i.salon_id = s.id and i.status = 'submitted'
                          and i.submitted_at > now() - interval '48 hours') then 'grace'
           else 'locked'
         end
    from public.salons s left join public.platform_settings ps on true
   where s.id = p_salon;
$fn$;
revoke all on function public.subscription_state(uuid) from public, anon, authenticated;
grant execute on function public.subscription_state(uuid) to service_role;
