-- ============================================================================
-- Migration v2.24 — Multi-Tenant SaaS foundation (part 7: RLS for the
-- salons table itself)
-- ============================================================================
-- Found while designing the frontend tenant-resolution flow: salons never
-- got RLS enabled or any grant at all in parts 1-6. Resolving a URL slug
-- to a salon_id is necessarily the FIRST thing the frontend does, before
-- any salon context (and therefore the x-salon-id header) exists — so
-- this lookup can't depend on current_salon_id() the way every other
-- policy in this migration set does. A public, slug-based read (name/id/
-- slug/active only — a directory entry, not sensitive) is the standard,
-- correct answer: anyone choosing which salon's booking page to open
-- necessarily needs this exact lookup to work with no prior context.
-- Row-level write access stays fully locked down (service_role only, for
-- provisioning new salons — no self-service tenant creation from the
-- client in this delivery; see the checklist).
-- ============================================================================

alter table public.salons enable row level security;

drop policy if exists p_salons_read on public.salons;
create policy p_salons_read on public.salons for select using (active);

grant select on public.salons to anon, authenticated;
-- No insert/update/delete policy at all: default-deny for every direct
-- client operation. New salons are provisioned via the service_role key
-- only (an admin/ops path outside this app, e.g. Supabase SQL editor or
-- a future dedicated onboarding Edge Function — deliberately not exposed
-- to any authenticated app user in this delivery).
