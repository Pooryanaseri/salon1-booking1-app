-- Assertion + identity helpers for the DB tests (schema `tst`).
create schema if not exists tst;
grant usage on schema tst to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

create or replace function tst.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'ASSERT FAILED: %', p_msg; end if;
end $$;

-- Runs p_sql as the CURRENT role and requires it to fail (optionally with
-- p_contains in the message).
create or replace function tst.expect_error(p_sql text, p_contains text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_contains is not null and position(p_contains in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: expected error containing "%", got: %', p_contains, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: expected an error from: %', p_sql;
end $$;

-- Who is calling (PostgREST sets these per request).
create or replace function tst.as_anon(p_salon uuid default '00000000-0000-0000-0000-000000000001') returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.email', '', false),
         set_config('request.headers', json_build_object('x-salon-id', p_salon)::text, false);
$$;
create or replace function tst.as_user(p_id uuid, p_email text default '', p_salon uuid default '00000000-0000-0000-0000-000000000001') returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id::text, false),
         set_config('request.jwt.claim.email', p_email, false),
         set_config('request.headers', json_build_object('x-salon-id', p_salon)::text, false);
$$;
grant execute on all functions in schema tst to anon, authenticated, service_role;
