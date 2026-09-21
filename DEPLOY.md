# راهنمای راه‌اندازی — بک‌اند واقعی + پیامک

نسخهٔ ۲: دیتابیس واقعی (Supabase / Postgres) + احراز هویت واقعی + پیامک واقعی
(کاوه‌نگار یا ملی‌پیامک). تمام UI فارسی و RTL، تمام کامپوننت‌ها و RBAC قبلی
دست‌نخورده باقی مانده‌اند.

---

## ⚠️ ارتقا به v2.19 (امنیتی — الزامی)

مدیریت رزرو عمومی (مشاهده/لغو/جابه‌جایی توسط مشتری) از شمارهٔ تلفن‌محور به
**OTP + توکن دسترسی** تغییر کرد. دو قدم زیر **هر دو الزامی**اند، نه فقط SQL:

1. `supabase/migrations/v2.19_secure_public_booking.sql` را در SQL Editor
   اجرا کن (idempotent، بدون حذف داده).
2. `send-sms` را دوباره deploy کن — این نسخه اکشن جدید `request_otp` را
   دارد که بدونش، دکمهٔ «دریافت کد» در «داشبورد من» کار نمی‌کند:
   ```bash
   supabase functions deploy send-sms
   ```
3. اگر پروژهٔ شما بین migration های اولیه و v2.15/v2.16 دقیقاً همینطور که
   از این مخزن گرفته‌اید اجرا شده، نیازی به کار اضافه نیست. اگر شک دارید
   یک نصب تازه از `schema.sql` روی یک پروژهٔ تست بزنید و مقایسه کنید.

جزئیات کامل امنیتی در `CHANGES.md` (بخش v2.19).

---

## چرا Supabase و نه Firebase؟

| معیار | Supabase | Firebase |
|---|---|---|
| جدول‌های خواسته‌شده (`users`, `appointments`, `services`, `time_offs`, `stylists`) | Postgres، رابطه‌ای، دقیقاً همان مدل | باید به کالکشن‌های NoSQL تبدیل و denormalize شود |
| نقش‌های `owner/manager/stylist` | RLS در سطح دیتابیس، همان سه نقش | Security Rules، منطق تکراری |
| گزارش‌های تب حسابداری و BI | SQL و aggregate آماده | باید در کلاینت محاسبه یا Cloud Function نوشته شود |
| کمپین «بیش از X روز رزرو نداشته» | یک کوئری | خواندن کل کالکشن و فیلتر در کلاینت |
| پیامک با کلید مخفی | Edge Function | Cloud Function (نیازمند پلن Blaze) |

مدل داده‌ی این پروژه صراحتاً رابطه‌ای است (نوبت ↔ خدمت ↔ آرایشگر). **Supabase.**

---

## گام ۱ — ساخت پروژه

1. به [supabase.com](https://supabase.com) برو → **New project** (پلن رایگان کافی است).
2. منطقه: **Frankfurt (eu-central-1)** — کم‌ترین تأخیر از ایران بین گزینه‌های موجود.
3. رمز دیتابیس را جایی امن ذخیره کن.
4. از **Project Settings → API** این دو مقدار را بردار:
   - `Project URL` → می‌شود `VITE_SUPABASE_URL`
   - `anon public` → می‌شود `VITE_SUPABASE_ANON_KEY`
   - `service_role` → **هرگز در فرانت‌اند استفاده نکن**؛ فقط برای Edge Functions و cron.

## گام ۲ — ساخت جدول‌ها

**SQL Editor → New query** و به‌ترتیب اجرا کن:

1. `supabase/schema.sql` — جدول‌ها، ایندکس‌ها، تریگرها، RLS، و RPCها
2. `supabase/seed.sql` — انتقال دادهٔ نمونهٔ فعلی (۱۴ خدمت، ۳ آرایشگر، ساعات کاری، قالب‌های پیامک)

هر دو **idempotent** هستند (`on conflict do nothing`) — اجرای دوباره چیزی را خراب نمی‌کند.

## گام ۳ — ساخت حساب مدیر سالن

احراز هویت واقعی شد، پس رمز `1234` دیگر کار نمی‌کند. Supabase حداقل ۶ کاراکتر می‌خواهد.

**Authentication → Providers → Email**: گزینهٔ `Confirm email` را **خاموش** کن
(شماره موبایل به ایمیل ساختگی `09xxxxxxxxx@salon.local` نگاشت می‌شود، پس تأییدیه‌ای
قابل دریافت نیست).

> ⚠️ **اگه قبلاً یک‌بار ثبت‌نام کردی و الان «حساب پیدا نشد» یا رمز درست رو
> اشتباه می‌گیره:** احتمالاً این تنظیم موقع ثبت‌نام هنوز روشن بوده، و پروفایلت
> ساخته نشده (فقط حساب Auth ساخته شده، بدون ردیف متناظر در `public.users`).
> بعد از خاموش کردن `Confirm email`، `supabase/migrations/repair_owner_login.sql`
> رو اجرا کن — دیتابیس رو تشخیص و ترمیم می‌کنه، بدون نیاز به ثبت‌نام دوباره.
> نسخهٔ جدید اپ هم خودش موقع ورود بعدی این حالت رو تشخیص و ترمیم می‌کنه.

بعد در برنامه: تب **پنل مدیریت → ورود مدیر سالن → ثبت‌نام**، با شماره
`09120000000` و یک رمز ۶ کاراکتری یا بیشتر. اولین ثبت‌نام نقش `owner` می‌گیرد و
بعد از آن ثبت‌نام مدیر بسته می‌شود.

### حساب آرایشگرها

هر آرایشگر خودش از **ورود آرایشگر → ثبت‌نام** حساب می‌سازد (نقش `stylist`).
برای سه آرایشگر seed شده که فقط ردیف `stylists` دارند و حساب auth ندارند، در
SQL Editor نقش `manager` را به یک نفر بده یا بگذار خودشان ثبت‌نام کنند و بعد
`stylist_id` را وصل کن:

```sql
-- بعد از ثبت‌نام آرایشگر، او را به ردیف موجودش وصل کن
update public.users set stylist_id = 'st1' where phone = '09121110001';
delete from public.stylists where id = '<ردیف تکراری تازه‌ساخته‌شده>';
```

## گام ۴ — تنظیم متغیرهای فرانت‌اند

```bash
cp .env.example .env.local
```

و مقادیر `VITE_SUPABASE_URL` و `VITE_SUPABASE_ANON_KEY` را پر کن.

> اگر این دو مقدار خالی بمانند، برنامه به‌جای خطا دادن، به حالت دمو (حافظهٔ موقت)
> برمی‌گردد و یک نوار هشدار نشان می‌دهد. پس هیچ‌وقت صفحهٔ سفید نمی‌بینی.

```bash
npm install
npm run dev
```

## گام ۵ — سرویس پیامک

Supabase CLI را نصب و پروژه را link کن:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <PROJECT_REF>
```

کلیدها را به‌عنوان secret ست کن (**هرگز در `.env` فرانت‌اند نگذار** — anon key در
مرورگر دیده می‌شود):

```bash
# کاوه‌نگار
supabase secrets set SMS_PROVIDER=kavenegar
supabase secrets set KAVENEGAR_API_KEY=<کلید-پنل-کاوه‌نگار>
supabase secrets set KAVENEGAR_SENDER=            # خالی = خط پیش‌فرض حساب

# یا ملی‌پیامک
# supabase secrets set SMS_PROVIDER=melipayamak
# supabase secrets set MELIPAYAMAK_API_KEY=<کلید-REST-کنسول>
# supabase secrets set MELIPAYAMAK_SENDER=<شماره-خط>

# مشترک
supabase secrets set SALON_NAME="آرایشگاه و سالن زیبایی مانا"
supabase secrets set SALON_TZ_OFFSET_MINUTES=210        # ایران = UTC+03:30
supabase secrets set DEFAULT_REMINDER_HOURS=3
supabase secrets set INTERNAL_FUNCTION_SECRET="$(openssl rand -hex 32)"
supabase secrets set ALLOWED_ORIGIN=https://your-app.vercel.app
supabase secrets set SMS_DRY_RUN=true                   # اول با این تست کن
```

deploy:

```bash
supabase functions deploy send-sms
supabase functions deploy cron-reminders --no-verify-jwt
```

با `SMS_DRY_RUN=true` هیچ اعتباری خرج نمی‌شود؛ متن پیام‌ها در
**Edge Functions → Logs** ثبت می‌شود. وقتی خروجی درست بود:

```bash
supabase secrets set SMS_DRY_RUN=false
```

**تست «داشبورد من» (ورود با کد) بدون پیامک واقعی:** وقتی `SMS_DRY_RUN=true`
است، دکمهٔ «دریافت کد» در «داشبورد من» یک نوار زرد با کد واقعی نشان
می‌دهد و فیلد کد را هم خودکار پر می‌کند — نیازی به چک‌کردن Logs نیست، کل
جریان (درخواست کد → تایید → مشاهده/لغو/جابه‌جایی نوبت) را می‌توانید کامل
تست کنید. این کد **فقط برای همان درخواستی که همین الان زده‌اید** برمی‌گردد
(هیچ کاربر دیگری چیزی نمی‌بیند)، و این نوار وقتی `SMS_DRY_RUN` روی
`false` یا تنظیم‌نشده باشد **اصلاً ظاهر نمی‌شود** — یعنی در حالت واقعی
هیچ کدی هیچ‌وقت به مرورگر برنمی‌گردد.

**همون تست، بدون deploy کردن Edge Function (v2.20):** اگر هنوز
`send-sms` رو deploy نکرده‌اید یا `SMS_DRY_RUN` رو تنظیم نکرده‌اید،
یک راه کاملاً مستقل هست که فقط یک خط SQL می‌خواد — نه CLI، نه deploy:

```sql
-- توی SQL Editor، فقط همین یک بار:
update public.app_settings set sms_test_mode = true;
```

بعدش دکمهٔ «دریافت کد» خودش تشخیص می‌ده Edge Function در دسترس نیست و
مستقیماً از دیتابیس کد رو می‌گیره — همون نوار زرد، همون جریان کامل. وقتی
تست تموم شد، برای خاموش‌کردنش:

```sql
update public.app_settings set sms_test_mode = false;
```

پیش‌فرض این تنظیم خاموشه؛ تا وقتی صریحاً روشنش نکنید، این مسیر اصلاً کار
نمی‌کنه — و حتی وقتی روشنه، کد فقط برای همون شماره‌ای که همین الان
درخواست زده برمی‌گرده، نه بقیه.

> **API دقیق را که دادی**، فقط یک فایل عوض می‌شود:
> `supabase/functions/_shared/providers.ts` — دو تابع `sendKavenegar` و
> `sendMelipayamak`. بقیهٔ سیستم به آن دست نمی‌زند.

## گام ۶ — زمان‌بندی یادآوری‌ها

`supabase/cron.sql` را باز کن، `<PROJECT_REF>` و `<SERVICE_ROLE>` را جایگزین کن و در
SQL Editor اجرا کن. دو job ساخته می‌شود:

- **هر ۵ دقیقه** — صف یادآوری‌ها را می‌فرستد و نوبت‌های نزدیک جامانده را جارو می‌زند
- **هر شب ۳ بامداد** — روزهای باز رزرو را ۱۴ روز جلو می‌برد

بررسی: `select * from cron.job_run_details order by start_time desc limit 20;`

## گام ۷ — دیپلوی فرانت‌اند

همان مسیر قبلی (Vercel)، فقط با متغیرهای محیطی:

```bash
git add . && git commit -m "real backend + sms" && git push
```

در Vercel → **Settings → Environment Variables** اضافه کن:

| نام | مقدار |
|---|---|
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGci...` |
| `VITE_AUTH_EMAIL_DOMAIN` | `salon.local` |
| `VITE_SALON_NAME` | `آرایشگاه و سالن زیبایی مانا` |
| `VITE_OWNER_PHONE` | `09120000000` |

بعد **Redeploy** (متغیرهای Vite در زمان build تزریق می‌شوند، پس بدون build جدید اعمال نمی‌شوند).

در آخر `ALLOWED_ORIGIN` را روی دامنهٔ نهایی ست کن:

```bash
supabase secrets set ALLOWED_ORIGIN=https://your-app.vercel.app
supabase functions deploy send-sms
```

---

## چک‌لیست تست

- [ ] رزرو نوبت جدید → ردیف در `appointments` ساخته می‌شود
- [ ] پیامک تایید در `sms_messages` با وضعیت `sent`
- [ ] یک ردیف `reminder` با وضعیت `queued` و `scheduled_for` درست
- [ ] `scheduled_for` = زمان نوبت منهای `reminder_hours_before` همان آرایشگر
- [ ] لغو نوبت → یادآوری صف حذف می‌شود، پیامک لغو می‌رود
- [ ] تغییر زمان → یادآوری قدیمی حذف، یادآوری جدید صف می‌شود
- [ ] رفرش صفحه → همان‌جا لاگین می‌مانی (session پایدار)
- [ ] ورود آرایشگر → فقط نوبت‌های خودش، تب‌های «آرایشگرها»/«پیامک»/«هوش تجاری» را نمی‌بیند
- [ ] تب پیامک → ارسال دسته‌جمعی به نوبت‌های امروز
- [ ] وضعیت نوبت را `انجام شده` کن → امتیاز باشگاه در `customers.loyalty_points` اضافه می‌شود

## به‌روزرسانی امنیتی (اگر schema.sql را قبلاً اجرا کرده‌اید)

اگر پروژه‌تان از قبل روی نسخهٔ قدیمی‌تر deploy شده، این مرحله را حتماً انجام
دهید — `schema.sql` برای نصب تازه خودش این‌ها را دارد، ولی پایگاه‌دادهٔ
موجود باید صریحاً به‌روز شود:

1. **SQL Editor** → محتوای `supabase/migrations/v2.2_critical_fixes.sql`
   را اجرا کن (idempotent — دوباره اجرا کردنش بی‌خطر است).
2. **`ALLOWED_ORIGIN` الان واقعاً لازم است، نه فقط توصیه‌شده** — قبلاً اگر
   این تنظیم نمی‌شد، `send-sms` روی حالت باز (`*`) کار می‌کرد؛ الان اگر
   تنظیم نشه، **هیچ درخواستی از فرانت‌اند خودتان هم رد نمی‌شود** (CORS
   می‌بندد). قبل از هر چیز چک کن:
   ```bash
   supabase secrets list | grep ALLOWED_ORIGIN
   ```
   اگر نبود: `supabase secrets set ALLOWED_ORIGIN=https://your-app.vercel.app`
3. Edge Functionها را دوباره deploy کن (تغییرات `send-sms` و
   `cron-reminders` را می‌گیرد):
   ```bash
   supabase functions deploy send-sms
   supabase functions deploy cron-reminders --no-verify-jwt
   ```
4. اگر cron شما (pg_cron یا خارجی) هدر `x-internal-secret` را نمی‌فرستد،
   بعد از این آپدیت با خطای ۴۰۱ متوقف می‌شود — تنظیمش کن که همون مقدار
   `INTERNAL_FUNCTION_SECRET` رو به‌عنوان این هدر بفرسته.
5. `vercel.json` جدید هدرهای امنیتی (CSP و غیره) اضافه می‌کند — بعد از
   دیپلوی، کنسول مرورگر را چک کن که چیزی توسط CSP بلاک نشده باشد.

## عیب‌یابی

| نشانه | علت |
|---|---|
| نوار «اتصال به دیتابیس برقرار نشد» | `schema.sql` اجرا نشده، یا URL/anon key غلط است |
| ورود می‌گوید «حساب شما پیدا نشد» | کاربر در `auth.users` هست ولی ردیف `public.users` ندارد |
| پیامک وضعیت `failed` می‌گیرد | ستون `error` در `sms_messages` را ببین — تقریباً همیشه کلید یا اعتبار پنل است |
| یادآوری‌ها نمی‌رود | `select * from cron.job;` و لاگ `cron-reminders` را چک کن |
| ذخیره‌ها بی‌صدا کار نمی‌کنند | RLS دارد رد می‌کند — کنسول مرورگر پیام دقیق را می‌نویسد |
