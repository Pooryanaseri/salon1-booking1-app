-- =============================================================================
--  زمان‌بندی یادآوری پیامکی — بعد از deploy کردن Edge Functions اجرا کن
--  Supabase Studio -> SQL Editor
--
--  دو مقدار زیر را جایگزین کن:
--    <PROJECT_REF>   شناسه پروژه (مثلاً abcdefghijklmnop)
--    <SERVICE_ROLE>  کلید service_role از Project Settings -> API
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- هر ۵ دقیقه: صف یادآوری‌ها را خالی می‌کند و نوبت‌های نزدیک را جارو می‌زند.
select cron.schedule(
  'salon-sms-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron-reminders',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- هر شب ساعت ۳ بامداد: روزهای آیندهٔ باز را ۱۴ روز جلو می‌برد،
-- تا تقویم رزرو هیچ‌وقت خودش را تمام نکند.
select cron.schedule(
  'salon-roll-approved-dates',
  '0 3 * * *',
  $$
  insert into public.approved_dates (date)
  select (current_date + i)::date from generate_series(0, 13) as g(i)
  on conflict (date) do nothing;
  $$
);

-- بررسی زمان‌بندی‌ها:      select * from cron.job;
-- تاریخچهٔ اجرا:            select * from cron.job_run_details order by start_time desc limit 20;
-- حذف یک زمان‌بندی:        select cron.unschedule('salon-sms-reminders');
