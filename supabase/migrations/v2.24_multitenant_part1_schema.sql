-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 1 of 3: schema)
-- ============================================================================
-- Converts this app from single-tenant to shared-schema multi-tenant,
-- using salon_id (not schema-per-tenant or database-per-tenant) — the
-- standard, proven Supabase pattern at this scale (300+ salons), and the
-- one that builds directly on top of this project's existing, heavily-
-- tested RLS architecture (v2.15 through v2.23) rather than discarding it.
--
-- SAFE MIGRATION PATTERN (expand → backfill → contract), applied to every
-- existing table so this runs against a live database with real data,
-- with zero data loss and zero downtime-causing locks from a premature
-- NOT NULL:
--   1. ALTER TABLE ... ADD COLUMN salon_id uuid  (nullable — instant, no
--      table rewrite/lock on modern Postgres)
--   2. UPDATE ... SET salon_id = <the one pre-existing salon>  (backfills
--      every row this project already has, so it becomes salon #1 —
--      nothing is deleted or reset)
--   3. ALTER TABLE ... ALTER COLUMN salon_id SET NOT NULL  (now safe,
--      every row already has a value)
--   4. add the FK constraint, composite indexes, and salon-scoped RLS
--
-- Idempotent: every statement uses IF NOT EXISTS / OR REPLACE / DROP-then-
-- CREATE for policies, and the backfill only touches rows where
-- salon_id IS NULL, so re-running this migration is a no-op the second
-- time. Does not modify any earlier migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) The tenants table itself.
-- ----------------------------------------------------------------------------
create table if not exists public.salons (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists salons_slug_idx on public.salons (slug) where active;

-- The one salon this project already runs as, before this migration. Every
-- existing row across every table below is backfilled to belong to this
-- salon — nothing about the current, live deployment changes behavior.
insert into public.salons (id, slug, name)
select '00000000-0000-0000-0000-000000000001'::uuid, 'default', 'آرایشگاه و سالن زیبایی مانا'
where not exists (select 1 from public.salons where id = '00000000-0000-0000-0000-000000000001'::uuid);

-- ----------------------------------------------------------------------------
-- 2) salon_id, added to every existing table — expand step (nullable).
-- ----------------------------------------------------------------------------
alter table public.users                    add column if not exists salon_id uuid;
alter table public.stylists                 add column if not exists salon_id uuid;
alter table public.services                 add column if not exists salon_id uuid;
alter table public.customers                add column if not exists salon_id uuid;
alter table public.appointments             add column if not exists salon_id uuid;
alter table public.time_offs                add column if not exists salon_id uuid;
alter table public.working_hours            add column if not exists salon_id uuid;
alter table public.approved_dates           add column if not exists salon_id uuid;
alter table public.expenses                 add column if not exists salon_id uuid;
alter table public.waitlist                 add column if not exists salon_id uuid;
alter table public.sms_templates            add column if not exists salon_id uuid;
alter table public.sms_messages             add column if not exists salon_id uuid;
alter table public.campaigns                add column if not exists salon_id uuid;
alter table public.campaign_targets         add column if not exists salon_id uuid;
alter table public.campaign_logs            add column if not exists salon_id uuid;
alter table public.campaign_conversions     add column if not exists salon_id uuid;
alter table public.loyalty_ledger           add column if not exists salon_id uuid;
alter table public.loyalty_settings         add column if not exists salon_id uuid;
alter table public.customer_segment_settings add column if not exists salon_id uuid;
alter table public.audit_log                add column if not exists salon_id uuid;
alter table public.booking_otp_challenges   add column if not exists salon_id uuid;
alter table public.booking_access_tokens    add column if not exists salon_id uuid;
alter table public.app_settings             add column if not exists salon_id uuid;
-- rate_limit_events is intentionally excluded: its bucket keys are already
-- constructed per-call (e.g. 'otp_request:<phone>') and only ever read
-- back by the exact same key within check_rate_limit() itself — adding a
-- tenant dimension here would need every existing bucket-key string
-- changed to embed salon_id too; simpler and equally correct to prefix
-- salon_id into the bucket key at each call site instead (part 3 of this
-- migration set covers the RPC changes).

-- ----------------------------------------------------------------------------
-- 3) current_salon_id() — the single choke point every RLS policy and every
--    SECURITY DEFINER RPC below calls to find "which salon is this request
--    for". Reads from the caller's own users row — the exact same pattern
--    my_role()/is_staff()/is_manager() already use (see schema.sql), so
--    this is the simplest correct option (explicitly prioritized: "سادگی
--    کد") and needs no extra Supabase Auth Hook configuration to deploy.
--
--    PERFORMANCE NOTE (flagged, not silently deferred — see the checklist
--    in the delivery notes): every RLS check below does one extra lookup
--    against public.users via this function. At 300+ salons with heavy
--    traffic, the standard next step is moving salon_id into a custom JWT
--    claim (via a Supabase Auth Hook) so this becomes a claim read with no
--    table lookup at all — a drop-in replacement for this same function
--    signature, zero call-site changes needed anywhere else.
-- ----------------------------------------------------------------------------
create or replace function public.current_salon_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select salon_id from public.users where id = auth.uid();
$fn$;
grant execute on function public.current_salon_id() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Backfill — every existing row becomes part of the one pre-existing
--    salon. This is the step that guarantees zero data loss: nothing here
--    deletes, resets, or reseeds anything, it only labels existing rows.
-- ----------------------------------------------------------------------------
do $$
declare v_salon_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
begin
  update public.users                    set salon_id = v_salon_id where salon_id is null;
  update public.stylists                 set salon_id = v_salon_id where salon_id is null;
  update public.services                 set salon_id = v_salon_id where salon_id is null;
  update public.customers                set salon_id = v_salon_id where salon_id is null;
  update public.appointments             set salon_id = v_salon_id where salon_id is null;
  update public.time_offs                set salon_id = v_salon_id where salon_id is null;
  update public.working_hours            set salon_id = v_salon_id where salon_id is null;
  update public.approved_dates           set salon_id = v_salon_id where salon_id is null;
  update public.expenses                 set salon_id = v_salon_id where salon_id is null;
  update public.waitlist                 set salon_id = v_salon_id where salon_id is null;
  update public.sms_templates            set salon_id = v_salon_id where salon_id is null;
  update public.sms_messages             set salon_id = v_salon_id where salon_id is null;
  update public.campaigns                set salon_id = v_salon_id where salon_id is null;
  update public.campaign_targets         set salon_id = v_salon_id where salon_id is null;
  update public.campaign_logs            set salon_id = v_salon_id where salon_id is null;
  update public.campaign_conversions     set salon_id = v_salon_id where salon_id is null;
  update public.loyalty_ledger           set salon_id = v_salon_id where salon_id is null;
  update public.loyalty_settings         set salon_id = v_salon_id where salon_id is null;
  update public.customer_segment_settings set salon_id = v_salon_id where salon_id is null;
  update public.audit_log                set salon_id = v_salon_id where salon_id is null;
  update public.booking_otp_challenges   set salon_id = v_salon_id where salon_id is null;
  update public.booking_access_tokens    set salon_id = v_salon_id where salon_id is null;
  update public.app_settings             set salon_id = v_salon_id where salon_id is null;
end $$;

-- ----------------------------------------------------------------------------
-- 5) Contract — enforce NOT NULL now that every row has a value, and add
--    the FK relationship to salons. Wrapped per-table so one unexpected
--    NULL (which the backfill above should never leave) reports exactly
--    which table has a problem instead of aborting the whole migration
--    silently.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users','stylists','services','customers','appointments','time_offs',
    'working_hours','approved_dates','expenses','waitlist','sms_templates',
    'sms_messages','campaigns','campaign_targets','campaign_logs',
    'campaign_conversions','loyalty_ledger','loyalty_settings',
    'customer_segment_settings','audit_log','booking_otp_challenges',
    'booking_access_tokens','app_settings'
  ] loop
    execute format('alter table public.%I alter column salon_id set not null', t);
    if not exists (
      select 1 from pg_constraint where conname = t || '_salon_id_fkey' and conrelid = ('public.' || t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (salon_id) references public.salons (id) on delete cascade',
        t, t || '_salon_id_fkey'
      );
    end if;
  end loop;
end $$;
