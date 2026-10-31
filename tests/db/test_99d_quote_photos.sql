-- v2.47: photos with quote requests — who may upload and read them.
delete from public.salons where slug = 'tst-photos';
delete from storage.objects where bucket_id = 'quote-photos';
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000b9', '09120008899@salon.local')
on conflict do nothing;
insert into public.platform_admins (user_id) values ('aaaaaaaa-0000-0000-0000-000000000001') on conflict do nothing;
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-000000000001', '09120001111@salon.local');
select public.admin_create_salon('tst-photos', 'گرومینگ عکس', '09120008899', 'pet');
reset role;
select id as ps from public.salons where slug = 'tst-photos' \gset
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000b9';
insert into public.users (id, salon_id, phone, full_name, role) values ('aaaaaaaa-0000-0000-0000-0000000000b9', :'ps', '09120008899', 'مدیر', 'manager');
select id as svc from public.services where salon_id = :'ps' and gender = 'dog' and category = 'bath' \gset
select tst.ok(exists (select 1 from storage.buckets where id = 'quote-photos' and not public), 'private bucket');

select tst.as_anon(:'ps');
set role anon;
select public.request_quote('سارا', '09351116601', 'dog', '{"name":"پاپی","size":"medium"}', array[:'svc']) ->> 'id' as qid \gset
-- the requester uploads into their quote
insert into storage.objects (bucket_id, name) values ('quote-photos', :'ps' || '/' || :'qid' || '/a1b2c3d4e5.jpg');
insert into storage.objects (bucket_id, name) values ('quote-photos', :'ps' || '/' || :'qid' || '/a1b2c3d4e6.jpg');
insert into storage.objects (bucket_id, name) values ('quote-photos', :'ps' || '/' || :'qid' || '/a1b2c3d4e7.webp');
insert into storage.objects (bucket_id, name) values ('quote-photos', :'ps' || '/' || :'qid' || '/a1b2c3d4e8.png');
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '%s/%s/a1b2c3d4e9.jpg')$$, :'ps', :'qid'), 'row-level security');
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '00000000-0000-0000-0000-000000000001/%s/zzzzzzzzzz.jpg')$$, :'qid'), 'row-level security');
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '%s/%s/../../x.jpg')$$, :'ps', :'qid'), 'row-level security');
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '%s/%s/script.html')$$, :'ps', :'qid'), 'row-level security');
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '%s/%s/a1b2c3d4ea.jpg')$$, :'ps', gen_random_uuid()), 'row-level security');
select tst.ok(not exists (select 1 from storage.objects where bucket_id = 'quote-photos'), 'anonymous visitors cannot list photos');
reset role;
select tst.ok((select count(*) from storage.objects where bucket_id = 'quote-photos') = 4, 'four photos stored');

-- a priced quote takes no more photos
set role authenticated;
select tst.as_user('aaaaaaaa-0000-0000-0000-0000000000b9', '09120008899@salon.local', :'ps');
select tst.ok((select count(*) from storage.objects where bucket_id = 'quote-photos') = 4, 'the salon''s staff see the photos');
select public.send_quote(:'qid', 900000, 60);
reset role;
delete from storage.objects where name like '%a1b2c3d4e8.png';
set role anon;
select tst.expect_error(format($$insert into storage.objects (bucket_id, name) values ('quote-photos', '%s/%s/a1b2c3d4eb.jpg')$$, :'ps', :'qid'), 'row-level security');
reset role;

set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');
select tst.ok(not exists (select 1 from storage.objects where bucket_id = 'quote-photos'), 'another salon sees none');
reset role;

delete from storage.objects where bucket_id = 'quote-photos';
delete from public.users where id = 'aaaaaaaa-0000-0000-0000-0000000000b9';
delete from public.salons where slug = 'tst-photos';
