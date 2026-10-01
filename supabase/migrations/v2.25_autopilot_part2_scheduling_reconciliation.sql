-- ============================================================================
-- Migration v2.25 — Autopilot 2.0 (part 2 of 3: scheduled transitions +
-- reconciliation token system + submit_reconciliation_batch)
-- ============================================================================
-- Two functions meant to run on a schedule (pg_cron, or any external
-- scheduler hitting a thin Edge Function wrapper — see the delivery notes
-- for exactly how to wire this up; this migration provides the SQL side
-- either approach calls):
--   transition_elapsed_appointments() — confirmed/rescheduled whose
--     appointment_time + duration has passed become pending_verification.
--     Intended to run every 15-30 minutes.
--   archive_stale_pending_verifications() — pending_verification older
--     than 7 days becomes archived_unconfirmed. NEVER completed — the
--     hard policy from the spec: unverified income is never auto-
--     confirmed, only ever auto-archived out of the pending queue.
--     Intended to run once a day.
--
-- Both are SECURITY DEFINER, take no parameters, and are safe to call
-- repeatedly (idempotent — only touch rows still in the source status).
--
-- TIMEZONE NOTE: like the existing cron-reminders Edge Function, this
-- assumes one fixed wall-clock offset for every salon (matching this
-- codebase's current single-offset assumption — SALON_TZ_OFFSET_MINUTES).
-- A deployment spanning multiple timezones would need a
-- salons.tz_offset_minutes column and per-salon arithmetic below; flagged
-- in the checklist, not silently assumed away.
-- ============================================================================

create or replace function public.transition_elapsed_appointments(p_tz_offset_minutes int default 210)
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_count int;
begin
  with elapsed as (
    update public.appointments
       set status = 'pending_verification'
     where status in ('confirmed', 'rescheduled')
       and (date + (end_min || ' minutes')::interval) < (now() + (p_tz_offset_minutes || ' minutes')::interval)
    returning 1
  )
  select count(*) into v_count from elapsed;
  return v_count;
end;
$fn$;
-- Not granted to anon/authenticated — only ever invoked by the scheduler
-- via a service_role-authenticated call (an Edge Function, or pg_cron's
-- own execution context, which already runs as a privileged role).

create or replace function public.archive_stale_pending_verifications()
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_count int;
begin
  with archived as (
    update public.appointments
       set status = 'archived_unconfirmed'
     where status = 'pending_verification'
       and updated_at < now() - interval '7 days'
    returning 1
  )
  select count(*) into v_count from archived;
  return v_count;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- Reconciliation tokens — the owner's "magic link" credential, same shape
-- and trust model as the customer OTP/token system (booking_access_tokens
-- from v2.19): random 256-bit token, only its sha256 hash stored, short
-- expiry, single-salon scope, revocable.
-- ----------------------------------------------------------------------------
create table if not exists public.reconciliation_tokens (
  id         bigint generated always as identity primary key,
  salon_id   uuid not null references public.salons(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reconciliation_tokens_salon_idx on public.reconciliation_tokens (salon_id);
alter table public.reconciliation_tokens enable row level security;
-- No policies at all: reachable only via the SECURITY DEFINER functions
-- below (same pattern as booking_otp_challenges/booking_access_tokens).

create or replace function public.create_reconciliation_token(p_salon_id uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_token text; v_hash text;
begin
  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_token, 'sha256'), 'hex');
  insert into public.reconciliation_tokens (salon_id, token_hash, expires_at)
  values (p_salon_id, v_hash, now() + interval '72 hours');
  if random() < 0.05 then
    delete from public.reconciliation_tokens where expires_at < now() - interval '7 days';
  end if;
  return json_build_object('ok', true, 'token', v_token);
end;
$fn$;
-- Not granted to anon/authenticated — only the weekly-dispatch Edge
-- Function (service_role) ever mints one of these.

create or replace function public.resolve_reconciliation_token(p_token text)
returns uuid
language sql stable security definer set search_path = public as $fn$
  select salon_id from public.reconciliation_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now();
$fn$;

-- ----------------------------------------------------------------------------
-- get_reconciliation_queue — what the owner's magic-link page loads: every
-- pending_verification appointment for their salon, oldest first.
-- ----------------------------------------------------------------------------
create or replace function public.get_reconciliation_queue(p_token text)
returns table (
  id text, customer_name text, customer_phone text, service_id text,
  staff_id text, date date, start_min int, final_price bigint
)
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon_id uuid;
begin
  v_salon_id := public.resolve_reconciliation_token(p_token);
  if v_salon_id is null then
    return;
  end if;
  return query
    select a.id, a.customer_name, a.customer_phone, a.service_id, a.staff_id, a.date, a.start_min, a.final_price
    from public.appointments a
    where a.salon_id = v_salon_id and a.status = 'pending_verification'
    order by a.date asc, a.start_min asc;
end;
$fn$;
grant execute on function public.get_reconciliation_queue(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- submit_reconciliation_batch — the actual write. p_decisions is a JSON
-- array of {"id": "<appointment id>", "decision": "completed" | "no_show"}.
-- Strict tenant check: every appointment id must belong to the token's own
-- salon and still be pending_verification, or it's silently skipped (never
-- an error that would block the rest of a legitimate batch) — this is the
-- "strict tenant checks" requirement: an id from another salon, or
-- already resolved by someone else in the meantime, simply can't be
-- touched through this path, token or no token.
-- ----------------------------------------------------------------------------
create or replace function public.submit_reconciliation_batch(p_token text, p_decisions jsonb)
returns json
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon_id uuid;
  v_decision jsonb;
  v_completed int := 0;
  v_no_show int := 0;
  v_skipped int := 0;
begin
  v_salon_id := public.resolve_reconciliation_token(p_token);
  if v_salon_id is null then
    return json_build_object('ok', false, 'error', 'این لینک منقضی یا نامعتبر است');
  end if;
  if jsonb_typeof(p_decisions) <> 'array' then
    return json_build_object('ok', false, 'error', 'ورودی نامعتبر است');
  end if;

  for v_decision in select * from jsonb_array_elements(p_decisions) loop
    if v_decision->>'decision' not in ('completed', 'no_show') then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.appointments
       set status = v_decision->>'decision'
     where id = v_decision->>'id'
       and salon_id = v_salon_id
       and status = 'pending_verification';
    if found then
      if v_decision->>'decision' = 'completed' then v_completed := v_completed + 1;
      else v_no_show := v_no_show + 1; end if;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return json_build_object('ok', true, 'completed', v_completed, 'no_show', v_no_show, 'skipped', v_skipped);
end;
$fn$;
grant execute on function public.submit_reconciliation_batch(text, jsonb) to anon, authenticated;
