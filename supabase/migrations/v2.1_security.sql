-- ============================================================================
--  Migration v2.1 — سخت‌گیری بیشتر روی RLS
--  این فایل روی schema.sql موجود سوار می‌شه، جایگزینش نمی‌کنه. idempotent است
--  (می‌تونید چندبار اجراش کنید، خطا نمی‌ده).
--
--  ⚠️ نکتهٔ مهم قبل از اجرا: چند مورد از چیزهایی که معمولاً در این نوع
--  migration خواسته می‌شه، از قبل در schema.sql پیاده‌سازی شده و دوباره
--  اینجا تکرار نشدن، تا با چیزی که هست تداخل پیدا نکنن:
--    • «فقط owner/manager بتونن services و stylists رو اضافه/حذف کنن»
--      از قبل هست: policy عمومی p_mgr_write روی هر دو جدول.
--    • «ایندکس روی appointment_date» از قبل هست: appointments_date_idx.
--  فقط دو مورد واقعاً جدید + یک تریگر امنیتی اضافه، پایین می‌آد.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ۱. آرایشگر فقط نوبت‌های امروز و آینده را ویرایش کند، نه نوبت‌های گذشته.
--    بقیهٔ policy فعلی (مدیر همه‌چیز را می‌بیند/ویرایش می‌کند، مشتری مهمان
--    می‌تواند نوبت خودش را لغو/جابه‌جا کند) دست‌نخورده می‌ماند — فقط یک شرط
--    تاریخ به شاخهٔ «آرایشگر» اضافه می‌شود.
-- ----------------------------------------------------------------------------
drop policy if exists p_appt_update on public.appointments;
create policy p_appt_update on public.appointments for update using (
  public.is_manager()
  or (
    public.my_role() = 'stylist'
    and staff_id = public.my_stylist_id()
    and date >= current_date
  )
  or auth.uid() is null
);

-- ----------------------------------------------------------------------------
-- ۲. کاربران فقط پروفایل خودشان را ویرایش کنند.
--    قبلاً چنین policy‌ای اصلاً وجود نداشت — p_users_mgr فقط به مدیر اجازهٔ
--    ویرایش هر پروفایلی را می‌داد، و خودِ آرایشگر نمی‌توانست پروفایل خودش را
--    (مثلاً شمارهٔ تلفن نمایشی یا نام) ویرایش کند. نقش (role) را نمی‌تواند
--    خودش تغییر بدهد — فقط مدیر می‌تواند نقش کسی را عوض کند.
-- ----------------------------------------------------------------------------
drop policy if exists p_users_selfupdate on public.users;
create policy p_users_selfupdate on public.users for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from public.users where id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- ۳. جلوگیری از لغو لحظهٔ‌آخری: نوبتی که کمتر از ۲۴ ساعت به شروعش مانده،
--    فقط مدیر/owner می‌تواند حذف کند.
--    توجه: policy فعلی (p_appt_delete) از قبل حذف را کلاً به مدیر محدود
--    کرده، پس این تریگر برای کاربران عادی معمولاً هیچ‌وقت لازم نمی‌شه که
--    فعال بشه — این یک لایهٔ دفاعی اضافه است، برای مسیرهایی مثل فراخوانی از
--    یک Edge Function با کلید service-role که از RLS عبور می‌کند.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_last_minute_delete() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_manager() then
    if (old.date::timestamp + (old.start_min || ' minutes')::interval) < (now() + interval '24 hours') then
      raise exception 'نوبت‌های کمتر از ۲۴ ساعت مانده به شروع را فقط مدیر سالن می‌تواند لغو کند';
    end if;
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_prevent_last_minute_delete on public.appointments;
create trigger trg_prevent_last_minute_delete
  before delete on public.appointments
  for each row execute function public.prevent_last_minute_delete();

-- ----------------------------------------------------------------------------
-- ۴. ایندکس appointment_date — از قبل در schema.sql هست (appointments_date_idx)؛
--    این خط فقط برای اطمینان دوباره اجرا می‌شود، بی‌خطر و idempotent است.
-- ----------------------------------------------------------------------------
create index if not exists appointments_date_idx on public.appointments (date);
