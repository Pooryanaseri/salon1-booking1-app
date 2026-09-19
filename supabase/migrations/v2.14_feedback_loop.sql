-- Migration v2.14 — customer feedback loop. Idempotent.

create table if not exists public.feedbacks (
  id         text primary key default 'fb-' || substr(md5(gen_random_uuid()::text), 1, 12),
  booking_id text not null unique references public.appointments(id) on delete cascade,
  rating     int not null check (rating between 1 and 5),
  tags       text[] not null default '{}',
  comment    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists feedbacks_created_at_idx on public.feedbacks (created_at);

alter table public.feedbacks enable row level security;

-- Public insert, no login: booking_id (appointments.id, already an opaque
-- per-booking string) is the bearer token — same trust model as the
-- tracking-code lookup used elsewhere in this app. Restricted to bookings
-- that are actually completed, so a random/guessed id or an unfinished
-- booking can't be used to submit feedback. unique(booking_id) blocks a
-- second submission for the same booking.
drop policy if exists p_feedback_insert on public.feedbacks;
create policy p_feedback_insert on public.feedbacks
  for insert
  with check (
    exists (select 1 from public.appointments a where a.id = booking_id and a.status = 'completed')
  );

drop policy if exists p_feedback_read on public.feedbacks;
create policy p_feedback_read on public.feedbacks
  for select using (public.is_staff());

grant select, insert on public.feedbacks to anon, authenticated;
