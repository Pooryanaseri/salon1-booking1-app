-- =============================================================================
--  زمان‌بندی یادآوری پیامکی — بعد از deploy کردن Edge Functions اجرا کن
--  Supabase Studio -> SQL Editor
--
--  سه مقدار زیر را جایگزین کن:
--    <PROJECT_REF>               شناسه پروژه (مثلاً abcdefghijklmnop)
--    <SERVICE_ROLE>              کلید service_role از Project Settings -> API
--    <INTERNAL_FUNCTION_SECRET>  همان مقداری که با supabase secrets set گذاشته‌اید
--                                (بدون آن، Edge Functionها درخواست cron را رد می‌کنند)
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- هر دقیقه: صف پیامک‌ها را خالی می‌کند و نوبت‌های نزدیک را جارو می‌زند.
-- از v2.31 پیامک تایید رزرو هم از همین صف ارسال می‌شود، پس فاصله کوتاه است
-- تا مشتری تایید را ظرف حدود یک دقیقه بگیرد. (اجرای خالی هزینه‌ای ندارد.)
select cron.schedule(
  'salon-sms-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/cron-reminders',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE>',
                 'x-internal-secret', '<INTERNAL_FUNCTION_SECRET>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- هر شب ساعت ۳ بامداد (UTC): برای هر سالنی که «باز بودن خودکار روزها» را
-- روشن دارد، بازهٔ رزرو (پیش‌فرض ۳۰ روز) را جلو می‌برد (v2.28).
-- نسخهٔ قبلی این job از v2.24 به بعد خطا می‌داد (بدون salon_id). همین نام
-- را نگه داشته‌ایم تا اجرای دوبارهٔ این فایل job قبلی را جایگزین کند.
select cron.schedule(
  'salon-roll-approved-dates',
  '0 3 * * *',
  $$ select public.open_booking_window(); $$
);

-- هر روز ساعت ۰۴:۳۰ UTC (۸ صبح به وقت تهران): پیامک برنامهٔ روز برای هر
-- آرایشگر و خلاصهٔ کوتاه برای مدیر را در صف می‌گذارد (v2.28). ارسال واقعی
-- را همان cron-reminders (هر ۵ دقیقه) انجام می‌دهد.
select cron.schedule(
  'salon-daily-digests',
  '30 4 * * *',
  $$ select public.queue_daily_digests(); $$
);

-- =============================================================================
--  Autopilot 2.0 (v2.25/v2.26) — بدون این ۴ زمان‌بندی، کل این بخش از اپ
--  (چرخهٔ خودکار پس از نوبت، تطبیق هفتگی، موتور پیش‌بینی) هیچ‌وقت خودش
--  اجرا نمی‌شه؛ فقط با فراخوانی دستی کار می‌کنه.
-- =============================================================================

-- هر ۲۰ دقیقه: نوبت‌های «تایید‌شده/تغییرزمان‌یافته»ای که زمانشون گذشته
-- رو به «در انتظار تایید نهایی» منتقل می‌کنه.
-- هر ۵ دقیقه: نوبت‌هایی که منتظر پرداخت بیعانه بودند و ۲۰ دقیقه پرداخت نشدند
-- آزاد می‌شوند (v2.37 — فقط وقتی پیش‌پرداخت آنلاین روشن باشد کاری انجام می‌دهد).
select cron.schedule(
  'salon-expire-unpaid-bookings',
  '*/5 * * * *',
  $$ select public.expire_unpaid_bookings(); $$
);

select cron.schedule(
  'salon-transition-elapsed-appointments',
  '*/20 * * * *',
  $$ select public.transition_elapsed_appointments(); $$
);

-- هر شب ساعت ۴ بامداد: نوبت‌های «در انتظار تایید نهایی»ِ قدیمی‌تر از
-- ۷ روز رو خودکار بایگانی می‌کنه (هرگز خودکار «تکمیل‌شده» نه).
select cron.schedule(
  'salon-archive-stale-pending-verifications',
  '0 4 * * *',
  $$ select public.archive_stale_pending_verifications(); $$
);

-- هر جمعه ساعت ۱۸: برای هر سالن، اگه نوبت تاییدنشده داره، لینک تطبیق
-- پیامک می‌کنه؛ وگرنه خلاصهٔ درآمد هفتگی.
select cron.schedule(
  'salon-weekly-reconciliation',
  '0 18 * * 5',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/weekly-reconciliation',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE>',
                 'x-internal-secret', '<INTERNAL_FUNCTION_SECRET>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- هر روز ساعت ۱۰ صبح: مشتری‌هایی که به موعد تقریبی رزرو مجددشون
-- رسیدن رو پیدا می‌کنه و پیامک رزرو مجدد می‌فرسته.
select cron.schedule(
  'salon-predictive-rebooking',
  '0 10 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/predictive-rebooking-cron',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE>',
                 'x-internal-secret', '<INTERNAL_FUNCTION_SECRET>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- بررسی زمان‌بندی‌ها:      select * from cron.job;
-- تاریخچهٔ اجرا:            select * from cron.job_run_details order by start_time desc limit 20;
-- حذف یک زمان‌بندی:        select cron.unschedule('salon-sms-reminders');
