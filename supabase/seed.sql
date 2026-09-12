-- =============================================================================
--  Seed / migration — run AFTER schema.sql
--  Everything below is idempotent (on conflict do nothing), so re-running it
--  never destroys data you've since edited in the panel.
-- =============================================================================

-- ---- STYLISTS (verbatim from SEED_STYLISTS in App.jsx) ----------------------
insert into public.stylists (id, name, gender, phone, password, active, reminder_hours_before) values
  ('st1', 'مهسا کریمی',    'female', '09121110001', '1234', true, 3),
  ('st2', 'نیلوفر صادقی',  'female', '09121110002', '1234', true, 3),
  ('st3', 'رضا احمدی',     'male',   '09121110003', '1234', true, 3)
on conflict (id) do nothing;

-- ---- SERVICES (verbatim from SEED_SERVICES) ---------------------------------
insert into public.services (id, name, gender, category, duration_minutes, buffer_minutes, price, discount_type, discount_value, discount_reason, is_active, loyalty_points) values
  ('f1','کوتاهی و مدل مو',      'female','hair',              45,  0,  250000,'none',    0,  '',                      true, 10),
  ('f2','رنگ مو کامل',           'female','color',            120, 15,  950000,'none',    0,  '',                      true, 25),
  ('f3','رنگ ریشه',              'female','color',             60, 10,  450000,'percent', 10, 'تشویقی مشتریان ثابت',  true, 15),
  ('f4','کراتینه و بوتاکس مو',   'female','hair',             180, 20, 1800000,'none',    0,  '',                      true, 40),
  ('f5','میکاپ عروس',            'female','makeup',            90,  0, 2500000,'none',    0,  '',                      true, 50),
  ('f6','میکاپ روزانه',          'female','makeup',            45,  0,  600000,'none',    0,  '',                      true, 15),
  ('f7','مانیکور',                'female','nails',             45,  0,  350000,'none',    0,  '',                      true, 10),
  ('f8','پاکسازی پوست صورت',     'female','skin',              60,  0,  700000,'none',    0,  '',                      true, 20),
  ('f9','لمینت و کاشت ابرو',     'female','permanent_makeup',  50,  0,    null,'none',    0,  '',                      true, 15),
  ('m1','کوتاهی مو مردانه',      'male',  'hair',              30,  0,  180000,'fixed',   20000,'تخفیف افتتاحیه',      true, 10),
  ('m2','اصلاح و فرم ریش',       'male',  'beard',             20,  0,  120000,'none',    0,  '',                      true, 5),
  ('m3','پکیج مو و ریش',         'male',  'hair',              45,  0,  270000,'none',    0,  '',                      true, 15),
  ('m4','رنگ مو و ریش',          'male',  'color',             40, 10,  300000,'none',    0,  '',                      true, 15),
  ('m5','پاکسازی پوست صورت',     'male',  'skin',              40,  0,  400000,'none',    0,  '',                      true, 20)
on conflict (id) do nothing;

-- ---- SALON WORKING HOURS (day_of_week 0=شنبه .. 6=جمعه) --------------------
insert into public.working_hours (id, staff_id, day_of_week, start_time, end_time, is_closed) values
  ('wh-salon-0', null, 0, '09:00', '21:00', false),
  ('wh-salon-1', null, 1, '09:00', '21:00', false),
  ('wh-salon-2', null, 2, '09:00', '21:00', false),
  ('wh-salon-3', null, 3, '09:00', '21:00', false),
  ('wh-salon-4', null, 4, '09:00', '21:00', false),
  ('wh-salon-5', null, 5, '09:00', '21:00', false),
  ('wh-salon-6', null, 6, '00:00', '00:00', true)
on conflict (id) do nothing;

-- ---- APPROVED DATES: open the next 14 days, same as the app's default ------
insert into public.approved_dates (date)
select (current_date + i)::date from generate_series(0, 13) as g(i)
on conflict (date) do nothing;

-- ---- SMS TEMPLATES ---------------------------------------------------------
-- Placeholders: {{name}} {{service}} {{date}} {{time}} {{stylist}} {{code}}
--               {{salon}} {{points}} {{discount}} {{days}}
insert into public.sms_templates (id, kind, title, body, is_default) values
  ('tpl-confirm', 'confirmation', 'تایید رزرو',
   E'{{name}} عزیز، نوبت شما در {{salon}} ثبت شد.\nخدمت: {{service}}\nتاریخ: {{date}} ساعت {{time}}\nآرایشگر: {{stylist}}\nکد پیگیری: {{code}}', true),

  ('tpl-remind', 'reminder', 'یادآوری نوبت',
   E'{{name}} عزیز، یادآوری نوبت شما در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما هستیم.', true),

  ('tpl-cancel', 'cancellation', 'لغو نوبت',
   E'{{name}} عزیز، نوبت شما ({{service}} — {{date}} ساعت {{time}}) لغو شد.\nبرای رزرو مجدد به {{salon}} مراجعه کنید.', true),

  ('tpl-reschedule', 'reschedule', 'تغییر زمان نوبت',
   E'{{name}} عزیز، زمان نوبت شما تغییر کرد.\nزمان جدید: {{date}} ساعت {{time}}\nخدمت: {{service}}\nکد پیگیری: {{code}}', true),

  ('tpl-winback', 'campaign', 'کمپین جذب مجدد',
   E'{{name}} عزیز، جای شما در {{salon}} خالیه!\nبه‌مناسبت بازگشتتون {{discount}}٪ تخفیف روی همه خدمات براتون فعال کردیم.\nهمین حالا رزرو کنید.', true),

  ('tpl-loyalty', 'loyalty', 'باشگاه مشتریان',
   E'{{name}} عزیز، امتیاز شما در باشگاه مشتریان {{salon}}: {{points}}\nتخفیف فعال شما: {{discount}}٪', true),

  ('tpl-blank', 'custom', 'پیام آزاد', '', true)
on conflict (id) do nothing;
