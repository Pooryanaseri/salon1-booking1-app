# راهنمای کامل اجرا روی سرور

این راهنما همهٔ مراحل را به ترتیب دارد — هم برای **نصب تازه** و هم برای **ارتقای
نصب فعلی**. جزئیات بیشتر و تاریخچه در `DEPLOY.md` و `CHANGES.md` است.

چیزهایی که لازم دارید:

| سرویس | برای چه | اجباری؟ |
|---|---|---|
| Supabase (یک پروژه) | دیتابیس، ورود، Edge Functions، زمان‌بندی | بله |
| Vercel (یا هر میزبان فایل ثابت) | صفحهٔ وب | بله |
| کاوه‌نگار یا ملی‌پیامک | پیامک | بله (برای تست: `SMS_DRY_RUN=true`) |
| زرین‌پال (مرچنت‌کد خود سالن) | بیعانهٔ آنلاین | اختیاری |
| Supabase CLI روی کامپیوتر شما | deploy کردن Edge Functions | بله |

---

## ۱) دیتابیس

### نصب تازه
در **Supabase → SQL Editor** کل محتوای این فایل را اجرا کنید:

```
supabase/deploy/full_install.sql
```

(همهٔ `schema.sql` + `seed.sql` + همهٔ migrationها به ترتیب، در یک فایل. روی
PostgreSQL 16 به‌صورت یک تراکنش آزموده شده است.) اگر SQL Editor برای این حجم
خطا داد، همین فایل را با `psql` اجرا کنید:

```bash
psql "<connection string از Project Settings → Database>" -1 -f supabase/deploy/full_install.sql
```

### ارتقای نصب فعلی (اگر قبلاً تا v2.27 را اجرا کرده‌اید)
```
supabase/deploy/upgrade_v2.28_to_latest.sql
```
این شامل اصلاحات امنیتی فوری هم هست (v2.32، v2.33، v2.38) — هر چه زودتر اجرا شود.

> اجرای دوبارهٔ این فایل امن است. اگر نسخهٔ قبلی آن را اجرا کرده‌اید، نسخهٔ جدید را
> دوباره اجرا کنید (یا فقط `supabase/migrations/v2.39_reminder_timing.sql`) و بعد
> `cron-reminders` را دوباره deploy کنید.

### دو تنظیم یک‌باره (هر دو حالت)
آدرس عمومی سایت برای لینک‌های داخل پیامک (بدون آن، هیچ لینکی ارسال نمی‌شود):

```sql
alter database postgres set app.base_url = 'https://آدرس-سایت-شما';
-- فقط اگر سالن در منطقهٔ زمانی دیگری است (پیش‌فرض Asia/Tehran):
-- alter database postgres set app.timezone = 'Asia/Tehran';
```

### نام و آدرس سالن
سالن پیش‌فرض با آدرس `default` ساخته می‌شود (صفحهٔ رزرو: `https://سایت/default`).
برای تغییر:

```sql
update public.salons set slug = 'mana', name = 'آرایشگاه و سالن زیبایی مانا'
 where id = '00000000-0000-0000-0000-000000000001';
```
(`slug` فقط حروف کوچک انگلیسی، عدد و خط تیره.)

---

## ۲) تنظیمات ورود (Authentication)

**Supabase → Authentication → Providers → Email**: گزینهٔ **Confirm email** را
خاموش کنید (شماره موبایل به ایمیل ساختگی `09xxxxxxxxx@salon.local` تبدیل می‌شود
و ایمیل تایید هیچ‌وقت نمی‌رسد).

---

## ۳) Edge Functions

### رمزها (secrets)
```bash
supabase link --project-ref <PROJECT_REF>

supabase secrets set \
  SMS_PROVIDER=kavenegar \
  KAVENEGAR_API_KEY=<کلید> \
  KAVENEGAR_SENDER=<شمارهٔ خط، اختیاری> \
  INTERNAL_FUNCTION_SECRET=<یک رشتهٔ تصادفی طولانی> \
  ALLOWED_ORIGIN=https://آدرس-سایت-شما \
  SALON_NAME="آرایشگاه و سالن زیبایی مانا"
```
- برای ملی‌پیامک: `SMS_PROVIDER=melipayamak` و `MELIPAYAMAK_API_KEY` / `MELIPAYAMAK_SENDER`.
- برای تست بدون مصرف اعتبار: `SMS_DRY_RUN=true` (پیامک‌ها فقط ثبت می‌شوند).
- برای تست بیعانه با درگاه آزمایشی زرین‌پال: `ZARINPAL_SANDBOX=true`.
- `INTERNAL_FUNCTION_SECRET` را جایی یادداشت کنید — در گام ۴ لازم است.

### deploy
```bash
supabase functions deploy send-sms --no-verify-jwt
supabase functions deploy payment --no-verify-jwt
supabase functions deploy cron-reminders --no-verify-jwt
supabase functions deploy weekly-reconciliation --no-verify-jwt
supabase functions deploy predictive-rebooking-cron --no-verify-jwt
```

---

## ۴) زمان‌بندی‌ها (cron)

در `supabase/cron.sql` سه مقدار را جایگزین کنید و کل فایل را در SQL Editor اجرا کنید:

| جای‌نگهدار | مقدار |
|---|---|
| `<PROJECT_REF>` | شناسهٔ پروژه |
| `<SERVICE_ROLE>` | کلید service_role (Project Settings → API) |
| `<INTERNAL_FUNCTION_SECRET>` | همان مقدار گام ۳ |

این‌ها راه می‌افتند: ارسال صف پیامک (هر دقیقه)، باز نگه داشتن ۳۰ روز آینده،
برنامهٔ صبحگاهی آرایشگر و خلاصهٔ مدیر (۸ صبح)، آزاد کردن نوبت‌های پرداخت‌نشده،
تایید/بایگانی نوبت‌های گذشته، گزارش هفتگی مدیر، دعوت دوباره از مشتری‌ها.

> اجرای دوبارهٔ `cron.sql` امن است؛ job های هم‌نام جایگزین می‌شوند.

---

## ۵) صفحهٔ وب (Vercel)

متغیرهای محیطی (**Vercel → Settings → Environment Variables**):

```
VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<کلید anon>
VITE_AUTH_EMAIL_DOMAIN=salon.local
VITE_SALON_NAME=آرایشگاه و سالن زیبایی مانا
VITE_OWNER_PHONE=<شمارهٔ موبایل مدیر>
```

سپس deploy (`npm ci && npm run build`، پوشهٔ خروجی `dist`). `vercel.json` همهٔ
مسیرها (`/default`، `/confirm`، `/book`، `/payment/callback`، …) و سرتیترهای امنیتی
را تنظیم می‌کند.

---

## ۶) اولین ورود و تنظیمات

1. `https://سایت/<slug>` ← **پنل مدیریت ← ورود مدیر سالن ← ثبت‌نام** با شمارهٔ
   `VITE_OWNER_PHONE`. (فقط اولین مدیر می‌تواند خودش ثبت‌نام کند.)
2. **آرایشگرها:** هر آرایشگر را با شمارهٔ موبایلش اضافه کنید؛ بعد خودش از «ورود
   آرایشگر ← ثبت‌نام» با همان شماره حساب می‌سازد و مستقیم وصل می‌شود. کسی که بدون
   این، خودش ثبت‌نام کند تا تایید شما غیرفعال می‌ماند (پیامک می‌گیرید).
3. **خدمات و ساعات کاری** را تنظیم کنید.
4. **ساعات کاری ← خودکارسازی:** همه به‌صورت پیش‌فرض روشن‌اند (تایید خودکار، باز
   بودن روزها، تایید حضور، لیست انتظار، پیامک‌های صبحگاهی).
5. **ساعات کاری ← پیش‌پرداخت آنلاین** (اختیاری): مرچنت‌کد زرین‌پال، درصد، و حداقل
   قیمت خدمت.
6. **پیامک ← زمان پیامک یادآوری:** چند ساعت قبل از نوبت به مشتری یادآوری شود (یا خاموش).

---

## ۷) بررسی بعد از راه‌اندازی

- [ ] صفحهٔ `https://سایت/<slug>` باز می‌شود و نام سالن درست است.
- [ ] یک نوبت آزمایشی با شمارهٔ خودتان ← ظرف ~۱ دقیقه پیامک تایید.
- [ ] در «داشبورد من» با کد پیامکی وارد شوید، نوبت را ببینید و لغو کنید.
- [ ] در SQL Editor: `select kind, status, error from sms_messages order by created_at desc limit 10;`
      — همه `sent` باشند.
- [ ] `select jobname, status, return_message from cron.job_run_details order by start_time desc limit 10;`
      — بدون خطا.
- [ ] اگر بیعانه را روشن کرده‌اید: با `ZARINPAL_SANDBOX=true` یک پرداخت آزمایشی، سپس
      `ZARINPAL_SANDBOX` را بردارید و دوباره `payment` را deploy کنید.
- [ ] **پنل ← ساعات کاری ← سلامت برنامه** — خطاهای ثبت‌شده از دستگاه کاربران.

---

## برای توسعه‌دهنده

```bash
npm ci
npm run lint && npm test && npm run build
npm run test:db          # نصب کامل روی PostgreSQL 16 + تست‌ها (PGHOST/PGUSER/...)
scripts/build-sql-bundles.sh   # بعد از اضافه کردن هر migration
```
همهٔ این‌ها در GitHub Actions روی هر PR اجرا می‌شوند (`.github/workflows/ci.yml`).
