-- ============================================================================
--  Migration v2.2 — CRITICAL security fixes from a bug-bounty-style audit
--  Run AFTER schema.sql and v2.1_security.sql. Idempotent.
--
--  Found during the audit, worse than anything in the original report:
--
--  🔴 CRITICAL — anonymous appointment updates were unrestricted.
--  p_appt_update's `or auth.uid() is null` branch (needed so a customer can
--  cancel/reschedule their own booking without an account) had NO further
--  restriction — it let anyone, unauthenticated, update ANY row to ANY
--  values. In practice that meant: mark a stranger's appointment "completed"
--  (which fires the loyalty-points trigger — free points for any phone
--  number you like), reassign it to a different stylist, change its price,
--  or overwrite the customer's contact info entirely. This is fixed below
--  with a WITH CHECK clause plus a trigger that locks every field except
--  the ones a self-service cancel/reschedule actually needs to touch.
--
--  🔴 CRITICAL (≈ H1 in the report) — plaintext stylist passwords.
--  Real login already goes through Supabase Auth (bcrypt, in auth.users) —
--  that part was never at risk. But `stylists.password` was ALSO being
--  written in plaintext on every registration/edit (see api.js's row
--  mapper), fully redundant with Supabase Auth, and the owner's "edit
--  stylist" form pre-filled it into a visible input. Dropped here; the app
--  changes (same commit) stop reading/writing it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Minimal audit log (≈ L6), created first since two triggers below write
--    to it. Just the highest-value events: role changes, and successful
--    anonymous appointment self-updates.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 1. Lock down what an anonymous (no-login) caller can actually change on
--    an appointment. USING still lets them reach their own row (unchanged —
--    the app finds it by phone client-side, same as before); WITH CHECK now
--    additionally requires the new status to be cancel/reschedule-shaped.
-- ----------------------------------------------------------------------------
drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id() and date >= current_date)
  or auth.uid() is null
) with check (
  public.is_manager()
  or (public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
  or (auth.uid() is null and status in ('cancelled', 'rescheduled'))
);

-- Belt-and-braces: even within an allowed status change, an anonymous caller
-- must not be able to touch who/what/how-much the appointment is for. RLS's
-- WITH CHECK can't compare OLD vs NEW column-by-column on its own, so this
-- is a trigger. Applies regardless of role, but only actually restricts
-- when auth.uid() is null (managers/stylists are already scoped by the
-- policy above). On success (not on the raised exception, which rolls the
-- whole transaction back) it also leaves an audit trail entry.
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
-- self-update policy from v2.1 already blocks anyone changing their own role).
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

-- ----------------------------------------------------------------------------
-- 2. Drop the plaintext password column. Nothing reads it for real auth —
--    that was always Supabase Auth — so this is safe to remove outright.
--    (Matching app-code change lands in the same commit; see CHANGES.md.)
-- ----------------------------------------------------------------------------
alter table public.stylists drop column if exists password;

-- ----------------------------------------------------------------------------
-- 3. Referral fraud (≈ H6): require the referred phone to already belong to
--    a real customer, and rate-limit reward payouts per referrer per day.
--    (Same fix as in schema.sql's apply_referral — repeated here so an
--    existing deployment gets it without re-running the whole schema.)
-- ----------------------------------------------------------------------------
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
  if not exists (select 1 from public.customers where phone = p_new_phone) then
    return json_build_object('ok', false, 'error', 'ابتدا باید یک نوبت برای این شماره ثبت شده باشد');
  end if;
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

-- ----------------------------------------------------------------------------
-- 4. Idempotency key for SMS sends (≈ H4) — lets a retried request reuse the
--    prior outcome instead of sending the message twice.
-- ----------------------------------------------------------------------------
alter table public.sms_messages add column if not exists idempotency_key text;
create unique index if not exists sms_messages_idempotency_key_uidx
  on public.sms_messages (idempotency_key) where idempotency_key is not null;

-- ----------------------------------------------------------------------------
-- 5. cron-reminders is deployed with --no-verify-jwt (it has to be, since
--    your scheduler calls it with no user session) — which also means
--    anyone who finds the URL can invoke it. It can't be tricked into
--    sending arbitrary content (every message it sends is built server-side
--    from real appointment data, and it's already de-duplicated), so the
--    worst case today is wasted invocations/cost, not a content-injection
--    or fraud vector — but let's close it anyway. The Edge Function change
--    (same commit) now requires this secret via an `x-internal-secret`
--    header, same pattern already used by send-sms.
-- ----------------------------------------------------------------------------
-- (No schema change needed for this one — see supabase/functions/cron-reminders/index.ts.
--  Listed here so this migration file stays the single place that documents
--  every fix in this pass.)
