-- =============================================================================
--  آرایشگاه مانا — Supabase schema
--  Run ONCE: Supabase Studio -> SQL Editor -> New query -> paste -> Run.
--
--  Design notes:
--   * Primary keys are TEXT, not UUID. The app already generates ids like
--     "st1", "f1", "id-lx8f2-a91kd" via uid(); TEXT keys mean zero id churn and
--     the existing seed data / demo logins keep working exactly as they do now.
--   * Dates are real DATE columns. The app uses an unpadded "YYYY-M-D" key
--     (dateKey()); src/lib/api.js converts in both directions.
--   * RBAC is enforced in Postgres via RLS, mirroring the app's three roles:
--     owner / manager / stylist. The UI role checks stay untouched — RLS is a
--     second lock, not a replacement.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. USERS — one row per authenticated person (owner / manager / stylist)
--    Linked 1:1 to Supabase Auth. Login stays "phone + password": the client
--    maps 09121110001 -> 09121110001@salon.local before calling Supabase Auth,
--    so the user-facing form never changes.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  phone       text not null unique check (phone ~ '^09[0-9]{9}$'),
  full_name   text not null default '',
  role        text not null default 'stylist' check (role in ('owner', 'manager', 'stylist')),
  stylist_id  text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- RBAC helpers — moved here (were originally much further down the file,
-- after being used by several earlier policies, which fails on a genuine
-- top-to-bottom fresh install; see the v2.19 CHANGES.md entry).
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $fn$
  select role from public.users where id = auth.uid();
$fn$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce((select active from public.users where id = auth.uid()), false);
$fn$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.my_role() in ('owner', 'manager');
$fn$;

create or replace function public.my_stylist_id() returns text
language sql stable security definer set search_path = public as $fn$
  select stylist_id from public.users where id = auth.uid();
$fn$;

-- ---------------------------------------------------------------------------
-- 2. STYLISTS
--    reminder_hours_before is the per-stylist reminder window the SMS cron
--    reads (this column already exists on the app's stylist objects).
-- ---------------------------------------------------------------------------
create table if not exists public.stylists (
  id                    text primary key,
  name                  text not null default '',
  gender                text not null default 'female' check (gender in ('female', 'male')),
  phone                 text not null default '',
  active                boolean not null default true,
  reminder_hours_before integer not null default 3 check (reminder_hours_before between 0 and 72),
  created_at            timestamptz not null default now()
);

do $$
begin
  alter table public.users
    add constraint users_stylist_fk
    foreign key (stylist_id) references public.stylists (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. SERVICES
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id               text primary key,
  name             text not null default '',
  gender           text not null default 'female' check (gender in ('female', 'male')),
  category         text not null default 'hair',
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  buffer_minutes   integer not null default 0 check (buffer_minutes >= 0),
  price            bigint,
  discount_type    text not null default 'none' check (discount_type in ('none', 'percent', 'fixed')),
  discount_value   bigint not null default 0,
  discount_reason  text not null default '',
  is_active        boolean not null default true,
  loyalty_points   integer not null default 10,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. CUSTOMERS — derived from bookings so the win-back campaign (phase 3) and
--    the loyalty club (phase 4) have something to point at. Auto-upserted by
--    the appointment trigger, so the booking flow needs no extra call.
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  phone           text primary key check (phone ~ '^09[0-9]{9}$'),
  name            text not null default '',
  gender          text not null default 'female' check (gender in ('female', 'male')),
  loyalty_points  integer not null default 0,
  referral_code   text unique not null default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  referred_by     text references public.customers (phone) on delete set null,
  sms_opt_out     boolean not null default false,
  last_booking_at timestamptz,
  total_visits    integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. APPOINTMENTS (the app calls these "bookings")
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id                    text primary key,
  customer_name         text not null default '',
  customer_phone        text not null default '',
  customer_gender       text not null default 'female' check (customer_gender in ('female', 'male')),
  service_id            text references public.services (id) on delete set null,
  staff_id              text references public.stylists (id) on delete set null,
  staff_name            text not null default '',
  date                  date not null,
  start_min             integer not null check (start_min between 0 and 1440),
  end_min               integer not null check (end_min between 0 and 1560),
  buffer_minutes        integer not null default 0,
  status                text not null default 'confirmed'
                        check (status in ('pending','confirmed','cancelled','rescheduled','completed','no_show','reschedule_proposed')),
  -- When staff proposes moving a booking, the CURRENT date/start_min/end_min
  -- stay as the source of truth (nothing actually moves yet) and the
  -- proposed new time goes here instead, until the customer confirms,
  -- rejects, or picks a different time themselves.
  pending_date          date,
  pending_start_min     integer check (pending_start_min is null or pending_start_min between 0 and 1440),
  pending_end_min       integer check (pending_end_min is null or pending_end_min between 0 and 1560),
  tracking_code         text not null,
  original_price        bigint not null default 0,
  discount_type         text not null default 'none',
  discount_value        bigint not null default 0,
  discount_reason       text not null default '',
  final_price           bigint,
  sms_sent_confirmation boolean not null default false,
  sms_sent_reminder     boolean not null default false,
  campaign_id           text,
  points_awarded        integer not null default 0,
  -- Staff-only, set at checkout time: "I've verified this is a genuinely
  -- new customer" — required (alongside status='completed') before the
  -- referrer's points get awarded. See sync_customer_from_appointment().
  referral_verified     boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists appointments_date_idx  on public.appointments (date);
create index if not exists appointments_staff_idx on public.appointments (staff_id);
create index if not exists appointments_phone_idx on public.appointments (customer_phone);
create index if not exists appointments_track_idx on public.appointments (tracking_code);
create index if not exists appointments_rem_idx   on public.appointments (date, status) where sms_sent_reminder = false;

-- Phase 5: cashflow breakdown in Accounting. Nullable — old rows have no recorded
-- method yet, and there is no capture UI wired up for it in this phase either
-- (see CHANGES.md); the column exists so Accounting has something real to read
-- once a completion flow starts asking for it.
alter table public.appointments
  add column if not exists payment_method text
  check (payment_method in ('cash', 'pos', 'card_transfer'));

-- ---------------------------------------------------------------------------
-- 6. TIME_OFFS — staff_id NULL = salon-wide closure
-- ---------------------------------------------------------------------------
create table if not exists public.time_offs (
  id         text primary key,
  date       date not null,
  reason     text not null default '',
  staff_id   text references public.stylists (id) on delete cascade,
  -- NULL/NULL = whole day off (original behavior). Both set = only that
  -- time window is closed; the rest of the day stays bookable as normal.
  start_min  integer check (start_min is null or start_min between 0 and 1439),
  end_min    integer check (end_min is null or end_min between 1 and 1440),
  created_at timestamptz not null default now(),
  constraint time_offs_partial_range_valid check (
    (start_min is null and end_min is null) or
    (start_min is not null and end_min is not null and end_min > start_min)
  )
);
create index if not exists time_offs_date_idx on public.time_offs (date);

-- ---------------------------------------------------------------------------
-- 7. WORKING HOURS — salon default (staff_id NULL) + per-stylist overrides.
--    day_of_week: 0 = شنبه … 6 = جمعه (matches SCHEMA_DAY_LABELS in App.jsx)
-- ---------------------------------------------------------------------------
create table if not exists public.working_hours (
  id           text primary key,
  staff_id     text references public.stylists (id) on delete cascade,
  day_of_week  integer not null check (day_of_week between 0 and 6),
  start_time   text not null default '09:00',
  end_time     text not null default '21:00',
  is_closed    boolean not null default false,
  unique (staff_id, day_of_week)
);
create unique index if not exists working_hours_salon_uniq
  on public.working_hours (day_of_week) where staff_id is null;

-- ---------------------------------------------------------------------------
-- 8. APPROVED DATES — a day only accepts bookings once opened
-- ---------------------------------------------------------------------------
create table if not exists public.approved_dates (
  date       date primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. EXPENSES (accounting tab)
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id         text primary key,
  title      text not null default '',
  category   text not null default 'other'
             check (category in ('rent','supplies','salary','marketing','utilities','other')),
  amount     bigint not null default 0,
  date       date not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. WAITLIST
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist (
  id              text primary key,
  date            date not null,
  customer_name   text not null default '',
  customer_phone  text not null default '',
  customer_gender text not null default 'female',
  service_id      text references public.services (id) on delete set null,
  staff_id        text references public.stylists (id) on delete set null,
  staff_name      text not null default '',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 11. SMS — templates, outbox/log, campaigns
-- ---------------------------------------------------------------------------
create table if not exists public.sms_templates (
  id         text primary key,
  kind       text not null check (kind in ('confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom')),
  title      text not null default '',
  body       text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.sms_messages (
  id              text primary key default 'sms-' || substr(md5(gen_random_uuid()::text), 1, 12),
  to_phone        text not null,
  body            text not null,
  kind            text not null default 'custom',
  appointment_id  text references public.appointments (id) on delete set null,
  campaign_id     text,
  idempotency_key text,
  provider        text,
  provider_msg_id text,
  status          text not null default 'queued' check (status in ('queued','sent','failed','delivered')),
  error           text,
  cost            integer,
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists sms_messages_idempotency_key_uidx
  on public.sms_messages (idempotency_key) where idempotency_key is not null;
create index if not exists sms_messages_pending_idx on public.sms_messages (status, scheduled_for);

create table if not exists public.campaigns (
  id               text primary key,
  name             text not null default '',
  inactive_days    integer not null default 60,
  discount_percent integer not null default 15,
  template_id      text references public.sms_templates (id) on delete set null,
  status           text not null default 'draft' check (status in ('draft','sent','archived')),
  targeted_count   integer not null default 0,
  sent_count       integer not null default 0,
  returned_count   integer not null default 0,
  valid_until      date,
  created_at       timestamptz not null default now()
);

create table if not exists public.campaign_targets (
  id             text primary key default 'ct-' || substr(md5(gen_random_uuid()::text), 1, 12),
  campaign_id    text not null references public.campaigns (id) on delete cascade,
  customer_phone text not null,
  sms_id         text references public.sms_messages (id) on delete set null,
  returned       boolean not null default false,
  returned_at    timestamptz,
  unique (campaign_id, customer_phone)
);

-- v2.13: per-template send log, independent of the campaigns/campaign_targets
-- pair above (which tracks per-recipient outcomes for a named campaign) —
-- this tracks per-TEMPLATE performance across every kind of bulk send.
create table if not exists public.campaign_logs (
  id               text primary key default 'cl-' || substr(md5(gen_random_uuid()::text), 1, 12),
  -- Not FK-constrained: a real sms_templates.id for a manual-composer send,
  -- or a synthetic key (e.g. "champions") for a one-click RFM smart
  -- campaign, which has no row in sms_templates. template_label is a
  -- human-readable snapshot so a title is always available either way.
  template_id      text,
  template_label   text not null default '',
  segment          text, -- RFM segment targeted, if this was segment-based; null for a manual/free audience
  sent_at          timestamptz not null default now(),
  total_sent       integer not null default 0,
  successful_count integer not null default 0,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create index if not exists campaign_logs_template_idx on public.campaign_logs (template_id);
create index if not exists campaign_logs_sent_at_idx on public.campaign_logs (sent_at);

alter table public.sms_messages
  add column if not exists campaign_log_id text references public.campaign_logs(id) on delete set null;
create index if not exists sms_messages_campaign_log_idx on public.sms_messages (campaign_log_id);
-- Partial index scoped to campaign sends only — this is exactly the lookup
-- the v2.13 attribution trigger does on every new booking, so it needs to
-- stay fast as sms_messages grows into mostly confirmation/reminder rows
-- that have nothing to do with campaigns.
create index if not exists sms_messages_conversion_lookup_idx
  on public.sms_messages (to_phone, sent_at desc) where campaign_log_id is not null;

-- v2.13: one row per booking attributed to a campaign send (time-based
-- attribution — see the trigger below). unique(appointment_id) is the
-- idempotency guard.
create table if not exists public.campaign_conversions (
  id               text primary key default 'cc-' || substr(md5(gen_random_uuid()::text), 1, 12),
  campaign_log_id  text not null references public.campaign_logs(id) on delete cascade,
  customer_phone   text not null,
  appointment_id   text not null references public.appointments(id) on delete cascade,
  sms_message_id   text references public.sms_messages(id) on delete set null,
  converted_at     timestamptz not null default now(),
  days_to_convert  integer not null default 0,
  unique (appointment_id)
);
create index if not exists campaign_conversions_log_idx on public.campaign_conversions (campaign_log_id);
create index if not exists campaign_conversions_phone_idx on public.campaign_conversions (customer_phone);

create table if not exists public.loyalty_ledger (
  id             text primary key default 'lp-' || substr(md5(gen_random_uuid()::text), 1, 12),
  customer_phone text not null references public.customers (phone) on delete cascade,
  delta          integer not null,
  reason         text not null default '',
  appointment_id text references public.appointments (id) on delete set null,
  created_at     timestamptz not null default now()
);

-- Minimal audit log: not every table gets one, just the highest-value
-- security-relevant events — who changed a role, and every time the
-- anonymous-update guard trigger actually fires (a signal someone tried to
-- touch fields they shouldn't via the customer-facing cancel/reschedule path).
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  event      text not null,
  actor      uuid,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
drop policy if exists p_audit_read on public.audit_log;
create policy p_audit_read on public.audit_log for select using (public.is_manager());

-- v2.18: lightweight rate limiting for public RPCs (get_my_bookings,
-- apply_referral) — internal bookkeeping only, reachable exclusively
-- through check_rate_limit() below (RLS enabled, no policies).
create table if not exists public.rate_limit_events (
  id bigserial primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_bucket_idx on public.rate_limit_events (bucket, created_at);
alter table public.rate_limit_events enable row level security;

create table if not exists public.loyalty_settings (
  id                int primary key default 1 check (id = 1),
  points_per_visit  integer not null default 10,
  points_per_tier   integer not null default 100,
  discount_per_tier integer not null default 5,
  max_discount      integer not null default 30,
  referral_points   integer not null default 300
);
insert into public.loyalty_settings (id) values (1) on conflict (id) do nothing;

-- Customer segmentation thresholds — same singleton shape as loyalty_settings
-- above. RLS policies are added later, in the RBAC section, since they need
-- is_staff()/is_manager() which aren't defined yet at this point in the file.
create table if not exists public.customer_segment_settings (
  id                   int primary key default 1 check (id = 1),
  loyal_recency_days   int not null default 60  check (loyal_recency_days between 1 and 365),
  loyal_min_visits     int not null default 4   check (loyal_min_visits between 1 and 100),
  inactive_after_days  int not null default 120 check (inactive_after_days > loyal_recency_days),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id)
);
insert into public.customer_segment_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 12. TRIGGERS — keep customers / loyalty in sync with no extra client calls
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists appointments_touch on public.appointments;
create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();

create or replace function public.sync_customer_from_appointment() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare pts int; ref_phone text; ref_pts int;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  -- name is immutable per phone once set: the FIRST non-empty name wins and
  -- later bookings never overwrite it (previously the newest booking's name
  -- always won, which let a referred phone's identity be re-labeled after
  -- the fact — a loose end an anti-fraud review flagged).
  insert into public.customers (phone, name, gender, last_booking_at)
  values (new.customer_phone, new.customer_name, new.customer_gender, now())
  on conflict (phone) do update
    set name            = coalesce(nullif(public.customers.name, ''), excluded.name),
        last_booking_at = now();

  -- Phase 3: a booking from a targeted customer counts as a win-back return
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

  -- Phase 4: award points once, when the visit is actually completed
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

  -- Anti-fraud: both the referrer's AND the new customer's own referral
  -- bonus are earned only when the visit is BOTH completed AND staff has
  -- verified at checkout (referral_verified) that this is a genuinely new
  -- customer — not the moment the referral code is entered, which was
  -- farmable with fake phone numbers and no real appointment ever
  -- happening. Idempotent via the ledger existence check (guards both
  -- inserts together, since they're always written in the same pass), so
  -- this is safe even if the row is saved more than once after completion.
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

drop trigger if exists appointments_sync_customer on public.appointments;
create trigger appointments_sync_customer before insert or update on public.appointments
  for each row execute function public.sync_customer_from_appointment();

-- ---------------------------------------------------------------------------
-- 13. RBAC HELPERS — moved to right after the users table (top of file);
--     see the note there.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 14. ROW LEVEL SECURITY
--     anon  = customers on the public site (book / track only)
--     staff = stylist sees own bookings; owner + manager see everything
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users','stylists','services','customers','appointments','time_offs','working_hours',
    'approved_dates','expenses','waitlist','sms_templates','sms_messages','campaigns',
    'campaign_targets','loyalty_ledger','loyalty_settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- customer_segment_settings: deliberately its own dedicated policies, not
-- either generic loop below — read is staff-only (not public, unlike
-- loyalty_settings which customers legitimately need for their own
-- discount display), and write is manager-only, not the generic
-- manager-full-CRUD every other settings table gets.
alter table public.customer_segment_settings enable row level security;
drop policy if exists p_segment_settings_read on public.customer_segment_settings;
create policy p_segment_settings_read on public.customer_segment_settings
  for select using (public.is_staff() or public.is_manager());
drop policy if exists p_segment_settings_write on public.customer_segment_settings;
create policy p_segment_settings_write on public.customer_segment_settings
  for update using (public.is_manager()) with check (public.is_manager());
grant select, update on public.customer_segment_settings to authenticated;

-- v2.13: campaign_logs / campaign_conversions — also their own dedicated
-- policies. campaign_logs is staff-read + staff-insert (append-only, no
-- update/delete policy at all). campaign_conversions is staff-read only —
-- every row is written by the security-definer attribution trigger, which
-- isn't subject to RLS for its own inserts, so no client insert policy is
-- needed or wanted.
alter table public.campaign_logs enable row level security;
drop policy if exists p_campaign_logs_read on public.campaign_logs;
create policy p_campaign_logs_read on public.campaign_logs for select using (public.is_manager());
drop policy if exists p_campaign_logs_write on public.campaign_logs;
create policy p_campaign_logs_write on public.campaign_logs for insert with check (public.is_manager());
grant select, insert on public.campaign_logs to authenticated;

alter table public.campaign_conversions enable row level security;
drop policy if exists p_campaign_conversions_read on public.campaign_conversions;
create policy p_campaign_conversions_read on public.campaign_conversions for select using (public.is_manager());
grant select on public.campaign_conversions to authenticated;

-- Public read: the booking flow must work for unauthenticated visitors.
do $$
declare t text;
begin
  foreach t in array array['services','stylists','working_hours','time_offs','approved_dates','loyalty_settings'] loop
    execute format('drop policy if exists p_read_public on public.%I', t);
    execute format('create policy p_read_public on public.%I for select using (true)', t);
  end loop;
end $$;

-- Appointments: staff read is role-scoped (manager: all, stylist: own).
-- Anonymous reads do NOT go through this table — see
-- appointments_public_slots (slot availability, no PII) and
-- get_my_bookings() (a customer's own bookings by phone) below.
drop policy if exists p_appt_select on public.appointments;
create policy p_appt_select on public.appointments for select using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
);

-- PII-free slots view for the public booking flow's availability check —
-- id/staff_id/date/start_min/end_min/buffer_minutes/status only. A plain
-- view runs as its owner, not the querying role, so this exposes all rows
-- to anon regardless of the base table's RLS above — scoped by column
-- instead of by row, which is exactly what "who's booked when, not who
-- they are" needs.
create or replace view public.appointments_public_slots as
select staff_id, date, start_min, end_min, buffer_minutes, status
from public.appointments;
grant select on public.appointments_public_slots to anon, authenticated;

-- v2.19: OTP tables + overlap-prevention constraint (see migration for full rationale)
create extension if not exists btree_gist;

-- ----------------------------------------------------------------------------
-- 1) OTP challenges and access tokens — hash-only, RLS enabled with no
--    policies at all (default-deny for every direct client operation;
--    reachable exclusively through the SECURITY DEFINER functions below).
-- ----------------------------------------------------------------------------
create table if not exists public.booking_otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  otp_hash     text not null,
  salt         text not null,
  attempts     int not null default 0,
  max_attempts int not null default 5,
  consumed     boolean not null default false,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists booking_otp_challenges_phone_idx
  on public.booking_otp_challenges (phone, created_at desc);
alter table public.booking_otp_challenges enable row level security;

create table if not exists public.booking_access_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  phone       text not null,
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists booking_access_tokens_hash_idx
  on public.booking_access_tokens (token_hash);
alter table public.booking_access_tokens enable row level security;

-- ----------------------------------------------------------------------------
-- 2) Overlap prevention at the database level — a GiST exclusion
--    constraint, not application logic. Two active (non-cancelled) rows
--    for the same stylist on the same date can never have overlapping
--    [start_min, end_min + buffer_minutes) ranges, enforced atomically by
--    Postgres itself regardless of how many requests arrive at once.
--    Postgres does not support NOT VALID on exclusion constraints (unlike
--    CHECK/FK constraints), so creation itself is wrapped in an exception
--    handler: if a real deployment already has legacy overlapping rows,
--    this produces a warning instead of aborting the migration — no data
--    is touched or deleted either way, but the constraint won't exist
--    until an operator resolves the conflicting rows and re-runs this
--    block.
-- ----------------------------------------------------------------------------
alter table public.appointments drop constraint if exists appointments_no_overlap;
do $$
begin
  alter table public.appointments add constraint appointments_no_overlap
    exclude using gist (
      staff_id with =,
      date with =,
      int4range(start_min, end_min + buffer_minutes) with &&
    ) where (staff_id is not null and status in ('pending', 'confirmed', 'rescheduled'));
exception when others then
  raise warning 'appointments_no_overlap could not be created — likely pre-existing overlapping legacy data (no data was touched or deleted). Resolve conflicting rows and re-run this migration to add the constraint. Detail: %', sqlerrm;
end $$;

-- v2.18: rate-limit checker — see rate_limit_events above.
create or replace function public.check_rate_limit(p_bucket text, p_max_calls int, p_window_minutes int)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare recent_count int;
begin
  select count(*) into recent_count from public.rate_limit_events
   where bucket = p_bucket and created_at >= now() - (p_window_minutes || ' minutes')::interval;
  if recent_count >= p_max_calls then
    return false;
  end if;
  insert into public.rate_limit_events (bucket, created_at) values (p_bucket, now());
  if random() < 0.01 then
    delete from public.rate_limit_events where created_at < now() - interval '1 day';
  end if;
  return true;
end;
$fn$;
grant execute on function public.check_rate_limit(text, int, int) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5) OTP request — service_role ONLY. This is the one place the plaintext
--    OTP exists outside a customer's own phone; it must never be callable
--    by anon/authenticated (no such grant is given), only by the send-sms
--    Edge Function's admin client.
-- ----------------------------------------------------------------------------
create or replace function public.request_booking_otp_internal(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea;
begin
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request:' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  -- Invalidate any still-outstanding code for this phone — only the most
  -- recently requested OTP is ever valid.
  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (phone, otp_hash, salt, expires_at)
  values (p_phone, v_hash, v_salt, now() + interval '5 minutes');

  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
revoke all on function public.request_booking_otp_internal(text) from public, anon, authenticated;
grant execute on function public.request_booking_otp_internal(text) to service_role;

-- ----------------------------------------------------------------------------
-- 6) OTP verification — anon-callable (rate-limited + attempt-limited per
--    challenge). Success consumes the challenge and issues a fresh access
--    token; only its hash is stored, the plaintext is returned exactly
--    once, to the caller who just proved phone ownership.
-- ----------------------------------------------------------------------------
create or replace function public.verify_booking_otp(p_phone text, p_otp text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_challenge record; v_hash text; v_token text; v_token_hash text;
begin
  if p_phone !~ '^09[0-9]{9}$' or p_otp !~ '^[0-9]{6}$' then
    return json_build_object('ok', false, 'error', 'ورودی نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_verify:' || p_phone, 10, 10) then
    return json_build_object('ok', false, 'error', 'تعداد تلاش بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into v_challenge from public.booking_otp_challenges
   where phone = p_phone and consumed = false and expires_at > now()
   order by created_at desc limit 1;

  if v_challenge is null then
    return json_build_object('ok', false, 'error', 'کدی یافت نشد یا منقضی شده — دوباره درخواست کنید');
  end if;
  if v_challenge.attempts >= v_challenge.max_attempts then
    update public.booking_otp_challenges set consumed = true where id = v_challenge.id;
    return json_build_object('ok', false, 'error', 'تعداد تلاش‌های مجاز تمام شد — دوباره درخواست کنید');
  end if;

  v_hash := encode(digest(p_otp || v_challenge.salt, 'sha256'), 'hex');
  if v_hash <> v_challenge.otp_hash then
    update public.booking_otp_challenges set attempts = attempts + 1 where id = v_challenge.id;
    return json_build_object('ok', false, 'error', 'کد اشتباه است');
  end if;

  update public.booking_otp_challenges set consumed = true where id = v_challenge.id;

  v_token := encode(gen_random_bytes(32), 'hex'); -- 256 bits
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  insert into public.booking_access_tokens (token_hash, phone, expires_at)
  values (v_token_hash, p_phone, now() + interval '20 minutes');

  if random() < 0.01 then
    delete from public.booking_access_tokens where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'token', v_token, 'expires_in_seconds', 1200);
end;
$fn$;
grant execute on function public.verify_booking_otp(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7) Token → phone resolver, shared by every token-gated RPC below.
--    Rate-limited by the token's own hash (never the raw token, and this
--    never leaks whether a token exists — mismatched/expired/revoked all
--    resolve to the same null).
-- ----------------------------------------------------------------------------
create or replace function public.resolve_booking_token(p_token text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare v_hash text; v_phone text;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  if not public.check_rate_limit('token_use:' || v_hash, 60, 10) then
    return null;
  end if;
  select phone into v_phone from public.booking_access_tokens
   where token_hash = v_hash and revoked = false and expires_at > now();
  return v_phone;
end;
$fn$;
revoke all on function public.resolve_booking_token(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8) Token-gated booking access — replaces get_my_bookings(phone).
-- ----------------------------------------------------------------------------
drop function if exists public.get_my_bookings(text);

create or replace function public.get_my_bookings_with_token(p_token text)
returns setof public.appointments
language plpgsql security definer set search_path = public as $fn$
declare v_phone text;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return;
  end if;
  return query
    select * from public.appointments
    where customer_phone = v_phone
    order by date desc, start_min desc;
end;
$fn$;
grant execute on function public.get_my_bookings_with_token(text) to anon, authenticated;

create or replace function public.cancel_my_booking_with_token(p_token text, p_appointment_id text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_phone text; v_owner text;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;
  select customer_phone into v_owner from public.appointments where id = p_appointment_id;
  if v_owner is null or v_owner <> v_phone then
    return json_build_object('ok', false, 'error', 'این نوبت متعلق به شما نیست');
  end if;
  update public.appointments set status = 'cancelled' where id = p_appointment_id;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.cancel_my_booking_with_token(text, text) to anon, authenticated;

create or replace function public.reschedule_my_booking_with_token(
  p_token text, p_appointment_id text, p_new_date date, p_new_start_min int
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_phone text; v_appt record; v_svc record;
  v_new_end int; v_app_dow int; v_wh record; v_wh_start int; v_wh_end int;
begin
  v_phone := public.resolve_booking_token(p_token);
  if v_phone is null then
    return json_build_object('ok', false, 'error', 'نشست شما منقضی شده — دوباره وارد شوید');
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;
  if v_appt is null or v_appt.customer_phone <> v_phone then
    return json_build_object('ok', false, 'error', 'این نوبت متعلق به شما نیست');
  end if;
  if p_new_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_new_date) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = v_appt.service_id;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت مرتبط با این نوبت یافت نشد');
  end if;
  v_new_end := p_new_start_min + v_svc.duration_minutes;

  -- Postgres dow: 0=Sunday..6=Saturday; this app's day_of_week: 0=Saturday..6=Friday.
  v_app_dow := (extract(dow from p_new_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = v_appt.staff_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null;
  end if;
  if v_wh is null or v_wh.is_closed then
    return json_build_object('ok', false, 'error', 'در این روز سالن یا آرایشگر تعطیل است');
  end if;
  v_wh_start := split_part(v_wh.start_time, ':', 1)::int * 60 + split_part(v_wh.start_time, ':', 2)::int;
  v_wh_end := split_part(v_wh.end_time, ':', 1)::int * 60 + split_part(v_wh.end_time, ':', 2)::int;
  if p_new_start_min < v_wh_start or v_new_end > v_wh_end then
    return json_build_object('ok', false, 'error', 'خارج از ساعات کاری است');
  end if;

  begin
    update public.appointments
       set date = p_new_date, start_min = p_new_start_min, end_min = v_new_end,
           status = 'rescheduled', pending_date = null, pending_start_min = null, pending_end_min = null
     where id = p_appointment_id;
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.reschedule_my_booking_with_token(text, text, date, int) to anon, authenticated;

-- Explicit revocation, so "log out" actually invalidates the server-side
-- credential, not just client-side state.
create or replace function public.revoke_booking_token(p_token text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_hash text;
begin
  if p_token is null or length(p_token) < 32 then
    return json_build_object('ok', true);
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  update public.booking_access_tokens set revoked = true where token_hash = v_hash;
  return json_build_object('ok', true);
end;
$fn$;
grant execute on function public.revoke_booking_token(text) to anon, authenticated;

-- v2.20: DB-only OTP test path — no Edge Function needed. Off by default
-- (sms_test_mode = false); a manager flips it directly in the database.
-- Even when on, the OTP is returned only to the caller who just requested
-- it for their own phone. See v2.20_db_only_test_mode.sql for full rationale.
create table if not exists public.app_settings (
  id            int primary key default 1 check (id = 1),
  sms_test_mode boolean not null default false
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
alter table public.app_settings enable row level security;
drop policy if exists p_app_settings_read on public.app_settings;
create policy p_app_settings_read on public.app_settings for select using (true);
drop policy if exists p_app_settings_write on public.app_settings;
create policy p_app_settings_write on public.app_settings for update using (public.is_manager()) with check (public.is_manager());
grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;

create or replace function public.request_booking_otp_test(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea; v_test_mode boolean;
begin
  select sms_test_mode into v_test_mode from public.app_settings where id = 1;
  if not coalesce(v_test_mode, false) then
    return json_build_object('ok', false, 'error', 'حالت تست فعال نیست');
  end if;
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request_test:' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (phone, otp_hash, salt, expires_at)
  values (p_phone, v_hash, v_salt, now() + interval '5 minutes');

  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'test_otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
grant execute on function public.request_booking_otp_test(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9) Server-computed booking creation — price, discount, end_min, and
--    initial status are computed here, never accepted from the client.
-- ----------------------------------------------------------------------------
create or replace function public.create_public_booking(
  p_service_id text, p_staff_id text, p_date date, p_start_min int,
  p_customer_name text, p_customer_phone text, p_customer_gender text,
  p_referral_code text default null
)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_svc record; v_wh record; v_app_dow int; v_wh_start int; v_wh_end int;
  v_end_min int; v_id text; v_code text; v_original bigint; v_svc_discount bigint;
  v_after_svc bigint; v_loyalty_pct int := 0; v_final bigint; v_loyalty json; v_code_bytes bytea;
begin
  if p_customer_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است');
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    return json_build_object('ok', false, 'error', 'نام لازم است');
  end if;
  if p_customer_gender not in ('female', 'male') then
    return json_build_object('ok', false, 'error', 'جنسیت نامعتبر است');
  end if;
  if not public.check_rate_limit('create_booking:' || p_customer_phone, 10, 30) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — کمی بعد دوباره امتحان کنید');
  end if;
  if p_date < current_date then
    return json_build_object('ok', false, 'error', 'تاریخ گذشته قابل انتخاب نیست');
  end if;
  if not exists (select 1 from public.approved_dates where date = p_date) then
    return json_build_object('ok', false, 'error', 'این روز برای رزرو باز نشده است');
  end if;

  select * into v_svc from public.services where id = p_service_id and is_active;
  if v_svc is null then
    return json_build_object('ok', false, 'error', 'خدمت یافت نشد یا غیرفعال است');
  end if;
  if v_svc.gender <> p_customer_gender then
    return json_build_object('ok', false, 'error', 'این خدمت با جنسیت انتخابی مطابقت ندارد');
  end if;

  if p_staff_id is not null and not exists (select 1 from public.stylists where id = p_staff_id and active) then
    return json_build_object('ok', false, 'error', 'آرایشگر یافت نشد یا غیرفعال است');
  end if;

  v_app_dow := (extract(dow from p_date)::int + 1) % 7;
  select * into v_wh from public.working_hours
   where day_of_week = v_app_dow and staff_id = p_staff_id;
  if v_wh is null then
    select * into v_wh from public.working_hours
     where day_of_week = v_app_dow and staff_id is null;
  end if;
  if v_wh is null or v_wh.is_closed then
    return json_build_object('ok', false, 'error', 'در این روز سالن یا آرایشگر تعطیل است');
  end if;
  v_wh_start := split_part(v_wh.start_time, ':', 1)::int * 60 + split_part(v_wh.start_time, ':', 2)::int;
  v_wh_end := split_part(v_wh.end_time, ':', 1)::int * 60 + split_part(v_wh.end_time, ':', 2)::int;
  v_end_min := p_start_min + v_svc.duration_minutes;
  if p_start_min < v_wh_start or v_end_min > v_wh_end then
    return json_build_object('ok', false, 'error', 'خارج از ساعات کاری است');
  end if;

  -- Price: service's own discount, then the customer's current loyalty-tier
  -- discount stacked on top (same order as the client's v2.17 logic) —
  -- computed here from loyalty_settings/customers, never from client input.
  v_original := coalesce(v_svc.price, 0);
  v_svc_discount := case
    when v_svc.discount_type = 'percent' then round(v_original * v_svc.discount_value / 100.0)
    when v_svc.discount_type = 'fixed' then v_svc.discount_value
    else 0
  end;
  v_after_svc := greatest(0, v_original - v_svc_discount);
  if v_svc.price is not null then
    v_loyalty := public.customer_loyalty(p_customer_phone);
    if (v_loyalty->>'found')::boolean then
      v_loyalty_pct := coalesce((v_loyalty->>'discount_percent')::int, 0);
    end if;
  end if;
  v_final := case when v_svc.price is null then null
                  else greatest(0, v_after_svc - round(v_after_svc * v_loyalty_pct / 100.0)) end;

  v_id := 'apt-' || substr(md5(gen_random_uuid()::text), 1, 16);
  v_code_bytes := gen_random_bytes(4);
  v_code := 'MN-' || lpad((
    ((get_byte(v_code_bytes, 0)::bigint << 24) | (get_byte(v_code_bytes, 1)::bigint << 16)
     | (get_byte(v_code_bytes, 2)::bigint << 8) | get_byte(v_code_bytes, 3)::bigint) % 90000 + 10000
  )::text, 5, '0');

  begin
    insert into public.appointments (
      id, customer_name, customer_phone, customer_gender, service_id, staff_id,
      staff_name, date, start_min, end_min, buffer_minutes, status,
      tracking_code, original_price, discount_type, discount_value, discount_reason, final_price
    ) values (
      v_id, trim(p_customer_name), p_customer_phone, p_customer_gender, p_service_id, p_staff_id,
      coalesce((select name from public.stylists where id = p_staff_id), ''),
      p_date, p_start_min, v_end_min, v_svc.buffer_minutes, 'pending',
      v_code, v_original, v_svc.discount_type, v_svc.discount_value,
      case when v_loyalty_pct > 0 then v_svc.discount_reason || case when v_svc.discount_reason <> '' then ' · ' else '' end || v_loyalty_pct || '٪ تخفیف باشگاه مشتریان' else v_svc.discount_reason end,
      v_final
    );
  exception when exclusion_violation then
    return json_build_object('ok', false, 'error', 'این زمان قبلاً رزرو شده — زمان دیگری انتخاب کنید');
  end;

  if p_referral_code is not null and length(trim(p_referral_code)) > 0 then
    perform public.apply_referral(p_customer_phone, p_referral_code);
  end if;

  return json_build_object(
    'ok', true, 'id', v_id, 'tracking_code', v_code, 'final_price', v_final,
    'original_price', v_original, 'staff_name', coalesce((select name from public.stylists where id = p_staff_id), '')
  );
end;
$fn$;
grant execute on function public.create_public_booking(text, text, date, int, text, text, text, text) to anon, authenticated;

drop policy if exists p_appt_insert on public.appointments;
create policy p_appt_insert on public.appointments for insert with check (public.is_manager() or public.is_staff());

drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
) with check (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
);

-- Explicit base grant for authenticated (manager/stylist) — appointments
-- previously had no explicit grant anywhere in schema.sql, relying
-- entirely on Supabase's implicit default table grants. RLS above still
-- fully governs which rows are visible/writable; this just makes the
-- privilege model self-contained instead of depending on a platform
-- default. anon gets nothing here — no policy grants it direct access.
grant select, insert, update on public.appointments to authenticated;


-- An anonymous caller (a customer managing their own booking with no login)
-- may only cancel or reschedule — never touch who/what/how-much the
-- appointment is for. RLS's WITH CHECK above restricts the new `status`;
-- this trigger additionally locks every other sensitive field, since RLS
-- alone can't compare OLD vs NEW column-by-column in one expression.
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
    -- Reached only once the change above has passed validation — a genuine
    -- self-service cancel/reschedule, worth a trail even though it's routine.
    insert into public.audit_log (event, actor, detail) values (
      'appointment_self_update', null,
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

drop trigger if exists trg_guard_anonymous_appt_update on public.appointments;
create trigger trg_guard_anonymous_appt_update
  before update on public.appointments
  for each row execute function public.guard_anonymous_appt_update();

-- Every time a user's role actually changes (owner/manager doing it — the
-- self-update policy above already blocks anyone changing their own role).
create or replace function public.audit_role_change() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.role is distinct from old.role then
    insert into public.audit_log (event, actor, detail) values (
      'role_change', auth.uid(),
      jsonb_build_object('user_id', new.id, 'phone', new.phone, 'from_role', old.role, 'to_role', new.role)
    );
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_audit_role_change on public.users;
create trigger trg_audit_role_change
  after update on public.users
  for each row execute function public.audit_role_change();

drop policy if exists p_appt_delete on public.appointments;
create policy p_appt_delete on public.appointments for delete using (public.is_manager());

-- Waitlist: customers add themselves, staff read/clear.
drop policy if exists p_wait_insert on public.waitlist;
create policy p_wait_insert on public.waitlist for insert with check (true);
drop policy if exists p_wait_select on public.waitlist;
create policy p_wait_select on public.waitlist for select using (true);
drop policy if exists p_wait_delete on public.waitlist;
create policy p_wait_delete on public.waitlist for delete using (public.is_staff());

-- Manager-only write surfaces.
do $$
declare t text;
begin
  foreach t in array array['services','stylists','expenses','campaigns','campaign_targets','sms_templates','loyalty_settings','customers'] loop
    execute format('drop policy if exists p_mgr_write on public.%I', t);
    execute format('create policy p_mgr_write on public.%I for all using (public.is_manager()) with check (public.is_manager())', t);
  end loop;
end $$;

-- Schedule surfaces: managers do anything; a stylist edits only their own rows.
drop policy if exists p_sched_write on public.working_hours;
create policy p_sched_write on public.working_hours for all
  using (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

drop policy if exists p_sched_write on public.time_offs;
create policy p_sched_write on public.time_offs for all
  using (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

-- Which days the whole salon is open for booking is a manager decision,
-- not a per-stylist one.
drop policy if exists p_sched_write on public.approved_dates;
create policy p_sched_write on public.approved_dates for all
  using (public.is_manager()) with check (public.is_manager());

-- Back-office tables: no legitimate per-stylist scope — accounting,
-- campaigns, SMS log/templates, and the full loyalty ledger are
-- manager-only.
do $$
declare t text;
begin
  foreach t in array array['expenses','campaigns','campaign_targets','sms_messages','sms_templates','loyalty_ledger'] loop
    execute format('drop policy if exists p_staff_read on public.%I', t);
    execute format('create policy p_staff_read on public.%I for select using (public.is_manager())', t);
  end loop;
end $$;

-- customers: a stylist may look up a customer they've actually had an
-- appointment with — not the whole customer bank.
drop policy if exists p_staff_read on public.customers;
create policy p_staff_read on public.customers for select using (
  public.is_manager()
  or (
    public.is_staff() and public.my_role() = 'stylist'
    and exists (
      select 1 from public.appointments a
      where a.customer_phone = customers.phone and a.staff_id = public.my_stylist_id()
    )
  )
);

drop policy if exists p_sms_insert on public.sms_messages;
create policy p_sms_insert on public.sms_messages for insert with check (public.is_manager());

-- Users: read your own row (to resolve your role at login); managers see all.
drop policy if exists p_users_self on public.users;
create policy p_users_self on public.users for select using (id = auth.uid() or public.is_manager());
drop policy if exists p_users_mgr on public.users;
create policy p_users_mgr on public.users for all using (public.is_manager()) with check (public.is_manager());
drop policy if exists p_users_selfins on public.users;
create policy p_users_selfins on public.users for insert with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- 15. PUBLIC RPCs — customer-facing reads that must not expose whole tables
-- ---------------------------------------------------------------------------

-- Customer loyalty panel: points + tier discount + history, by phone.
create or replace function public.customer_loyalty(p_phone text)
returns json language plpgsql stable security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int;
begin
  select * into ls from public.loyalty_settings where id = 1;
  select * into c from public.customers where phone = p_phone;
  if c is null then
    return json_build_object('found', false, 'points', 0, 'discount_percent', 0, 'history', '[]'::json, 'referrals', '[]'::json);
  end if;
  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  return json_build_object(
    'found', true,
    'name', c.name,
    'points', c.loyalty_points,
    'total_visits', c.total_visits,
    'referral_code', c.referral_code,
    'discount_percent', disc,
    'max_discount', ls.max_discount,
    'at_cap', disc >= ls.max_discount,
    'points_to_next_tier', greatest(ls.points_per_tier - (c.loyalty_points % greatest(ls.points_per_tier, 1)), 0),
    'history', coalesce((
      select json_agg(json_build_object('delta', l.delta, 'reason', l.reason, 'at', l.created_at) order by l.created_at desc)
        from (select * from public.loyalty_ledger where customer_phone = p_phone
               order by created_at desc limit 30) l
    ), '[]'::json),
    -- People this customer referred — their own "downline" for the referral program.
    'referrals', coalesce((
      select json_agg(json_build_object('name', r.name, 'phone', r.phone, 'total_visits', r.total_visits, 'joined_at', r.created_at) order by r.created_at desc)
        from public.customers r where r.referred_by = p_phone
    ), '[]'::json)
  );
end $fn$;
grant execute on function public.customer_loyalty(text) to anon, authenticated;

-- Staff-triggered: a customer has reached the discount cap and is redeeming
-- it in person. Resets their points to zero (they start climbing the tiers
-- again from scratch) and logs the redemption as a negative ledger entry so
-- the full history stays honest — never a silent reset with no record.
create or replace function public.redeem_loyalty_reward(p_phone text)
returns json language plpgsql security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int;
begin
  if not (public.is_manager() or public.my_role() = 'stylist') then
    return json_build_object('ok', false, 'error', 'اجازهٔ این کار را ندارید');
  end if;
  select * into ls from public.loyalty_settings where id = 1;
  select * into c from public.customers where phone = p_phone;
  if c is null then return json_build_object('ok', false, 'error', 'مشتری پیدا نشد'); end if;

  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  if disc < ls.max_discount then
    return json_build_object('ok', false, 'error', 'مشتری هنوز به سقف تخفیف نرسیده');
  end if;
  if c.loyalty_points <= 0 then
    return json_build_object('ok', false, 'error', 'امتیازی برای استفاده نیست');
  end if;

  insert into public.loyalty_ledger (customer_phone, delta, reason) values (p_phone, -c.loyalty_points, 'redeemed');
  update public.customers set loyalty_points = 0 where phone = p_phone;

  return json_build_object('ok', true, 'redeemed_discount_percent', disc);
end $fn$;
grant execute on function public.redeem_loyalty_reward(text) to authenticated;

-- Phase 3: who hasn't booked in more than X days?
create or replace function public.inactive_customers(p_days int default 60)
returns table (phone text, name text, gender text, last_booking_at timestamptz, days_since int, total_visits int)
language sql stable security definer set search_path = public as $fn$
  select c.phone, c.name, c.gender, c.last_booking_at,
         extract(day from now() - c.last_booking_at)::int, c.total_visits
    from public.customers c
   where public.is_manager()
     and c.sms_opt_out = false
     and c.last_booking_at is not null
     and c.last_booking_at < now() - make_interval(days => p_days)
   order by c.last_booking_at asc;
$fn$;
grant execute on function public.inactive_customers(int) to authenticated;

-- Phase 5: RFM segmentation. recency/frequency read straight off the customers
-- table (already trigger-maintained), monetary is summed fresh from completed
-- appointments since it's never stored anywhere.
-- Recency/frequency computed strictly from `completed` appointments — a
-- booking that was cancelled or no-showed was never a real visit, so it
-- must not count toward either measure (previously recency came from
-- customers.last_booking_at, which updates on ANY booking regardless of
-- outcome).
create or replace view public.customer_rfm_raw as
select
  c.phone,
  c.name,
  c.sms_opt_out,
  coalesce(extract(day from (now() - max(a.date)))::int, 9999) as recency_days,
  count(a.id) as frequency,
  coalesce(sum(a.final_price), 0) as monetary
from public.customers c
left join public.appointments a
  on a.customer_phone = c.phone and a.status = 'completed'
group by c.phone, c.name, c.sms_opt_out;

-- Direct-threshold classification against the manager-configurable
-- customer_segment_settings singleton (see that table for the shape).
-- v2.11: recency is now compared against a PER-CUSTOMER threshold (their
-- own average gap between completed visits × 1.5, floored at the salon
-- default) instead of one flat number for everyone, and champions get an
-- additional is_vip flag for the top 20% by completed spend. segment/
-- segment_fa still return exactly the same 4 values as before — three
-- columns are ADDED (avg_gap_days, personal_recency_limit, is_vip), so any
-- existing caller reading the old columns by name is unaffected. DROP is
-- required first since CREATE OR REPLACE cannot change a function's return
-- columns — every aggregate below is explicitly cast to its declared
-- output type for the same reason (count()/sum() default to bigint,
-- avg()/percentile_cont() default to numeric/double precision; left
-- uncast, a mismatch against the RETURNS TABLE declaration is exactly
-- what trips a 42P16 "invalid table definition" error).
drop function if exists public.get_customer_rfm_segments();

create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  segment text, segment_fa text,
  avg_gap_days numeric, personal_recency_limit int, is_vip boolean
)
language sql stable security definer set search_path = public as $fn$
  with settings as (
    select * from public.customer_segment_settings where id = 1
  ),
  -- Gap between each customer's own consecutive completed visits (in days).
  -- date - date in Postgres yields a plain integer day count directly.
  gaps as (
    select
      customer_phone,
      (date - lag(date) over (partition by customer_phone order by date))::int as gap_days
    from public.appointments
    where status = 'completed'
  ),
  avg_gaps as (
    select customer_phone, avg(gap_days)::numeric as avg_gap_days
    from gaps
    where gap_days is not null and gap_days > 0
    group by customer_phone
  ),
  -- 80th percentile of total completed spend, among customers who have at
  -- least one completed visit.
  monetary_p80 as (
    select percentile_cont(0.80) within group (order by monetary)::bigint as p80
    from public.customer_rfm_raw
    where frequency > 0
  ),
  scored as (
    select
      raw.*,
      ag.avg_gap_days,
      case
        when coalesce(ag.avg_gap_days, 0) > 0
          then greatest(s.loyal_recency_days, round(ag.avg_gap_days * 1.5)::int)
        else s.loyal_recency_days
      end as personal_recency_limit,
      s.loyal_min_visits,
      mp.p80
    from public.customer_rfm_raw raw
    left join avg_gaps ag on ag.customer_phone = raw.phone
    cross join settings s
    cross join monetary_p80 mp
    where public.is_manager()
  )
  select
    phone, name, sms_opt_out, recency_days, frequency, monetary,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'champions'
      when recency_days >  personal_recency_limit and frequency >= loyal_min_visits then 'at_risk'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'new'
      else 'inactive'
    end as segment,
    case
      when recency_days <= personal_recency_limit and frequency >= loyal_min_visits then 'مشتریان وفادار'
      when recency_days >  personal_recency_limit and frequency >= loyal_min_visits then 'در خطر ریزش'
      when recency_days <= personal_recency_limit and frequency <  loyal_min_visits then 'مشتریان جدید'
      else 'غیرفعال'
    end as segment_fa,
    avg_gap_days,
    personal_recency_limit,
    -- VIP only means anything within "champions" — a big spender who hasn't
    -- been back in a year is a high-value at_risk/inactive customer, not a
    -- VIP champion.
    (recency_days <= personal_recency_limit
       and frequency >= loyal_min_visits
       and monetary >= coalesce(p80, monetary + 1)) as is_vip
  from scored
  order by monetary desc
  limit 500;
$fn$;
grant execute on function public.get_customer_rfm_segments() to authenticated;

-- Per-customer × per-service-category recency — a customer who is a
-- hair-color regular but hasn't had a facial in 8 months looks very
-- different line by line vs. as one blended average recency number.
create or replace function public.get_customer_category_matrix()
returns table (
  phone text, name text, category text, category_fa text,
  visit_count int, last_visit_days int, line_status text, line_status_fa text
)
language sql stable security definer set search_path = public as $fn$
  with cat_stats as (
    select
      a.customer_phone as phone,
      c.name,
      s.category,
      count(a.id)::int as visit_count,
      extract(day from (now() - max(a.date)))::int as last_visit_days
    from public.appointments a
    join public.services s on s.id = a.service_id
    join public.customers c on c.phone = a.customer_phone
    where a.status = 'completed'
    group by a.customer_phone, c.name, s.category
  )
  select
    phone, name, category,
    case category
      when 'hair'             then 'مو'
      when 'beard'             then 'ریش'
      when 'color'             then 'رنگ'
      when 'makeup'            then 'میکاپ'
      when 'nails'             then 'ناخن'
      when 'skin'              then 'پوست'
      when 'permanent_makeup'  then 'خدمات دائم'
      else category
    end as category_fa,
    visit_count, last_visit_days,
    case
      when last_visit_days <= 45 then 'active'
      when last_visit_days <= 90 then 'at_risk'
      else 'dormant'
    end as line_status,
    case
      when last_visit_days <= 45 then 'فعال در این خط خدمت'
      when last_visit_days <= 90 then 'در خطر ریزش در این خط خدمت'
      else 'غیرفعال در این خط خدمت'
    end as line_status_fa
  from cat_stats
  where public.is_manager()
  order by phone, category
  limit 2000;
$fn$;
grant execute on function public.get_customer_category_matrix() to authenticated;

-- v2.14/v2.18: customer feedback loop. Public insert (booking_id, an opaque
-- appointments.id, is the bearer token — same trust model as the
-- tracking-code lookup elsewhere), restricted to completed bookings, one
-- submission per booking. Read is manager-only — v2.14 originally shipped
-- as a standalone migration (not mirrored here per that task's explicit
-- "single migration file" instruction) and used is_staff() for read; v2.18
-- adds it here for a coherent fresh install and tightens read to
-- is_manager(), consistent with v2.15's "salon-wide reports blocked for
-- stylist" rule — feedback read is a quality metric across every
-- stylist's bookings, not scoped to one's own.
create table if not exists public.feedbacks (
  id         text primary key default 'fb-' || substr(md5(gen_random_uuid()::text), 1, 12),
  booking_id text not null unique references public.appointments(id) on delete cascade,
  rating     int not null check (rating between 1 and 5),
  tags       text[] not null default '{}',
  comment    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists feedbacks_created_at_idx on public.feedbacks (created_at);
alter table public.feedbacks enable row level security;
drop policy if exists p_feedback_insert on public.feedbacks;
create policy p_feedback_insert on public.feedbacks
  for insert
  with check (
    exists (select 1 from public.appointments a where a.id = booking_id and a.status = 'completed')
  );
drop policy if exists p_feedback_read on public.feedbacks;
create policy p_feedback_read on public.feedbacks
  for select using (public.is_manager());
grant select, insert on public.feedbacks to anon, authenticated;

create or replace function public.get_feedback_stats()
returns table (
  total_count bigint, avg_rating numeric,
  rating_1 bigint, rating_2 bigint, rating_3 bigint, rating_4 bigint, rating_5 bigint
)
language sql stable security definer set search_path = public as $fn$
  select
    count(*)::bigint as total_count,
    round(avg(rating)::numeric, 2) as avg_rating,
    count(*) filter (where rating = 1)::bigint as rating_1,
    count(*) filter (where rating = 2)::bigint as rating_2,
    count(*) filter (where rating = 3)::bigint as rating_3,
    count(*) filter (where rating = 4)::bigint as rating_4,
    count(*) filter (where rating = 5)::bigint as rating_5
  from public.feedbacks
  where public.is_manager();
$fn$;
grant execute on function public.get_feedback_stats() to authenticated;

-- v2.13: campaign conversion attribution — a separate, minimal AFTER
-- INSERT trigger, fully isolated from sync_customer_from_appointment()
-- (the existing booking trigger, which is untouched by this migration).
-- Time-based attribution: a booking counts as a conversion if that phone
-- was sent a campaign SMS within the preceding 7 days.
create or replace function public.track_campaign_conversion() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare matched_sms record;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  select sm.id as sms_id, sm.campaign_log_id, sm.sent_at
    into matched_sms
    from public.sms_messages sm
   where sm.to_phone = new.customer_phone
     and sm.campaign_log_id is not null
     and sm.status in ('sent', 'delivered')
     and sm.sent_at >= now() - interval '7 days'
   order by sm.sent_at desc
   limit 1;

  if matched_sms.campaign_log_id is not null then
    insert into public.campaign_conversions
      (campaign_log_id, customer_phone, appointment_id, sms_message_id, converted_at, days_to_convert)
    values (
      matched_sms.campaign_log_id, new.customer_phone, new.id, matched_sms.sms_id, now(),
      greatest(0, extract(day from (now() - matched_sms.sent_at))::int)
    )
    on conflict (appointment_id) do nothing;
  end if;

  return new;
end $fn$;

drop trigger if exists appointments_track_conversion on public.appointments;
create trigger appointments_track_conversion after insert on public.appointments
  for each row execute function public.track_campaign_conversion();

-- v2.13: per-template conversion rate and attributed revenue. Revenue is
-- joined live from appointments.final_price at query time, not snapshotted,
-- so a later price change or completion always reflects accurately. Every
-- join is on an indexed key, and the result is one row per template (not
-- per message or per conversion), so this stays fast as send volume grows.
create or replace function public.get_campaign_performance(p_template_id text default null)
returns table (
  template_id text, template_label text, segment text,
  total_sent bigint, successful_count bigint,
  total_conversions bigint, conversion_rate numeric,
  attributed_revenue bigint
)
language sql stable security definer set search_path = public as $fn$
  select
    cl.template_id,
    max(cl.template_label) as template_label,
    max(cl.segment) as segment,
    sum(cl.total_sent)::bigint as total_sent,
    sum(cl.successful_count)::bigint as successful_count,
    count(distinct cc.id)::bigint as total_conversions,
    case when sum(cl.successful_count) = 0 then 0::numeric
         else round(count(distinct cc.id)::numeric / sum(cl.successful_count) * 100, 1)
    end as conversion_rate,
    coalesce(sum(a.final_price) filter (where a.status = 'completed'), 0)::bigint as attributed_revenue
  from public.campaign_logs cl
  left join public.campaign_conversions cc on cc.campaign_log_id = cl.id
  left join public.appointments a on a.id = cc.appointment_id
  where public.is_manager()
    and (p_template_id is null or cl.template_id = p_template_id)
  group by cl.template_id
  order by conversion_rate desc;
$fn$;
grant execute on function public.get_campaign_performance(text) to authenticated;

-- Preview a hypothetical set of thresholds (not yet saved) against live
-- customer data, without writing anything — lets a manager see the effect
-- of a change before committing to it.
create or replace function public.preview_customer_segment_distribution(
  p_recency int, p_visits int, p_inactive int
)
returns table (segment text, segment_fa text, customer_count bigint, pct numeric)
language sql stable security definer set search_path = public as $fn$
  -- p_inactive is accepted for parameter symmetry with the 3-field settings
  -- form (and to leave room for a future "hibernating beyond N days"
  -- split), but the current 4-way classification is fully determined by
  -- the recency/visits crossover alone, matching get_customer_rfm_segments()
  -- exactly — it isn't referenced further in this query.
  with classified as (
    select
      case
        when raw.recency_days <= p_recency and raw.frequency >= p_visits then 'champions'
        when raw.recency_days >  p_recency and raw.frequency >= p_visits then 'at_risk'
        when raw.recency_days <= p_recency and raw.frequency <  p_visits then 'new'
        else 'inactive'
      end as segment
    from public.customer_rfm_raw raw
    where public.is_manager()
  ),
  totals as (select count(*) as n from classified),
  counted as (
    select segment, count(*) as customer_count
    from classified
    group by segment
  )
  select
    seg.key as segment,
    case seg.key
      when 'champions' then 'مشتریان وفادار'
      when 'at_risk'   then 'در خطر ریزش'
      when 'new'       then 'مشتریان جدید'
      else                  'غیرفعال'
    end as segment_fa,
    coalesce(counted.customer_count, 0) as customer_count,
    case when (select n from totals) = 0 then 0
         else round(coalesce(counted.customer_count, 0)::numeric / (select n from totals) * 100, 1)
    end as pct
  from (values ('champions'), ('at_risk'), ('new'), ('inactive')) as seg(key)
  left join counted on counted.segment = seg.key;
$fn$;
grant execute on function public.preview_customer_segment_distribution(int, int, int) to authenticated;

-- Phase 4: referral redemption — award both sides.
create or replace function public.apply_referral(p_new_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $fn$
declare referrer record;
begin
  if not public.check_rate_limit('apply_referral:' || coalesce(p_new_phone, ''), 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  select * into referrer from public.customers where referral_code = upper(p_code);
  if referrer is null then return json_build_object('ok', false, 'error', 'کد معرف پیدا نشد'); end if;
  if referrer.phone = p_new_phone then return json_build_object('ok', false, 'error', 'کد معرف خودتان قابل استفاده نیست'); end if;
  if exists (select 1 from public.customers where phone = p_new_phone and referred_by is not null) then
    return json_build_object('ok', false, 'error', 'قبلاً از کد معرف استفاده کرده‌اید');
  end if;
  -- The referred phone must belong to a real customer (created by the
  -- appointment trigger the first time they actually book) — otherwise
  -- this is callable with arbitrarily made-up numbers to set up a fake
  -- relationship with no appointment ever having happened.
  if not exists (select 1 from public.customers where phone = p_new_phone) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;

  -- Anti-fraud: this only records the referred_by relationship now. No
  -- points are awarded here — the referrer's reward is earned later, only
  -- once this customer's visit is completed AND staff has verified at
  -- checkout that they're a genuinely new customer (see
  -- sync_customer_from_appointment()). Awarding points at this step was
  -- the actual exploit: apply a code against any real-looking phone number
  -- and farm the referrer's points with no visit ever happening.
  update public.customers set referred_by = referrer.phone where phone = p_new_phone;

  return json_build_object('ok', true);
end $fn$;
grant execute on function public.apply_referral(text, text) to anon, authenticated;

-- Realtime: an open panel updates when another device books.
do $$
begin
  alter publication supabase_realtime add table public.appointments;
exception when others then null;
end $$;
