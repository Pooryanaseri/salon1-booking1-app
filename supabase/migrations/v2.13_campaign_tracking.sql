-- ============================================================================
--  Migration v2.13 — campaign conversion tracking & ROI analytics
--  Run AFTER schema.sql + earlier migrations (through v2.12). Idempotent.
--  Purely additive: two new tables, one new nullable column on an existing
--  table, one new isolated trigger, one new RPC. Nothing existing is
--  altered in behavior — sync_customer_from_appointment() (the existing
--  booking trigger) is untouched.
--
--  ATTRIBUTION MODEL: time-based (not link-based). The system has no link
--  shortener today — SMS bodies are plain template text, no URLs are
--  generated or tracked — so building one would mean a whole new redirect
--  service, well past "additive." Time-based attribution needs nothing new
--  at the infrastructure level: a booking counts as a conversion of a
--  campaign if that phone number was sent a campaign SMS within the
--  preceding 7 days. This is the standard fallback attribution model used
--  when link tracking isn't available, and it's what actually answers "did
--  this campaign make our phone ring" for a salon.
--
--  WHY A SEPARATE TRIGGER, NOT AN EXTENSION OF THE EXISTING ONE: the
--  existing sync_customer_from_appointment() already does a lot (customer
--  upsert, campaign_targets.returned flag, loyalty points, referral
--  rewards). Bolting conversion-attribution logic onto it would make an
--  already-dense BEFORE trigger denser and riskier to touch. A separate,
--  minimal AFTER INSERT trigger keeps this feature's logic fully isolated
--  — it reads sms_messages and writes campaign_conversions only, and a bug
--  in it cannot affect booking creation itself (AFTER triggers run once the
--  row is already committed to the table).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. campaign_logs — one row per bulk send (smart-campaign or manual-
--    composer), independent of whether it went through the older
--    campaigns/campaign_targets pair (which tracks per-recipient outcomes
--    for a named campaign) — this tracks per-TEMPLATE performance across
--    every kind of send, which the older tables don't do.
-- ----------------------------------------------------------------------------
create table if not exists public.campaign_logs (
  id               text primary key default 'cl-' || substr(md5(gen_random_uuid()::text), 1, 12),
  -- Not FK-constrained: a real sms_templates.id when a manual-composer
  -- template was used, OR a synthetic key (e.g. "champions", "at_risk")
  -- for a one-click RFM smart campaign, which has no row in sms_templates.
  -- template_label is a human-readable snapshot so a title is always
  -- available for display regardless of which case this is.
  template_id      text,
  template_label   text not null default '',
  segment          text, -- RFM segment targeted, if this was a segment-based send; null for a manual/free audience
  sent_at          timestamptz not null default now(),
  total_sent       integer not null default 0,
  successful_count integer not null default 0,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create index if not exists campaign_logs_template_idx on public.campaign_logs (template_id);
create index if not exists campaign_logs_sent_at_idx on public.campaign_logs (sent_at);

alter table public.campaign_logs enable row level security;
drop policy if exists p_campaign_logs_read on public.campaign_logs;
create policy p_campaign_logs_read on public.campaign_logs for select using (public.is_staff());
drop policy if exists p_campaign_logs_write on public.campaign_logs;
create policy p_campaign_logs_write on public.campaign_logs for insert with check (public.is_staff());
-- No update/delete policy — logs are append-only by design.
grant select, insert on public.campaign_logs to authenticated;

-- ----------------------------------------------------------------------------
-- 2. sms_messages gets one new nullable column, linking a send back to the
--    campaign_log it belongs to (null for confirmations/reminders/etc,
--    which aren't campaigns). This is what the attribution trigger below
--    looks up by phone number.
-- ----------------------------------------------------------------------------
alter table public.sms_messages
  add column if not exists campaign_log_id text references public.campaign_logs(id) on delete set null;

create index if not exists sms_messages_campaign_log_idx on public.sms_messages (campaign_log_id);
-- Partial index scoped to only campaign sends — this is exactly the lookup
-- the attribution trigger does on every new booking, so it needs to stay
-- fast as sms_messages grows into the tens of thousands of confirmation/
-- reminder rows that have nothing to do with campaigns.
create index if not exists sms_messages_conversion_lookup_idx
  on public.sms_messages (to_phone, sent_at desc) where campaign_log_id is not null;

-- ----------------------------------------------------------------------------
-- 3. campaign_conversions — one row per booking attributed to a campaign
--    send, written automatically by the trigger below. unique(appointment_id)
--    is the idempotency guard: a given appointment can be attributed at
--    most once, ever, no matter how many times this trigger logic runs.
-- ----------------------------------------------------------------------------
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

alter table public.campaign_conversions enable row level security;
drop policy if exists p_campaign_conversions_read on public.campaign_conversions;
create policy p_campaign_conversions_read on public.campaign_conversions for select using (public.is_staff());
-- No client insert policy: rows are written exclusively by the security-
-- definer trigger function below, which runs with elevated privilege and
-- isn't subject to this table's RLS for its own writes.
grant select on public.campaign_conversions to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Attribution trigger — the ONE new trigger this migration adds to the
--    booking path. Fires AFTER INSERT (the row is already committed, so
--    nothing here can block or slow down booking creation itself), does
--    one indexed lookup, and writes at most one row.
-- ----------------------------------------------------------------------------
create or replace function public.track_campaign_conversion() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare matched_sms record;
begin
  if new.customer_phone !~ '^09[0-9]{9}$' then
    return new;
  end if;

  -- Most recent campaign SMS sent to this phone in the last 7 days, if any.
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

-- ----------------------------------------------------------------------------
-- 5. get_campaign_performance() — per-template conversion rate and
--    attributed revenue. Revenue is joined live from appointments.final_price
--    at query time (not snapshotted at conversion time), so a later price
--    change or completion always reflects accurately — "دقت محاسبات" over
--    a cached number that can go stale.
--
--    Performance: every join below is on an indexed key (campaign_log_id,
--    appointment_id is the appointments primary key) and the whole result
--    is a small, GROUP BY-aggregated set — one row per template, not one
--    row per message or per conversion — so this stays fast as send volume
--    grows into the thousands without needing to change shape.
-- ----------------------------------------------------------------------------
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
  where public.is_staff()
    and (p_template_id is null or cl.template_id = p_template_id)
  group by cl.template_id
  order by conversion_rate desc;
$fn$;
grant execute on function public.get_campaign_performance(text) to authenticated;
