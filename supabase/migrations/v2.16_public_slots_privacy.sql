-- Migration v2.16 — close anonymous PII exposure on appointments.
-- Idempotent, no data changes.
--
-- Found while fixing v2.15 (stylist access): p_appt_select still allowed
-- `auth.uid() is null` unrestricted — meaning ANY anonymous visitor to the
-- public booking page could read the full appointments table (every
-- customer's name, phone, price) via a direct Supabase client call, since
-- bootstrap() fetches the whole table with select("*") on every app load,
-- logged in or not.
--
-- Fix: the public booking flow only ever needs OCCUPIED-SLOT data (who's
-- booked when, not who they are) to compute availability. That's now
-- served by a PII-free view. A customer looking up their OWN bookings by
-- phone (the existing "داشبورد من" trust model — typing your own number
-- is what proves ownership) gets a dedicated RPC scoped to that phone
-- only. The raw table's anonymous access is removed entirely.

-- 1) PII-free slots view — id, staff_id, date, start_min, end_min,
--    buffer_minutes, status only. No customer_name/phone/price/discount.
--    A plain view (not security_invoker) runs as its owner, not the
--    querying role, so this exposes ALL rows to anon regardless of the
--    base table's RLS — that's the point, scoped by column instead of by
--    row.
create or replace view public.appointments_public_slots as
select id, staff_id, date, start_min, end_min, buffer_minutes, status
from public.appointments;

grant select on public.appointments_public_slots to anon, authenticated;

-- 2) Customer self-lookup by phone — returns full rows (with PII) but only
--    for that one phone number. Security definer so it works with no
--    session; same trust boundary the app already uses everywhere else
--    (typing your own phone = proving it's yours).
create or replace function public.get_my_bookings(p_phone text)
returns setof public.appointments
language sql stable security definer set search_path = public as $fn$
  select * from public.appointments
  where p_phone ~ '^09[0-9]{9}$' and customer_phone = p_phone
  order by date desc, start_min desc;
$fn$;
grant execute on function public.get_my_bookings(text) to anon, authenticated;

-- 3) Remove the anonymous branch from p_appt_select entirely — anonymous
--    reads now go through the view/RPC above, never the raw table.
--    Manager (full) and stylist (own rows, from v2.15) are unchanged.
drop policy if exists p_appt_select on public.appointments;
create policy p_appt_select on public.appointments for select using (
  public.is_manager()
  or (public.is_staff() and public.my_role() = 'stylist' and staff_id = public.my_stylist_id())
);
