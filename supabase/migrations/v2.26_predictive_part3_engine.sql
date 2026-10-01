-- ============================================================================
-- Migration v2.26 — Predictive Autopilot (part 3 of 3): Predictive
-- Re-booking Engine
-- ============================================================================
-- Reuses part 1's rebooking_tokens/create_rebooking_token wholesale — the
-- spec explicitly frames this as the SAME dynamic-link mechanism as
-- Feature 2, just triggered by a different reason ('predictive' vs
-- 'closure'), so there's no separate token table or link format here.
-- ============================================================================

alter table public.services add column if not exists average_cycle_days int;
alter table public.services drop constraint if exists services_average_cycle_days_check;
alter table public.services add constraint services_average_cycle_days_check
  check (average_cycle_days is null or average_cycle_days > 0);

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check
  check (kind in ('confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom','reconciliation_prompt','weekly_summary','predictive_rebooking'));

-- ----------------------------------------------------------------------------
-- run_predictive_rebooking — daily job. For every active salon, every
-- service with average_cycle_days set, finds each customer's own most
-- recent COMPLETED visit for that service, and queues an outreach SMS
-- when today falls in a short window around their typical due date
-- (cycle - 3 days through cycle + 2 days — a few days wide since this
-- only runs once a day and shouldn't miss someone or double-send across
-- runs).
--
-- Two exclusions that matter as much as the inclusion rule:
--   - a customer who ALREADY has an upcoming (pending/confirmed/
--     rescheduled/pending_verification) booking for the SAME service is
--     skipped outright — nagging someone who's already rebooked is
--     exactly the kind of "automation that annoys customers" this
--     feature is supposed to avoid, not cause.
--   - a customer who already got a 'predictive' token for this service
--     within the last 10 days is skipped too, so drifting through the
--     few-day window on consecutive daily runs doesn't send the same
--     nudge repeatedly.
-- ----------------------------------------------------------------------------
create or replace function public.run_predictive_rebooking()
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_candidate record;
  v_token text;
  v_body text;
  v_sent int := 0;
begin
  for v_candidate in
    with last_visit as (
      select
        a.salon_id, a.customer_phone, a.service_id,
        max(a.date) as last_date,
        (array_agg(a.customer_name order by a.date desc))[1] as customer_name,
        (array_agg(a.staff_id order by a.date desc))[1] as staff_id
      from public.appointments a
      where a.status = 'completed'
      group by a.salon_id, a.customer_phone, a.service_id
    )
    select
      lv.salon_id, lv.customer_phone, lv.customer_name, lv.service_id, lv.staff_id,
      s.name as service_name, s.average_cycle_days, lv.last_date,
      sal.name as salon_name
    from last_visit lv
    join public.services s on s.id = lv.service_id and s.salon_id = lv.salon_id and s.is_active
    join public.salons sal on sal.id = lv.salon_id and sal.active
    where s.average_cycle_days is not null
      and current_date between
            lv.last_date + (s.average_cycle_days - 3)
        and lv.last_date + (s.average_cycle_days + 2)
      -- not already upcoming for the same service
      and not exists (
        select 1 from public.appointments up
        where up.salon_id = lv.salon_id and up.customer_phone = lv.customer_phone and up.service_id = lv.service_id
          and up.status in ('pending', 'confirmed', 'rescheduled', 'pending_verification')
          and up.date >= current_date
      )
      -- not already nudged recently for this same service
      and not exists (
        select 1 from public.rebooking_tokens rt
        where rt.salon_id = lv.salon_id and rt.customer_phone = lv.customer_phone and rt.service_id = lv.service_id
          and rt.reason = 'predictive' and rt.created_at > now() - interval '10 days'
      )
      -- respects opt-out — this is a retention/marketing nudge, not a
      -- transactional message, and the queued-message send path (unlike
      -- send-sms's direct "send" action) has no opt-out check of its own
      and not coalesce(
        (select c.sms_opt_out from public.customers c where c.salon_id = lv.salon_id and c.phone = lv.customer_phone),
        false
      )
  loop
    v_token := public.create_rebooking_token(
      v_candidate.salon_id, v_candidate.customer_phone, v_candidate.service_id, v_candidate.staff_id, 'predictive'
    );

    v_body := 'سلام ' || nullif(trim(v_candidate.customer_name), '') || E'\n' ||
      'وقتشه برای ' || v_candidate.service_name || ' بعدی‌تون وقت بگیرید! برای حفظ ظاهرتون و رزرو زمان دلخواه، لمس کنید: ' ||
      coalesce(current_setting('app.base_url', true), '') || '/book?token=' || v_token;

    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (v_candidate.salon_id, v_candidate.customer_phone, v_body, 'predictive_rebooking', 'queued', now());

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$fn$;
-- Not granted to anon/authenticated — only ever invoked by the daily
-- scheduler (an Edge Function using the service_role key), same access
-- pattern as transition_elapsed_appointments()/archive_stale_pending_
-- verifications() from v2.25.
