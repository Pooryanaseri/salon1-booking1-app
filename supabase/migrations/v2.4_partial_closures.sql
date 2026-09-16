-- ============================================================================
--  Migration v2.4 — partial-hour closures ("تعطیلی ساعتی")
--  Run AFTER schema.sql + earlier migrations. Idempotent.
--
--  Lets the owner/stylist close just PART of a day (e.g. "13:00–14:00 lunch
--  break") instead of only whole days. A whole-day closure is still just a
--  time_offs row with start_min/end_min left NULL — nothing about existing
--  rows or existing behavior changes.
-- ============================================================================

alter table public.time_offs add column if not exists start_min integer;
alter table public.time_offs add column if not exists end_min integer;

alter table public.time_offs drop constraint if exists time_offs_start_min_check;
alter table public.time_offs add constraint time_offs_start_min_check
  check (start_min is null or start_min between 0 and 1439);

alter table public.time_offs drop constraint if exists time_offs_end_min_check;
alter table public.time_offs add constraint time_offs_end_min_check
  check (end_min is null or end_min between 1 and 1440);

alter table public.time_offs drop constraint if exists time_offs_partial_range_valid;
alter table public.time_offs add constraint time_offs_partial_range_valid check (
  (start_min is null and end_min is null) or
  (start_min is not null and end_min is not null and end_min > start_min)
);
