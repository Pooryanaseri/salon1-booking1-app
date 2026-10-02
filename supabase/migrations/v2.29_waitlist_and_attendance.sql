-- ============================================================================
-- Migration v2.29 — Waitlist auto-offer + customer attendance confirmation
-- ============================================================================
-- Continues v2.28 (hands-off automation). Two more jobs move from people to
-- the system, each switchable per salon in app_settings (both ON by default):
--
--   1. waitlist_auto_offer — when a booking is cancelled, everyone on that
--      day's waitlist gets an SMS with a single-use booking link (the
--      existing /book?token=… page from v2.26, now pre-set to the freed
--      day). First to book gets the slot. Nobody has to phone anyone.
--      Booking (by any path) removes that customer from that day's list.
--
--   2. attendance_confirmation — every reminder SMS carries a personal link
--      to /confirm?token=… where the customer taps "I'll be there" or
--      "I can't make it". Declining cancels the booking, which in turn
--      offers the slot to the waitlist (1) — a no-show turned into a
--      re-filled slot with zero staff involvement.
--
--   Plus: any cancellation of a booking for TODAY sends the stylist a short
--   SMS (the morning digest from v2.28 already went out, so this is the one
--   change they need to hear about straight away).
--
-- Links need the public site address. Set it once (see DEPLOY.md):
--   alter database postgres set app.base_url = 'https://your-domain.com';
-- Without it no link is sent (the closure/predictive SMS from v2.26 had the
-- same dependency, undocumented until now).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) Settings, SMS kinds, link helper
-- ----------------------------------------------------------------------------
alter table public.app_settings add column if not exists waitlist_auto_offer     boolean not null default true;
alter table public.app_settings add column if not exists attendance_confirmation boolean not null default true;

alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check
  check (kind in (
    'confirmation','reminder','cancellation','reschedule','campaign','loyalty','custom',
    'reconciliation_prompt','weekly_summary','predictive_rebooking',
    'reschedule_proposed','feedback_request','feedback_followup','staff_new_booking',
    'daily_digest','waitlist_offer','staff_change'
  ));

-- Absolute link to a public page, or NULL when app.base_url isn't set (so
-- callers can skip the link instead of sending a broken relative one).
create or replace function public.public_link(p_path text) returns text
language sql stable as $$
  select case when coalesce(current_setting('app.base_url', true), '') = '' then null
              else rtrim(current_setting('app.base_url', true), '/') || p_path end
$$;

-- ----------------------------------------------------------------------------
-- 1) Waitlist auto-offer
-- ----------------------------------------------------------------------------
alter table public.rebooking_tokens add column if not exists preferred_date date;
alter table public.rebooking_tokens drop constraint if exists rebooking_tokens_reason_check;
alter table public.rebooking_tokens add constraint rebooking_tokens_reason_check
  check (reason in ('closure', 'predictive', 'manual', 'waitlist'));

alter table public.waitlist add column if not exists notified_at timestamptz;

-- resolve_rebooking_token now also tells the page why the link was sent and
-- which day to open on.
create or replace function public.resolve_rebooking_token(p_token text)
returns json
language sql stable security definer set search_path = public as $fn$
  select case when rt.id is null then json_build_object('ok', false, 'error', 'این لینک منقضی یا نامعتبر است')
    else json_build_object(
      'ok', true,
      'salon_id', rt.salon_id,
      'salon_name', s.name,
      'salon_slug', s.slug,
      'customer_name', rt.customer_name,
      'service_id', rt.service_id,
      'service_name', svc.name,
      'staff_id', rt.staff_id,
      'staff_name', st.name,
      'reason', rt.reason,
      'preferred_date', rt.preferred_date
    )
  end
  from (select 1) as dummy
  left join public.rebooking_tokens rt
    on rt.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   and rt.used_at is null and rt.expires_at > now()
  left join public.salons s on s.id = rt.salon_id
  left join public.services svc on svc.id = rt.service_id and svc.salon_id = rt.salon_id
  left join public.stylists st on st.id = rt.staff_id and st.salon_id = rt.salon_id;
$fn$;
grant execute on function public.resolve_rebooking_token(text) to anon, authenticated;

create or replace function public.on_appointment_cancelled()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_set record; v_w record; v_token text; v_link text; v_salon_name text;
  v_staff_phone text; v_service_name text; v_offered int := 0;
  c_max_offers constant int := 5;
begin
  if new.status <> 'cancelled' or old.status not in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed') then
    return new;
  end if;
  if new.date < current_date then
    return new;
  end if;

  select * into v_set from public.app_settings where salon_id = new.salon_id;
  select name into v_salon_name from public.salons where id = new.salon_id;

  -- Same-day change: tell the stylist now (their morning digest is stale).
  if new.date = current_date and new.staff_id is not null and coalesce(v_set.staff_daily_digest, false) then
    select phone into v_staff_phone from public.stylists where id = new.staff_id and salon_id = new.salon_id;
    select name into v_service_name from public.services where id = new.service_id and salon_id = new.salon_id;
    if v_staff_phone ~ '^09[0-9]{9}$' then
      insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
      values (new.salon_id, v_staff_phone,
              'لغو شد: نوبت امروز ساعت ' || public.fa_clock(new.start_min) || ' — '
                || coalesce(nullif(new.customer_name, ''), 'مشتری') || ' (' || coalesce(v_service_name, 'خدمت') || ')',
              'staff_change', new.id, 'queued', now());
    end if;
  end if;

  -- Offer the freed time to that day's waitlist.
  if coalesce(v_set.waitlist_auto_offer, false) then
    for v_w in
      select w.*
        from public.waitlist w
       where w.salon_id = new.salon_id and w.date = new.date
         and w.customer_phone ~ '^09[0-9]{9}$'
         and w.customer_phone <> new.customer_phone
         and (w.staff_id is null or new.staff_id is null or w.staff_id = new.staff_id)
         -- already holds a booking that day: no need to offer
         and not exists (
           select 1 from public.appointments a
            where a.salon_id = w.salon_id and a.date = w.date and a.customer_phone = w.customer_phone
              and a.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed')
         )
       order by w.created_at
       limit c_max_offers
    loop
      v_token := public.create_rebooking_token(new.salon_id, v_w.customer_phone, coalesce(v_w.service_id, new.service_id), v_w.staff_id, 'waitlist');
      update public.rebooking_tokens
         set preferred_date = new.date,
             expires_at = least(expires_at, (new.date + 1)::timestamptz)
       where token_hash = encode(digest(v_token, 'sha256'), 'hex');
      v_link := public.public_link('/book?token=' || v_token);
      continue when v_link is null;

      insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
      values (new.salon_id, v_w.customer_phone,
              coalesce(v_salon_name, 'سالن') || ': نوبتی در روزی که در لیست انتظارش بودید خالی شد. '
                || 'هر کس زودتر رزرو کند، نوبت مال اوست: ' || v_link,
              'waitlist_offer', 'queued', now());
      update public.waitlist set notified_at = now() where id = v_w.id;
      v_offered := v_offered + 1;
    end loop;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_on_appointment_cancelled on public.appointments;
create trigger trg_on_appointment_cancelled
  after update of status on public.appointments
  for each row execute function public.on_appointment_cancelled();

-- Whoever books a day (by any path) leaves that day's waitlist.
create or replace function public.clear_waitlist_on_booking()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  delete from public.waitlist
   where salon_id = new.salon_id and date = new.date and customer_phone = new.customer_phone;
  return new;
end;
$fn$;

drop trigger if exists trg_clear_waitlist_on_booking on public.appointments;
create trigger trg_clear_waitlist_on_booking
  after insert on public.appointments
  for each row execute function public.clear_waitlist_on_booking();

-- ----------------------------------------------------------------------------
-- 2) Attendance confirmation
-- ----------------------------------------------------------------------------
alter table public.appointments add column if not exists attendance_token_hash text;
alter table public.appointments add column if not exists customer_response     text;
alter table public.appointments add column if not exists customer_responded_at timestamptz;
alter table public.appointments drop constraint if exists appointments_customer_response_check;
alter table public.appointments add constraint appointments_customer_response_check
  check (customer_response is null or customer_response in ('confirmed', 'declined'));
create unique index if not exists appointments_attendance_token_idx
  on public.appointments (attendance_token_hash) where attendance_token_hash is not null;

-- Mints the link for one appointment (only the hash is stored). Each call
-- replaces the previous token, so only the latest link works.
create or replace function public.issue_attendance_link(p_appointment_id text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare v_token text; v_link text;
begin
  v_token := encode(gen_random_bytes(32), 'hex');
  v_link := public.public_link('/confirm?token=' || v_token);
  if v_link is null then
    return null;
  end if;
  update public.appointments
     set attendance_token_hash = encode(digest(v_token, 'sha256'), 'hex')
   where id = p_appointment_id;
  return v_link;
end;
$fn$;
revoke all on function public.issue_attendance_link(text) from public, anon, authenticated;

-- Every queued reminder (client-scheduled or not) gets the link appended,
-- so no Edge Function change is needed for the normal path.
create or replace function public.add_attendance_link_to_reminder()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_link text;
begin
  if new.kind = 'reminder' and new.appointment_id is not null and new.status = 'queued'
     and coalesce((select attendance_confirmation from public.app_settings where salon_id = new.salon_id), false)
  then
    v_link := public.issue_attendance_link(new.appointment_id);
    if v_link is not null then
      new.body := new.body || E'\n' || 'تایید حضور یا لغو: ' || v_link;
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_add_attendance_link_to_reminder on public.sms_messages;
create trigger trg_add_attendance_link_to_reminder
  before insert on public.sms_messages
  for each row execute function public.add_attendance_link_to_reminder();

-- What the /confirm page shows. Token is the only credential; no PII
-- beyond the customer's own first name and their own booking.
create or replace function public.get_attendance(p_token text)
returns json
language sql stable security definer set search_path = public as $fn$
  select case when a.id is null then json_build_object('ok', false, 'error', 'این لینک نامعتبر است')
    else json_build_object(
      'ok', true,
      'salon_name', s.name,
      'customer_name', a.customer_name,
      'service_name', svc.name,
      'staff_name', nullif(a.staff_name, ''),
      'date', a.date,
      'start_min', a.start_min,
      'status', a.status,
      'customer_response', a.customer_response,
      'active', a.status in ('pending', 'confirmed', 'rescheduled') and a.date >= current_date
    )
  end
  from (select 1) as dummy
  left join public.appointments a on a.attendance_token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  left join public.salons s on s.id = a.salon_id
  left join public.services svc on svc.id = a.service_id and svc.salon_id = a.salon_id;
$fn$;
grant execute on function public.get_attendance(text) to anon, authenticated;

create or replace function public.respond_attendance(p_token text, p_response text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_appt record;
begin
  if p_response not in ('confirmed', 'declined') then
    return json_build_object('ok', false, 'error', 'پاسخ نامعتبر است');
  end if;
  select * into v_appt from public.appointments
   where attendance_token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;
  if v_appt.id is null then
    return json_build_object('ok', false, 'error', 'این لینک نامعتبر است');
  end if;
  if v_appt.status not in ('pending', 'confirmed', 'rescheduled') or v_appt.date < current_date then
    return json_build_object('ok', false, 'error', 'این نوبت دیگر فعال نیست');
  end if;

  if p_response = 'confirmed' then
    update public.appointments
       set customer_response = 'confirmed', customer_responded_at = now()
     where id = v_appt.id;
  else
    -- Cancelling fires on_appointment_cancelled: same-day stylist SMS and
    -- the waitlist offer happen there.
    update public.appointments
       set status = 'cancelled', customer_response = 'declined', customer_responded_at = now()
     where id = v_appt.id;
    update public.sms_messages set status = 'cancelled', error = 'customer declined via attendance link'
     where appointment_id = v_appt.id and status = 'queued'
       and kind in ('reminder', 'feedback_request', 'feedback_followup'); -- not the stylist notice queued just above
  end if;

  return json_build_object('ok', true, 'response', p_response);
end;
$fn$;
grant execute on function public.respond_attendance(text, text) to anon, authenticated;
