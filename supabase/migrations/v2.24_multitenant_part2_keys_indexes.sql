-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 2 of 3: composite
-- keys and indexes)
-- ============================================================================
-- Two tables had a business key that was only safe under single-tenancy
-- and must become composite now that the SAME phone number or calendar
-- date is legitimately independent data per salon:
--   - customers: phone was the primary key. Under multi-tenancy the same
--     phone number is a DIFFERENT customer at salon A vs salon B — the
--     real key is (salon_id, phone).
--   - approved_dates: date was the primary key (one calendar globally).
--     Each salon must be able to independently open/close the same
--     calendar date — the real key is (salon_id, date).
-- Two foreign keys point at customers(phone) and must be widened to match
-- its new composite key, or every insert into those tables would break.
-- Idempotent (checks pg_constraint/pg_indexes before altering).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- customers: phone -> (salon_id, phone). Both dependent foreign keys
-- (loyalty_ledger.customer_phone, customers.referred_by) must be dropped
-- FIRST — Postgres refuses to drop a primary key that something else
-- still references — then re-added against the new composite key.
-- The whole block is skipped if the PK is already the composite key
-- (true on every run after the first), so re-running never tries to
-- drop a PK that newly-added FKs from a prior run now also depend on.
-- ----------------------------------------------------------------------------
alter table public.loyalty_ledger add column if not exists salon_id uuid;
update public.loyalty_ledger set salon_id = '00000000-0000-0000-0000-000000000001'::uuid where salon_id is null;
alter table public.loyalty_ledger alter column salon_id set not null;

do $$
declare v_is_composite boolean;
begin
  select (array_agg(attname::text order by attname) = array['phone', 'salon_id'])
    into v_is_composite
    from pg_constraint c
    join unnest(c.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conname = 'customers_pkey' and c.conrelid = 'public.customers'::regclass
    group by c.conname;

  if not coalesce(v_is_composite, false) then
    if exists (select 1 from pg_constraint where conname = 'loyalty_ledger_customer_phone_fkey') then
      alter table public.loyalty_ledger drop constraint loyalty_ledger_customer_phone_fkey;
    end if;
    if exists (select 1 from pg_constraint where conname = 'customers_referred_by_fkey') then
      alter table public.customers drop constraint customers_referred_by_fkey;
    end if;
    alter table public.customers drop constraint customers_pkey;
    alter table public.customers add constraint customers_pkey primary key (salon_id, phone);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loyalty_ledger_salon_phone_fkey') then
    alter table public.loyalty_ledger add constraint loyalty_ledger_salon_phone_fkey
      foreign key (salon_id, customer_phone) references public.customers (salon_id, phone) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customers_referred_by_salon_fkey') then
    alter table public.customers add constraint customers_referred_by_salon_fkey
      foreign key (salon_id, referred_by) references public.customers (salon_id, phone) on delete set null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- approved_dates: date -> (salon_id, date). No dependent foreign keys
-- reference this table, so this is a straightforward key swap.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'approved_dates_pkey' and conrelid = 'public.approved_dates'::regclass) then
    alter table public.approved_dates drop constraint approved_dates_pkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approved_dates_pkey' and conrelid = 'public.approved_dates'::regclass) then
    alter table public.approved_dates add constraint approved_dates_pkey primary key (salon_id, date);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- users.phone: was globally unique; a phone number can now legitimately
-- be staff at more than one salon (each a separate auth identity — see
-- the delivery checklist for the follow-up synthetic-email limitation
-- this still has). Scope uniqueness to (salon_id, phone) instead.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'users_phone_key') then
    alter table public.users drop constraint users_phone_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_salon_phone_key') then
    alter table public.users add constraint users_salon_phone_key unique (salon_id, phone);
  end if;
end $$;

-- working_hours: the existing "one salon-wide row per weekday" index
-- (staff_id is null) must become one-per-TENANT-per-weekday, not a single
-- global row shared by every salon.
drop index if exists working_hours_salon_uniq;
create unique index if not exists working_hours_tenant_default_uniq
  on public.working_hours (salon_id, day_of_week) where staff_id is null;

-- sms_messages: the existing idempotency key must also be scoped per
-- salon (two different salons legitimately sending an identical
-- idempotency key — e.g. both derived the same way from an
-- appointment id namespaced only within their own data — must not
-- collide with each other).
drop index if exists sms_messages_idempotency_key_uidx;
create unique index if not exists sms_messages_salon_idempotency_key_uidx
  on public.sms_messages (salon_id, idempotency_key) where idempotency_key is not null;

-- campaign_conversions: unique(appointment_id) already can't collide
-- across salons since appointment ids are already globally distinct
-- (uid()-generated) — no change needed there.

-- ----------------------------------------------------------------------------
-- Composite indexes for the hot query paths at 300+-salon scale. Every
-- one of these leads with salon_id, since every real query in this app
-- is always scoped to "the current salon" first (RLS enforces this is
-- true for every access path, not just an optimization hint).
-- ----------------------------------------------------------------------------
create index if not exists appointments_salon_date_idx        on public.appointments (salon_id, date);
create index if not exists appointments_salon_staff_date_idx  on public.appointments (salon_id, staff_id, date);
create index if not exists appointments_salon_phone_idx       on public.appointments (salon_id, customer_phone);
create index if not exists appointments_salon_status_idx      on public.appointments (salon_id, status);
create index if not exists customers_salon_idx                on public.customers (salon_id);
create index if not exists stylists_salon_idx                 on public.stylists (salon_id) where active;
create index if not exists services_salon_idx                 on public.services (salon_id) where is_active;
create index if not exists sms_messages_salon_sent_idx        on public.sms_messages (salon_id, sent_at);
create index if not exists expenses_salon_date_idx            on public.expenses (salon_id, date);
create index if not exists loyalty_ledger_salon_phone_idx     on public.loyalty_ledger (salon_id, customer_phone);
create index if not exists campaign_logs_salon_sent_idx        on public.campaign_logs (salon_id, sent_at);
create index if not exists users_salon_idx                    on public.users (salon_id);
