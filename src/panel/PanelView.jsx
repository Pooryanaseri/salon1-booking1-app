import React, { useState } from "react";
import { Clock, Phone, X, Calendar as CalendarIcon, MoreVertical, CheckCircle2, MessageSquareText, User, Plus, Trash2, Pencil, Settings, LayoutList, Brain, BarChart3, ChevronLeft, ChevronRight, History, CalendarClock, Wallet, Users, Bell, Gift, ShieldCheck } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { fetchCustomerReferredBy } from "../lib/api";
import { toFa, normalizeMobile, formatToman, jalaliLabel, formatClock, hhmmToMin, isRevenueEligible, dateKey, parseDateKey } from "../lib/format";
import { AIAnalysisTab } from "./AIAnalysisTab";
import { AccountingTab } from "./AccountingTab";
import { BITab } from "./BITab";
import { Badge, DayTimeline, GenderBadge, MenuItem, Modal, PanelSectionHeader, Row, StatCard, Switch } from "../components/ui";
import { CancelModal, ReferralVerifyModal, RescheduleModal } from "../components/bookingModals";
import { LoyaltyTab } from "./LoyaltyTab";
import { SECTION_META, STATUS_META, makeSeedStylist, occupiedEndFor, schemaDayOf } from "../app/shared";
import { ScheduleTab } from "./ScheduleTab";
import { ServicesTab } from "./ServicesTab";
import { SmsTab } from "./SmsTab";

/* ============================================================
   Panel view (staff) — dashboard / services / schedule
   ============================================================ */
export function PanelView({ bookings, services, setServices, stylists, addStylist, updateStylist, removeStylist, currentStylistId, currentRole, smsTemplates, workingHours, setWorkingHours, staffWorkingHours, setStaffWorkingHours, timeOff, setTimeOff, approvedDates, setApprovedDates, updateBooking, expenses, addExpense, removeExpense, waitlist, removeWaitlistEntry, notify, onLogout }) {
  const [subTab, setSubTab] = useState("dashboard");
  const [pendingSmsSegment, setPendingSmsSegment] = useState(null);
  const currentStylist = stylists.find((s) => s.id === currentStylistId) || null;

  // Everyone gets the same tabs — each one shows only what belongs to the logged-in
  // person (their own bookings/revenue/hours). Only staff management is owner-only,
  // since letting a stylist add/remove colleagues doesn't make sense.
  const subTabs = [
    { id: "dashboard", label: currentStylist ? "نوبت‌های من" : "نوبت‌های امروز", Icon: LayoutList, color: "var(--color-tab-book)" },
    ...(currentStylist ? [] : [{ id: "accounting", label: "حسابداری", Icon: Wallet, color: "var(--color-warning)" }]),
    ...(currentStylist ? [] : [{ id: "services", label: "خدمات", Icon: Settings, color: "var(--color-tab-services)" }]),
    ...(currentStylist ? [] : [{ id: "staff", label: "آرایشگرها", Icon: Users, color: "var(--color-info)" }]),
    { id: "schedule", label: currentStylist ? "ساعات کاری من" : "ساعات کاری", Icon: CalendarIcon, color: "var(--color-tab-dash)" },
    // NEW — پنل ارسال پیامک: owner/manager only, same rule as staff management.
    ...(currentStylist ? [] : [{ id: "sms", label: "پیامک", Icon: MessageSquareText, color: "var(--color-tab-panel)" }]),
    // باشگاه مشتریان: owner/manager AND stylist (discount settings should be
    // adjustable by either, per explicit request — stylists interact with
    // customers directly about redeeming rewards). Segment/category views
    // within this tab are separately gated to manager-only (they expose the
    // full customer bank, not just the stylist's own customers).
    { id: "loyalty", label: "باشگاه مشتریان", Icon: Gift, color: "var(--color-success)" },
    // v2.15: AIAnalysisTab includes a salon-wide revenue forecast —
    // owner/manager only, same rule as accounting/BI.
    ...(currentStylist ? [] : [{ id: "ai", label: "تحلیل هوشمند", Icon: Brain, color: "var(--color-tab-dash)" }]),
    ...(currentStylist ? [] : [{ id: "bi", label: "هوش تجاری", Icon: BarChart3, color: "var(--color-tab-panel)" }]),
  ];

  return (
    <div className="fade-in">
      <div
        className="flex items-center justify-between mb-3"
        style={{ padding: "12px 14px", borderRadius: "var(--radius-lg)", background: "var(--grad-tab-panel)" }}
      >
        <p className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 800, color: "white" }}>
          <ShieldCheck size={16} />
          {currentStylist ? <>پنل شخصی {currentStylist.name}</> : "پنل مدیر سالن"}
        </p>
        <button
          className="tap flex items-center gap-1"
          style={{ fontSize: 11.5, fontWeight: 700, color: "white", background: "oklch(100% 0 0 / 0.18)", padding: "6px 11px", borderRadius: "var(--radius-full)" }}
          onClick={onLogout}
        >
          خروج
        </button>
      </div>

      {/* Sub-nav — a grid, not a scrolling strip, so every tab is visible at
          once with nothing hidden off-screen. Each tab keeps its own color
          identity (solid fill when active, soft tint when inactive). */}
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(3, 1fr)" }} role="tablist" aria-label="بخش‌های پنل">
        {subTabs.map((t) => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setSubTab(t.id)}
              className="tap flex flex-col items-center justify-center gap-1"
              style={{
                padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 10.5, fontWeight: active ? 800 : 700, textAlign: "center",
                background: active ? t.color : `color-mix(in oklch, ${t.color} 11%, var(--color-surface))`,
                color: active ? "white" : t.color,
                border: active ? "none" : `1px solid color-mix(in oklch, ${t.color} 22%, transparent)`,
                boxShadow: active ? `0 3px 10px -3px color-mix(in oklch, ${t.color} 55%, transparent)` : "none",
                lineHeight: 1.3,
              }}
            >
              <t.Icon size={17} />
              {t.label}
            </button>
          );
        })}
      </div>

      {subTab === "dashboard" && (
        <DashboardTab bookings={bookings} services={services} stylists={stylists} defaultStaffId={currentStylistId} workingHours={workingHours} timeOff={timeOff} updateBooking={updateBooking} waitlist={waitlist} removeWaitlistEntry={removeWaitlistEntry} />
      )}
      {subTab === "accounting" && !currentStylist && (
        <AccountingTab
          bookings={bookings}
          services={services}
          stylists={stylists}
          expenses={expenses}
          addExpense={addExpense}
          removeExpense={removeExpense}
          notify={notify}
          staffId={currentStylistId}
          canEditExpenses={!currentStylist}
        />
      )}
      {subTab === "services" && !currentStylist && <ServicesTab services={services} setServices={setServices} notify={notify} />}
      {subTab === "staff" && !currentStylist && (
        <StaffTab stylists={stylists} addStylist={addStylist} updateStylist={updateStylist} removeStylist={removeStylist} notify={notify} />
      )}
      {subTab === "schedule" && (
        <ScheduleTab
          workingHours={workingHours}
          setWorkingHours={setWorkingHours}
          staffWorkingHours={staffWorkingHours}
          setStaffWorkingHours={setStaffWorkingHours}
          currentStylistId={currentStylistId}
          currentStylist={currentStylist}
          updateStylist={updateStylist}
          timeOff={timeOff}
          setTimeOff={setTimeOff}
          approvedDates={approvedDates}
          setApprovedDates={setApprovedDates}
          notify={notify}
        />
      )}
      {subTab === "sms" && !currentStylist && (
        <SmsTab
          bookings={bookings}
          services={services}
          stylists={stylists}
          smsTemplates={smsTemplates}
          notify={notify}
          presetSegment={pendingSmsSegment}
          onConsumePresetSegment={() => setPendingSmsSegment(null)}
        />
      )}
      {subTab === "loyalty" && (
        <LoyaltyTab
          notify={notify}
          currentStylist={currentStylist}
          onNavigateToSmsSegment={(segment) => { setPendingSmsSegment(segment); setSubTab("sms"); }}
        />
      )}
      {subTab === "ai" && !currentStylist && <AIAnalysisTab bookings={bookings} />}
      {subTab === "bi" && !currentStylist && (
        <BITab
          bookings={bookings}
          services={services}
          stylists={stylists}
          workingHours={workingHours}
          staffWorkingHours={staffWorkingHours}
          timeOff={timeOff}
          approvedDates={approvedDates}
        />
      )}
    </div>
  );
}

/* ============================================================
   Staff tab — each stylist belongs to one section (female/male),
   same as services. Customers pick from this list during booking.
   ============================================================ */
export function StaffTab({ stylists, addStylist, updateStylist, removeStylist, notify }) {
  const [editing, setEditing] = useState(null); // stylist object or 'new'
  const [genderFilter, setGenderFilter] = useState("all");

  function saveStylist(data) {
    if (data.id) {
      updateStylist(data.id, data);
      notify("مشخصات آرایشگر ویرایش شد");
    } else {
      addStylist(makeSeedStylist(data));
    }
    setEditing(null);
  }

  const filtered = genderFilter === "all" ? stylists : stylists.filter((s) => s.gender === genderFilter);

  return (
    <div>
      <PanelSectionHeader Icon={Users} title="آرایشگرها" subtitle="افزودن، ویرایش، و مدیریت وضعیت فعال بودن هر آرایشگر" color="var(--color-info)" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
            <button
              key={f.v}
              onClick={() => setGenderFilter(f.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
        <button className="tap accent-btn flex items-center gap-1" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => setEditing("new")}>
          <Plus size={15} /> افزودن آرایشگر
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((s) => (
          <div key={s.id} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, opacity: s.active ? 1 : 0.55 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: SECTION_META[s.gender].tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <User size={17} color={SECTION_META[s.gender].color} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-1.5">
                <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)" }}>{s.name}</span>
                <GenderBadge gender={s.gender} />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>{s.active ? "فعال" : "غیرفعال"}</div>
            </div>
            <Switch checked={s.active} onChange={() => updateStylist(s.id, { active: !s.active })} />
            <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => setEditing(s)}>
              <Pencil size={14} style={{ margin: "auto" }} />
            </button>
            <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0, color: "var(--color-danger)" }} onClick={() => removeStylist(s.id)}>
              <Trash2 size={14} style={{ margin: "auto" }} />
            </button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>آرایشگری در این بخش ثبت نشده</p>
          </div>
        )}
      </div>

      {editing && <StylistEditModal stylist={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveStylist} />}
    </div>
  );
}

export function StylistEditModal({ stylist, onClose, onSave }) {
  const [name, setName] = useState(stylist?.name || "");
  const [gender, setGender] = useState(stylist?.gender || "female");
  const [phone, setPhone] = useState(stylist?.phone || "");
  const [password, setPassword] = useState(stylist?.password || "");
  const [reminderHours, setReminderHours] = useState(stylist?.reminder_hours_before ?? 3);

  const phoneValid = /^09\d{9}$/.test(phone);
  // A password is only meaningful in demo mode (compared locally for the demo
  // login simulation). In real/Supabase mode, a stylist's actual login is
  // created separately when THEY self-register from "ورود آرایشگر" using
  // this same phone number — this admin form only manages their business
  // record (name/phone/gender/active), never a credential.
  const needsPassword = !SUPABASE_ENABLED;
  const canSave = name.trim().length > 0 && phoneValid && (!needsPassword || password.trim().length >= 4);

  return (
    <Modal title={stylist ? "ویرایش آرایشگر" : "افزودن آرایشگر جدید"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>بخش</label>
          <div className="flex gap-2 mt-1">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              return (
                <button
                  key={g}
                  onClick={() => setGender(g)}
                  className="tap flex-1 flex items-center justify-center gap-1.5"
                  style={{
                    padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                    border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                    background: gender === g ? meta.tint : "var(--color-surface)",
                    color: gender === g ? meta.color : "var(--color-body)",
                  }}
                >
                  <Icon size={14} /> {meta.short}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>نام آرایشگر</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً مهسا کریمی" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>شماره موبایل (برای ورود به پنل)</label>
          <input
            dir="ltr" type="tel" inputMode="tel" autoComplete="off" value={phone}
            onChange={(e) => setPhone(normalizeMobile(e.target.value))}
            placeholder="09xxxxxxxxx" className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4, textAlign: "left" }}
          />
        </div>
        {needsPassword ? (
          <div>
            <label className="muted" style={{ fontSize: 12 }}>رمز عبور (حداقل ۴ رقم/کاراکتر)</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="رمز ورود به پنل" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
            رمز عبور اینجا تنظیم نمی‌شود — خودِ آرایشگر با همین شماره موبایل از «ورود آرایشگر ← ثبت‌نام» وارد می‌شود و رمز خودش را انتخاب می‌کند.
          </p>
        )}
        <div>
          <label className="muted" style={{ fontSize: 12 }}>چند ساعت قبل از هر نوبت، پیامک یادآوری ارسال شود؟</label>
          <select
            value={reminderHours}
            onChange={(e) => setReminderHours(Number(e.target.value))}
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4, fontWeight: 700 }}
          >
            <option value={1}>۱ ساعت قبل</option>
            <option value={2}>۲ ساعت قبل</option>
            <option value={3}>۳ ساعت قبل</option>
            <option value={6}>۶ ساعت قبل</option>
            <option value={12}>۱۲ ساعت قبل</option>
            <option value={24}>۲۴ ساعت قبل</option>
          </select>
          <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>خودِ آرایشگر هم می‌تواند این را از پنل شخصی‌اش تغییر دهد</p>
        </div>
        <button
          disabled={!canSave}
          className="tap accent-btn w-full"
          style={{ padding: 12, fontSize: 14, marginTop: 4 }}
          onClick={() => canSave && onSave({ id: stylist?.id, name: name.trim(), gender, phone, password: needsPassword ? password : undefined, active: stylist?.active ?? true, reminder_hours_before: reminderHours })}
        >
          {stylist ? "ذخیره تغییرات" : "افزودن آرایشگر"}
        </button>
      </div>
    </Modal>
  );
}

export function DashboardTab({ bookings, services, stylists, defaultStaffId, workingHours, timeOff, updateBooking, waitlist, removeWaitlistEntry }) {
  const [menuFor, setMenuFor] = useState(null);
  const [action, setAction] = useState(null);
  const [verifyAction, setVerifyAction] = useState(null); // { booking } — pending referral-verification prompt
  const [genderFilter, setGenderFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState(defaultStaffId || "all");
  const [view, setView] = useState("list"); // "list" | "timeline"
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const locked = !!defaultStaffId; // a stylist viewing their OWN panel — can't switch to see others

  const viewDateKey = dateKey(viewDate);
  const isToday = viewDateKey === dateKey(new Date());

  function shiftDay(delta) {
    setViewDate((d) => { const n = new Date(d); n.setDate(n.getDate() + delta); return n; });
  }

  // "انجام شد" — most bookings have no referrer involved and complete
  // immediately as before. Only when this customer was referred does staff
  // need to confirm (in ReferralVerifyModal) that they're genuinely new
  // before the referrer's reward can be awarded.
  async function handleComplete(b) {
    setMenuFor(null);
    const referredBy = await fetchCustomerReferredBy(b.customer_phone);
    if (referredBy) {
      setVerifyAction({ booking: b });
    } else {
      updateBooking(b.id, { status: "completed" }, "وضعیت به «انجام شده» تغییر کرد");
    }
  }

  const dayBookings = bookings
    .filter((b) => b.date === viewDateKey)
    .sort((a, b) => a.start_min - b.start_min);
  const todays = dayBookings.filter(
    (b) => (genderFilter === "all" || b.customer_gender === genderFilter) && (staffFilter === "all" || b.staff_id === staffFilter)
  );

  const dayWaitlist = (waitlist || []).filter(
    (w) => w.date === viewDateKey
      && (genderFilter === "all" || w.customer_gender === genderFilter)
      && (!locked || !w.staff_id || w.staff_id === defaultStaffId)
  );

  const billable = todays.filter((b) => isRevenueEligible(b.status));
  const summary = {
    total: todays.length,
    confirmed: todays.filter((b) => b.status === "confirmed").length,
    pending: todays.filter((b) => b.status === "pending").length,
    revenue: billable.filter((b) => b.final_price != null).reduce((s, b) => s + b.final_price, 0),
    unpriced: billable.filter((b) => b.final_price == null).length,
  };

  const dayWH = workingHours.find((w) => w.day_of_week === schemaDayOf(viewDate));
  const timelineRange = dayWH && !dayWH.is_closed
    ? { start: hhmmToMin(dayWH.start_time), end: hhmmToMin(dayWH.end_time) }
    : { start: 9 * 60, end: 21 * 60 };

  return (
    <div>
      <PanelSectionHeader
        Icon={LayoutList}
        title={defaultStaffId ? "نوبت‌های من" : "نوبت‌های امروز"}
        subtitle="مدیریت وضعیت نوبت‌ها بر اساس روز — تایید، تکمیل، یا لغو"
        color="var(--color-tab-book)"
      />
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => shiftDay(-1)} aria-label="روز قبل">
            <ChevronRight size={15} style={{ margin: "auto" }} />
          </button>
          <div style={{ minWidth: 92, textAlign: "center" }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{jalaliLabel(viewDate, { short: true })}</p>
          </div>
          <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => shiftDay(1)} aria-label="روز بعد">
            <ChevronLeft size={15} style={{ margin: "auto" }} />
          </button>
          {!isToday && (
            <button className="muted" style={{ fontSize: 11.5, marginRight: 4 }} onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setViewDate(d); }}>
              امروز
            </button>
          )}
        </div>
        {!locked && (
          <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
            {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
              <button
                key={f.v}
                onClick={() => setGenderFilter(f.v)}
                className="tap"
                style={{
                  padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                  background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                  color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
                }}
              >
                {f.l}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between mb-2" style={{ flexWrap: "wrap", gap: 8 }}>
        <p className="muted" style={{ fontSize: 11.5 }}>{jalaliLabel(viewDate)}</p>
        {!locked && stylists.length > 0 && (
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            style={{ padding: "5px 10px", fontSize: 11.5, fontWeight: 700, borderRadius: "var(--radius-md)" }}
          >
            <option value="all">همه آرایشگرها</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex gap-2 mb-4">
        <StatCard label="تعداد" value={toFa(summary.total)} icon={LayoutList} color="var(--color-accent-700)" />
        <StatCard label="تایید شده" value={toFa(summary.confirmed)} icon={CheckCircle2} color="var(--color-accent-500)" />
        <StatCard label="در انتظار" value={toFa(summary.pending)} icon={Clock} color="var(--color-info)" />
      </div>
      <div className="card mb-4" style={{ padding: 14 }}>
        <Row label={isToday ? "مجموع درآمد امروز" : "مجموع درآمد این روز"} value={formatToman(summary.revenue)} bold />
        {summary.unpriced > 0 && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            + {toFa(summary.unpriced)} نوبت بدون قیمت تعیین‌شده (در محاسبه لحاظ نشده)
          </p>
        )}
      </div>

      {dayWaitlist.length > 0 && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-info) 8%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)" }}>
            <Bell size={13} /> لیست انتظار این روز ({toFa(dayWaitlist.length)} نفر)
          </p>
          <div className="flex flex-col gap-2">
            {dayWaitlist.map((w) => {
              const svc = services.find((s) => s.id === w.service_id);
              return (
                <div key={w.id} className="flex items-center gap-2 surface-raised" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                      {w.customer_name || "بدون نام"} <span dir="ltr" className="tabular muted" style={{ fontSize: 11 }}>{toFa(w.customer_phone)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 10.5, marginTop: 1 }}>
                      {svc?.name}{w.staff_name ? ` · ${w.staff_name}` : ""}
                    </div>
                  </div>
                  <a href={`tel:${w.customer_phone}`} className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }}>
                    <Phone size={13} style={{ margin: "auto" }} />
                  </a>
                  <button className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={() => removeWaitlistEntry(w.id)}>
                    <X size={13} style={{ margin: "auto" }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <p className="muted" style={{ fontSize: 11.5 }}>نمای نوبت‌ها</p>
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "list", l: "لیست", Icon: LayoutList }, { v: "timeline", l: "جدول زمانی", Icon: CalendarClock }].map((o) => (
            <button
              key={o.v}
              onClick={() => setView(o.v)}
              className="tap flex items-center gap-1"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: view === o.v ? "var(--color-surface)" : "transparent",
                color: view === o.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              <o.Icon size={12} /> {o.l}
            </button>
          ))}
        </div>
      </div>

      {view === "timeline" && (
        <div className="fade-in mb-4">
          {todays.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: "center" }}>
              <p className="muted" style={{ fontSize: 13 }}>نوبتی برای این بخش {isToday ? "امروز" : "این روز"} ثبت نشده</p>
            </div>
          ) : (
            <DayTimeline
              startMin={timelineRange.start}
              endMin={timelineRange.end}
              blocks={todays.map((b) => ({
                start: b.start_min,
                end: occupiedEndFor(b),
                color: STATUS_META[b.status].bg,
                textColor: STATUS_META[b.status].fg,
                label: b.customer_name,
                title: `${b.customer_name} · ${formatClock(b.start_min)}`,
              }))}
            />
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <span key={key} className="flex items-center gap-1 muted" style={{ fontSize: 10.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: meta.bg, display: "inline-block" }} /> {meta.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {view === "list" && (
      <div className="flex flex-col gap-2">
        {todays.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>نوبتی برای این بخش {isToday ? "امروز" : "این روز"} ثبت نشده</p>
          </div>
        )}
        {todays.map((b, idx) => {
          const service = services.find((s) => s.id === b.service_id);
          const meta = STATUS_META[b.status];
          const prevB = todays[idx - 1];
          const nextB = todays[idx + 1];
          const gapBefore = prevB ? b.start_min - occupiedEndFor(prevB) : null;
          return (
            <React.Fragment key={b.id}>
              {prevB && gapBefore != null && gapBefore > 0 && (
                <div className="muted flex items-center justify-center gap-1" style={{ fontSize: 10.5, padding: "1px 0" }}>
                  <History size={10} /> {toFa(gapBefore)} دقیقه فاصله تا نوبت قبل
                </div>
              )}
              <div className="card" style={{ padding: 12, position: "relative" }}>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="tabular" style={{ textAlign: "center", minWidth: 44 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: "var(--color-heading)" }}>{formatClock(b.start_min)}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{toFa(service?.duration_minutes)} د</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)", textDecoration: meta.strike ? "line-through" : "none" }}>
                        {b.customer_name}
                      </span>
                      <GenderBadge gender={b.customer_gender} />
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 1, textDecoration: meta.strike ? "line-through" : "none" }}>
                      {service?.name}{b.staff_name ? ` · ${b.staff_name}` : ""}
                    </div>
                    <div className="mt-1.5"><Badge status={b.status} /></div>
                    {b.status === "reschedule_proposed" && (
                      <div className="flex items-center gap-1 tabular" style={{ fontSize: 10.5, marginTop: 3, color: "var(--color-warning)" }}>
                        <Clock size={11} /> پیشنهاد: {jalaliLabel(parseDateKey(b.pending_date), { short: true })} - {formatClock(b.pending_start_min)} — در انتظار پاسخ مشتری
                      </div>
                    )}
                    <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 4 }}>
                      {prevB ? <>قبلی: {formatClock(prevB.start_min)} · {prevB.customer_name}</> : "اولین نوبت این روز"}
                      {" — "}
                      {nextB ? <>بعدی: {formatClock(nextB.start_min)} · {nextB.customer_name}</> : "آخرین نوبت این روز"}
                    </div>
                  </div>
                </div>
                {!["completed", "cancelled", "cancelled_by_salon", "no_show", "archived_unconfirmed"].includes(b.status) && (
                  <button onClick={() => setMenuFor(menuFor === b.id ? null : b.id)} className="tap" style={{ width: 32, height: 32, borderRadius: "var(--radius-sm)" }}>
                    <MoreVertical size={16} style={{ margin: "auto" }} />
                  </button>
                )}
              </div>

              {menuFor === b.id && (
                <div className="fade-in card" style={{ position: "absolute", left: 12, top: 44, zIndex: 20, minWidth: 170, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,.15)" }}>
                  {/* Only actions that are genuinely valid from the booking's
                      CURRENT status are shown — not every action regardless
                      of state (e.g. "لغو نوبت" on an already-cancelled
                      booking, or "انجام شد" on an already-completed one). */}
                  {b.status === "pending" && (
                    <MenuItem positive label="تایید نوبت" onClick={() => { updateBooking(b.id, { status: "confirmed" }, "نوبت تایید شد؛ پیامک برای مشتری ارسال شد"); setMenuFor(null); }} />
                  )}
                  {["pending", "confirmed", "rescheduled"].includes(b.status) && (
                    <MenuItem label="تغییر زمان" onClick={() => { setAction({ type: "reschedule", booking: b }); setMenuFor(null); }} />
                  )}
                  {["pending", "confirmed", "rescheduled", "pending_verification"].includes(b.status) && (
                    <MenuItem label="انجام شد" onClick={() => handleComplete(b)} />
                  )}
                  {["pending", "confirmed", "rescheduled", "pending_verification"].includes(b.status) && (
                    <MenuItem label="عدم حضور" onClick={() => { updateBooking(b.id, { status: "no_show" }, "وضعیت به «عدم حضور» تغییر کرد"); setMenuFor(null); }} />
                  )}
                  {["pending", "confirmed", "rescheduled", "reschedule_proposed"].includes(b.status) && (
                    <MenuItem danger label="لغو نوبت" onClick={() => { setAction({ type: "cancel", booking: b }); setMenuFor(null); }} />
                  )}
                </div>
              )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      )}

      {action?.type === "cancel" && (
        <CancelModal
          booking={action.booking}
          onClose={() => setAction(null)}
          onConfirm={() => { updateBooking(action.booking.id, { status: "cancelled" }, "نوبت لغو شد؛ پیامک برای مشتری ارسال شد"); setAction(null); }}
        />
      )}
      {action?.type === "reschedule" && (
        <RescheduleModal
          booking={action.booking}
          services={services}
          bookings={bookings}
          workingHours={workingHours}
          timeOff={timeOff}
          onClose={() => setAction(null)}
          onConfirm={(newStart, newDate) => {
            const svc = services.find((s) => s.id === action.booking.service_id);
            updateBooking(
              action.booking.id,
              { pending_date: newDate, pending_start_min: newStart, pending_end_min: newStart + svc.duration_minutes, status: "reschedule_proposed" },
              "پیشنهاد زمان جدید ثبت شد؛ برای تایید نهایی منتظر پاسخ مشتری بمانید"
            );
            setAction(null);
          }}
        />
      )}
      {verifyAction && (
        <ReferralVerifyModal
          booking={verifyAction.booking}
          onClose={() => setVerifyAction(null)}
          onConfirm={(verified) => {
            updateBooking(
              verifyAction.booking.id,
              { status: "completed", referral_verified: verified },
              verified ? "وضعیت به «انجام شده» تغییر کرد؛ امتیاز معرف و مشتری ثبت شد" : "وضعیت به «انجام شده» تغییر کرد؛ بدون امتیاز معرفی"
            );
            setVerifyAction(null);
          }}
        />
      )}
    </div>
  );
}
