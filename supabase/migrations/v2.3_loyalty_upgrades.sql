-- ============================================================================
--  Migration v2.3 — loyalty/referral program upgrades
--  Run AFTER schema.sql + v2.1_security.sql + v2.2_critical_fixes.sql.
--  Idempotent.
-- ============================================================================

-- 1. Referral reward increased significantly (30x a single visit's points,
--    so referring a friend is clearly the single most rewarding action).
update public.loyalty_settings set referral_points = 300 where id = 1 and referral_points = 50;

-- 2. customer_loyalty() now also returns max_discount, an at_cap flag (so the
--    UI can clearly show "ready to redeem"), and the customer's referral
--    downline (people they referred).
create or replace function public.customer_loyalty(p_phone text)
returns json language plpgsql stable security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int;
begin
  select * into ls from public.loyalty_settings where id = 1;
  select * into c from public.customers where phone = p_phone;
  if c is null then
    return json_build_object('found', false, 'points', 0, 'discount_percent', 0, 'history', '[]'::json, 'referrals', '[]'::json);
  end if;
  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  return json_build_object(
    'found', true,
    'name', c.name,
    'points', c.loyalty_points,
    'total_visits', c.total_visits,
    'referral_code', c.referral_code,
    'discount_percent', disc,
    'max_discount', ls.max_discount,
    'at_cap', disc >= ls.max_discount,
    'points_to_next_tier', greatest(ls.points_per_tier - (c.loyalty_points % greatest(ls.points_per_tier, 1)), 0),
    'history', coalesce((
      select json_agg(json_build_object('delta', l.delta, 'reason', l.reason, 'at', l.created_at) order by l.created_at desc)
        from (select * from public.loyalty_ledger where customer_phone = p_phone
               order by created_at desc limit 30) l
    ), '[]'::json),
    'referrals', coalesce((
      select json_agg(json_build_object('name', r.name, 'phone', r.phone, 'total_visits', r.total_visits, 'joined_at', r.created_at) order by r.created_at desc)
        from public.customers r where r.referred_by = p_phone
    ), '[]'::json)
  );
end $fn$;
grant execute on function public.customer_loyalty(text) to anon, authenticated;

-- 3. redeem_loyalty_reward(): staff-only, resets a customer's points to zero
--    once they've reached the discount cap, logging the redemption in the
--    ledger for an honest history (never a silent reset).
create or replace function public.redeem_loyalty_reward(p_phone text)
returns json language plpgsql security definer set search_path = public as $fn$
declare c record; ls record; tier int; disc int;
begin
  if not (public.is_manager() or public.my_role() = 'stylist') then
    return json_build_object('ok', false, 'error', 'اجازهٔ این کار را ندارید');
  end if;
  select * into ls from public.loyalty_settings where id = 1;
  select * into c from public.customers where phone = p_phone;
  if c is null then return json_build_object('ok', false, 'error', 'مشتری پیدا نشد'); end if;

  tier := floor(c.loyalty_points::numeric / greatest(ls.points_per_tier, 1));
  disc := least(tier * ls.discount_per_tier, ls.max_discount);
  if disc < ls.max_discount then
    return json_build_object('ok', false, 'error', 'مشتری هنوز به سقف تخفیف نرسیده');
  end if;
  if c.loyalty_points <= 0 then
    return json_build_object('ok', false, 'error', 'امتیازی برای استفاده نیست');
  end if;

  insert into public.loyalty_ledger (customer_phone, delta, reason) values (p_phone, -c.loyalty_points, 'redeemed');
  update public.customers set loyalty_points = 0 where phone = p_phone;

  return json_build_object('ok', true, 'redeemed_discount_percent', disc);
end $fn$;
grant execute on function public.redeem_loyalty_reward(text) to authenticated;
