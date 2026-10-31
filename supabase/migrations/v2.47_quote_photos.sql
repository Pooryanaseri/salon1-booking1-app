-- ============================================================================
-- Migration v2.47 — photos with price-quote requests (run after v2.46)
-- ============================================================================
--  The customer can attach up to 4 photos of the animal to a quote request
--  so the groomer sees the coat, mats and size before pricing.
--   - Private Storage bucket "quote-photos" (3 MB per file, jpeg/png/webp;
--     the app shrinks photos to ~1600 px JPEG before upload).
--   - Path: <salon_id>/<quote_id>/<random>.jpg. Anyone may upload only
--     into a quote that is still pending and less than 2 hours old, at
--     most 4 files — the quote id (a random uuid only the requester gets
--     back) is the capability.
--   - Only that salon's staff can read them (signed URLs in the panel).
--  If Storage isn't installed (plain Postgres), the bucket and policies are
--  skipped and the rest of the app works unchanged.
-- ============================================================================

create or replace function public.quote_photo_upload_ok(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare v_salon text := split_part(coalesce(p_name, ''), '/', 1); v_quote text := split_part(coalesce(p_name, ''), '/', 2);
        v_file text := split_part(coalesce(p_name, ''), '/', 3); v_count int;
begin
  if split_part(p_name, '/', 4) <> ''
     or v_file !~ '^[a-z0-9-]{8,64}\.(jpg|jpeg|png|webp)$'
     or v_salon !~ '^[0-9a-f-]{36}$' or v_quote !~ '^[0-9a-f-]{36}$' then
    return false;
  end if;
  if not exists (select 1 from public.quote_requests q
                  where q.id = v_quote::uuid and q.salon_id = v_salon::uuid
                    and q.status = 'pending' and q.created_at > now() - interval '2 hours') then
    return false;
  end if;
  execute 'select count(*) from storage.objects where bucket_id = $1 and name like $2'
     into v_count using 'quote-photos', v_salon || '/' || v_quote || '/%';
  return v_count < 4;
end;
$fn$;
revoke all on function public.quote_photo_upload_ok(text) from public;
grant execute on function public.quote_photo_upload_ok(text) to anon, authenticated;

do $do$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage not found — quote photos are disabled on this database';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('quote-photos', 'quote-photos', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists quote_photos_upload on storage.objects';
  execute $p$create policy quote_photos_upload on storage.objects for insert to anon, authenticated
           with check (bucket_id = 'quote-photos' and public.quote_photo_upload_ok(name))$p$;
  execute 'drop policy if exists quote_photos_staff_read on storage.objects';
  execute $p$create policy quote_photos_staff_read on storage.objects for select to authenticated
           using (bucket_id = 'quote-photos' and public.is_staff()
                  and split_part(name, '/', 1) = public.current_salon_id()::text)$p$;
end
$do$;
