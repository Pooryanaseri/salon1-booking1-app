-- v2.40: manager reports only ever see their own salon's data.
insert into public.salons (id, slug, name) values ('00000000-0000-0000-0000-000000000002', 'tst-other', 'سالن دیگر')
on conflict do nothing;

delete from public.customers where phone in ('09127770001', '09127770002');
insert into public.customers (salon_id, phone, name, last_booking_at, sms_opt_out) values
  ('00000000-0000-0000-0000-000000000001', '09127770001', 'مشتری خودی', now() - interval '120 days', false),
  ('00000000-0000-0000-0000-000000000002', '09127770002', 'مشتری سالن دیگر', now() - interval '120 days', false);

insert into public.services (id, salon_id, name, gender, category, duration_minutes, price, is_active)
values ('tsvc-s2', '00000000-0000-0000-0000-000000000002', 'خدمت سالن دیگر', 'female', 'hair', 30, 100000, true)
on conflict (id) do nothing;
insert into public.customers (salon_id, phone, name) values ('00000000-0000-0000-0000-000000000002', '09127770003', 'مشتری ۳')
on conflict do nothing;
insert into public.appointments (id, salon_id, service_id, customer_name, customer_phone, date, start_min, end_min, status, tracking_code)
values ('tst-s2-appt', '00000000-0000-0000-0000-000000000002', 'tsvc-s2', 'مشتری ۳', '09127770003',
        current_date - 10, 600, 630, 'confirmed', 'S2TST1')
on conflict (id) do nothing;
update public.appointments set status = 'completed' where id = 'tst-s2-appt';

insert into public.campaign_logs (salon_id, template_id, template_label, total_sent, successful_count)
values ('00000000-0000-0000-0000-000000000002', 'tst-other-tpl', 'کمپین سالن دیگر', 5, 5);

set role authenticated;
select tst.as_user('11111111-1111-1111-1111-111111111111', '09125550000@salon.local');

select tst.ok(exists (select 1 from public.inactive_customers(30) where phone = '09127770001'), 'own inactive customer listed');
select tst.ok(not exists (select 1 from public.inactive_customers(30) where phone = '09127770002'), 'other salon''s customer hidden (inactive_customers)');
select tst.ok(not exists (select 1 from public.get_customer_category_matrix() where phone = '09127770003'), 'other salon''s customer hidden (category matrix)');
select tst.ok(not exists (select 1 from public.get_campaign_performance() where template_id = 'tst-other-tpl'), 'other salon''s campaigns hidden');

reset role;
select tst.as_anon();
