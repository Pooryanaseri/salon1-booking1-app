-- v2.59 guard: no STABLE/IMMUTABLE function may write, directly or through
-- the functions it calls. Supabase runs those in a read-only transaction,
-- so such a function fails for real callers even though SQL tests pass.
with recursive fns as (
  select p.proname, p.provolatile, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
), writers(proname) as (
  select proname from fns where prosrc ~* '(insert\s+into|update\s+public\.|delete\s+from)'
  union
  select f.proname from fns f join writers w on f.prosrc ~* ('\m' || w.proname || '\s*\(') where f.proname <> w.proname
)
select tst.ok(not exists (select 1 from fns where provolatile in ('s', 'i') and proname in (select proname from writers)),
              'read-only functions never write: ' || coalesce((select string_agg(distinct proname, ', ') from fns
                 where provolatile in ('s', 'i') and proname in (select proname from writers)), 'none'));
