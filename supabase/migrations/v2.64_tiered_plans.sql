-- v2.64: subscription tiers by number of stylists, with an SMS allowance per tier.
--
-- What the platform owner sees (all editable in /admin → «اشتراک سالن‌ها»):
--   tier      active stylists   3 months     6 months     12 months    free SMS (3/6/12 months)
--   پایه        up to 2          6,000,000   11,400,000   21,600,000    1,000 /  2,000 /  4,000
--   حرفه‌ای     3 to 5          10,000,000   19,000,000   36,000,000    2,500 /  5,000 / 10,000
--   ویژه        6 to 10         15,000,000   28,500,000   54,000,000    4,500 /  9,000 / 18,000
--   بزرگ        11 to 20        21,000,000   40,000,000   75,500,000    7,500 / 15,000 / 30,000
--   over 20: «بزرگ» plus 900,000 per extra stylist per 3 months (same 6/12-month ratio)
--
-- Rules
--   * Only ACTIVE stylists count. Reaching the limit only blocks adding (or
--     re-activating) a stylist; nothing else is locked.
--   * SMS allowance comes with each purchase, for the whole period, and what
--     is left carries over on renewal. Beyond it the salon buys SMS packs
--     (sms_price per SMS part, 250 toman by default).
--   * With no allowance left: marketing SMS (campaigns, loyalty, win-back…)
--     stop; booking SMS (confirmation, reminder, cancellation…) keep going and
--     the balance goes negative — the next purchase settles it. Login codes
--     (OTP) and renewal reminders are never counted.
--   * A salon on its OWN SMS account (kavenegar / melipayamak key in the
--     panel) pays its provider directly: no allowance, no limit.
--   * Upgrading mid-term pays only the difference for the days left.
--   * Like the rest of the subscription, limits apply only while
--     «اجرای اشتراک» (enforce_subscription) is on, and never to a salon
--     without an expiry date.
-- Existing salons are placed in the tier that fits their active stylists,
-- keep their expiry date, and get the SMS allowance for the days they have left.
-- Safe to run more than once.

-- ------------------------------------------------------------ 1. schema ----
alter table public.platform_plans add column if not exists max_stylists int check (max_stylists is null or max_stylists between 1 and 1000);
alter table public.platform_plans add column if not exists price_3 bigint check (price_3 is null or price_3 between 0 and 100000000000);
alter table public.platform_plans add column if not exists price_6 bigint check (price_6 is null or price_6 between 0 and 100000000000);
alter table public.platform_plans add column if not exists price_12 bigint check (price_12 is null or price_12 between 0 and 100000000000);
alter table public.platform_plans add column if not exists sms_3 int not null default 0 check (sms_3 >= 0);
alter table public.platform_plans add column if not exists sms_6 int not null default 0 check (sms_6 >= 0);
alter table public.platform_plans add column if not exists sms_12 int not null default 0 check (sms_12 >= 0);
alter table public.platform_plans add column if not exists extra_stylist_price_3 bigint not null default 0 check (extra_stylist_price_3 between 0 and 1000000000);

alter table public.platform_settings add column if not exists sms_price int not null default 250 check (sms_price between 0 and 100000);
alter table public.platform_settings add column if not exists sms_packs int[] not null default '{500,1000,5000}';
alter table public.platform_settings add column if not exists trial_sms int not null default 200 check (trial_sms between 0 and 100000);
alter table public.platform_settings add column if not exists trial_plan text;
alter table public.platform_settings drop constraint if exists platform_settings_sms_packs_check;
alter table public.platform_settings add constraint platform_settings_sms_packs_check
  check (cardinality(sms_packs) between 1 and 6 and 1 <= all (sms_packs) and 100000 >= all (sms_packs));

alter table public.salons add column if not exists sms_balance int not null default 0;
alter table public.salons add column if not exists plan_seats int check (plan_seats is null or plan_seats between 1 and 1000);

alter table public.plan_invoices add column if not exists kind text not null default 'plan';
alter table public.plan_invoices add column if not exists seats int;
alter table public.plan_invoices add column if not exists sms_count int not null default 0;
alter table public.plan_invoices alter column plan_id drop not null;
alter table public.plan_invoices drop constraint if exists plan_invoices_kind_check;
alter table public.plan_invoices add constraint plan_invoices_kind_check check (kind in ('plan', 'upgrade', 'sms'));
alter table public.plan_invoices drop constraint if exists plan_invoices_months_check;
alter table public.plan_invoices add constraint plan_invoices_months_check
  check ((kind = 'plan' and months in (1, 3, 6, 12)) or (kind <> 'plan' and months = 0));

-- ------------------------------------------- 2. the tiers (first run only) ---
do $do$
declare v_first boolean := not exists (select 1 from public.platform_plans where id = 'paye');
        s record; v_plan text; v_days int; v_sms3 int;
begin
  insert into public.platform_plans (id, name, monthly_price, sms_quota, payment_fee_pct, active, sort_order,
                                     max_stylists, price_3, price_6, price_12, sms_3, sms_6, sms_12, extra_stylist_price_3)
  values ('paye',   'پایه',     2000000, 0, 0, true, 1,  2,  6000000, 11400000, 21600000, 1000,  2000,  4000, 0),
         ('herfei', 'حرفه‌ای',  3333333, 0, 0, true, 2,  5, 10000000, 19000000, 36000000, 2500,  5000, 10000, 0),
         ('vizhe',  'ویژه',     5000000, 0, 0, true, 3, 10, 15000000, 28500000, 54000000, 4500,  9000, 18000, 0),
         ('bozorg', 'بزرگ',     7000000, 0, 0, true, 4, 20, 21000000, 40000000, 75500000, 7500, 15000, 30000, 900000)
  on conflict (id) do nothing;
  if not v_first then return; end if;

  -- the old per-month plans stay for history but can't be bought any more
  update public.platform_plans set active = false where id not in ('paye', 'herfei', 'vizhe', 'bozorg');
  update public.platform_settings set trial_plan = 'herfei' where trial_plan is null;

  -- every salon into the tier that fits its active stylists; SMS for the days left
  for s in select sa.id, sa.plan_expires_at,
                  (select count(*) from public.stylists st where st.salon_id = sa.id and st.active)::int as n
             from public.salons sa loop
    v_plan := case when s.n <= 2 then 'paye' when s.n <= 5 then 'herfei' when s.n <= 10 then 'vizhe' else 'bozorg' end;
    select sms_3 into v_sms3 from public.platform_plans where id = v_plan;
    v_days := greatest(0, least(coalesce(s.plan_expires_at - public.salon_today(), 0), 365));
    update public.salons
       set plan_id = v_plan,
           plan_seats = case when s.n > 20 then s.n end,
           sms_balance = sms_balance + round(v_sms3 * v_days / 90.0)::int
     where id = s.id;
  end loop;
end
$do$;

-- --------------------------------------------------- 3. stylist limit -------
create or replace function public.active_stylist_count(p_salon uuid)
returns int
language sql stable security definer set search_path = public as $fn$
  select count(*)::int from public.stylists where salon_id = p_salon and active;
$fn$;
revoke all on function public.active_stylist_count(uuid) from public, anon;
grant execute on function public.active_stylist_count(uuid) to authenticated;

-- How many active stylists this salon's subscription allows (null = no limit).
create or replace function public.stylist_limit(p_salon uuid)
returns int
language sql stable security definer set search_path = public as $fn$
  select case when not coalesce(ps.enforce_subscription, false) or s.plan_expires_at is null or p.id is null then null
              else coalesce(s.plan_seats, p.max_stylists) end
    from public.salons s
    left join public.platform_plans p on p.id = s.plan_id
    left join public.platform_settings ps on true
   where s.id = p_salon;
$fn$;
revoke all on function public.stylist_limit(uuid) from public, anon;
grant execute on function public.stylist_limit(uuid) to authenticated;

create or replace function public.enforce_stylist_limit()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_limit int; v_plan text;
begin
  if not new.active or (tg_op = 'UPDATE' and old.active and old.salon_id = new.salon_id) then return new; end if;
  if public.is_platform_admin() then return new; end if;
  v_limit := public.stylist_limit(new.salon_id);
  if v_limit is null then return new; end if;
  if (select count(*) from public.stylists where salon_id = new.salon_id and active and id <> new.id) >= v_limit then
    select p.name into v_plan from public.salons s join public.platform_plans p on p.id = s.plan_id where s.id = new.salon_id;
    raise exception 'اشتراک «%» حداکثر % آرایشگر فعال دارد — برای افزودن، اشتراک را ارتقا دهید (تنظیمات سالن ← پروفایل و امنیت)',
      coalesce(v_plan, ''), public.fa_digits(v_limit::text) using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_enforce_stylist_limit on public.stylists;
create trigger trg_enforce_stylist_limit before insert or update of active, salon_id on public.stylists
  for each row execute function public.enforce_stylist_limit();

-- ------------------------------------------------------------ 4. prices -----
-- Seats a purchase covers: the tier's maximum, or for a tier that sells extra
-- seats («بزرگ»), at least what the salon already uses.
create or replace function public.plan_seats_for(p_plan text, p_seats int, p_salon uuid)
returns int
language sql stable security definer set search_path = public as $fn$
  select case when p.max_stylists is null then null
              when p.extra_stylist_price_3 > 0 then greatest(p.max_stylists, coalesce(p_seats, 0), public.active_stylist_count(p_salon))
              else p.max_stylists end
    from public.platform_plans p where p.id = p_plan;
$fn$;
revoke all on function public.plan_seats_for(text, int, uuid) from public, anon, authenticated;

-- Price of p_months of a tier for p_seats stylists. Tiers with their own
-- 3/6/12-month prices use them (extra seats at the same 6/12-month ratio);
-- older plans keep the monthly price with the owner's discounts.
create or replace function public.plan_price(p_plan text, p_months int, p_seats int)
returns bigint
language sql stable security definer set search_path = public as $fn$
  select case
    when p.price_3 is not null then
      case p_months when 3 then p.price_3 when 6 then p.price_6 when 12 then p.price_12 end
      + case when p.extra_stylist_price_3 > 0 and coalesce(p_seats, 0) > coalesce(p.max_stylists, 0) then
          round((p_seats - p.max_stylists) * p.extra_stylist_price_3
                * case p_months when 3 then 1 when 6 then p.price_6::numeric / nullif(p.price_3, 0)
                                when 12 then p.price_12::numeric / nullif(p.price_3, 0) end)::bigint
        else 0 end
    else
      round(p.monthly_price * p_months * (1 - case p_months when 3 then ps.discount_3 when 6 then ps.discount_6
                                                            when 12 then ps.discount_12 else 0 end / 100.0))::bigint
    end
    from public.platform_plans p left join public.platform_settings ps on true
   where p.id = p_plan and p.active
     and ((p.price_3 is not null and p_months in (3, 6, 12)) or (p.price_3 is null and p_months in (1, 3, 6, 12)));
$fn$;
revoke all on function public.plan_price(text, int, int) from public, anon;
grant execute on function public.plan_price(text, int, int) to authenticated;

create or replace function public.plan_price(p_plan text, p_months int)
returns bigint
language sql stable security definer set search_path = public as $fn$
  select public.plan_price(p_plan, p_months, null);
$fn$;
revoke all on function public.plan_price(text, int) from public, anon;
grant execute on function public.plan_price(text, int) to authenticated;

create or replace function public.plan_sms(p_plan text, p_months int)
returns int
language sql stable security definer set search_path = public as $fn$
  select coalesce(case p_months when 3 then p.sms_3 when 6 then p.sms_6 when 12 then p.sms_12 end, 0)
    from public.platform_plans p where p.id = p_plan;
$fn$;
revoke all on function public.plan_sms(text, int) from public, anon;
grant execute on function public.plan_sms(text, int) to authenticated;

-- Daily value of a tier (its 3-month price over 90 days), for upgrades.
create or replace function public.plan_daily(p_plan text, p_seats int)
returns numeric
language sql stable security definer set search_path = public as $fn$
  select coalesce(public.plan_price(p_plan, 3, p_seats), 0) / 90.0;
$fn$;
revoke all on function public.plan_daily(text, int) from public, anon, authenticated;

-- -------------------------------------------------------- 5. invoices -------
create or replace function public.create_plan_invoice(p_plan text, p_months int, p_seats int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_amount bigint; v_salon uuid := public.current_salon_id(); v_seats int; v_max int; v_n int;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if coalesce((select zarinpal_merchant_id from public.platform_settings), '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین اشتراک فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  v_seats := public.plan_seats_for(p_plan, p_seats, v_salon);
  v_amount := public.plan_price(p_plan, p_months, v_seats);
  if v_amount is null then return json_build_object('ok', false, 'error', 'پلن نامعتبر است'); end if;
  if v_amount < 1000 then return json_build_object('ok', false, 'error', 'این پلن رایگان است'); end if;
  select max_stylists into v_max from public.platform_plans where id = p_plan;
  v_n := public.active_stylist_count(v_salon);
  if coalesce(v_seats, v_max) is not null and v_n > coalesce(v_seats, v_max) then
    return json_build_object('ok', false, 'error',
      'این اشتراک برای ' || public.fa_digits(coalesce(v_seats, v_max)::text) || ' آرایشگر است و سالن ' || public.fa_digits(v_n::text)
      || ' آرایشگر فعال دارد — سطح بالاتری انتخاب کنید یا آرایشگرهای اضافه را غیرفعال کنید');
  end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount, kind, seats, sms_count)
  values (v_salon, p_plan, p_months, v_amount, 'plan', v_seats, public.plan_sms(p_plan, p_months))
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', v_amount);
end;
$fn$;
revoke all on function public.create_plan_invoice(text, int, int) from public, anon;
grant execute on function public.create_plan_invoice(text, int, int) to authenticated;

create or replace function public.create_plan_invoice(p_plan text, p_months int)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  return public.create_plan_invoice(p_plan, p_months, null);
end;
$fn$;
grant execute on function public.create_plan_invoice(text, int) to authenticated;

-- What an upgrade to p_plan (p_seats) costs today: the difference in daily
-- value for the days left, plus the matching share of the SMS allowance.
create or replace function public.upgrade_quote(p_salon uuid, p_plan text, p_seats int)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare s public.salons; v_days int; v_old_seats int; v_new_seats int; v_amount bigint; v_sms int; v_old_cap int; v_new_cap int;
begin
  select * into s from public.salons where id = p_salon;
  if s.plan_id is null or s.plan_expires_at is null then return json_build_object('ok', false, 'error', 'اشتراک فعالی برای ارتقا نیست'); end if;
  v_days := s.plan_expires_at - public.salon_today();
  if v_days < 1 then return json_build_object('ok', false, 'error', 'اشتراک تمام شده — به‌جای ارتقا، اشتراک جدید بخرید'); end if;
  v_old_seats := coalesce(s.plan_seats, (select max_stylists from public.platform_plans where id = s.plan_id));
  v_new_seats := public.plan_seats_for(p_plan, p_seats, p_salon);
  v_old_cap := coalesce(v_old_seats, 100000);
  v_new_cap := coalesce(v_new_seats, (select max_stylists from public.platform_plans where id = p_plan), 100000);
  if v_new_cap <= v_old_cap then return json_build_object('ok', false, 'error', 'سطح انتخابی بالاتر از سطح فعلی نیست'); end if;
  v_amount := (round((public.plan_daily(p_plan, v_new_seats) - public.plan_daily(s.plan_id, v_old_seats)) * v_days / 1000.0) * 1000)::bigint;
  if v_amount < 1000 then return json_build_object('ok', false, 'error', 'پلن نامعتبر است'); end if;
  v_sms := greatest(0, round((public.plan_sms(p_plan, 3) - public.plan_sms(s.plan_id, 3)) * v_days / 90.0)::int);
  return json_build_object('ok', true, 'amount', v_amount, 'days', v_days, 'seats', v_new_seats, 'sms', v_sms);
end;
$fn$;
revoke all on function public.upgrade_quote(uuid, text, int) from public, anon, authenticated;

create or replace function public.create_upgrade_invoice(p_plan text, p_seats int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); q json; v_id uuid;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if coalesce((select zarinpal_merchant_id from public.platform_settings), '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین اشتراک فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  if not exists (select 1 from public.platform_plans where id = p_plan and active) then
    return json_build_object('ok', false, 'error', 'پلن نامعتبر است');
  end if;
  q := public.upgrade_quote(v_salon, p_plan, p_seats);
  if not (q ->> 'ok')::boolean then return q; end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount, kind, seats, sms_count)
  values (v_salon, p_plan, 0, (q ->> 'amount')::bigint, 'upgrade', (q ->> 'seats')::int, (q ->> 'sms')::int)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', (q ->> 'amount')::bigint);
end;
$fn$;
revoke all on function public.create_upgrade_invoice(text, int) from public, anon;
grant execute on function public.create_upgrade_invoice(text, int) to authenticated;

create or replace function public.create_sms_invoice(p_count int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare ps public.platform_settings; v_id uuid; v_amount bigint;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into ps from public.platform_settings;
  if coalesce(ps.zarinpal_merchant_id, '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  if not (p_count = any (ps.sms_packs)) then return json_build_object('ok', false, 'error', 'بستهٔ پیامک نامعتبر است'); end if;
  v_amount := p_count::bigint * ps.sms_price;
  if v_amount < 1000 then return json_build_object('ok', false, 'error', 'قیمت پیامک تعیین نشده است'); end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount, kind, sms_count)
  values (public.current_salon_id(), null, 0, v_amount, 'sms', p_count)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', v_amount);
end;
$fn$;
revoke all on function public.create_sms_invoice(int) from public, anon;
grant execute on function public.create_sms_invoice(int) to authenticated;

-- The payment Edge Function calls this once Zarinpal confirms.
create or replace function public.confirm_plan_payment(p_id uuid, p_ref text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare i public.plan_invoices;
begin
  select * into i from public.plan_invoices where id = p_id for update;
  if i.id is null or i.status <> 'awaiting_payment' then return; end if;
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

-- Platform admin: plan, expiry and (optionally) SMS by hand — cash payment, gift.
create or replace function public.admin_set_plan(p_salon uuid, p_plan text, p_expires date, p_add_sms int)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_plan is not null and not exists (select 1 from public.platform_plans where id = p_plan) then
    return json_build_object('ok', false, 'error', 'پلن پیدا نشد');
  end if;
  if coalesce(p_add_sms, 0) not between -100000 and 100000 then return json_build_object('ok', false, 'error', 'تعداد پیامک نامعتبر است'); end if;
  update public.salons
     set plan_id = p_plan, plan_expires_at = p_expires,
         plan_seats = case when p_plan is distinct from plan_id then null else plan_seats end,
         sms_balance = sms_balance + coalesce(p_add_sms, 0)
   where id = p_salon;
  return json_build_object('ok', found);
end;
$fn$;
revoke all on function public.admin_set_plan(uuid, text, date, int) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, date, int) to authenticated;

-- ---------------------------------------------- 6. trial for new salons -----
create or replace function public.default_trial()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare ps public.platform_settings;
begin
  select * into ps from public.platform_settings;
  if new.plan_expires_at is null and coalesce(ps.trial_days, 0) > 0 then
    new.plan_expires_at := public.salon_today() + ps.trial_days;
    if new.plan_id is null and exists (select 1 from public.platform_plans where id = ps.trial_plan) then
      new.plan_id := ps.trial_plan;
    end if;
    new.sms_balance := coalesce(new.sms_balance, 0) + coalesce(ps.trial_sms, 0);
  end if;
  return new;
end;
$fn$;

-- ------------------------------------------------------------- 7. SMS -------
-- Marketing kinds stop when the allowance is gone; everything else is a
-- booking/service message that must reach the customer.
create or replace function public.sms_is_marketing(p_kind text)
returns boolean
language sql immutable set search_path = public as $fn$
  select coalesce(p_kind, '') in ('campaign', 'loyalty', 'predictive_rebooking', 'slot_offer', 'winback', 'birthday', 'pet_reminder');
$fn$;

-- A Persian SMS part holds 70 characters; longer texts go in parts of 67.
create or replace function public.sms_parts(p_body text)
returns int
language sql immutable set search_path = public as $fn$
  select case when length(coalesce(p_body, '')) <= 70 then 1 else ceil(length(p_body) / 67.0)::int end;
$fn$;

-- Is this salon's SMS counted against its allowance? Only on the platform's
-- SMS line, while the subscription is enforced, for a salon with an expiry.
create or replace function public.sms_metered(p_salon uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(ps.enforce_subscription, false) and s.plan_expires_at is not null
         and not exists (select 1 from public.salon_sms_settings x where x.salon_id = s.id and coalesce(x.api_key, '') <> '')
    from public.salons s left join public.platform_settings ps on true
   where s.id = p_salon;
$fn$;
revoke all on function public.sms_metered(uuid) from public, anon, authenticated;

-- For the send-sms Edge Function, before sending a message straight away.
create or replace function public.sms_may_send(p_salon uuid, p_kind text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select not public.sms_is_marketing(p_kind) or not coalesce(public.sms_metered(p_salon), false)
         or coalesce((select sms_balance from public.salons where id = p_salon), 0) > 0;
$fn$;
revoke all on function public.sms_may_send(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_may_send(uuid, text) to service_role;

-- Queued marketing messages are dropped once the allowance is gone.
create or replace function public.skip_sms_without_credit()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'queued' and not public.sms_may_send(new.salon_id, new.kind) then
    return null;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_skip_sms_without_credit on public.sms_messages;
create trigger trg_skip_sms_without_credit before insert on public.sms_messages
  for each row execute function public.skip_sms_without_credit();

-- Every message that actually went out on the platform line is counted.
create or replace function public.count_sms_credit()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status in ('sent', 'delivered')
     and (tg_op = 'INSERT' or old.status not in ('sent', 'delivered'))
     and coalesce(new.kind, '') not in ('otp', 'plan')
     and coalesce(new.provider, '') like '%(platform)%'
     and coalesce(public.sms_metered(new.salon_id), false) then
    update public.salons set sms_balance = sms_balance - public.sms_parts(new.body) where id = new.salon_id;
  end if;
  return null;
end;
$fn$;
drop trigger if exists trg_count_sms_credit on public.sms_messages;
create trigger trg_count_sms_credit after insert or update of status on public.sms_messages
  for each row execute function public.count_sms_credit();

-- --------------------------------------------- 8. the salon's own view ------
create or replace function public.my_plan()
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); s public.salons; p public.platform_plans; ps public.platform_settings; v_volume bigint; v_n int;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into s from public.salons where id = v_salon;
  select * into p from public.platform_plans where id = s.plan_id;
  select * into ps from public.platform_settings;
  v_n := public.active_stylist_count(v_salon);
  select coalesce(sum(amount_rial)::bigint / 10, 0) into v_volume from public.payments
   where salon_id = v_salon and status = 'paid' and plan_invoice_id is null and paid_at >= (date_trunc('month', public.salon_today())::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'));
  return json_build_object('ok', true,
    'plan_id', s.plan_id, 'plan_name', p.name, 'expires_at', s.plan_expires_at,
    'expired', s.plan_expires_at is not null and s.plan_expires_at < public.salon_today(),
    'state', public.subscription_state(v_salon),
    'days_left', case when s.plan_expires_at is null then null else s.plan_expires_at - public.salon_today() end,
    'grace_until', case when s.plan_expires_at is null then null else s.plan_expires_at + coalesce(ps.grace_days, 0) end,
    'discounts', json_build_object('3', coalesce(ps.discount_3, 5), '6', coalesce(ps.discount_6, 10), '12', coalesce(ps.discount_12, 20)),
    'support_phone', coalesce(ps.support_phone, ''),
    'enforced', coalesce(ps.enforce_subscription, false),
    'active_stylists', v_n,
    'seat_limit', coalesce(s.plan_seats, p.max_stylists),
    'sms_balance', s.sms_balance,
    'sms_metered', coalesce(public.sms_metered(v_salon), false),
    'sms_price', coalesce(ps.sms_price, 0),
    'sms_packs', coalesce(to_json(ps.sms_packs), '[]'::json),
    'sms_quota', p.sms_quota,
    'sms_used', (select count(*) from public.sms_messages m where m.salon_id = v_salon and m.status in ('sent', 'delivered')
                   and m.created_at >= (date_trunc('month', public.salon_today())::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))),
    'online_volume', v_volume, 'payment_fee_pct', coalesce(p.payment_fee_pct, 0),
    'payment_fee', round(v_volume * coalesce(p.payment_fee_pct, 0) / 100.0),
    'online', coalesce(ps.zarinpal_merchant_id, '') <> '',
    'plans', coalesce((select json_agg(json_build_object(
                 'id', x.id, 'name', x.name, 'monthly_price', x.monthly_price, 'sms_quota', x.sms_quota, 'payment_fee_pct', x.payment_fee_pct,
                 'max_stylists', x.max_stylists, 'extra_stylist_price_3', x.extra_stylist_price_3,
                 'price_3', public.plan_price(x.id, 3, public.plan_seats_for(x.id, null, v_salon)),
                 'price_6', public.plan_price(x.id, 6, public.plan_seats_for(x.id, null, v_salon)),
                 'price_12', public.plan_price(x.id, 12, public.plan_seats_for(x.id, null, v_salon)),
                 'seats', public.plan_seats_for(x.id, null, v_salon),
                 'sms_3', x.sms_3, 'sms_6', x.sms_6, 'sms_12', x.sms_12,
                 'tiered', x.price_3 is not null,
                 'fits', coalesce(public.plan_seats_for(x.id, null, v_salon), x.max_stylists, 100000) >= v_n,
                 'upgrade', case when s.plan_id is not null and x.id <> s.plan_id then public.upgrade_quote(v_salon, x.id, null) end)
               order by x.sort_order, x.monthly_price)
             from public.platform_plans x where x.active), '[]'::json));
end;
$fn$;
grant execute on function public.my_plan() to authenticated;

-- ------------------------------------------------------ 9. admin view -------
create or replace function public.admin_subscription_overview()
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'plan_id', s.plan_id, 'plan_name', p.name,
                                      'expires_at', s.plan_expires_at, 'state', public.subscription_state(s.id),
                                      'days_left', s.plan_expires_at - public.salon_today(),
                                      'stylists', public.active_stylist_count(s.id),
                                      'seat_limit', coalesce(s.plan_seats, p.max_stylists),
                                      'sms_balance', s.sms_balance)
                    order by s.plan_expires_at nulls last)
      from public.salons s left join public.platform_plans p on p.id = s.plan_id where s.active), '[]'::json));
end;
$fn$;
revoke all on function public.admin_subscription_overview() from public, anon;
grant execute on function public.admin_subscription_overview() to authenticated;
