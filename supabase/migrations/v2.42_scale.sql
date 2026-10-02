-- ============================================================================
-- Migration v2.42 — scale to hundreds of salons (run after v2.41)
-- ============================================================================
-- * queue_due_reminders(): the cron-reminders "safety net" sweep used to load
--   every upcoming booking, every stylist and every service of every salon
--   through the REST API each minute. The API returns at most 1000 rows, so
--   past a few dozen salons reminders and service names went missing
--   silently. The sweep is now one SQL statement that queues only what is
--   due; the regular drain sends it (through each salon's own SMS account).
-- * Deactivated salons send nothing: claim_due_sms() skips them and
--   deactivating a salon drops its queued messages.
-- * RLS policies call current_salon_id() / is_manager() / is_staff() once per
--   statement instead of once per row (wrapped in a scalar sub-select — the
--   pattern Supabase recommends), and indexes cover the per-salon lookups the
--   policies and cron jobs make.
-- ============================================================================

create or replace function public.queue_due_reminders(p_limit int default 500)
returns int
language plpgsql security definer set search_path = public as $fn$
declare v_tz text := coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'); v_n int;
begin
  insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
  select a.salon_id, a.customer_phone, public.booking_sms_text(a, 'reminder'), 'reminder', a.id, 'queued', now()
    from public.appointments a
    join public.salons s on s.id = a.salon_id and s.active
    join public.app_settings st on st.salon_id = a.salon_id and st.reminder_hours_before > 0
    left join public.stylists t on t.id = a.staff_id and t.salon_id = a.salon_id
    cross join lateral (
      select ((a.date + make_interval(mins => a.start_min)) at time zone v_tz) as starts_at,
             coalesce(nullif(t.reminder_hours_before, 0), st.reminder_hours_before) as hrs
    ) w
   where a.status in ('confirmed', 'rescheduled')
     and not a.sms_sent_reminder
     and a.customer_phone ~ '^09[0-9]{9}$'
     and a.date between public.salon_today() and public.salon_today() + 3
     and now() >= w.starts_at - make_interval(hours => w.hrs)
     and now() < w.starts_at
     and not exists (
       select 1 from public.sms_messages m
        where m.appointment_id = a.id and m.kind = 'reminder'
          and m.status in ('queued', 'sending', 'sent', 'delivered'))
   limit greatest(p_limit, 1);
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
revoke all on function public.queue_due_reminders(int) from public, anon, authenticated;
grant execute on function public.queue_due_reminders(int) to service_role;

create or replace function public.claim_due_sms(p_limit integer default 200)
returns setof public.sms_messages
language sql security definer set search_path = public as $fn$
  update public.sms_messages m
     set status = 'sending', claimed_at = now()
   where m.id in (
     select q.id from public.sms_messages q
       join public.salons s on s.id = q.salon_id and s.active
      where q.scheduled_for <= now()
        and (q.status = 'queued' or (q.status = 'sending' and q.claimed_at < now() - interval '10 minutes'))
      order by q.scheduled_for
      limit greatest(p_limit, 1)
      for update of q skip locked
   )
  returning m.*;
$fn$;
revoke all on function public.claim_due_sms(int) from public, anon, authenticated;
grant execute on function public.claim_due_sms(int) to service_role;

-- Deactivating a salon drops what it still had queued (so reactivating it
-- later doesn't fire a backlog of stale reminders).
create or replace function public.cancel_queued_sms_of_inactive_salon()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if old.active and not new.active then
    update public.sms_messages set status = 'cancelled', error = 'salon deactivated'
     where salon_id = new.id and status in ('queued', 'sending');
  end if;
  return new;
end;
$fn$;
revoke all on function public.cancel_queued_sms_of_inactive_salon() from public, anon, authenticated;
drop trigger if exists trg_salon_deactivated on public.salons;
create trigger trg_salon_deactivated after update of active on public.salons
  for each row execute function public.cancel_queued_sms_of_inactive_salon();

-- ---------------------------------------------------------------- indexes ---
create index if not exists appointments_salon_date_idx on public.appointments (salon_id, date);
create index if not exists appointments_salon_staff_date_idx on public.appointments (salon_id, staff_id, date);
create index if not exists appointments_salon_phone_idx on public.appointments (salon_id, customer_phone);
create index if not exists appointments_upcoming_reminder_idx on public.appointments (date)
  where status in ('confirmed', 'rescheduled') and not sms_sent_reminder;
create index if not exists sms_messages_appointment_idx on public.sms_messages (appointment_id, kind) where appointment_id is not null;
create index if not exists sms_messages_salon_created_idx on public.sms_messages (salon_id, created_at desc);
create index if not exists users_salon_role_idx on public.users (salon_id, role);
create index if not exists stylists_salon_idx on public.stylists (salon_id);
create index if not exists services_salon_idx on public.services (salon_id);
create index if not exists time_offs_salon_date_idx on public.time_offs (salon_id, date);
create index if not exists waitlist_salon_date_idx on public.waitlist (salon_id, date);
create index if not exists expenses_salon_date_idx on public.expenses (salon_id, date);
create index if not exists loyalty_ledger_salon_phone_idx on public.loyalty_ledger (salon_id, customer_phone);
create index if not exists campaign_logs_salon_idx on public.campaign_logs (salon_id);
create index if not exists feedbacks_salon_idx on public.feedbacks (salon_id);
create index if not exists rate_limit_events_bucket_idx on public.rate_limit_events (bucket, created_at);

-- -------------------------------------------- RLS: evaluate once per query ---
-- Rewrites every public policy's expressions so the tenant/role helpers sit
-- inside (select …): Postgres then runs them once as an InitPlan instead of
-- once per row. Same logic; idempotent (already-wrapped calls are skipped).
do $$
declare
  p record; v_using text; v_check text; v_sql text;
  fns text[] := array['current_salon_id', 'is_manager', 'is_staff', 'my_role', 'my_stylist_id'];
  f text;
begin
  for p in
    select pol.polname, c.relname, pol.polcmd, pol.polpermissive,
           pg_get_expr(pol.polqual, pol.polrelid) as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck,
           array(select rolname from pg_roles where oid = any(pol.polroles)) as roles
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where c.relnamespace = 'public'::regnamespace
  loop
    v_using := p.qual; v_check := p.wcheck;
    foreach f in array fns loop
      -- only bare calls: "f()" not already preceded by "select "
      v_using := regexp_replace(v_using, '(?<!SELECT )(?<!select )\m' || f || '\(\)', '(select public.' || f || '())', 'g');
      v_check := regexp_replace(v_check, '(?<!SELECT )(?<!select )\m' || f || '\(\)', '(select public.' || f || '())', 'g');
    end loop;
    if v_using is not distinct from p.qual and v_check is not distinct from p.wcheck then
      continue;
    end if;
    v_sql := format('alter policy %I on public.%I', p.polname, p.relname);
    if v_using is not null then v_sql := v_sql || format(' using (%s)', v_using); end if;
    if v_check is not null then v_sql := v_sql || format(' with check (%s)', v_check); end if;
    execute v_sql;
  end loop;
end $$;

-- -------------------------------------------------- public slot view -------
-- The booking page only needs occupied slots from yesterday on. Without the
-- date filter it fetched every booking the salon ever had, oldest first —
-- and past 1000 of them the API cut off exactly the upcoming ones, so taken
-- times showed as free.
create or replace view public.appointments_public_slots as
  select staff_id, date, start_min, end_min, buffer_minutes, status
    from public.appointments
   where salon_id = public.current_salon_id()
     and date >= public.salon_today() - 1;
grant select on public.appointments_public_slots to anon, authenticated;
