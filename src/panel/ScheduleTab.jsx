import { useState, useMemo, useEffect } from "react";
import { useData } from "../hooks/useData";
import { Clock, Check, X, Calendar as CalendarIcon, MessageSquareText, Lock, CalendarX, CheckCircle2, CalendarCheck, Sun, Zap, UserCheck, Bell, Activity, CreditCard } from "lucide-react";
import { fetchClosures, announceClosure, revokeClosure, updateAutomationSettings, DEFAULT_AUTOMATION, fetchClientErrors, fetchPaymentSettings, savePaymentSettings } from "../lib/api";
import { jalaliDayNum, WEEKDAYS_FA_SHORT, SCHEMA_DAY_LABELS, toFa, jalaliLabel, formatClock, hhmmToMin, dateKey, parseDateKey, digitsOnly } from "../lib/format";
import { PanelSectionHeader, Switch } from "../components/ui";
import { schemaDayOf, uid } from "../app/shared";
import { SUPABASE_ENABLED } from "../lib/supabase";

/* ============================================================
   Schedule management tab (working hours + time-off)
   ============================================================ */
// v2.26 — Smart Absence & Holiday Management. Self-contained (useData),
// matching FeedbackStatsCard's pattern, rather than threading a new piece
// of global state through ScheduleTab's existing prop chain. Distinct
// from the simpler per-stylist/salon time-off mechanism just below it:
// announcing a closure here actually cancels every affected confirmed/
// rescheduled appointment on that date and queues a personalized
// rebooking-link SMS to each customer — not just blocking future bookings.
export function ClosuresCard({ notify }) {
  const { data: closures, loading, refetch } = useData(fetchClosures, [], { cacheKey: "salon_closures" });
  const [date, setDate] = useState("");
  const [type, setType] = useState("holiday");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const TYPE_LABEL = { holiday: "تعطیلی رسمی", maintenance: "تعمیرات", personal_leave: "مرخصی" };

  async function submit() {
    if (!date) { notify("تاریخ را انتخاب کنید"); return; }
    setSubmitting(true);
    const res = await announceClosure(date, type, notes.trim());
    setSubmitting(false);
    if (!res.ok) { notify(res.error || "ثبت تعطیلی ناموفق بود"); return; }
    notify(
      res.affected_appointments > 0
        ? `تعطیلی ثبت شد — ${toFa(res.affected_appointments)} نوبت لغو و پیامک رزرو مجدد برای مشتریان ارسال شد`
        : "تعطیلی ثبت شد"
    );
    setDate(""); setNotes("");
    refetch();
  }

  async function revoke(id) {
    const res = await revokeClosure(id);
    if (!res.ok) { notify(res.error || "لغو ناموفق بود"); return; }
    notify("تعطیلی لغو شد");
    refetch();
  }

  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>تعطیلی سریع (لغو خودکار نوبت‌ها + پیامک رزرو مجدد)</p>
      <p className="muted" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.7 }}>
        برخلاف «تعطیلی‌های موقت» پایین، اعلام تعطیلی اینجا نوبت‌های تاییدشدهٔ همان روز را خودکار لغو می‌کند
        و به هر مشتری پیامکی با لینک رزرو مجدد (با یک لمس) ارسال می‌شود.
      </p>
      <div className="card mb-3" style={{ padding: 12 }}>
        <div className="flex gap-2 mb-2" style={{ flexWrap: "wrap" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ flex: 1, minWidth: 140, padding: "9px 10px", fontSize: 12.5 }} />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ flex: 1, minWidth: 120, padding: "9px 10px", fontSize: 12.5 }}>
            {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <input
          value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="یادداشت (اختیاری)"
          style={{ width: "100%", padding: "9px 10px", fontSize: 12.5, marginBottom: 8 }}
        />
        <button disabled={!date || submitting} className="tap accent-btn w-full" style={{ padding: 10, fontSize: 13 }} onClick={submit}>
          {submitting ? "در حال ثبت..." : "اعلام تعطیلی"}
        </button>
      </div>

      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
      ) : (closures || []).length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          {closures.map((c) => (
            <div key={c.id} className="card flex items-center justify-between" style={{ padding: "10px 12px" }}>
              <div>
                <p style={{ fontSize: 12.5, fontWeight: 700 }}>{jalaliLabel(parseDateKey(c.closure_date), { withWeekday: false })} — {TYPE_LABEL[c.closure_type]}</p>
                {c.notes && <p className="muted" style={{ fontSize: 11 }}>{c.notes}</p>}
              </div>
              <button className="tap ghost-btn" style={{ fontSize: 11, padding: "5px 10px" }} onClick={() => revoke(c.id)}>لغو</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// v2.28 — the switches that keep the manager and stylists out of the app for
// routine work. Everything here is on by default; each one can be turned
// back to the old manual way.
function AutomationCard({ automation, onAutomationChange, notify }) {
  const [saving, setSaving] = useState(null);
  async function save(key, value) {
    const next = { ...automation, [key]: value };
    setSaving(key);
    const { error, approvedDates } = await updateAutomationSettings({ [key]: value });
    setSaving(null);
    if (error) { notify("ذخیرهٔ تنظیم ناموفق بود"); return; }
    onAutomationChange?.(next, approvedDates);
    notify("تنظیم ذخیره شد");
  }
  const rows = [
    {
      key: "auto_confirm_bookings", Icon: CheckCircle2,
      title: "تایید خودکار نوبت‌ها",
      on: "هر نوبتی که مشتری ثبت کند بلافاصله تایید می‌شود و پیامک تایید و یادآوری می‌گیرد.",
      off: "هر نوبت جدید منتظر تایید دستی شما در «نوبت‌های امروز» می‌ماند.",
    },
    {
      key: "auto_open_days", Icon: CalendarCheck,
      title: "باز بودن خودکار روزها",
      on: `همیشه ${toFa(automation.booking_window_days)} روز آینده بر اساس ساعات کاری برای رزرو باز است. برای بستن یک روز از «تعطیلی» یا «مرخصی» استفاده کنید.`,
      off: "مشتری فقط روزهایی را می‌تواند رزرو کند که شما دستی باز کرده‌اید.",
    },
    {
      key: "attendance_confirmation", Icon: UserCheck,
      title: "تایید حضور توسط مشتری",
      on: "پیامک یادآوری یک لینک دارد: «می‌آیم» یا «نمی‌توانم بیایم». با لغو، نوبت خودکار آزاد می‌شود.",
      off: "پیامک یادآوری فقط اطلاع‌رسانی است.",
    },
    {
      key: "waitlist_auto_offer", Icon: Bell,
      title: "پر کردن خودکار نوبت لغوشده",
      on: "با لغو هر نوبت، برای افراد لیست انتظار همان روز لینک رزرو پیامک می‌شود؛ هر کس زودتر رزرو کند.",
      off: "لیست انتظار فقط نمایش داده می‌شود و باید خودتان تماس بگیرید.",
    },
    {
      key: "staff_daily_digest", Icon: Sun,
      title: "برنامهٔ صبحگاهی آرایشگران",
      on: "هر آرایشگر صبح یک پیامک با نوبت‌های همان روزش می‌گیرد؛ فقط نوبت‌های همان روز جداگانه اطلاع داده می‌شوند.",
      off: "برای هر نوبت جدید جداگانه به آرایشگر پیامک می‌رود.",
    },
    {
      key: "manager_daily_digest", Icon: MessageSquareText,
      title: "خلاصهٔ صبحگاهی مدیر",
      on: "صبح‌ها یک پیامک کوتاه: تعداد نوبت‌های روز و فقط مواردی که به شما نیاز دارند.",
      off: "پیامک خلاصه‌ای برای مدیر ارسال نمی‌شود.",
    },
  ];
  return (
    <div className="card mb-6" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>
        <Zap size={15} color="var(--color-accent-500)" /> خودکارسازی
      </p>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 2, marginBottom: 6, lineHeight: 1.7 }}>
        کارهای تکراری را به سیستم بسپارید تا شما و آرایشگرها فقط برای موارد ضروری سراغ برنامه بیایید.
      </p>
      {rows.map(({ key, Icon, title, on, off }) => (
        <div key={key} className="flex items-start gap-3" style={{ padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
          <Icon size={16} color={automation[key] ? "var(--color-accent-500)" : "var(--color-muted)"} style={{ marginTop: 3, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{title}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.7 }}>{automation[key] ? on : off}</div>
            {key === "auto_open_days" && automation.auto_open_days && (
              <label className="flex items-center gap-2 mt-2 muted" style={{ fontSize: 11.5 }}>
                بازهٔ رزرو:
                <select
                  value={automation.booking_window_days}
                  disabled={saving != null}
                  onChange={(e) => save("booking_window_days", Number(e.target.value))}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                >
                  {[14, 30, 60, 90].map((n) => <option key={n} value={n}>{toFa(n)} روز</option>)}
                </select>
              </label>
            )}
          </div>
          <div style={{ opacity: saving === key ? 0.5 : 1, pointerEvents: saving != null ? "none" : "auto" }} aria-label={title}>
            <Switch checked={!!automation[key]} onChange={(v) => save(key, v)} />
          </div>
        </div>
      ))}
    </div>
  );
}

// v2.37 — optional online deposit through the salon's own Zarinpal account.
function DepositCard({ automation, onAutomationChange, notify }) {
  const [merchant, setMerchant] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [percent, setPercent] = useState(automation.deposit_percent || 0);
  const [minPrice, setMinPrice] = useState(String(automation.deposit_min_price || 0));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchPaymentSettings().then((r) => { if (!cancelled) { setMerchant(r?.zarinpal_merchant_id || ""); setLoaded(true); } });
    return () => { cancelled = true; };
  }, []);
  const merchantOk = /^[0-9a-fA-F-]{36}$/.test(merchant.trim());
  async function save() {
    if (percent > 0 && !merchantOk) { notify("برای فعال کردن، مرچنت‌کد ۳۶ کاراکتری زرین‌پال را وارد کنید"); return; }
    setSaving(true);
    const errA = await savePaymentSettings(merchant);
    const patch = { deposit_percent: Number(percent) || 0, deposit_min_price: Math.max(0, Number(digitsOnly(minPrice)) || 0) };
    const { error: errB } = await updateAutomationSettings(patch);
    setSaving(false);
    if (errA || errB) { notify("ذخیرهٔ تنظیمات پرداخت ناموفق بود"); return; }
    onAutomationChange?.({ ...automation, ...patch });
    notify(patch.deposit_percent > 0 ? "پیش‌پرداخت آنلاین فعال شد" : "تنظیمات پرداخت ذخیره شد");
  }
  if (!loaded) return null;
  return (
    <div className="card mb-6" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>
        <CreditCard size={15} color="var(--color-accent-500)" /> پیش‌پرداخت آنلاین (بیعانه)
      </p>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 2, marginBottom: 10, lineHeight: 1.8 }}>
        برای خدمات گران‌تر، مشتری بخشی از مبلغ را هنگام رزرو از درگاه زرین‌پال خود سالن می‌پردازد؛ نوبت فقط بعد از پرداخت قطعی می‌شود و نوبت پرداخت‌نشده بعد از ۲۰ دقیقه آزاد می‌شود. بازگرداندن وجه از پنل زرین‌پال انجام می‌شود.
      </p>
      <label className="muted" style={{ fontSize: 12 }}>مرچنت‌کد زرین‌پال</label>
      <input dir="ltr" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        autoComplete="off" spellCheck={false}
        style={{ width: "100%", padding: "9px 12px", fontSize: 13, marginTop: 4, textAlign: "left", fontFamily: "monospace" }} />
      <div className="flex gap-2 mt-3">
        <div style={{ flex: 1 }}>
          <label className="muted" style={{ fontSize: 12 }}>درصد بیعانه</label>
          <select value={percent} onChange={(e) => setPercent(Number(e.target.value))} style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}>
            {[0, 10, 20, 30, 50, 100].map((p) => <option key={p} value={p}>{p === 0 ? "خاموش" : `${toFa(p)}٪`}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label className="muted" style={{ fontSize: 12 }}>برای خدمات از (تومان)</label>
          <input dir="ltr" inputMode="numeric" value={minPrice} onChange={(e) => setMinPrice(digitsOnly(e.target.value))}
            style={{ width: "100%", padding: "9px 12px", fontSize: 13, marginTop: 4, textAlign: "left" }} />
        </div>
      </div>
      <button disabled={saving} onClick={save} className="tap accent-btn w-full mt-3" style={{ padding: 11, fontSize: 13 }}>
        {saving ? "در حال ذخیره…" : "ذخیره"}
      </button>
    </div>
  );
}

// v2.36 — errors the app hit on anyone's device (public pages included),
// merged by message. Mostly for whoever maintains the app; a manager only
// needs to notice "something keeps failing" and pass it on.
const ERROR_KIND_LABEL = { render: "نمایش صفحه", runtime: "اجرای برنامه", promise: "درخواست ناتمام", save: "ذخیره روی سرور" };
function AppHealthCard() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchClientErrors(10).then((r) => { if (!cancelled) setRows(r); });
    return () => { cancelled = true; };
  }, []);
  if (rows == null) return null;
  return (
    <div className="card mb-6" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>
        <Activity size={15} color={rows.length ? "var(--color-warning)" : "var(--color-success)"} /> سلامت برنامه
      </p>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>در ۳۰ روز اخیر خطایی ثبت نشده است.</p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 2, marginBottom: 8, lineHeight: 1.7 }}>
            خطاهایی که برنامه روی دستگاه کاربران (مشتری‌ها یا پرسنل) با آن روبه‌رو شده — اگر تکرار می‌شود، این فهرست را برای پشتیبان برنامه بفرستید.
          </p>
          {rows.map((r) => (
            <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--color-border)" }}>
              <div className="flex items-center justify-between gap-2" style={{ fontSize: 11 }}>
                <span className="badge" style={{ background: "var(--color-surface-raised)", color: "var(--color-body)" }}>{ERROR_KIND_LABEL[r.kind] || r.kind}</span>
                <span className="muted tabular">
                  {toFa(r.occurrences)} بار · آخرین: {jalaliLabel(new Date(r.last_seen), { short: true })} {formatClock(new Date(r.last_seen).getHours() * 60 + new Date(r.last_seen).getMinutes())}
                </span>
              </div>
              <div dir="ltr" style={{ fontSize: 11.5, marginTop: 4, color: "var(--color-heading)", wordBreak: "break-word", textAlign: "left" }}>{r.message}</div>
              {r.url && <div dir="ltr" className="muted" style={{ fontSize: 10.5, textAlign: "left" }}>{r.url}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ScheduleTab({ workingHours, setWorkingHours, staffWorkingHours, setStaffWorkingHours, currentStylistId, currentStylist, updateStylist, timeOff, setTimeOff, approvedDates, setApprovedDates, automation = DEFAULT_AUTOMATION, onAutomationChange, notify }) {
  const [newOffDate, setNewOffDate] = useState("");
  const [newOffReason, setNewOffReason] = useState("");
  const [newOffAllDay, setNewOffAllDay] = useState(true);
  const [newOffStart, setNewOffStart] = useState("13:00");
  const [newOffEnd, setNewOffEnd] = useState("14:00");

  const myHours = currentStylistId ? (staffWorkingHours[currentStylistId] || workingHours) : workingHours;
  const myTimeOff = currentStylistId ? timeOff.filter((t) => t.staff_id === currentStylistId) : timeOff.filter((t) => !t.staff_id);

  function updateDay(day, patch) {
    if (currentStylistId) {
      setStaffWorkingHours((prev) => {
        const base = prev[currentStylistId] || workingHours;
        return { ...prev, [currentStylistId]: base.map((w) => (w.day_of_week === day ? { ...w, ...patch } : w)) };
      });
    } else {
      setWorkingHours((prev) => prev.map((w) => (w.day_of_week === day ? { ...w, ...patch } : w)));
    }
  }

  // Per-stylist attendance confirmation — parallel to the manager's
  // salon-wide "روزهای باز برای رزرو" calendar below, but for this one
  // stylist's own presence on specific upcoming dates. Reuses time_offs
  // (already scoped to this stylist and correctly persisted) rather than
  // introducing a new concept: a day within the stylist's own weekly
  // schedule is attending by default; a whole-day time-off entry for that
  // date is what marks them absent.
  function isMyWorkingDay(d) {
    const wh = myHours.find((w) => w.day_of_week === schemaDayOf(d));
    return !!wh && !wh.is_closed;
  }
  function isMyAttending(d) {
    const k = dateKey(d);
    return !myTimeOff.some((t) => t.date === k && t.start_min == null);
  }
  function toggleMyAttendance(d) {
    if (!isMyWorkingDay(d)) return; // outside my weekly schedule — change the schedule itself, not a one-off exception here
    const k = dateKey(d);
    const existing = myTimeOff.find((t) => t.date === k && t.start_min == null);
    if (existing) {
      setTimeOff((prev) => prev.filter((t) => t.id !== existing.id));
      notify("حضور شما در این روز دوباره تایید شد");
    } else {
      setTimeOff((prev) => [...prev, { id: uid(), date: k, reason: "", staff_id: currentStylistId, start_min: null, end_min: null }]);
      notify("این روز به‌عنوان مرخصی ثبت شد");
    }
  }
  const newOffRangeValid = newOffAllDay || hhmmToMin(newOffEnd) > hhmmToMin(newOffStart);
  function addTimeOff() {
    if (!newOffDate || !newOffRangeValid) return;
    setTimeOff((prev) => [...prev, {
      id: uid(), date: newOffDate, reason: newOffReason.trim(), staff_id: currentStylistId || null,
      start_min: newOffAllDay ? null : hhmmToMin(newOffStart),
      end_min: newOffAllDay ? null : hhmmToMin(newOffEnd),
    }]);
    setNewOffDate(""); setNewOffReason(""); setNewOffAllDay(true);
    notify(newOffAllDay ? "تعطیلی تمام‌روز اضافه شد" : "تعطیلی ساعتی اضافه شد");
  }
  function removeTimeOff(id) {
    setTimeOff((prev) => prev.filter((t) => t.id !== id));
  }

  function isDayLocked(d) {
    const wh = workingHours.find((w) => w.day_of_week === schemaDayOf(d));
    return !wh || wh.is_closed || timeOff.some((t) => t.date === dateKey(d) && !t.staff_id && t.start_min == null);
  }
  function toggleApproved(d) {
    if (isDayLocked(d)) return;
    const k = dateKey(d);
    setApprovedDates((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }
  function approveNext(count, label) {
    const keys = upcomingDates.slice(0, count).filter((d) => !isDayLocked(d)).map((d) => dateKey(d));
    setApprovedDates((prev) => Array.from(new Set([...prev, ...keys])));
    notify(`${label} برای رزرو باز شد`);
  }
  function revokeAllApproved() {
    setApprovedDates([]);
    notify("همهٔ تاییدها لغو شد");
  }

  const upcomingDates = useMemo(() => {
    const arr = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, []);

  return (
    <div>
      <PanelSectionHeader
        Icon={CalendarIcon}
        title={currentStylistId ? "ساعات کاری من" : "ساعات کاری"}
        subtitle="ساعات کاری سالن، مرخصی‌ها، و تایید روزهای باز برای رزرو"
        color="var(--color-tab-dash)"
      />
      {currentStylistId && currentStylist && (
        <div className="card mb-6" style={{ padding: 14 }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>
            <MessageSquareText size={14} /> یادآوری پیامکی خودکار
          </p>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4, marginBottom: 10, lineHeight: 1.7 }}>
            چند ساعت قبل از هر نوبت، پیامک یادآوری برای مشتری ارسال شود؟
          </p>
          <select
            value={currentStylist.reminder_hours_before ?? 3}
            onChange={(e) => updateStylist(currentStylistId, { reminder_hours_before: Number(e.target.value) })}
            style={{ width: "100%", padding: "9px 10px", fontSize: 13, fontWeight: 700 }}
          >
            <option value={1}>۱ ساعت قبل</option>
            <option value={2}>۲ ساعت قبل</option>
            <option value={3}>۳ ساعت قبل</option>
            <option value={6}>۶ ساعت قبل</option>
            <option value={12}>۱۲ ساعت قبل</option>
            <option value={24}>۲۴ ساعت قبل</option>
            <option value={48}>۴۸ ساعت قبل</option>
          </select>
        </div>
      )}

      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        {currentStylistId ? "ساعات کاری شخصی شما — در صورت عدم تغییر، از ساعات پیش‌فرض سالن پیروی می‌کند" : "ساعات کاری هفتگی (مشترک برای هر دو بخش)"}
      </p>
      <div className="flex flex-col gap-2 mb-6">
        {myHours.slice().sort((a, b) => a.day_of_week - b.day_of_week).map((w) => (
          <div key={w.day_of_week} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ width: 68, fontWeight: 700, fontSize: 13, color: "var(--color-heading)" }}>{SCHEMA_DAY_LABELS[w.day_of_week]}</div>
            <Switch checked={!w.is_closed} onChange={(v) => updateDay(w.day_of_week, { is_closed: !v })} />
            {!w.is_closed ? (
              <div className="flex items-center gap-1.5 tabular" style={{ marginRight: "auto" }} dir="ltr">
                <input type="time" value={w.start_time} onChange={(e) => updateDay(w.day_of_week, { start_time: e.target.value })} style={{ padding: "6px 8px", fontSize: 12.5 }} />
                <span className="muted" style={{ fontSize: 12 }}>تا</span>
                <input type="time" value={w.end_time} onChange={(e) => updateDay(w.day_of_week, { end_time: e.target.value })} style={{ padding: "6px 8px", fontSize: 12.5 }} />
              </div>
            ) : (
              <span className="muted" style={{ fontSize: 12.5, marginRight: "auto" }}>تعطیل</span>
            )}
          </div>
        ))}
      </div>

      {currentStylistId && (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>تایید روزهای حضور من</p>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.7 }}>
            روزهایی که طبق برنامهٔ هفتگی‌تان کار می‌کنید، پیش‌فرض «حضور دارم» هستند —
            روی هر روز بزنید تا آن را به‌عنوان مرخصی علامت بزنید یا حضورتان را دوباره تایید کنید.
            روزهایی که در برنامهٔ هفتگی‌تان تعطیل است از اینجا قابل‌تغییر نیست.
          </p>
          <div className="card mb-6" style={{ padding: 12 }}>
            <div className="flex items-center gap-3 mb-3" style={{ flexWrap: "wrap" }}>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-accent-500)", display: "inline-block" }} /> حضور دارم
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-warning)", display: "inline-block" }} /> مرخصی
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <Lock size={9} /> خارج از برنامهٔ هفتگی
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {upcomingDates.slice(0, 30).map((d) => {
                const k = dateKey(d);
                const workingDay = isMyWorkingDay(d);
                const attending = workingDay && isMyAttending(d);
                return (
                  <button
                    key={k}
                    disabled={!workingDay}
                    onClick={() => toggleMyAttendance(d)}
                    className="tap tabular"
                    title={!workingDay ? "خارج از برنامهٔ هفتگی شماست" : attending ? "علامت‌زدن به‌عنوان مرخصی" : "تایید دوبارهٔ حضور"}
                    style={{
                      padding: "6px 2px", borderRadius: "var(--radius-md)", textAlign: "center",
                      border: `1px solid ${!workingDay ? "var(--color-border)" : attending ? "var(--color-accent-500)" : "var(--color-warning)"}`,
                      background: !workingDay ? "var(--color-surface)" : attending ? "var(--color-accent-500)" : "var(--color-warning)",
                      color: !workingDay ? "var(--color-muted)" : "white",
                      opacity: !workingDay ? 0.4 : 1,
                    }}
                  >
                    <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.8 }}>{WEEKDAYS_FA_SHORT[d.getDay()]}</div>
                    <div className="tabular" style={{ fontSize: 12.5, fontWeight: 800, marginTop: 1 }}>{toFa(jalaliDayNum(d))}</div>
                    {!workingDay && <Lock size={9} style={{ margin: "2px auto 0" }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!currentStylistId && <AutomationCard automation={automation} onAutomationChange={onAutomationChange} notify={notify} />}
      {!currentStylistId && SUPABASE_ENABLED && <DepositCard automation={automation} onAutomationChange={onAutomationChange} notify={notify} />}
      {!currentStylistId && SUPABASE_ENABLED && <AppHealthCard />}

      {!currentStylistId && !automation.auto_open_days && (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>روزهای باز برای رزرو</p>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.7 }}>
            مشتری فقط می‌تواند روزی را رزرو کند که شما برای آن روز تایید کرده باشید — تک‌روز، یک هفته، یا یک ماه.
          </p>
          <div className="flex gap-2 mb-3 flex-wrap">
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(1, "امروز")}>
              <Check size={13} /> تایید امروز
            </button>
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(7, "این هفته")}>
              <Check size={13} /> تایید این هفته
            </button>
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(30, "این ماه")}>
              <Check size={13} /> تایید این ماه
            </button>
            <button
              className="tap ghost-btn flex items-center gap-1.5"
              style={{ padding: "8px 14px", fontSize: 12.5, color: "var(--color-danger)", borderColor: "var(--color-danger)" }}
              onClick={revokeAllApproved}
            >
              <X size={13} /> لغو همه تاییدها
            </button>
          </div>

          <div className="card mb-6" style={{ padding: 12 }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-accent-500)", display: "inline-block" }} /> تاییدشده
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, border: "1px solid var(--color-border)", display: "inline-block" }} /> هنوز تاییدنشده
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <Lock size={9} /> تعطیل
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {upcomingDates.slice(0, 30).map((d) => {
                const k = dateKey(d);
                const locked = isDayLocked(d);
                const approved = approvedDates.includes(k);
                return (
                  <button
                    key={k}
                    disabled={locked}
                    onClick={() => toggleApproved(d)}
                    className="tap tabular"
                    title={locked ? "این روز تعطیل یا غیرفعال است" : approved ? "لغو تایید این روز" : "تایید این روز برای رزرو"}
                    style={{
                      padding: "6px 2px", borderRadius: "var(--radius-md)", textAlign: "center",
                      border: `1px solid ${approved ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: approved ? "var(--color-accent-500)" : "var(--color-surface)",
                      color: approved ? "white" : locked ? "var(--color-muted)" : "var(--color-heading)",
                      opacity: locked ? 0.4 : 1,
                    }}
                  >
                    <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.8 }}>{WEEKDAYS_FA_SHORT[d.getDay()]}</div>
                    <div className="tabular" style={{ fontSize: 12.5, fontWeight: 800, marginTop: 1 }}>{toFa(jalaliDayNum(d))}</div>
                    {locked && <Lock size={9} style={{ margin: "2px auto 0" }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!currentStylistId && <ClosuresCard notify={notify} />}

      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        {currentStylistId ? "مرخصی‌های شخصی شما" : "تعطیلی‌های موقت سالن"}
      </p>
      <div className="card mb-3" style={{ padding: 12 }}>
        <div className="flex gap-2">
          <select value={newOffDate} onChange={(e) => setNewOffDate(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }}>
            <option value="">انتخاب تاریخ...</option>
            {upcomingDates.map((d) => (
              <option key={dateKey(d)} value={dateKey(d)}>{jalaliLabel(d, { short: false })}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-1 mt-2" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          <button
            onClick={() => setNewOffAllDay(true)}
            className="tap flex-1"
            style={{ padding: "7px 4px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700, background: newOffAllDay ? "var(--color-surface)" : "transparent", color: newOffAllDay ? "var(--color-heading)" : "var(--color-muted)", boxShadow: newOffAllDay ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
          >
            تمام روز
          </button>
          <button
            onClick={() => setNewOffAllDay(false)}
            className="tap flex-1"
            style={{ padding: "7px 4px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700, background: !newOffAllDay ? "var(--color-surface)" : "transparent", color: !newOffAllDay ? "var(--color-heading)" : "var(--color-muted)", boxShadow: !newOffAllDay ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
          >
            بازهٔ ساعتی (مثلاً استراحت ناهار)
          </button>
        </div>

        {!newOffAllDay && (
          <div className="flex items-center gap-1.5 tabular mt-2" dir="ltr">
            <input type="time" value={newOffStart} onChange={(e) => setNewOffStart(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} />
            <span className="muted" style={{ fontSize: 12 }}>تا</span>
            <input type="time" value={newOffEnd} onChange={(e) => setNewOffEnd(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} />
          </div>
        )}
        {!newOffAllDay && !newOffRangeValid && (
          <p style={{ fontSize: 11, color: "var(--color-danger)", marginTop: 4 }}>ساعت پایان باید بعد از ساعت شروع باشد</p>
        )}

        <input
          value={newOffReason} onChange={(e) => setNewOffReason(e.target.value)} placeholder="دلیل (اختیاری)"
          style={{ width: "100%", padding: "9px 10px", fontSize: 12.5, marginTop: 8 }}
        />
        <button disabled={!newOffDate || !newOffRangeValid} className="tap accent-btn w-full mt-2 flex items-center justify-center gap-1.5" style={{ padding: 10, fontSize: 13 }} onClick={addTimeOff}>
          <CalendarX size={14} /> {newOffAllDay ? "ثبت تعطیلی تمام‌روز" : "ثبت تعطیلی ساعتی"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {myTimeOff.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>تعطیلی موقتی ثبت نشده</p>}
        {myTimeOff
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((t) => {
            const [y, m, d] = t.date.split("-").map(Number);
            const isPartial = t.start_min != null;
            return (
              <div key={t.id} className="card" style={{ padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
                {isPartial ? <Clock size={15} color="var(--color-warning)" style={{ flexShrink: 0 }} /> : <CalendarX size={15} color="var(--color-danger)" style={{ flexShrink: 0 }} />}
                <div style={{ flex: 1 }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{jalaliLabel(new Date(y, m - 1, d), { short: true })}</span>
                    {isPartial && (
                      <span className="tabular" dir="ltr" style={{ fontSize: 11, fontWeight: 700, color: "var(--color-warning)", background: "color-mix(in oklch, var(--color-warning) 14%, transparent)", padding: "2px 7px", borderRadius: "var(--radius-full)" }}>
                        {formatClock(t.start_min)} - {formatClock(t.end_min)}
                      </span>
                    )}
                  </div>
                  {t.reason && <div className="muted" style={{ fontSize: 11.5 }}>{t.reason}</div>}
                </div>
                <button className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0 }} onClick={() => removeTimeOff(t.id)}>
                  <X size={13} style={{ margin: "auto" }} />
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}
