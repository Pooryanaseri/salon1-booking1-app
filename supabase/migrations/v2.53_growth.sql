-- =============================================================================
--  v2.53 — growth tools
--
--   4. Off-peak pricing ("ساعت طلایی"): discount rules for quiet hours.
--   5. Freed slots: a cancelled booking today/tomorrow is also offered by SMS
--      to regulars who have not been in for a while (on top of the waitlist).
--   7. Add-on offers at booking: "+ hair mask for X" right after choosing a
--      service.
--   8. Events (bride, engagement, …): request → quote → accept → deposit
--      (online or at the desk) → staged payments.
--   9. Reviews: 5-star clients are sent to the salon's Google / Neshan page;
--      a low score alerts the owner by SMS.
--  10. Booking sources: ?src=instagram links, stored on the booking.
--  12. Staff monthly targets with a bonus.
--  13. Platform plans: plans, platform merchant, invoices paid online,
--      payment-fee report for the platform owner.
--  Idempotent; safe to run again.
-- =============================================================================

-- ------------------------------------------------------------ shared -------
alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote', 'order', 'order_staff',
  'pet_update', 'pet_report', 'pet_reminder', 'pet_package', 'gift_card', 'checkin',
  'slot_offer', 'event', 'rating_alert', 'plan')) not valid;

alter table public.rebooking_tokens drop constraint if exists rebooking_tokens_reason_check;
alter table public.rebooking_tokens add constraint rebooking_tokens_reason_check
  check (reason in ('closure', 'predictive', 'manual', 'waitlist', 'quote', 'slot_offer')) not valid;

alter table public.app_settings add column if not exists slot_offer_lapsed boolean not null default false;
alter table public.app_settings add column if not exists slot_offer_lapsed_days int not null default 45;
alter table public.app_settings drop constraint if exists app_settings_slot_offer_days_check;
alter table public.app_settings add constraint app_settings_slot_offer_days_check check (slot_offer_lapsed_days between 14 and 365);
alter table public.app_settings add column if not exists low_rating_alert boolean not null default true;

-- Helper: weekday in the schema's numbering (0 = Saturday).
create or replace function public.schema_dow(p date) returns int
language sql immutable as $$ select (extract(dow from p)::int + 1) % 7 $$;
grant execute on function public.schema_dow(date) to anon, authenticated;

-- ------------------------------------------------------ 4. off-peak --------
create table if not exists public.offpeak_rules (
  id           uuid primary key default gen_random_uuid(),
  salon_id     uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  day_of_week  int check (day_of_week between 0 and 6),          -- null = every day
  start_min    int not null check (start_min between 0 and 1439),
  end_min      int not null check (end_min between 1 and 1440),
  percent      int not null check (percent between 5 and 50),
  label        text not null default 'ساعت طلایی' check (length(label) between 1 and 30),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  check (end_min > start_min)
);
alter table public.offpeak_rules enable row level security;
drop policy if exists p_offpeak_mgr on public.offpeak_rules;
create policy p_offpeak_mgr on public.offpeak_rules for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.offpeak_rules to authenticated;

alter table public.appointments add column if not exists offpeak_discount bigint;

create or replace function public.get_offpeak_rules()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object('day', day_of_week, 'start', start_min, 'end', end_min, 'percent', percent, 'label', label)
                           order by percent desc), '[]'::json)
    from public.offpeak_rules where salon_id = public.current_salon_id() and active;
$fn$;
grant execute on function public.get_offpeak_rules() to anon, authenticated;

-- Best matching rule for a date + start minute (null when none).
create or replace function public.offpeak_percent(p_salon uuid, p_date date, p_start int)
returns int
language sql stable security definer set search_path = public as $fn$
  select max(percent) from public.offpeak_rules
   where salon_id = p_salon and active
     and (day_of_week is null or day_of_week = public.schema_dow(p_date))
     and p_start >= start_min and p_start < end_min;
$fn$;
revoke all on function public.offpeak_percent(uuid, date, int) from public, anon, authenticated;

-- Applied by the booking page right after the booking (like a discount code).
create or replace function public.apply_offpeak(p_appt text, p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_pct int; v_base bigint; v_disc bigint;
begin
  select * into a from public.appointments
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone for update;
  if a.id is null or a.created_at < now() - interval '30 minutes' or a.offpeak_discount is not null
     or a.final_price is null or a.status in ('cancelled', 'no_show', 'completed') then
    return json_build_object('ok', false);
  end if;
  v_pct := public.offpeak_percent(a.salon_id, a.date, a.start_min);
  if v_pct is null then return json_build_object('ok', false); end if;
  v_base := greatest(0, a.final_price - coalesce(a.transport_fee, 0));
  v_disc := round(v_base * v_pct / 100.0);
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments
     set offpeak_discount = v_disc, final_price = final_price - v_disc,
         deposit_amount = case when deposit_amount is not null then least(deposit_amount, greatest(1000, final_price - v_disc)) end
   where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', true, 'percent', v_pct, 'discount', v_disc, 'final_price', a.final_price - v_disc);
end;
$fn$;
grant execute on function public.apply_offpeak(text, text) to anon, authenticated;

-- ------------------------------------------------- 5. freed slots ----------
-- The waitlist offer (earlier versions) still runs first; this adds regulars
-- who have not been in for slot_offer_lapsed_days, max 5 per cancellation,
-- at most one such SMS per person per 14 days.
create or replace function public.offer_freed_slot()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_set record; v_c record; v_token text; v_link text; v_salon_name text; v_service record;
  v_now_min int; v_sent int := 0;
begin
  if new.status not in ('cancelled', 'cancelled_by_salon')
     or old.status not in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed') then
    return new;
  end if;
  if new.date not in (public.salon_today(), public.salon_today() + 1) then return new; end if;
  v_now_min := extract(hour from now() at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::int * 60
             + extract(minute from now() at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))::int;
  if new.date = public.salon_today() and new.start_min < v_now_min + 60 then return new; end if;

  select * into v_set from public.app_settings where salon_id = new.salon_id;
  if not coalesce(v_set.slot_offer_lapsed, false) then return new; end if;
  select name into v_salon_name from public.salons where id = new.salon_id;
  select name, gender into v_service from public.services where id = new.service_id and salon_id = new.salon_id;

  for v_c in
    select c.phone, c.name from public.customers c
     where c.salon_id = new.salon_id and not c.sms_opt_out
       and c.phone ~ '^09[0-9]{9}$' and c.phone <> new.customer_phone
       and c.last_booking_at between now() - interval '365 days' and now() - make_interval(days => v_set.slot_offer_lapsed_days)
       and (v_service.gender not in ('female', 'male') or c.gender = v_service.gender)
       and not exists (select 1 from public.appointments a
                        where a.salon_id = c.salon_id and a.customer_phone = c.phone and a.date >= public.salon_today()
                          and a.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment'))
       and not exists (select 1 from public.sms_messages m
                        where m.salon_id = c.salon_id and m.to_phone = c.phone and m.kind = 'slot_offer'
                          and m.created_at > now() - interval '14 days')
     order by c.total_visits desc, c.last_booking_at desc
     limit 5
  loop
    v_token := public.create_rebooking_token(new.salon_id, v_c.phone, new.service_id, new.staff_id, 'slot_offer');
    update public.rebooking_tokens
       set preferred_date = new.date, expires_at = least(expires_at, (new.date + 1)::timestamptz)
     where token_hash = encode(digest(v_token, 'sha256'), 'hex');
    v_link := public.public_link('/book?token=' || v_token);
    exit when v_link is null;
    insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
    values (new.salon_id, v_c.phone,
            coalesce(nullif(split_part(trim(v_c.name), ' ', 1), '') || ' عزیز، ', '') || 'یک نوبت '
              || coalesce(v_service.name, '') || ' ' || case when new.date = public.salon_today() then 'امروز' else 'فردا' end
              || ' ساعت ' || public.fa_clock(new.start_min) || ' در ' || v_salon_name
              || ' خالی شد. اولین نفری که رزرو کند، نوبت مال اوست:' || E'\n' || v_link,
            'slot_offer', new.id, 'queued', now());
    v_sent := v_sent + 1;
  end loop;
  return new;
end;
$fn$;
drop trigger if exists trg_offer_freed_slot on public.appointments;
create trigger trg_offer_freed_slot after update of status on public.appointments
  for each row execute function public.offer_freed_slot();

-- ------------------------------------------------- 7. add-on offers ---------
create table if not exists public.upsell_offers (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  service_id      text not null references public.services (id) on delete cascade,
  addon_service_id text not null references public.services (id) on delete cascade,
  price           bigint not null check (price between 1000 and 10000000000),
  extra_minutes   int not null default 0 check (extra_minutes between 0 and 240),
  pitch           text not null default '' check (length(pitch) <= 120),
  active          boolean not null default true,
  accepted_count  int not null default 0,
  created_at      timestamptz not null default now(),
  unique (salon_id, service_id, addon_service_id),
  check (service_id <> addon_service_id)
);
alter table public.upsell_offers enable row level security;
drop policy if exists p_upsell_mgr on public.upsell_offers;
create policy p_upsell_mgr on public.upsell_offers for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id());
grant select, insert, update, delete on public.upsell_offers to authenticated;
alter table public.appointments add column if not exists upsell_offer_id uuid;

create or replace function public.get_upsell_offers()
returns json
language sql stable security definer set search_path = public as $fn$
  select coalesce(json_agg(json_build_object(
           'id', o.id, 'service_id', o.service_id, 'addon_name', s.name, 'addon_price', s.price,
           'price', o.price, 'extra_minutes', o.extra_minutes, 'pitch', o.pitch)), '[]'::json)
    from public.upsell_offers o join public.services s on s.id = o.addon_service_id and s.salon_id = o.salon_id
   where o.salon_id = public.current_salon_id() and o.active and s.is_active;
$fn$;
grant execute on function public.get_upsell_offers() to anon, authenticated;

create or replace function public.apply_upsell(p_appt text, p_phone text, p_offer uuid)
returns json
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; o public.upsell_offers; v_name text;
begin
  select * into a from public.appointments
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone for update;
  if a.id is null or a.created_at < now() - interval '30 minutes' or a.upsell_offer_id is not null
     or a.status in ('cancelled', 'no_show', 'completed') then
    return json_build_object('ok', false, 'error', 'این پیشنهاد روی این نوبت قابل اعمال نیست');
  end if;
  select * into o from public.upsell_offers where id = p_offer and salon_id = a.salon_id and active and service_id = a.service_id;
  if o.id is null then return json_build_object('ok', false, 'error', 'پیشنهاد پیدا نشد'); end if;
  select name into v_name from public.services where id = o.addon_service_id;
  -- extra time must not run into the stylist's next booking
  if o.extra_minutes > 0 and exists (
       select 1 from public.appointments b
        where b.salon_id = a.salon_id and b.id <> a.id and b.date = a.date and b.staff_id is not distinct from a.staff_id
          and b.status in ('pending', 'confirmed', 'rescheduled', 'reschedule_proposed', 'awaiting_payment')
          and b.start_min < a.end_min + o.extra_minutes and b.end_min > a.end_min) then
    return json_build_object('ok', false, 'error', 'برای «' || v_name || '» بعد از این نوبت وقت خالی نیست — در سالن هماهنگ کنید');
  end if;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments
     set upsell_offer_id = o.id, end_min = end_min + o.extra_minutes,
         extra_charges = coalesce(extra_charges, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('label', v_name, 'amount', o.price)),
         final_price = case when final_price is not null then final_price + o.price end
   where id = a.id;
  perform set_config('app.trusted_rpc', '', true);
  update public.upsell_offers set accepted_count = accepted_count + 1 where id = o.id;
  return json_build_object('ok', true, 'label', v_name, 'amount', o.price, 'extra_minutes', o.extra_minutes);
end;
$fn$;
grant execute on function public.apply_upsell(text, text, uuid) to anon, authenticated;

-- ------------------------------------------------------- 8. events ---------
create table if not exists public.event_requests (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  kind            text not null check (kind in ('bride', 'engagement', 'party', 'groom', 'other')),
  event_date      date not null,
  guests          int not null default 1 check (guests between 1 and 30),
  customer_name   text not null check (length(trim(customer_name)) between 1 and 80),
  customer_phone  text not null check (customer_phone ~ '^09[0-9]{9}$'),
  services        text not null default '' check (length(services) <= 400),
  note            text not null default '' check (length(note) <= 600),
  status          text not null default 'new' check (status in ('new', 'quoted', 'accepted', 'declined', 'cancelled', 'done')),
  quote_total     bigint check (quote_total between 0 and 100000000000),
  deposit_amount  bigint check (deposit_amount between 0 and 100000000000),
  quote_terms     text not null default '' check (length(quote_terms) <= 1500),
  quote_note      text not null default '' check (length(quote_note) <= 600),
  token_hash      text unique,
  quoted_at       timestamptz,
  accepted_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists event_requests_salon_idx on public.event_requests (salon_id, status, event_date);
alter table public.event_requests enable row level security;
drop policy if exists p_event_requests_staff on public.event_requests;
create policy p_event_requests_staff on public.event_requests for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.event_requests to authenticated;

create table if not exists public.event_payments (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.event_requests (id) on delete cascade,
  salon_id    uuid not null references public.salons (id) on delete cascade,
  amount      bigint not null check (amount > 0),
  method      text not null check (method in ('online', 'desk')),
  ref         text not null default '',
  note        text not null default '' check (length(note) <= 200),
  created_at  timestamptz not null default now()
);
create index if not exists event_payments_event_idx on public.event_payments (event_id);
alter table public.event_payments enable row level security;
drop policy if exists p_event_payments_staff on public.event_payments;
create policy p_event_payments_staff on public.event_payments for select
  using (public.is_staff() and salon_id = public.current_salon_id());
grant select on public.event_payments to authenticated;

alter table public.payments add column if not exists event_request_id uuid references public.event_requests (id) on delete set null;

create or replace function public.create_event_request(p_kind text, p_date date, p_guests int, p_name text, p_phone text,
                                                       p_services text default '', p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_id uuid;
begin
  if v_salon is null then return json_build_object('ok', false, 'error', 'سالن پیدا نشد'); end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{9}$' then return json_build_object('ok', false, 'error', 'شماره موبایل نامعتبر است'); end if;
  if trim(coalesce(p_name, '')) = '' then return json_build_object('ok', false, 'error', 'نام لازم است'); end if;
  if p_date is null or p_date < public.salon_today() + 1 or p_date > public.salon_today() + 365 then
    return json_build_object('ok', false, 'error', 'تاریخ مراسم را درست انتخاب کنید');
  end if;
  if p_kind not in ('bride', 'engagement', 'party', 'groom', 'other') then return json_build_object('ok', false, 'error', 'نوع مراسم نامعتبر است'); end if;
  if not public.check_rate_limit('event:' || v_salon || ':' || p_phone, 3, 1440) then
    return json_build_object('ok', false, 'error', 'درخواست شما ثبت شده است؛ سالن با شما تماس می‌گیرد');
  end if;
  insert into public.event_requests (salon_id, kind, event_date, guests, customer_name, customer_phone, services, note)
  values (v_salon, p_kind, p_date, greatest(1, least(30, coalesce(p_guests, 1))), trim(p_name), p_phone,
          left(trim(coalesce(p_services, '')), 400), left(trim(coalesce(p_note, '')), 600))
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$fn$;
grant execute on function public.create_event_request(text, date, int, text, text, text, text) to anon, authenticated;

-- The manager prices it; the client gets a link to read the terms and accept.
create or replace function public.quote_event(p_id uuid, p_total bigint, p_deposit bigint, p_terms text, p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare e public.event_requests; v_token text; v_link text; v_salon_name text;
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into e from public.event_requests where id = p_id and salon_id = public.current_salon_id() for update;
  if e.id is null or e.status not in ('new', 'quoted') then return json_build_object('ok', false, 'error', 'درخواست پیدا نشد'); end if;
  if coalesce(p_total, 0) < 1000 or coalesce(p_deposit, 0) < 0 or p_deposit > p_total then
    return json_build_object('ok', false, 'error', 'مبلغ کل و بیعانه را درست وارد کنید');
  end if;
  v_token := encode(gen_random_bytes(18), 'hex');
  update public.event_requests
     set status = 'quoted', quote_total = p_total, deposit_amount = p_deposit, quote_terms = left(trim(coalesce(p_terms, '')), 1500),
         quote_note = left(trim(coalesce(p_note, '')), 600), token_hash = encode(digest(v_token, 'sha256'), 'hex'), quoted_at = now()
   where id = e.id;
  v_link := public.public_link('/event?token=' || v_token);
  select name into v_salon_name from public.salons where id = e.salon_id;
  if v_link is not null then
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (e.salon_id, e.customer_phone,
            coalesce(nullif(split_part(e.customer_name, ' ', 1), ''), 'مشتری') || ' عزیز، پیش‌فاکتور مراسم شما در ' || v_salon_name
              || ' آماده است. برای دیدن جزئیات و تایید:' || E'\n' || v_link,
            'event', 'queued', now());
  end if;
  return json_build_object('ok', true, 'sent', v_link is not null, 'link', v_link);
end;
$fn$;
grant execute on function public.quote_event(uuid, bigint, bigint, text, text) to authenticated;

create or replace function public.set_event_status(p_id uuid, p_status text)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_status not in ('declined', 'cancelled', 'done') then return json_build_object('ok', false, 'error', 'وضعیت نامعتبر'); end if;
  update public.event_requests set status = p_status where id = p_id and salon_id = public.current_salon_id();
  return json_build_object('ok', found);
end;
$fn$;
grant execute on function public.set_event_status(uuid, text) to authenticated;

-- Payments at the desk (cash / card machine), any number of instalments.
create or replace function public.record_event_payment(p_id uuid, p_amount bigint, p_note text default '')
returns json
language plpgsql security definer set search_path = public as $fn$
declare e public.event_requests; v_paid bigint;
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into e from public.event_requests where id = p_id and salon_id = public.current_salon_id() for update;
  if e.id is null or e.status in ('declined', 'cancelled') then return json_build_object('ok', false, 'error', 'مراسم پیدا نشد'); end if;
  if coalesce(p_amount, 0) < 1000 then return json_build_object('ok', false, 'error', 'مبلغ را وارد کنید'); end if;
  insert into public.event_payments (event_id, salon_id, amount, method, note) values (e.id, e.salon_id, p_amount, 'desk', left(coalesce(p_note, ''), 200));
  if e.status in ('new', 'quoted') then update public.event_requests set status = 'accepted', accepted_at = now() where id = e.id; end if;
  select coalesce(sum(amount), 0) into v_paid from public.event_payments where event_id = e.id;
  return json_build_object('ok', true, 'paid', v_paid, 'left', greatest(0, coalesce(e.quote_total, 0) - v_paid));
end;
$fn$;
grant execute on function public.record_event_payment(uuid, bigint, text) to authenticated;

create or replace function public.get_event_quote(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare e public.event_requests;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{36}$' then return json_build_object('ok', false); end if;
  select * into e from public.event_requests where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if e.id is null or e.status in ('declined', 'cancelled') then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'id', e.id, 'kind', e.kind, 'event_date', e.event_date, 'guests', e.guests,
    'customer_name', e.customer_name, 'services', e.services, 'status', e.status,
    'quote_total', e.quote_total, 'deposit_amount', e.deposit_amount, 'quote_terms', e.quote_terms, 'quote_note', e.quote_note,
    'paid', coalesce((select sum(amount) from public.event_payments p where p.event_id = e.id), 0),
    'salon_name', (select name from public.salons where id = e.salon_id),
    'salon_slug', (select slug from public.salons where id = e.salon_id),
    'online', coalesce((select zarinpal_merchant_id from public.salon_payment_settings where salon_id = e.salon_id), '') <> '');
end;
$fn$;
grant execute on function public.get_event_quote(text) to anon, authenticated;

create or replace function public.accept_event_quote(p_token text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare e public.event_requests;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{36}$' then return json_build_object('ok', false, 'error', 'لینک نامعتبر است'); end if;
  select * into e from public.event_requests where token_hash = encode(digest(p_token, 'sha256'), 'hex') for update;
  if e.id is null or e.status not in ('quoted', 'accepted') then return json_build_object('ok', false, 'error', 'این پیش‌فاکتور قابل تایید نیست'); end if;
  if e.event_date < public.salon_today() then return json_build_object('ok', false, 'error', 'تاریخ مراسم گذشته است'); end if;
  update public.event_requests set status = 'accepted', accepted_at = coalesce(accepted_at, now()) where id = e.id;
  return json_build_object('ok', true, 'id', e.id, 'deposit', e.deposit_amount);
end;
$fn$;
grant execute on function public.accept_event_quote(text) to anon, authenticated;

-- Called by the payment Edge Function after Zarinpal verifies the deposit.
create or replace function public.confirm_event_payment(p_id uuid, p_amount bigint, p_ref text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare e public.event_requests; v_salon_name text;
begin
  select * into e from public.event_requests where id = p_id for update;
  if e.id is null then return; end if;
  if exists (select 1 from public.event_payments where event_id = e.id and method = 'online' and ref = coalesce(p_ref, '')) then return; end if;
  insert into public.event_payments (event_id, salon_id, amount, method, ref) values (e.id, e.salon_id, p_amount, 'online', coalesce(p_ref, ''));
  update public.event_requests set status = 'accepted', accepted_at = coalesce(accepted_at, now()) where id = e.id and status in ('quoted', 'accepted');
  select name into v_salon_name from public.salons where id = e.salon_id;
  insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
  values (e.salon_id, e.customer_phone, 'بیعانهٔ مراسم شما (' || public.fa_money(p_amount) || ' تومان) دریافت شد و تاریخ '
          || public.fa_digits(to_char(e.event_date, 'YYYY/MM/DD')) || ' برایتان رزرو است — ' || v_salon_name, 'event', 'queued', now());
end;
$fn$;
revoke all on function public.confirm_event_payment(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.confirm_event_payment(uuid, bigint, text) to service_role;

-- ------------------------------------------------------- 9. reviews --------
alter table public.salon_profiles add column if not exists review_url text not null default '';
alter table public.salon_profiles drop constraint if exists salon_profiles_review_url_check;
alter table public.salon_profiles add constraint salon_profiles_review_url_check check (review_url = '' or review_url ~ '^https://[^ ]{4,250}$');

-- After a 5-star feedback, the page offers the salon's public review link.
create or replace function public.feedback_followup(p_booking text)
returns json
language sql stable security definer set search_path = public as $fn$
  select json_build_object('ok', true,
           'review_url', case when f.rating = 5 then nullif(p.review_url, '') end,
           'salon_name', s.name)
    from public.feedbacks f
    join public.appointments a on a.id = f.booking_id
    join public.salons s on s.id = a.salon_id
    left join public.salon_profiles p on p.salon_id = a.salon_id
   where f.booking_id = p_booking and f.created_at > now() - interval '1 day';
$fn$;
grant execute on function public.feedback_followup(text) to anon, authenticated;

create or replace function public.alert_low_rating()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare a public.appointments; v_owner text; v_on boolean;
begin
  if new.rating > 3 then return new; end if;
  select * into a from public.appointments where id = new.booking_id;
  if a.id is null then return new; end if;
  select coalesce(low_rating_alert, true) into v_on from public.app_settings where salon_id = a.salon_id;
  if not coalesce(v_on, true) then return new; end if;
  select owner_phone into v_owner from public.salons where id = a.salon_id;
  if coalesce(v_owner, '') !~ '^09[0-9]{9}$' then return new; end if;
  insert into public.sms_messages (salon_id, to_phone, body, kind, appointment_id, status, scheduled_for)
  values (a.salon_id, v_owner,
          'امتیاز ' || public.fa_digits(new.rating::text) || ' از ۵ — ' || coalesce(nullif(a.customer_name, ''), 'مشتری')
            || ' ' || a.customer_phone
            || case when coalesce(a.staff_name, '') <> '' then ' (آرایشگر: ' || a.staff_name || ')' else '' end
            || case when coalesce(new.comment, '') <> '' then E'\n«' || left(new.comment, 200) || '»' else '' end
            || E'\nبا مشتری تماس بگیرید تا نارضایتی به نظر منفی در اینترنت تبدیل نشود.',
          'rating_alert', a.id, 'queued', now());
  return new;
end;
$fn$;
drop trigger if exists trg_alert_low_rating on public.feedbacks;
create trigger trg_alert_low_rating after insert on public.feedbacks
  for each row execute function public.alert_low_rating();

-- ----------------------------------------------------- 10. sources ---------
alter table public.appointments add column if not exists source text;
alter table public.appointments drop constraint if exists appointments_source_check;
alter table public.appointments add constraint appointments_source_check check (source is null or source ~ '^[a-z0-9_-]{1,30}$') not valid;

create or replace function public.set_booking_source(p_appt text, p_phone text, p_source text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_src text := lower(trim(coalesce(p_source, ''))); n int;
begin
  if v_src !~ '^[a-z0-9_-]{1,30}$' then return json_build_object('ok', false); end if;
  perform set_config('app.trusted_rpc', 'on', true);
  update public.appointments set source = v_src
   where id = p_appt and salon_id = public.current_salon_id() and customer_phone = p_phone
     and source is null and created_at > now() - interval '30 minutes';
  get diagnostics n = row_count;
  perform set_config('app.trusted_rpc', '', true);
  return json_build_object('ok', n = 1);
end;
$fn$;
grant execute on function public.set_booking_source(text, text, text) to anon, authenticated;

-- --------------------------------------------------- 12. staff targets -----
create table if not exists public.staff_targets (
  salon_id        uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  stylist_id      text not null references public.stylists (id) on delete cascade,
  month           date not null check (extract(day from month) = 1),
  revenue_target  bigint not null default 0 check (revenue_target >= 0),
  visits_target   int not null default 0 check (visits_target >= 0),
  bonus           bigint not null default 0 check (bonus >= 0),
  primary key (stylist_id, month)
);
alter table public.staff_targets enable row level security;
drop policy if exists p_staff_targets_mgr on public.staff_targets;
create policy p_staff_targets_mgr on public.staff_targets for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id()
              and exists (select 1 from public.stylists s where s.id = stylist_id and s.salon_id = public.current_salon_id()));
drop policy if exists p_staff_targets_own on public.staff_targets;
create policy p_staff_targets_own on public.staff_targets for select
  using (salon_id = public.current_salon_id() and stylist_id = public.my_stylist_id());
grant select, insert, update, delete on public.staff_targets to authenticated;

-- Progress for a month: managers see everyone, a stylist only themself.
create or replace function public.targets_progress(p_month date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); v_from date := date_trunc('month', p_month)::date;
        v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  if not public.is_staff() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'month', v_from, 'rows', coalesce((
    select json_agg(r order by r.name) from (
      select s.id, s.name, coalesce(t.revenue_target, 0) as revenue_target, coalesce(t.visits_target, 0) as visits_target,
             coalesce(t.bonus, 0) as bonus,
             coalesce(sum(a.final_price - coalesce(a.transport_fee, 0)) filter (where a.id is not null), 0) as revenue,
             count(a.id)::int as visits
        from public.stylists s
        left join public.staff_targets t on t.stylist_id = s.id and t.month = v_from
        left join public.appointments a on a.salon_id = s.salon_id and a.staff_id = s.id and a.status = 'completed'
                                       and a.date between v_from and v_to
       where s.salon_id = v_salon and s.active and (public.is_manager() or s.id = public.my_stylist_id())
       group by s.id, s.name, t.revenue_target, t.visits_target, t.bonus) r), '[]'::json));
end;
$fn$;
grant execute on function public.targets_progress(date) to authenticated;

-- ------------------------------------------------------ 13. plans ----------
create table if not exists public.platform_plans (
  id               text primary key check (id ~ '^[a-z0-9_-]{2,20}$'),
  name             text not null check (length(trim(name)) between 1 and 40),
  monthly_price    bigint not null check (monthly_price between 0 and 10000000000),
  sms_quota        int not null default 0 check (sms_quota >= 0),
  payment_fee_pct  numeric(4, 2) not null default 0 check (payment_fee_pct between 0 and 20),
  active           boolean not null default true,
  sort_order       int not null default 0
);
alter table public.platform_plans enable row level security;
drop policy if exists p_platform_plans_read on public.platform_plans;
create policy p_platform_plans_read on public.platform_plans for select using (active or public.is_platform_admin());
drop policy if exists p_platform_plans_admin on public.platform_plans;
create policy p_platform_plans_admin on public.platform_plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select on public.platform_plans to authenticated;
grant insert, update, delete on public.platform_plans to authenticated;

create table if not exists public.platform_settings (
  id                    boolean primary key default true check (id),
  zarinpal_merchant_id  text not null default '' check (zarinpal_merchant_id = '' or zarinpal_merchant_id ~ '^[0-9a-fA-F-]{36}$'),
  trial_days            int not null default 14 check (trial_days between 0 and 90)
);
insert into public.platform_settings (id) values (true) on conflict do nothing;
alter table public.platform_settings enable row level security;
drop policy if exists p_platform_settings_admin on public.platform_settings;
create policy p_platform_settings_admin on public.platform_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select, update on public.platform_settings to authenticated;

alter table public.salons add column if not exists plan_id text references public.platform_plans (id) on delete set null;
alter table public.salons add column if not exists plan_expires_at date;

create table if not exists public.plan_invoices (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salons (id) on delete cascade,
  plan_id     text not null references public.platform_plans (id),
  months      int not null check (months in (1, 3, 6, 12)),
  amount      bigint not null check (amount >= 1000),
  status      text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'cancelled')),
  ref         text not null default '',
  created_at  timestamptz not null default now(),
  paid_at     timestamptz
);
alter table public.plan_invoices enable row level security;
drop policy if exists p_plan_invoices_read on public.plan_invoices;
create policy p_plan_invoices_read on public.plan_invoices for select
  using ((public.is_manager() and salon_id = public.current_salon_id()) or public.is_platform_admin());
grant select on public.plan_invoices to authenticated;

alter table public.payments add column if not exists plan_invoice_id uuid references public.plan_invoices (id) on delete set null;
alter table public.payments drop constraint if exists payments_target_check;
alter table public.payments add constraint payments_target_check check (
  (appointment_id is not null)::int + (order_id is not null)::int + (gift_card_id is not null)::int
  + (package_purchase_id is not null)::int + (event_request_id is not null)::int + (plan_invoice_id is not null)::int = 1) not valid;

-- The salon's own view: plan, expiry, this month's SMS and online payments.
create or replace function public.my_plan()
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id(); s public.salons; p public.platform_plans; v_volume bigint;
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  select * into s from public.salons where id = v_salon;
  select * into p from public.platform_plans where id = s.plan_id;
  select coalesce(sum(amount_rial)::bigint / 10, 0) into v_volume from public.payments
   where salon_id = v_salon and status = 'paid' and plan_invoice_id is null and paid_at >= (date_trunc('month', public.salon_today())::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'));
  return json_build_object('ok', true,
    'plan_id', s.plan_id, 'plan_name', p.name, 'expires_at', s.plan_expires_at,
    'expired', s.plan_expires_at is not null and s.plan_expires_at < public.salon_today(),
    'sms_quota', p.sms_quota,
    'sms_used', (select count(*) from public.sms_messages m where m.salon_id = v_salon and m.status in ('sent', 'delivered')
                   and m.created_at >= (date_trunc('month', public.salon_today())::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran'))),
    'online_volume', v_volume, 'payment_fee_pct', coalesce(p.payment_fee_pct, 0),
    'payment_fee', round(v_volume * coalesce(p.payment_fee_pct, 0) / 100.0),
    'online', coalesce((select zarinpal_merchant_id from public.platform_settings), '') <> '',
    'plans', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'monthly_price', monthly_price,
                                                         'sms_quota', sms_quota, 'payment_fee_pct', payment_fee_pct) order by sort_order, monthly_price)
                         from public.platform_plans where active), '[]'::json));
end;
$fn$;
grant execute on function public.my_plan() to authenticated;

create or replace function public.create_plan_invoice(p_plan text, p_months int)
returns json
language plpgsql security definer set search_path = public as $fn$
declare p public.platform_plans; v_id uuid; v_amount bigint;
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if coalesce((select zarinpal_merchant_id from public.platform_settings), '') = '' then
    return json_build_object('ok', false, 'error', 'پرداخت آنلاین اشتراک فعال نیست — با پشتیبانی تماس بگیرید');
  end if;
  select * into p from public.platform_plans where id = p_plan and active;
  if p.id is null or p_months not in (1, 3, 6, 12) then return json_build_object('ok', false, 'error', 'پلن نامعتبر است'); end if;
  -- 3/6/12 months: 5/10/20 percent off
  v_amount := round(p.monthly_price * p_months * case p_months when 3 then 0.95 when 6 then 0.90 when 12 then 0.80 else 1 end);
  if v_amount < 1000 then return json_build_object('ok', false, 'error', 'این پلن رایگان است'); end if;
  insert into public.plan_invoices (salon_id, plan_id, months, amount) values (public.current_salon_id(), p.id, p_months, v_amount)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'amount', v_amount);
end;
$fn$;
grant execute on function public.create_plan_invoice(text, int) to authenticated;

create or replace function public.extend_salon_plan(p_salon uuid, p_plan text, p_months int)
returns date
language plpgsql security definer set search_path = public as $fn$
declare v_until date;
begin
  update public.salons
     set plan_id = p_plan,
         plan_expires_at = (greatest(coalesce(plan_expires_at, public.salon_today()), public.salon_today()) + make_interval(months => p_months))::date
   where id = p_salon
  returning plan_expires_at into v_until;
  return v_until;
end;
$fn$;
revoke all on function public.extend_salon_plan(uuid, text, int) from public, anon, authenticated;

create or replace function public.confirm_plan_payment(p_id uuid, p_ref text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare i public.plan_invoices;
begin
  select * into i from public.plan_invoices where id = p_id for update;
  if i.id is null or i.status <> 'awaiting_payment' then return; end if;
  update public.plan_invoices set status = 'paid', paid_at = now(), ref = coalesce(p_ref, '') where id = i.id;
  perform public.extend_salon_plan(i.salon_id, i.plan_id, i.months);
end;
$fn$;
revoke all on function public.confirm_plan_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_plan_payment(uuid, text) to service_role;

-- Platform admin: set a plan by hand (trial, cash payment, gift).
create or replace function public.admin_set_plan(p_salon uuid, p_plan text, p_expires date)
returns json
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  if p_plan is not null and not exists (select 1 from public.platform_plans where id = p_plan) then
    return json_build_object('ok', false, 'error', 'پلن پیدا نشد');
  end if;
  update public.salons set plan_id = p_plan, plan_expires_at = p_expires where id = p_salon;
  return json_build_object('ok', found);
end;
$fn$;
revoke all on function public.admin_set_plan(uuid, text, date) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, date) to authenticated;

-- Platform admin: one row per salon for a month — plan, subscription paid,
-- online payment volume and the fee owed, SMS sent.
create or replace function public.admin_billing_report(p_month date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_from timestamptz := date_trunc('month', p_month)::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran');
        v_to timestamptz := (date_trunc('month', p_month) + interval '1 month')::timestamp at time zone coalesce(nullif(current_setting('app.timezone', true), ''), 'Asia/Tehran');
begin
  if not public.is_platform_admin() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(r order by r.fee + r.subscription desc) from (
      select s.id, s.name, s.slug, s.plan_id, p.name as plan_name, s.plan_expires_at,
             coalesce((select sum(i.amount) from public.plan_invoices i where i.salon_id = s.id and i.status = 'paid'
                        and i.paid_at >= v_from and i.paid_at < v_to), 0) as subscription,
             coalesce((select sum(y.amount_rial)::bigint / 10 from public.payments y where y.salon_id = s.id and y.status = 'paid'
                        and y.plan_invoice_id is null and y.paid_at >= v_from and y.paid_at < v_to), 0) as online_volume,
             round(coalesce((select sum(y.amount_rial)::bigint / 10 from public.payments y where y.salon_id = s.id and y.status = 'paid'
                        and y.plan_invoice_id is null and y.paid_at >= v_from and y.paid_at < v_to), 0)
                   * coalesce(p.payment_fee_pct, 0) / 100.0) as fee,
             (select count(*) from public.sms_messages m where m.salon_id = s.id and m.status in ('sent', 'delivered')
               and m.created_at >= v_from and m.created_at < v_to) as sms_sent,
             p.sms_quota
        from public.salons s left join public.platform_plans p on p.id = s.plan_id
       where s.active) r), '[]'::json));
end;
$fn$;
revoke all on function public.admin_billing_report(date) from public, anon;
grant execute on function public.admin_billing_report(date) to authenticated;

-- ---------------------------------------- accounting: event income too -----
create or replace function public.revenue_extras(p_from date, p_to date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if not public.is_manager() then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  return json_build_object(
    'ok', true,
    'shop_revenue', coalesce((select sum(total) from public.orders o
                               where o.salon_id = v_salon and o.created_at::date between p_from and p_to
                                 and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')), 0),
    'shop_orders', (select count(*) from public.orders o
                     where o.salon_id = v_salon and o.created_at::date between p_from and p_to
                       and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')),
    'packages_revenue', coalesce((select sum(price_paid) from public.package_purchases p
                                   where p.salon_id = v_salon and p.status = 'active' and p.created_at::date between p_from and p_to), 0),
    'packages_count', (select count(*) from public.package_purchases p
                        where p.salon_id = v_salon and p.status = 'active' and p.created_at::date between p_from and p_to),
    'gift_cards_revenue', coalesce((select sum(amount) from public.gift_cards g
                                     where g.salon_id = v_salon and g.status = 'active' and g.created_at::date between p_from and p_to), 0),
    'gift_cards_outstanding', coalesce((select sum(balance) from public.gift_cards g
                                         where g.salon_id = v_salon and g.status = 'active' and g.expires_at >= public.salon_today()), 0),
    'events_revenue', coalesce((select sum(amount) from public.event_payments e
                                 where e.salon_id = v_salon and e.created_at::date between p_from and p_to), 0),
    'top_products', coalesce((
      select json_agg(t order by t.revenue desc) from (
        select i.name, sum(i.qty)::int as qty, sum(i.qty * i.unit_price) as revenue
          from public.order_items i join public.orders o on o.id = i.order_id
         where o.salon_id = v_salon and o.created_at::date between p_from and p_to
           and o.status in ('pending', 'confirmed', 'ready', 'shipped', 'delivered')
         group by i.name order by 3 desc limit 8) t), '[]'::json),
    'low_stock', coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name, 'stock', p.stock) order by p.stock)
        from public.products p
       where p.salon_id = v_salon and p.active and p.stock is not null and p.stock <= p.low_stock_at), '[]'::json));
end;
$fn$;
grant execute on function public.revenue_extras(date, date) to authenticated;
