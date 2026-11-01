-- v2.58: subscription enforcement — run after v2.57 (v2.55 is the last schema change before this).
--
-- The platform owner (platform admin) controls everything from /admin:
--   * enforce_subscription — off by default, so upgrading never locks anyone out
--   * grace_days           — days after expiry the salon still works (renewal window)
--   * reminder_days        — days before expiry the owner gets a renewal SMS
--   * discount_3/6/12      — percent off for 3/6/12-month purchases
--   * trial_days           — (v2.53) given to every new salon
--   * support_phone        — shown on the locked screen
--
-- States per salon:  active → (expiry) → grace → (expiry + grace_days) → locked
-- A salon with no expiry date (plan_expires_at is null) is never locked.
-- When locked:
--   * staff lose data access (is_staff / is_manager return false) — except the
--     subscription itself: my_plan, create_plan_invoice and the payment flow
--   * no new appointments or shop orders (triggers)
--   * no SMS goes out, except the renewal reminders (kind 'plan')
-- Safe to run more than once.

-- ------------------------------------------------------- 1. settings -------
alter table public.platform_settings add column if not exists enforce_subscription boolean not null default false;
alter table public.platform_settings add column if not exists grace_days int not null default 5;
alter table public.platform_settings add column if not exists reminder_days int[] not null default '{14,7,3,1}';
alter table public.platform_settings add column if not exists discount_3 numeric(4, 1) not null default 5;
alter table public.platform_settings add column if not exists discount_6 numeric(4, 1) not null default 10;
alter table public.platform_settings add column if not exists discount_12 numeric(4, 1) not null default 20;
alter table public.platform_settings add column if not exists support_phone text not null default '';
alter table public.platform_settings drop constraint if exists platform_settings_sub_check;
alter table public.platform_settings add constraint platform_settings_sub_check check (
  grace_days between 0 and 30
  and cardinality(reminder_days) <= 8 and 1 <= all (reminder_days) and 60 >= all (reminder_days)
  and discount_3 between 0 and 50 and discount_6 between 0 and 50 and discount_12 between 0 and 50
  and (support_phone = '' or support_phone ~ '^0[0-9]{10}$'));

-- ------------------------------------------------------- 2. state ----------
create or replace function public.subscription_state(p_salon uuid)
returns text
language sql stable security definer set search_path = public as $fn$
  select case
           when not coalesce(ps.enforce_subscription, false) or s.plan_expires_at is null then 'active'
           when public.salon_today() <= s.plan_expires_at then 'active'
           when public.salon_today() <= s.plan_expires_at + ps.grace_days then 'grace'
           else 'locked'
         end
    from public.salons s left join public.platform_settings ps on true
   where s.id = p_salon;
$fn$;
revoke all on function public.subscription_state(uuid) from public, anon, authenticated;
grant execute on function public.subscription_state(uuid) to service_role; -- send-sms Edge Function

-- What the app needs to show (booking page, panel banner, lock screen).
create or replace function public.subscription_status()
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object(
           'ok', s.id is not null,
           'state', coalesce(public.subscription_state(s.id), 'active'),
           'expires_at', s.plan_expires_at,
           'days_left', case when s.plan_expires_at is null then null else s.plan_expires_at - public.salon_today() end,
           'grace_until', case when s.plan_expires_at is null then null else s.plan_expires_at + coalesce(ps.grace_days, 0) end,
           'enforced', coalesce(ps.enforce_subscription, false),
           'warn_days', coalesce((select max(d) from unnest(ps.reminder_days) d), 14),
           'support_phone', coalesce(ps.support_phone, ''))
    from public.salons s left join public.platform_settings ps on true
   where s.id = public.current_salon_id();
$fn$;
grant execute on function public.subscription_status() to anon, authenticated;

-- ------------------------------------------------ 3. lock data access ------
-- The same helpers every RLS policy and staff RPC already uses.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce((select u.active and public.subscription_state(u.salon_id) <> 'locked'
                     from public.users u where u.id = auth.uid()), false)
     and public.mfa_ok();
$fn$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $fn$
  select case when auth.uid() is null then public.my_role() in ('owner', 'manager')
              else coalesce(public.my_role() in ('owner', 'manager')
                            and public.subscription_state(public.current_salon_id()) <> 'locked', false) end;
$fn$;

-- The salon's owner/manager may always reach the subscription itself.
create or replace function public.is_billing_manager() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(public.my_role() in ('owner', 'manager'), false);
$fn$;
grant execute on function public.is_billing_manager() to authenticated;

-- ---------------------------------------- 4. block new work when locked ----
create or replace function public.block_when_locked()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if public.subscription_state(new.salon_id) = 'locked' and not public.is_platform_admin() then
    raise exception 'اشتراک این سالن به پایان رسیده است' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_block_locked_appointment on public.appointments;
create trigger trg_block_locked_appointment before insert on public.appointments
  for each row execute function public.block_when_locked();
drop trigger if exists trg_block_locked_order on public.orders;
create trigger trg_block_locked_order before insert on public.orders
  for each row execute function public.block_when_locked();

create or replace function public.skip_sms_when_locked()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.kind <> 'plan' and public.subscription_state(new.salon_id) = 'locked' then
    return null; -- nothing goes out for a locked salon, except its renewal reminders
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_skip_sms_when_locked on public.sms_messages;
create trigger trg_skip_sms_when_locked before insert on public.sms_messages
  for each row execute function public.skip_sms_when_locked();

-- --------------------------------------------- 5. trial for new salons -----
create or replace function public.default_trial()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_days int;
begin
  if new.plan_expires_at is null then
    select trial_days into v_days from public.platform_settings;
    if coalesce(v_days, 0) > 0 then new.plan_expires_at := public.salon_today() + v_days; end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_default_trial on public.salons;
create trigger trg_default_trial before insert on public.salons
  for each row execute function public.default_trial();

-- -------------------------------------- 6. billing reachable when locked ---
create or replace function public.my_plan()
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); s public.salons; p public.platform_plans; ps public.platform_settings; v_volume bigint;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into s from public.salons where id = v_salon;
  select * into p from public.platform_plans where id = s.plan_id;
  select * into ps from public.platform_settings;
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
    'sms_quota', p.sms_quota,
    'sms_used', (select count(*) from public.sms_messages m where m.salon_id = v_salon and m.status in ('sent', 'delivered')
                   and m.created_at >= (date_trunc('month', public.salon_today())::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))),
    'online_volume', v_volume, 'payment_fee_pct', coalesce(p.payment_fee_pct, 0),
    'payment_fee', round(v_volume * coalesce(p.payment_fee_pct, 0) / 100.0),
    'online', coalesce(ps.zarinpal_merchant_id, '') <> '',
    'plans', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'monthly_price', monthly_price,
                                                         'sms_quota', sms_quota, 'payment_fee_pct', payment_fee_pct) order by sort_order, monthly_price)
                         from public.platform_plans where active), '[]'::json));
end;
$fn$;
grant execute on function public.my_plan() to authenticated;

-- price for a purchase, with the owner's discounts
create or replace function public.plan_price(p_plan text, p_months int)
returns bigint
language sql stable security definer set search_path = public as $fn$
  select round(p.monthly_price * p_months * (1 - case p_months when 3 then ps.discount_3 when 6 then ps.discount_6
                                                               when 12 then ps.discount_12 else 0 end / 100.0))::bigint
    from public.platform_plans p left join public.platform_settings ps on true
   where p.id = p_plan and p.active and p_months in (1, 3, 6, 12);
$fn$;
revoke all on function public.plan_price(text, int) from public, anon;
grant execute on function public.plan_price(text, int) to authenticated;

create or replace function public.create_plan_invoice(p_plan text, p_months int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_id uuid; v_amount bigint;
begin
  if not public.is_billing_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if coalesce((select zarinpal_merchant_id from public.platform_settings), '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین اشتراک فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  v_amount := public.plan_price(p_plan, p_months);
  if v_amount is null then return json_build_object('ok', false, 'error', 'پلن نامعتبر است'); end if;
  if v_amount < 1000 then return json_build_object('ok', false, 'error', 'این پلن رایگان است'); end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount) values (public.current_salon_id(), p_plan, p_months, v_amount)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', v_amount);
end;
$fn$;
grant execute on function public.create_plan_invoice(text, int) to authenticated;

-- Renewal counts from the old expiry while still in the grace window (no
-- free days), and from today once locked.
create or replace function public.extend_salon_plan(p_salon uuid, p_plan text, p_months int)
returns date
language plpgsql security definer set search_path = public as $fn$
declare v_until date; v_grace int;
begin
  select coalesce(grace_days, 0) into v_grace from public.platform_settings;
  update public.salons
     set plan_id = p_plan,
         plan_expires_at = (case when plan_expires_at is not null and plan_expires_at + coalesce(v_grace, 0) >= public.salon_today()
                                 then plan_expires_at else public.salon_today() end
                            + make_interval(months => p_months))::date
   where id = p_salon
  returning plan_expires_at into v_until;
  return v_until;
end;
$fn$;
revoke all on function public.extend_salon_plan(uuid, text, int) from public, anon, authenticated;

-- --------------------------------------------- 7. renewal reminders ---------
-- Daily (cron.sql). To the salon owner's phone, at most one a day:
--   N days before expiry (each N in reminder_days), on expiry, on the last
--   day of the grace window, and the day the salon is locked.
create or replace function public.plan_reminders()
returns int
language plpgsql security definer set search_path = public as $fn$
declare r record; n int := 0; v_today date := public.salon_today(); ps public.platform_settings; v_body text; d int;
begin
  select * into ps from public.platform_settings;
  if ps.id is null or not ps.enforce_subscription then return 0; end if;
  for r in
    select s.id, s.name, s.owner_phone, s.plan_expires_at
      from public.salons s
     where s.active and s.plan_expires_at is not null and s.owner_phone ~ '^09[0-9]{9}$'
       and not exists (select 1 from public.sms_messages m where m.salon_id = s.id and m.kind = 'plan'
                         and (m.created_at at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::date = v_today)
  loop
    d := r.plan_expires_at - v_today;
    v_body := case
      when d > 0 and d = any (ps.reminder_days) then
        'اشتراک نرم‌افزار نوبت‌دهی «' || r.name || '» ' || public.fa_digits(d::text) || ' روز دیگر تمام می‌شود. برای تمدید: پنل ← تنظیمات سالن ← پروفایل و امنیت.'
      when d = 0 then
        'امروز آخرین روز اشتراک «' || r.name || '» است.'
        || case when ps.grace_days > 0 then ' پس از آن ' || public.fa_digits(ps.grace_days::text) || ' روز مهلت تمدید دارید.' else ' لطفاً امروز تمدید کنید.' end
      when ps.grace_days > 0 and d = -ps.grace_days then
        'امروز آخرین روز مهلت تمدید «' || r.name || '» است. از فردا پنل، رزرو آنلاین و پیامک‌ها غیرفعال می‌شوند.'
      when d = -ps.grace_days - 1 then
        'اشتراک «' || r.name || '» به پایان رسید و سرویس غیرفعال شد. با تمدید از پنل، همه چیز همان لحظه فعال می‌شود.'
      else null end;
    if v_body is not null then
      if ps.support_phone <> '' then v_body := v_body || ' پشتیبانی: ' || public.fa_digits(ps.support_phone); end if;
      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (r.id, r.owner_phone, v_body, 'plan', 'queued', now());
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$fn$;
revoke all on function public.plan_reminders() from public, anon, authenticated;
grant execute on function public.plan_reminders() to service_role;

-- ------------------------------------------- 8. admin: salon states --------
create or replace function public.admin_subscription_overview()
returns json
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'plan_id', s.plan_id,
                                      'expires_at', s.plan_expires_at, 'state', public.subscription_state(s.id),
                                      'days_left', s.plan_expires_at - public.salon_today())
                    order by s.plan_expires_at nulls last)
      from public.salons s where s.active), '[]'::json));
end;
$fn$;
revoke all on function public.admin_subscription_overview() from public, anon;
grant execute on function public.admin_subscription_overview() to authenticated;
