-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 4 of 4: settings
-- singletons + the sync_customer_from_appointment trigger)
-- ============================================================================
-- Found during real-Postgres testing of parts 1-3 (not discovered by code
-- review alone — this is exactly why every migration in this project gets
-- tested against a live database before delivery):
--
-- BUG A: loyalty_settings, customer_segment_settings, and app_settings
-- were each a global singleton (id int primary key default 1, check
-- id = 1) — literally impossible for a second salon to ever get its own
-- settings row, since the primary key only ever allows one row, period.
-- Fixed by re-keying all three on salon_id instead.
--
-- BUG B (blocking — breaks every single appointment write, confirmed by a
-- real "no unique or exclusion constraint matching ON CONFLICT" trigger
-- error during testing): sync_customer_from_appointment() hardcoded
-- `on conflict (phone)` for the customers upsert, `where id = 1` for both
-- loyalty_settings lookups, and phone-only matching for campaign_targets/
-- customers updates — none of which account for the new composite keys
-- or tenant boundaries from parts 1-3. A booking from a customer at
-- salon A could otherwise attribute a win-back return to salon B's
-- campaign, or use salon B's loyalty point rules, purely by phone
-- coincidence. Completely rewritten below with salon_id threaded through
-- every step.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Re-key the three settings singletons on salon_id.
-- ----------------------------------------------------------------------------
alter table public.loyalty_settings drop constraint if exists loyalty_settings_pkey;
alter table public.loyalty_settings drop constraint if exists loyalty_settings_id_check;
alter table public.loyalty_settings drop column if exists id;
alter table public.loyalty_settings add constraint loyalty_settings_pkey primary key (salon_id);

alter table public.customer_segment_settings drop constraint if exists customer_segment_settings_pkey;
alter table public.customer_segment_settings drop constraint if exists customer_segment_settings_id_check;
alter table public.customer_segment_settings drop column if exists id;
alter table public.customer_segment_settings add constraint customer_segment_settings_pkey primary key (salon_id);

alter table public.app_settings drop constraint if exists app_settings_pkey;
alter table public.app_settings drop constraint if exists app_settings_id_check;
alter table public.app_settings drop column if exists id;
alter table public.app_settings add constraint app_settings_pkey primary key (salon_id);

-- Every existing salon (in practice, just the one pre-existing salon at
-- this point) gets a settings row if it doesn't already have one —
-- covers both a fresh install and an upgrade from parts 1-3 in the same
-- transaction.
insert into public.loyalty_settings (salon_id)
select id from public.salons where id not in (select salon_id from public.loyalty_settings);
insert into public.customer_segment_settings (salon_id)
select id from public.salons where id not in (select salon_id from public.customer_segment_settings);
insert into public.app_settings (salon_id)
select id from public.salons where id not in (select salon_id from public.app_settings);

-- New salons, created after this migration, automatically get their own
-- default settings rows the moment they're created — no follow-up step
-- needed anywhere else (frontend, onboarding flow, etc.) to provision them.
create or replace function public.provision_salon_defaults() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.loyalty_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  insert into public.customer_segment_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  insert into public.app_settings (salon_id) values (new.id) on conflict (salon_id) do nothing;
  return new;
end;
$fn$;
drop trigger if exists trg_provision_salon_defaults on public.salons;
create trigger trg_provision_salon_defaults
  after insert on public.salons
  for each row execute function public.provision_salon_defaults();

-- ----------------------------------------------------------------------------
-- sync_customer_from_appointment() — full rewrite, salon_id threaded
-- through every lookup, upsert, and update.
-- ----------------------------------------------------------------------------
create or replace function public.sync_customer_from_appointment() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare pts int; ref_phone text; ref_pts int;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  insert into public.customers (salon_id, phone, name, gender, last_booking_at)
  values (new.salon_id, new.customer_phone, new.customer_name, new.customer_gender, now())
  on conflict (salon_id, phone) do update
    set name            = coalesce(nullif(public.customers.name, ''), excluded.name),
        last_booking_at = now();

  -- Phase 3: a booking from a targeted customer counts as a win-back
  -- return — scoped to campaigns from the SAME salon only, so a customer
  -- returning at salon B is never attributed to salon A's campaign just
  -- because they share a phone number.
  update public.campaign_targets ct
     set returned = true, returned_at = now()
   where ct.customer_phone = new.customer_phone
     and ct.salon_id = new.salon_id
     and ct.returned = false
     and exists (select 1 from public.campaigns c
                  where c.id = ct.campaign_id and c.salon_id = new.salon_id and c.status = 'sent');

  update public.campaigns c
     set returned_count = (select count(*) from public.campaign_targets t
                            where t.campaign_id = c.id and t.returned)
   where c.salon_id = new.salon_id and c.status = 'sent';

  -- Phase 4: award points once, when the visit is actually completed —
  -- using THIS salon's own loyalty rules, never another salon's.
  if new.status = 'completed'
     and coalesce(old.status, '') <> 'completed'
     and new.points_awarded = 0 then
    select coalesce(s.loyalty_points, ls.points_per_visit) into pts
      from public.loyalty_settings ls
      left join public.services s on s.id = new.service_id and s.salon_id = new.salon_id
     where ls.salon_id = new.salon_id;
    pts := coalesce(pts, 10);

    insert into public.loyalty_ledger (salon_id, customer_phone, delta, reason, appointment_id)
    values (new.salon_id, new.customer_phone, pts, 'visit', new.id);

    update public.customers
       set loyalty_points = loyalty_points + pts,
           total_visits   = total_visits + 1
     where phone = new.customer_phone and salon_id = new.salon_id;

    new.points_awarded := pts;
  end if;

  -- Anti-fraud: both the referrer's AND the new customer's own referral
  -- bonus, scoped to the same salon throughout (referred_by lookup,
  -- loyalty_settings rules, and both loyalty_ledger inserts/updates).
  if new.status = 'completed' and new.referral_verified = true then
    select referred_by into ref_phone from public.customers
     where phone = new.customer_phone and salon_id = new.salon_id;
    if ref_phone is not null and ref_phone <> new.customer_phone
       and not exists (
         select 1 from public.loyalty_ledger
          where reason = 'referral' and appointment_id = new.id and salon_id = new.salon_id
       ) then
      select referral_points into ref_pts from public.loyalty_settings where salon_id = new.salon_id;
      ref_pts := coalesce(ref_pts, 50);
      insert into public.loyalty_ledger (salon_id, customer_phone, delta, reason, appointment_id) values
        (new.salon_id, ref_phone, ref_pts, 'referral', new.id),
        (new.salon_id, new.customer_phone, ref_pts, 'referral', new.id);
      update public.customers set loyalty_points = loyalty_points + ref_pts
       where phone in (ref_phone, new.customer_phone) and salon_id = new.salon_id;
    end if;
  end if;

  return new;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- guard_anonymous_appt_update() — found broken the same way during
-- testing: its audit_log insert never set salon_id, which is now NOT
-- NULL. This trigger fires on every appointment update (self-service
-- cancel/reschedule, and every staff edit), so this was blocking, not
-- cosmetic — confirmed by a real constraint-violation error when marking
-- an appointment completed. Only the audit_log insert needed salon_id
-- added; everything else in this trigger is unchanged.
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
    insert into public.audit_log (salon_id, event, actor, detail) values (
      new.salon_id, 'appointment_self_update', null,
      jsonb_build_object('appointment_id', new.id, 'from_status', old.status, 'to_status', new.status)
    );
  elsif public.my_role() = 'stylist' and not public.is_manager() then
    if new.customer_phone is distinct from old.customer_phone
       or new.customer_name is distinct from old.customer_name
       or new.staff_id is distinct from old.staff_id
       or new.service_id is distinct from old.service_id
       or new.final_price is distinct from old.final_price
       or new.original_price is distinct from old.original_price
       or new.discount_type is distinct from old.discount_type
       or new.discount_value is distinct from old.discount_value then
      raise exception 'این تغییر خارج از اختیار آرایشگر است';
    end if;
  end if;
  return new;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- audit_role_change() — the third and last audit_log insert in the whole
-- schema with the same missing-salon_id bug (found by grepping every
-- occurrence after finding the first two by testing). Fires on users
-- table updates, so new.salon_id refers to the affected user's own salon.
-- ----------------------------------------------------------------------------
create or replace function public.audit_role_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.role is distinct from old.role then
    insert into public.audit_log (salon_id, event, actor, detail) values (
      new.salon_id, 'role_change', auth.uid(),
      jsonb_build_object('user_id', new.id, 'phone', new.phone, 'from_role', old.role, 'to_role', new.role)
    );
  end if;
  return new;
end;
$fn$;
