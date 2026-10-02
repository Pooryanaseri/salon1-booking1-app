# نوبت‌دهی آرایشگاه — Vite + React + Supabase

اپ رزرو نوبت آرایشگاه با UI فارسی/RTL، تقویم شمسی، پنل مدیریت با نقش‌های
owner / manager / stylist، حسابداری، هوش تجاری، و پیامک واقعی.

```bash
npm install
cp .env.example .env.local     # مقادیر Supabase را پر کن
npm run dev
```

- **راه‌اندازی کامل (دیتابیس، احراز هویت، پیامک، cron، دیپلوی):** [`DEPLOY.md`](./DEPLOY.md)
- **فهرست تغییرات نسخهٔ ۲ و dependencies جدید:** [`CHANGES.md`](./CHANGES.md)

> بدون متغیرهای محیطی Supabase، برنامه در حالت دمو (حافظهٔ موقت) اجرا می‌شود و
> یک نوار هشدار نشان می‌دهد — پس هیچ‌وقت با صفحهٔ سفید روبه‌رو نمی‌شوی.

## ساختار

```
src/
  App.jsx                  کل UI (کامپوننت‌ها دست‌نخورده از نسخهٔ ۱ + تب پیامک)
  main.jsx
  lib/
    supabase.js            کلاینت
    auth.js                ورود با شماره موبایل، نقش‌ها
    api.js                 لایهٔ داده + diff-sync + realtime
    sms.js                 کلاینت پیامک، رندر قالب
supabase/
  schema.sql               جدول‌ها، RLS، تریگرها، RPCها
  seed.sql                 دادهٔ اولیه
  cron.sql                 زمان‌بندی یادآوری‌ها
  functions/
    _shared/providers.ts   کاوه‌نگار + ملی‌پیامک
    send-sms/              ارسال و صف‌گذاری
    cron-reminders/        ارسال یادآوری‌های سررسیده
```
