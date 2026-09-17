-- ============================================================================
--  Migration v2.9 — anti-referral-fraud (2 layers)
--  Run AFTER schema.sql + earlier migrations. Idempotent.
--
--  THE PROBLEM this closes: apply_referral() previously awarded the
--  referrer's points the instant a referral code was entered — before any
--  real appointment ever happened. Combined with the anonymous booking
--  flow, this was farmable: create a booking under a real-looking but
--  fake/burner phone number, apply a referral code, collect the points,
--  repeat. The existing "must already be a real customer" and rate-limit
--  checks raised the bar but didn't close it.
--
--  LAYER 1 — customers.name becomes immutable per phone (first non-empty
--  value wins; later bookings never overwrite it). Closes a related
--  identity-manipulation angle where a phone's on-file name could be
--  changed after the fact.
--
--  LAYER 2 — referral points move from "code entered" to "visit completed
--  AND staff verified at checkout". apply_referral() now only records the
--  referred_by relationship — no points. A new referral_verified column
--  (staff-only, defaults false) must be explicitly set true, together with
--  status='completed', before EITHER side's reward is inserted — both the
--  referrer's and the new customer's own bonus, at the same time, under the
--  same check. This is the human-in-the-loop step: front-desk staff confirm
--  the person checking out is a genuinely new customer, not a fabricated
--  one, before any points for that referral exist anywhere.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New column
-- ----------------------------------------------------------------------------
alter table public.appointments
  add column if not exists referral_verified boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. sync_customer_from_appointment(): immutable name + gated referral award
-- ----------------------------------------------------------------------------
create or replace function public.sync_customer_from_appointment() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare pts int; ref_phone text; ref_pts int;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  -- LAYER 1: name is immutable per phone once set.
  insert into public.customers (phone, name, gender, last_booking_at)
  values (new.customer_phone, new.customer_name, new.customer_gender, now())
  on conflict (phone) do update
    set name            = coalesce(nullif(public.customers.name, ''), excluded.name),
        last_booking_at = now();

  update public.campaign_targets ct
     set returned = true, returned_at = now()
   where ct.customer_phone = new.customer_phone
     and ct.returned = false
     and exists (select 1 from public.campaigns c
                  where c.id = ct.campaign_id and c.status = 'sent');

  update public.campaigns c
     set returned_count = (select count(*) from public.campaign_targets t
                            where t.campaign_id = c.id and t.returned)
   where c.status = 'sent';

  -- Visit points — unchanged from before this migration.
  if new.status = 'completed'
     and coalesce(old.status, '') <> 'completed'
     and new.points_awarded = 0 then
    select coalesce(s.loyalty_points, ls.points_per_visit) into pts
      from public.loyalty_settings ls
      left join public.services s on s.id = new.service_id
     where ls.id = 1;
    pts := coalesce(pts, 10);

    insert into public.loyalty_ledger (customer_phone, delta, reason, appointment_id)
    values (new.customer_phone, pts, 'visit', new.id);

    update public.customers
       set loyalty_points = loyalty_points + pts,
           total_visits   = total_visits + 1
     where phone = new.customer_phone;

    new.points_awarded := pts;
  end if;

  -- LAYER 2: both the referrer's AND the new customer's own referral bonus
  -- — completed + staff-verified, idempotent via a ledger existence check
  -- (guards both inserts together, since they're always written as a pair).
  if new.status = 'completed' and new.referral_verified = true then
    select referred_by into ref_phone from public.customers where phone = new.customer_phone;
    if ref_phone is not null and ref_phone <> new.customer_phone
       and not exists (select 1 from public.loyalty_ledger where reason = 'referral' and appointment_id = new.id) then
      select referral_points into ref_pts from public.loyalty_settings where id = 1;
      ref_pts := coalesce(ref_pts, 50);
      insert into public.loyalty_ledger (customer_phone, delta, reason, appointment_id) values
        (ref_phone, ref_pts, 'referral', new.id),
        (new.customer_phone, ref_pts, 'referral', new.id);
      update public.customers set loyalty_points = loyalty_points + ref_pts
       where phone in (ref_phone, new.customer_phone);
    end if;
  end if;

  return new;
end $fn$;
-- Trigger definition (BEFORE INSERT OR UPDATE) is unchanged — replacing the
-- function body is enough; no DROP/CREATE TRIGGER needed here.

-- ----------------------------------------------------------------------------
-- 3. apply_referral(): validation + relationship only, no point awarding
-- ----------------------------------------------------------------------------
create or replace function public.apply_referral(p_new_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $fn$
declare referrer record;
begin
  select * into referrer from public.customers where referral_code = upper(p_code);
  if referrer is null then return json_build_object('ok', false, 'error', 'کد معرف پیدا نشد'); end if;
  if referrer.phone = p_new_phone then return json_build_object('ok', false, 'error', 'کد معرف خودتان قابل استفاده نیست'); end if;
  if exists (select 1 from public.customers where phone = p_new_phone and referred_by is not null) then
    return json_build_object('ok', false, 'error', 'قبلاً از کد معرف استفاده کرده‌اید');
  end if;
  if not exists (select 1 from public.customers where phone = p_new_phone) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;

  update public.customers set referred_by = referrer.phone where phone = p_new_phone;

  return json_build_object('ok', true);
end $fn$;
grant execute on function public.apply_referral(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. RLS: only manager/stylist can change referral_verified — anonymous
--    (customer) callers are blocked from it even on an otherwise-legal
--    cancel/reschedule update. Staff already have unrestricted field-level
--    access via p_appt_update's row-level policy, so no separate grant is
--    needed for them — only this trigger addition for the anon path.
-- ----------------------------------------------------------------------------
create or replace function public.guard_anonymous_appt_update() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or new.final_price is distinct from old.final_price
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value
       or new.referral_verified is distinct from old.referral_verified then
      raise exception 'این تغییر برای مشتری مجاز نیست — فقط لغو یا جابه‌جایی زمان مجاز است';
    end if;
    insert into public.audit_log (event, actor, detail) values (
      'appointment_self_update', null,
      jsonb_build_object('appointment_id', new.id, 'from_status', old.status, 'to_status', new.status)
    );
  end if;
  return new;
end;
$fn$;
-- Trigger definition (BEFORE UPDATE) is unchanged — replacing the function
-- body is enough; no DROP/CREATE TRIGGER needed here.
