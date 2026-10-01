-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 3 of 3: RLS + views)
-- ============================================================================
-- The security-critical part. Every policy below is DROPPED and RECREATED
-- with the exact same role logic it already had, plus one additional,
-- unconditional requirement: salon_id = current_salon_id(). This is a
-- pure AND — it can only narrow what a role could already see/do, never
-- widen it, so nothing here changes single-tenant behavior (with only one
-- salon in the database, current_salon_id() resolves to that one salon
-- for everyone, same net effect as before).
--
-- current_salon_id() now serves two different callers:
--   - Authenticated staff (managers/stylists): resolved from their OWN
--     users row — unspoofable, tied to their real login.
--   - Anonymous public visitors (the booking flow): resolved from an
--     explicit `x-salon-id` request header, set by the frontend once it
--     has resolved the salon from the URL slug (see the delivery notes
--     for exactly how/where the frontend sets this).
--
-- The header path is a correctness mechanism for public browsing, not a
-- security boundary — and it doesn't need to be one. It only ever governs
-- tables that were ALREADY globally public pre-multi-tenancy (services,
-- stylists, working hours, approved dates — a salon's public menu/hours,
-- not customer data): the isolation of actual customer/business data
-- (appointments, customers, expenses, revenue, staff accounts) never
-- depends on this header anywhere below — those policies additionally
-- require is_manager()/is_staff()/matching stylist ownership, which is
-- ALWAYS derived from the caller's own authenticated users row.
-- ============================================================================

create or replace function public.current_salon_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select salon_id from public.users where id = auth.uid()),
    nullif(current_setting('request.headers', true)::json ->> 'x-salon-id', '')::uuid
  );
$fn$;
grant execute on function public.current_salon_id() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Public-read loop (services, stylists, working_hours, time_offs,
-- approved_dates, loyalty_settings) — was `using (true)`, now scoped to
-- the requesting salon (staff: their own; public: the x-salon-id header).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['services','stylists','working_hours','time_offs','approved_dates','loyalty_settings'] loop
    execute format('drop policy if exists p_read_public on public.%I', t);
    execute format('create policy p_read_public on public.%I for select using (salon_id = public.current_salon_id())', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Manager-write loop (services, stylists, expenses, campaigns,
-- campaign_targets, sms_templates, loyalty_settings, customers).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['services','stylists','expenses','campaigns','campaign_targets','sms_templates','loyalty_settings','customers'] loop
    execute format('drop policy if exists p_mgr_write on public.%I', t);
    execute format(
      'create policy p_mgr_write on public.%I for all using (public.is_manager() and salon_id = public.current_salon_id()) with check (public.is_manager() and salon_id = public.current_salon_id())',
      t
    );
  end loop;
end $$;

-- Stylist self-registration: unchanged phone-matches-identity check, plus
-- the new stylist must be joining the salon their own signup declared via
-- the x-salon-id header (a brand-new person has no users row yet, so the
-- users-row branch of current_salon_id() is never available to them at
-- this exact moment — the header is the only source, by construction).
drop policy if exists p_stylists_selfreg on public.stylists;
create policy p_stylists_selfreg on public.stylists for insert
  with check (
    not exists (select 1 from public.users where id = auth.uid())
    and split_part(coalesce(auth.email(), ''), '@', 1) = phone
    and salon_id = public.current_salon_id()
  );

-- ----------------------------------------------------------------------------
-- Manager-only read loop (expenses, campaigns, campaign_targets,
-- sms_messages, sms_templates, loyalty_ledger).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['expenses','campaigns','campaign_targets','sms_messages','sms_templates','loyalty_ledger'] loop
    execute format('drop policy if exists p_staff_read on public.%I', t);
    execute format(
      'create policy p_staff_read on public.%I for select using (public.is_manager() and salon_id = public.current_salon_id())',
      t
    );
  end loop;
end $$;

-- customers: special stylist-scoped read policy (kept exactly as it was,
-- just salon-scoped in addition).
drop policy if exists p_staff_read on public.customers;
create policy p_staff_read on public.customers for select using (
  salon_id = public.current_salon_id()
  and (
    public.is_manager()
    or exists (
      select 1 from public.appointments a
      where a.customer_phone = customers.phone
        and a.salon_id = customers.salon_id
        and a.staff_id = public.my_stylist_id()
    )
  )
);

-- ----------------------------------------------------------------------------
-- Schedule surfaces (working_hours, time_offs, approved_dates):
-- manager does anything within their salon; a stylist edits only their
-- own rows within their own salon.
-- ----------------------------------------------------------------------------
drop policy if exists p_sched_write on public.working_hours;
create policy p_sched_write on public.working_hours for all
  using (
    salon_id = public.current_salon_id()
    and (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  )
  with check (
    salon_id = public.current_salon_id()
    and (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  );

drop policy if exists p_sched_write on public.time_offs;
create policy p_sched_write on public.time_offs for all
  using (
    salon_id = public.current_salon_id()
    and (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  )
  with check (
    salon_id = public.current_salon_id()
    and (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  );

drop policy if exists p_sched_write on public.approved_dates;
create policy p_sched_write on public.approved_dates for all
  using (salon_id = public.current_salon_id() and public.is_manager())
  with check (salon_id = public.current_salon_id() and public.is_manager());

-- ----------------------------------------------------------------------------
-- appointments — select/insert/update/delete.
-- ----------------------------------------------------------------------------
drop policy if exists p_appt_select on public.appointments;
create policy p_appt_select on public.appointments for select using (
  salon_id = public.current_salon_id()
  and (
    public.is_manager()
    or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  )
);

drop policy if exists p_appt_insert on public.appointments;
create policy p_appt_insert on public.appointments for insert
  with check (salon_id = public.current_salon_id() and (public.is_manager() or public.is_staff()));

drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  salon_id = public.current_salon_id()
  and (
    public.is_manager()
    or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  )
);

drop policy if exists p_appt_delete on public.appointments;
create policy p_appt_delete on public.appointments for delete
  using (salon_id = public.current_salon_id() and public.is_manager());

-- ----------------------------------------------------------------------------
-- waitlist — public insert/select (matches the public booking flow),
-- staff-only delete, all salon-scoped.
-- ----------------------------------------------------------------------------
drop policy if exists p_wait_insert on public.waitlist;
create policy p_wait_insert on public.waitlist for insert with check (salon_id = public.current_salon_id());
drop policy if exists p_wait_select on public.waitlist;
create policy p_wait_select on public.waitlist for select using (salon_id = public.current_salon_id());
drop policy if exists p_wait_delete on public.waitlist;
create policy p_wait_delete on public.waitlist for delete
  using (salon_id = public.current_salon_id() and public.is_staff());

-- ----------------------------------------------------------------------------
-- sms_messages insert (managers only, plus the Edge Function's service-role
-- path which already bypasses RLS entirely — unaffected).
-- ----------------------------------------------------------------------------
drop policy if exists p_sms_insert on public.sms_messages;
create policy p_sms_insert on public.sms_messages for insert
  with check (salon_id = public.current_salon_id() and public.is_manager());

-- ----------------------------------------------------------------------------
-- users — self-read/self-insert unchanged in spirit; manager access and
-- the read-any-user-at-my-salon branch both salon-scoped.
-- ----------------------------------------------------------------------------
drop policy if exists p_users_self on public.users;
create policy p_users_self on public.users for select using (
  id = auth.uid() or (public.is_manager() and salon_id = public.current_salon_id())
);
drop policy if exists p_users_mgr on public.users;
create policy p_users_mgr on public.users for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_users_selfins on public.users;
create policy p_users_selfins on public.users for insert
  with check (id = auth.uid() and salon_id = public.current_salon_id());

-- ----------------------------------------------------------------------------
-- audit_log, customer_segment_settings, campaign_logs, campaign_conversions,
-- app_settings — all manager-scoped reads/writes, now also salon-scoped.
-- ----------------------------------------------------------------------------
drop policy if exists p_audit_read on public.audit_log;
create policy p_audit_read on public.audit_log for select
  using (public.is_manager() and salon_id = public.current_salon_id());

drop policy if exists p_segment_settings_read on public.customer_segment_settings;
create policy p_segment_settings_read on public.customer_segment_settings for select
  using (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_segment_settings_write on public.customer_segment_settings;
create policy p_segment_settings_write on public.customer_segment_settings for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());

drop policy if exists p_campaign_logs_read on public.campaign_logs;
create policy p_campaign_logs_read on public.campaign_logs for select
  using (public.is_manager() and salon_id = public.current_salon_id());
drop policy if exists p_campaign_logs_write on public.campaign_logs;
create policy p_campaign_logs_write on public.campaign_logs for insert
  with check (public.is_manager() and salon_id = public.current_salon_id());

drop policy if exists p_campaign_conversions_read on public.campaign_conversions;
create policy p_campaign_conversions_read on public.campaign_conversions for select
  using (public.is_manager() and salon_id = public.current_salon_id());

drop policy if exists p_app_settings_read on public.app_settings;
create policy p_app_settings_read on public.app_settings for select
  using (salon_id = public.current_salon_id());
drop policy if exists p_app_settings_write on public.app_settings;
create policy p_app_settings_write on public.app_settings for update
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());

-- ----------------------------------------------------------------------------
-- appointments_public_slots — was completely unscoped (selected from
-- every salon's appointments with no filter at all: a real cross-tenant
-- data leak of staff_id/date/time slot availability). Now filtered to the
-- requesting salon, using the SAME current_salon_id() the rest of this
-- migration relies on (a plain function call, works the same inside a
-- view as anywhere else).
-- ----------------------------------------------------------------------------
create or replace view public.appointments_public_slots as
select staff_id, date, start_min, end_min, buffer_minutes, status
from public.appointments
where salon_id = public.current_salon_id();
