-- ============================================================================
-- Migration v2.34 — each queued SMS is sent exactly once (run after v2.33)
-- ============================================================================
-- cron-reminders' drain (now every minute) and predictive-rebooking-cron
-- both selected status='queued' rows and sent them; two overlapping runs
-- (or the two functions at 10:00) could send the same message twice.
-- claim_due_sms() hands out due rows atomically (FOR UPDATE SKIP LOCKED)
-- and marks them 'sending', so a row goes to exactly one sender. A row
-- stuck in 'sending' (sender crashed mid-run) is handed out again after
-- 10 minutes.
-- ============================================================================

alter table public.sms_messages drop constraint if exists sms_messages_status_check;
alter table public.sms_messages add constraint sms_messages_status_check
  check (status in ('queued', 'sending', 'sent', 'failed', 'delivered', 'cancelled'));
alter table public.sms_messages add column if not exists claimed_at timestamptz;

create index if not exists sms_messages_due_idx
  on public.sms_messages (scheduled_for) where status in ('queued', 'sending');

create or replace function public.claim_due_sms(p_limit int default 200)
returns setof public.sms_messages
language sql security definer set search_path = public as $fn$
  update public.sms_messages m
     set status = 'sending', claimed_at = now()
   where m.id in (
     select id from public.sms_messages
      where scheduled_for <= now()
        and (status = 'queued' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
      order by scheduled_for
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning m.*;
$fn$;
revoke all on function public.claim_due_sms(int) from public, anon, authenticated;
grant execute on function public.claim_due_sms(int) to service_role;
