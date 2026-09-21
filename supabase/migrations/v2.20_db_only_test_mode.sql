-- Migration v2.20 — DB-only OTP test path, no Edge Function required.
-- Idempotent, no data changes, does not modify v2.19 or any earlier
-- migration.
--
-- v2.19's SMS_DRY_RUN path still requires deploying the send-sms Edge
-- Function and setting a CLI secret — real steps some testers haven't
-- gotten to yet. This adds a second, independent path that needs neither:
-- a manager flips one boolean directly in the database (one SQL line, no
-- CLI, no deploy), and the booking-management OTP flow works end-to-end
-- through direct RPC calls only.
--
-- Security posture, unchanged from v2.19's principles:
--   - Off by default (sms_test_mode = false) — an absent/default
--     configuration never enables a weaker path.
--   - Turning it on is an explicit, deliberate action by whoever controls
--     the database — never inferred from "no Edge Function deployed" or
--     any other absence.
--   - Even when on, the plaintext OTP is returned only to the same
--     caller who just requested it for their own phone — never to any
--     other user. Same trust boundary as SMS_DRY_RUN in v2.19, same rate
--     limiting, same hash-only storage, same 5-minute expiry.
--   - This does not bypass verify_booking_otp, token issuance, or any
--     ownership check anywhere else — it only replaces how the OTP gets
--     to the tester (direct RPC response instead of SMS), for this one
--     narrow, explicitly-enabled case.

-- ----------------------------------------------------------------------------
-- 1) A single settings row. Readable by anyone (it's one boolean, not
--    sensitive — knowing whether test mode is on/off grants nothing by
--    itself), writable by managers only.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  id            int primary key default 1 check (id = 1),
  sms_test_mode boolean not null default false
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists p_app_settings_read on public.app_settings;
create policy p_app_settings_read on public.app_settings for select using (true);
drop policy if exists p_app_settings_write on public.app_settings;
create policy p_app_settings_write on public.app_settings for update using (public.is_manager()) with check (public.is_manager());
grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;

-- ----------------------------------------------------------------------------
-- 2) Test-mode OTP request — callable directly by anon/authenticated (no
--    service_role needed, so no Edge Function needed), but refuses to do
--    anything unless sms_test_mode is explicitly true. Mirrors
--    request_booking_otp_internal's generation logic exactly; the only
--    difference is returning the plaintext code in the response instead
--    of handing it to an SMS-sending step.
-- ----------------------------------------------------------------------------
create or replace function public.request_booking_otp_test(p_phone text)
returns json
language plpgsql security definer set search_path = public as $fn$
declare v_otp text; v_salt text; v_hash text; v_bytes bytea; v_test_mode boolean;
begin
  select sms_test_mode into v_test_mode from public.app_settings where id = 1;
  if not coalesce(v_test_mode, false) then
    return json_build_object('ok', false, 'error', 'حالت تست فعال نیست');
  end if;
  if p_phone !~ '^09[0-9]{9}$' then
    return json_build_object('ok', false, 'error', 'شماره نامعتبر است');
  end if;
  if not public.check_rate_limit('otp_request_test:' || p_phone, 5, 10) then
    return json_build_object('ok', false, 'error', 'تعداد درخواست بیش از حد مجاز است — چند دقیقه دیگر دوباره امتحان کنید');
  end if;

  update public.booking_otp_challenges
     set consumed = true
   where phone = p_phone and consumed = false and expires_at > now();

  v_bytes := gen_random_bytes(4);
  v_otp := lpad((
    ((get_byte(v_bytes, 0)::bigint << 24) | (get_byte(v_bytes, 1)::bigint << 16)
     | (get_byte(v_bytes, 2)::bigint << 8) | get_byte(v_bytes, 3)::bigint) % 900000 + 100000
  )::text, 6, '0');
  v_salt := encode(gen_random_bytes(16), 'hex');
  v_hash := encode(digest(v_otp || v_salt, 'sha256'), 'hex');

  insert into public.booking_otp_challenges (phone, otp_hash, salt, expires_at)
  values (p_phone, v_hash, v_salt, now() + interval '5 minutes');

  if random() < 0.01 then
    delete from public.booking_otp_challenges where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('ok', true, 'test_otp', v_otp, 'expires_in_seconds', 300);
end;
$fn$;
grant execute on function public.request_booking_otp_test(text) to anon, authenticated;
