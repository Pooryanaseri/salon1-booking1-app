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

create table if not exists public.loyalty_settings (
  id                int primary key default 1 check (id = 1),
  points_per_visit  integer not null default 10,
  points_per_tier   integer not null default 100,
  discount_per_tier integer not null default 5,
  max_discount      integer not null default 30,
  referral_points   integer not null default 300
);
insert into public.loyalty_settings (id) values (1) on conflict (id) do nothing;

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
declare pts int;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  insert into public.customers (phone, name, gender, last_booking_at)
  values (new.customer_phone, new.customer_name, new.customer_gender, now())
  on conflict (phone) do update
    set name            = coalesce(nullif(excluded.name, ''), public.customers.name),
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

  return new;
end $fn$;

drop trigger if exists appointments_sync_customer on public.appointments;
create trigger appointments_sync_customer before insert or update on public.appointments
  for each row execute function public.sync_customer_from_appointment();

-- ---------------------------------------------------------------------------
-- 13. RBAC HELPERS
-- ---------------------------------------------------------------------------
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

-- Public read: the booking flow must work for unauthenticated visitors.
do $$
declare t text;
begin
  foreach t in array array['services','stylists','working_hours','time_offs','approved_dates','loyalty_settings'] loop
    execute format('drop policy if exists p_read_public on public.%I', t);
    execute format('create policy p_read_public on public.%I for select using (true)', t);
  end loop;
end $$;

-- Appointments: anyone may read (slot availability) and create (book).
drop policy if exists p_appt_select on public.appointments;
create policy p_appt_select on public.appointments for select using (true);

drop policy if exists p_appt_insert on public.appointments;
create policy p_appt_insert on public.appointments for insert with check (true);

-- Staff update the calendar; a stylist only touches their own column.
-- anon is allowed so the customer "پیگیری نوبت" tab can cancel/reschedule.
drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or auth.uid() is null
) with check (
  public.is_manager()
  or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or (auth.uid() is null and status in ('cancelled', 'rescheduled'))
);

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
       or new.discount_value is distinct from old.discount_value then
      raise exception 'این تغییر برای مشتری مجاز نیست — فقط لغو یا جابه‌جایی زمان مجاز است';
    end if;
    -- Reached only once the change above has passed validation — a genuine
    -- self-service cancel/reschedule, worth a trail even though it's routine.
    insert into public.audit_log (event, actor, detail) values (
      'appointment_self_update', null,
      jsonb_build_object('appointment_id', new.id, 'from_status', old.status, 'to_status', new.status)
    );
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
  using (public.is_manager() or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

drop policy if exists p_sched_write on public.time_offs;
create policy p_sched_write on public.time_offs for all
  using (public.is_manager() or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id()))
  with check (public.is_manager() or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id()));

drop policy if exists p_sched_write on public.approved_dates;
create policy p_sched_write on public.approved_dates for all
  using (public.is_staff()) with check (public.is_staff());

-- Signed-in staff can read the back-office tables.
do $$
declare t text;
begin
  foreach t in array array['expenses','customers','campaigns','campaign_targets','sms_messages','sms_templates','loyalty_ledger'] loop
    execute format('drop policy if exists p_staff_read on public.%I', t);
    execute format('create policy p_staff_read on public.%I for select using (public.is_staff())', t);
  end loop;
end $$;

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
create or replace view public.customer_rfm_raw as
select
  c.phone,
  c.name,
  c.sms_opt_out,
  coalesce(extract(day from (now() - c.last_booking_at))::int, 999) as recency_days,
  c.total_visits as frequency,
  coalesce((
    select sum(a.final_price)
      from public.appointments a
     where a.customer_phone = c.phone and a.status = 'completed' and a.final_price is not null
  ), 0) as monetary
from public.customers c;

create or replace function public.get_customer_rfm_segments()
returns table (
  phone text, name text, sms_opt_out boolean,
  recency_days int, frequency int, monetary bigint,
  r_score int, f_score int, m_score int,
  segment text, segment_fa text
)
language sql stable security definer set search_path = public as $fn$
  -- Open to any authenticated staff member (owner, manager, or stylist) —
  -- previously manager-only, but a stylist deciding who to follow up with
  -- needs this exactly as much as the owner does.
  with scored as (
    select
      raw.*,
      case when raw.recency_days <= 30  then 4
           when raw.recency_days <= 60  then 3
           when raw.recency_days <= 120 then 2
           else 1 end as r_score,
      case when raw.frequency >= 8 then 4
           when raw.frequency >= 4 then 3
           when raw.frequency >= 2 then 2
           else 1 end as f_score,
      ntile(4) over (order by raw.monetary asc) as m_score
    from public.customer_rfm_raw raw
    where public.is_staff()
  )
  -- Four segments instead of six: each maps to one clear action, and the
  -- two "not quite champions, not quite gone" middle categories the old
  -- version split apart (نیازمند توجه / در خطر ریزش, and پتانسیل وفاداری as
  -- a catch-all) get merged into whichever real category they're closest to
  -- in practice, since the follow-up message for both is the same anyway.
  select
    phone, name, sms_opt_out, recency_days, frequency, monetary, r_score, f_score, m_score,
    case
      when r_score >= 3 and f_score >= 3 then 'champions'
      when r_score <= 2 and f_score >= 3 then 'at_risk'
      when r_score >= 3 and f_score < 3  then 'new'
      else 'inactive'
    end as segment,
    case
      when r_score >= 3 and f_score >= 3 then 'مشتریان وفادار'
      when r_score <= 2 and f_score >= 3 then 'در خطر ریزش'
      when r_score >= 3 and f_score < 3  then 'مشتریان جدید'
      else 'غیرفعال'
    end as segment_fa
  from scored;
$fn$;
grant execute on function public.get_customer_rfm_segments() to authenticated;

-- Phase 4: referral redemption — award both sides.
create or replace function public.apply_referral(p_new_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $fn$
declare referrer record; ls record; recent_count int;
begin
  select * into ls from public.loyalty_settings where id = 1;
  select * into referrer from public.customers where referral_code = upper(p_code);
  if referrer is null then return json_build_object('ok', false, 'error', 'کد معرف پیدا نشد'); end if;
  if referrer.phone = p_new_phone then return json_build_object('ok', false, 'error', 'کد معرف خودتان قابل استفاده نیست'); end if;
  if exists (select 1 from public.customers where phone = p_new_phone and referred_by is not null) then
    return json_build_object('ok', false, 'error', 'قبلاً از کد معرف استفاده کرده‌اید');
  end if;
  -- The referred phone must belong to a real customer (created by the
  -- appointment trigger the first time they actually book) — otherwise
  -- this is callable with arbitrarily made-up numbers to farm points for a
  -- chosen referrer, with no appointment ever having happened.
  if not exists (select 1 from public.customers where phone = p_new_phone) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;
  -- Rate limit: cap how many referral rewards one referrer can earn per day,
  -- so even a determined attacker generating real-looking numbers is bounded.
  select count(*) into recent_count from public.loyalty_ledger
   where customer_phone = referrer.phone and reason = 'referral' and created_at > now() - interval '24 hours';
  if recent_count >= 5 then
    return json_build_object('ok', false, 'error', 'سقف پاداش معرفی امروز برای این کد پر شده — فردا دوباره امتحان کنید');
  end if;

  update public.customers set referred_by = referrer.phone where phone = p_new_phone;
  insert into public.loyalty_ledger (customer_phone, delta, reason) values
    (referrer.phone, ls.referral_points, 'referral'),
    (p_new_phone,    ls.referral_points, 'referral');
  update public.customers set loyalty_points = loyalty_points + ls.referral_points
   where phone in (referrer.phone, p_new_phone);

  return json_build_object('ok', true, 'points', ls.referral_points);
end $fn$;
grant execute on function public.apply_referral(text, text) to anon, authenticated;

-- Realtime: an open panel updates when another device books.
do $$
begin
  alter publication supabase_realtime add table public.appointments;
exception when others then null;
end $$;
