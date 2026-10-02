# نوبت‌دهی آرایشگاه — Vite + React + Supabase

اپ رزرو نوبت آرایشگاه با UI فارسی/RTL، تقویم شمسی، پنل مدیریت با نقش‌های
owner / manager / stylist، حسابداری، هوش تجاری، و پیامک واقعی.

```bash
npm install
cp .env.example .env.local     # مقادیر Supabase را پر کن
npm run dev
```

- **اجرا روی سرور، گام‌به‌گام (نصب تازه یا ارتقا):** [`INSTALL.md`](./INSTALL.md)
- جزئیات و تاریخچهٔ راه‌اندازی: [`DEPLOY.md`](./DEPLOY.md)
- **فهرست تغییرات نسخهٔ ۲ و dependencies جدید:** [`CHANGES.md`](./CHANGES.md)
- **بررسی کد:** `npm test` (Vitest)، `npm run lint` (ESLint با قوانین React Hooks)، و
  `npm run test:db` — نصب تازهٔ کامل دیتابیس (schema → seed → همهٔ migrationها) روی
  PostgreSQL 16 و اجرای تست‌های `tests/db` (اتصال با متغیرهای `PGHOST`/`PGUSER`/…).
  هر سه در GitHub Actions (`.github/workflows/ci.yml`) روی هر PR اجرا می‌شوند.

> بدون متغیرهای محیطی Supabase، برنامه در حالت دمو (حافظهٔ موقت) اجرا می‌شود و
> یک نوار هشدار نشان می‌دهد — پس هیچ‌وقت با صفحهٔ سفید روبه‌رو نمی‌شوی.

## ساختار

```
src/
  App.jsx                  پوستهٔ برنامه: state اصلی، همگام‌سازی با دیتابیس، تب‌ها
  main.jsx                 مسیریابی صفحه‌ها، تشخیص سالن، ErrorBoundary
  app/shared.js            ثابت‌ها، دادهٔ نمونه، قیمت‌گذاری و منطق تداخل نوبت‌ها
  components/
    ui.jsx                 اجزای پایه: Modal، Toast، DateStrip، StatCard، …
    bookingModals.jsx      لغو / جابه‌جایی / تایید معرفی نوبت
    LoginScreen.jsx        ورود مدیر و آرایشگر
  booking/BookingFlow.jsx  فرم رزرو مشتری
  track/TrackView.jsx      «داشبورد من» (OTP، نوبت‌ها، امتیاز)
  panel/                   پنل مدیریت — هر تب یک فایل
    PanelView.jsx          ناوبری پنل + تب‌های نوبت‌ها و آرایشگرها
    ServicesTab.jsx  ScheduleTab.jsx  AccountingTab.jsx  AIAnalysisTab.jsx
    BITab.jsx  biCards.jsx  LoyaltyTab.jsx  SmsTab.jsx
  styles/
    tokens.js              متغیرهای CSS (روشن/تیره) و کلاس‌های پایه
  lib/
    format.js              تاریخ شمسی، اعداد فارسی، نرمال‌سازی شماره موبایل
    tenant.js              تشخیص سالن از آدرس + نام سالن
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
