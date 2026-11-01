-- =============================================================================
--  v2.54 — independent stylists: chair rental and revenue share
--
--  Each stylist can have a contract (latest effective_from wins):
--    employee  — today's model: the salon's revenue, commission to the stylist
--    rent      — fixed monthly rent, the rest is the stylist's
--    share     — a percentage of every service goes to the salon
--    hybrid    — lower rent + lower percentage
--  and a collector:
--    salon     — the salon takes the money (desk, online) and pays the
--                stylist their part at settlement
--    stylist   — the stylist takes it (own card reader); the salon only holds
--                what came through it (online deposits, gift cards, packages)
--  stylist_statement() gives the month's account in one place; a ledger keeps
--  charges (supplies, …), credits and settlements. contract_income() lets
--  accounting show the salon's real income next to the total turnover.
--  Idempotent; safe to run again.
-- =============================================================================

create table if not exists public.stylist_contracts (
  id                 uuid primary key default gen_random_uuid(),
  salon_id           uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  stylist_id         text not null references public.stylists (id) on delete cascade,
  kind               text not null check (kind in ('employee', 'rent', 'share', 'hybrid')),
  rent_amount        bigint not null default 0 check (rent_amount between 0 and 10000000000),
  service_share_pct  numeric(5, 2) not null default 0 check (service_share_pct between 0 and 100),
  collector          text not null default 'salon' check (collector in ('salon', 'stylist')),
  rent_due_day       int not null default 1 check (rent_due_day between 1 and 28),
  effective_from     date not null default date_trunc('month', current_date)::date,
  note               text not null default '' check (length(note) <= 300),
  created_at         timestamptz not null default now(),
  unique (stylist_id, effective_from)
);
create index if not exists stylist_contracts_idx on public.stylist_contracts (salon_id, stylist_id, effective_from desc);
alter table public.stylist_contracts enable row level security;
drop policy if exists p_contracts_mgr on public.stylist_contracts;
create policy p_contracts_mgr on public.stylist_contracts for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id()
              and exists (select 1 from public.stylists s where s.id = stylist_id and s.salon_id = public.current_salon_id()));
drop policy if exists p_contracts_own on public.stylist_contracts;
create policy p_contracts_own on public.stylist_contracts for select
  using (salon_id = public.current_salon_id() and stylist_id = public.my_stylist_id());
grant select, insert, update, delete on public.stylist_contracts to authenticated;

-- charge: the stylist owes the salon (supplies, damage, …)
-- credit: the salon owes the stylist (a refund, a correction, …)
-- paid_to_salon / paid_to_stylist: settlements
create table if not exists public.stylist_ledger (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null default public.current_salon_id() references public.salons (id) on delete cascade,
  stylist_id  text not null references public.stylists (id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  kind        text not null check (kind in ('charge', 'credit', 'paid_to_salon', 'paid_to_stylist')),
  amount      bigint not null check (amount > 0 and amount <= 10000000000),
  label       text not null default '' check (length(label) <= 120),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists stylist_ledger_idx on public.stylist_ledger (salon_id, stylist_id, month);
alter table public.stylist_ledger enable row level security;
drop policy if exists p_ledger_mgr on public.stylist_ledger;
create policy p_ledger_mgr on public.stylist_ledger for all
  using (public.is_manager() and salon_id = public.current_salon_id())
  with check (public.is_manager() and salon_id = public.current_salon_id()
              and exists (select 1 from public.stylists s where s.id = stylist_id and s.salon_id = public.current_salon_id()));
drop policy if exists p_ledger_own on public.stylist_ledger;
create policy p_ledger_own on public.stylist_ledger for select
  using (salon_id = public.current_salon_id() and stylist_id = public.my_stylist_id());
grant select, insert, update, delete on public.stylist_ledger to authenticated;

-- The contract in force on a day.
create or replace function public.contract_on(p_stylist text, p_day date)
returns public.stylist_contracts
language sql stable security definer set search_path = public as $fn$
  select * from public.stylist_contracts
   where stylist_id = p_stylist and effective_from <= p_day
   order by effective_from desc limit 1;
$fn$;
revoke all on function public.contract_on(text, date) from public, anon, authenticated;

-- Per-booking money of one stylist in a date range:
--   gross   — value of the work: what the client paid + gift card + the
--             prepaid package's share of this session (pick-up fees excluded)
--   online  — deposits paid online (always land with the salon)
--   gift    — gift-card part (the salon sold the card)
--   pkg     — package session value (the salon sold the package)
create or replace function public.stylist_takings(p_salon uuid, p_stylist text, p_from date, p_to date)
returns table (visits int, gross bigint, online bigint, gift bigint, pkg bigint)
language sql stable security definer set search_path = public as $fn$
  select count(*)::int,
         coalesce(sum(coalesce(a.final_price, 0) - coalesce(a.transport_fee, 0) + coalesce(a.gift_card_amount, 0)
                      + coalesce(round(pp.price_paid::numeric / nullif(pp.sessions_total, 0)), 0)), 0)::bigint,
         coalesce(sum((select coalesce(sum(y.amount_rial), 0) / 10 from public.payments y
                        where y.appointment_id = a.id and y.status = 'paid')), 0)::bigint,
         coalesce(sum(coalesce(a.gift_card_amount, 0)), 0)::bigint,
         coalesce(sum(coalesce(round(pp.price_paid::numeric / nullif(pp.sessions_total, 0)), 0)), 0)::bigint
    from public.appointments a
    left join public.package_purchases pp on pp.id = a.package_purchase_id
   where a.salon_id = p_salon and a.staff_id = p_stylist and a.status = 'completed'
     and a.date between p_from and p_to;
$fn$;
revoke all on function public.stylist_takings(uuid, text, date, date) from public, anon, authenticated;

-- The month's account of one stylist. balance > 0: the salon owes the
-- stylist; balance < 0: the stylist owes the salon.
create or replace function public.stylist_statement(p_stylist text, p_month date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  c public.stylist_contracts; t record; v_name text;
  v_share bigint; v_rent bigint; v_held bigint; v_charges bigint; v_credits bigint; v_to_salon bigint; v_to_stylist bigint; v_balance bigint;
begin
  if not public.is_staff() or not (public.is_manager() or p_stylist = public.my_stylist_id()) then
    return json_build_object('ok', false, 'error', 'دسترسی ندارید');
  end if;
  select name into v_name from public.stylists where id = p_stylist and salon_id = v_salon;
  if v_name is null then return json_build_object('ok', false, 'error', 'آرایشگر پیدا نشد'); end if;
  c := public.contract_on(p_stylist, v_to);
  if c.id is null or c.kind = 'employee' then
    return json_build_object('ok', true, 'stylist_id', p_stylist, 'name', v_name, 'month', v_from, 'kind', coalesce(c.kind, 'employee'));
  end if;
  select * into t from public.stylist_takings(v_salon, p_stylist, v_from, v_to);
  v_share := round(t.gross * c.service_share_pct / 100.0);
  v_rent := case when c.kind in ('rent', 'hybrid') then c.rent_amount else 0 end;
  -- what the salon is holding of this stylist's work
  v_held := case when c.collector = 'salon' then t.gross else t.online + t.gift + t.pkg end;
  select coalesce(sum(amount) filter (where kind = 'charge'), 0), coalesce(sum(amount) filter (where kind = 'credit'), 0),
         coalesce(sum(amount) filter (where kind = 'paid_to_salon'), 0), coalesce(sum(amount) filter (where kind = 'paid_to_stylist'), 0)
    into v_charges, v_credits, v_to_salon, v_to_stylist
    from public.stylist_ledger where salon_id = v_salon and stylist_id = p_stylist and month = v_from;
  v_balance := v_held - v_share - v_rent - v_charges + v_credits - v_to_stylist + v_to_salon;
  return json_build_object('ok', true, 'stylist_id', p_stylist, 'name', v_name, 'month', v_from,
    'kind', c.kind, 'collector', c.collector, 'service_share_pct', c.service_share_pct, 'rent_amount', c.rent_amount,
    'visits', t.visits, 'gross', t.gross, 'online', t.online, 'gift', t.gift, 'pkg', t.pkg,
    'held_by_salon', v_held, 'held_by_stylist', t.gross - v_held,
    'salon_share', v_share, 'rent', v_rent, 'charges', v_charges, 'credits', v_credits,
    'paid_to_salon', v_to_salon, 'paid_to_stylist', v_to_stylist,
    'stylist_net', t.gross - v_share - v_rent - v_charges + v_credits,
    'balance', v_balance,
    'ledger', coalesce((select json_agg(json_build_object('id', id, 'kind', kind, 'amount', amount, 'label', label, 'created_at', created_at) order by created_at)
                          from public.stylist_ledger where salon_id = v_salon and stylist_id = p_stylist and month = v_from), '[]'::json));
end;
$fn$;
grant execute on function public.stylist_statement(text, date) to authenticated;

-- Accounting: for independent stylists the salon's income is the share and
-- the rent (rent spread over the days of the range), not the turnover.
create or replace function public.contract_income(p_from date, p_to date)
returns json
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon uuid := public.current_salon_id();
begin
  if not public.is_manager() then return json_build_object('ok', false, 'error', 'دسترسی ندارید'); end if;
  return json_build_object('ok', true, 'rows', coalesce((
    select json_agg(r) from (
      select s.id, s.name, c.kind, c.collector, t.gross,
             round(t.gross * c.service_share_pct / 100.0)::bigint as share,
             case when c.kind in ('rent', 'hybrid')
                  then round(c.rent_amount * ((p_to - p_from + 1) / 30.0))::bigint else 0 end as rent
        from public.stylists s
        cross join lateral (select * from public.contract_on(s.id, p_to)) c
        cross join lateral (select * from public.stylist_takings(v_salon, s.id, p_from, p_to)) t
       where s.salon_id = v_salon and c.id is not null and c.kind <> 'employee') r), '[]'::json));
end;
$fn$;
grant execute on function public.contract_income(date, date) to authenticated;

-- Rent reminder on the due day (daily cron).
alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
alter table public.sms_messages add constraint sms_messages_kind_check check (kind in (
  'confirmation', 'reminder', 'cancellation', 'reschedule', 'campaign', 'loyalty', 'custom',
  'reconciliation_prompt', 'weekly_summary', 'predictive_rebooking', 'reschedule_proposed',
  'feedback_request', 'feedback_followup', 'staff_new_booking', 'daily_digest', 'waitlist_offer',
  'staff_change', 'quote_request', 'quote', 'order', 'order_staff',
  'pet_update', 'pet_report', 'pet_reminder', 'pet_package', 'gift_card', 'checkin',
  'slot_offer', 'event', 'rating_alert', 'plan', 'rent')) not valid;

create or replace function public.rent_reminders()
returns int
language plpgsql security definer set search_path = public as $fn$
declare r record; n int := 0; v_day date := public.salon_today();
begin
  for r in
    select s.salon_id, s.id, s.phone, sa.name as salon_name, c.rent_amount
      from public.stylists s
      join public.salons sa on sa.id = s.salon_id and sa.active
      cross join lateral (select * from public.contract_on(s.id, v_day)) c
     where s.active and c.id is not null and c.kind in ('rent', 'hybrid') and c.rent_amount > 0
       and c.rent_due_day = extract(day from v_day)::int and s.phone ~ '^09[0-9]{9}$'
       and not exists (select 1 from public.sms_messages m where m.salon_id = s.salon_id and m.to_phone = s.phone
                         and m.kind = 'rent' and m.created_at > now() - interval '20 days')
  loop
    insert into public.sms_messages (salon_id, to_phone, body, kind, status, scheduled_for)
    values (r.salon_id, r.phone, 'یادآوری: اجارهٔ صندلی این ماه (' || public.fa_money(r.rent_amount) || ' تومان) امروز سررسید است — '
            || r.salon_name || '. صورت‌حساب کامل در پنل شما.', 'rent', 'queued', now());
    n := n + 1;
  end loop;
  return n;
end;
$fn$;
revoke all on function public.rent_reminders() from public, anon, authenticated;
grant execute on function public.rent_reminders() to service_role;
