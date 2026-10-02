-- ============================================================================
-- Migration v2.36 — client error log (run after v2.35)
-- ============================================================================
-- Several serious bugs fixed in v2.30–v2.34 (e.g. no panel insert being
-- saved since v2.24) went unnoticed because failures only reached the
-- browser console. Hosted error trackers such as Sentry refuse traffic from
-- Iran and would also need a CSP exception, so errors are stored here, in
-- the project's own database:
--   * log_client_error(...) — callable by every page, rate-limited, merges
--     repeats of the same error into one row (occurrences / last_seen);
--   * managers read their salon's rows (Panel → ساعات کاری → سلامت برنامه);
--     the developer can query public.client_errors directly;
--   * rows older than 30 days are pruned as new ones arrive.
-- ============================================================================

create table if not exists public.client_errors (
  id           bigint generated always as identity primary key,
  salon_id     uuid references public.salons (id) on delete cascade,
  kind         text not null check (kind in ('render', 'runtime', 'promise', 'save')),
  message      text not null,
  stack        text not null default '',
  url          text not null default '',
  user_agent   text not null default '',
  occurrences  int  not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create index if not exists client_errors_salon_seen_idx on public.client_errors (salon_id, last_seen desc);

alter table public.client_errors enable row level security;
drop policy if exists p_client_errors_read on public.client_errors;
create policy p_client_errors_read on public.client_errors for select
  using (public.is_manager() and salon_id = public.current_salon_id());
grant select on public.client_errors to authenticated;
-- No insert/update policies: rows are written only by log_client_error().

create or replace function public.log_client_error(
  p_kind text, p_message text, p_stack text default '', p_url text default '', p_user_agent text default ''
)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_salon uuid := public.current_salon_id();
  v_msg text := left(coalesce(nullif(trim(p_message), ''), '(no message)'), 500);
begin
  if p_kind not in ('render', 'runtime', 'promise', 'save') then
    return;
  end if;
  -- At most 60 reports per salon per 10 minutes — enough to see a problem,
  -- not enough for a broken page (or someone malicious) to flood the table.
  if not public.check_rate_limit('client_error:' || coalesce(v_salon::text, 'none'), 60, 10) then
    return;
  end if;

  update public.client_errors
     set occurrences = occurrences + 1, last_seen = now()
   where salon_id is not distinct from v_salon and kind = p_kind and message = v_msg
     and last_seen > now() - interval '24 hours';
  if not found then
    insert into public.client_errors (salon_id, kind, message, stack, url, user_agent)
    values (v_salon, p_kind, v_msg, left(coalesce(p_stack, ''), 2000), left(coalesce(p_url, ''), 300), left(coalesce(p_user_agent, ''), 300));
  end if;

  if random() < 0.02 then
    delete from public.client_errors where last_seen < now() - interval '30 days';
  end if;
end;
$fn$;
grant execute on function public.log_client_error(text, text, text, text, text) to anon, authenticated, service_role;
