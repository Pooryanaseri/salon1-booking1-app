import { useState, useEffect, useMemo } from "react";
import { Clock, Percent, Copy, TrendingUp, TrendingDown, ChevronLeft, CalendarCheck, UserPlus, Award, Crown, LayoutDashboard } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { verifyBookingOtp, fetchMyBookingsWithToken, cancelMyBookingWithToken, rescheduleMyBookingWithToken, revokeBookingToken, requestBookingOtpTestMode, fetchCustomerLoyalty } from "../lib/api";
import { requestBookingOtp } from "../lib/sms";
import { toFa, digitsOnly, normalizeMobile, formatToman, jalaliLabel, formatClock, parseDateKey } from "../lib/format";
import { Badge, Row } from "../components/ui";
import { CancelModal, RescheduleModal } from "../components/bookingModals";
import { LOYALTY_REASON_FA } from "../app/shared";

/* ============================================================
   Track view (public, restricted fields only)
   ============================================================ */
// Public-facing (no login needed — customer_loyalty() is granted to `anon`).
// This is the only place a customer can see their own referral code, which
// is the whole point of having one: without this, applyReferral() has no
// codes for anyone to actually enter.
export const DASH_SEGMENTS = [
  { id: "bookings", label: "نوبت‌ها", Icon: CalendarCheck, color: "var(--color-tab-book)" },
  { id: "points", label: "امتیازات", Icon: Award, color: "var(--color-success)" },
  { id: "referrals", label: "معرفی‌ها", Icon: UserPlus, color: "var(--color-tab-panel)" },
];

// Small deterministic color picker for referral-member avatars — same person
// always gets the same color, and the palette stays varied (not all one hue).
export const AVATAR_PALETTE = [
  "var(--color-tab-book)", "var(--color-tab-dash)", "var(--color-tab-panel)",
  "var(--color-success)", "var(--color-warning)", "var(--color-female-500)",
];
export function avatarColorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[h];
}

export function TrackView({ bookings, services, stylists, workingHours, staffWorkingHours, timeOff, approvedDates, updateBooking, notify, initialPhone = "" }) {
  const [phone, setPhone] = useState(initialPhone);
  const [searched, setSearched] = useState(false);
  const [actionFor, setActionFor] = useState(null); // { id, type: "cancel" | "reschedule" }
  const [segment, setSegment] = useState("bookings");

  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [myBookings, setMyBookings] = useState([]);

  // v2.19 — OTP-verified ownership. Phone number alone no longer proves
  // anything; a customer must request and enter a one-time code sent to
  // that number before any booking data is shown. accessToken lives only
  // in memory for this session (nothing persisted) — a page refresh
  // requires re-verifying, which is the safe default for a short-lived
  // credential.
  const [otpStep, setOtpStep] = useState("phone"); // "phone" | "code" | "verified"
  const [otpCode, setOtpCode] = useState("");
  const [otpRequesting, setOtpRequesting] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [accessToken, setAccessToken] = useState(null);
  const [devOtp, setDevOtp] = useState(null); // only set when the backend is in SMS_DRY_RUN test mode

  const phoneValid = /^09\d{9}$/.test(phone);
  const codeValid = /^\d{6}$/.test(otpCode);

  async function requestCode() {
    setOtpError("");
    if (!SUPABASE_ENABLED) {
      setOtpError("این قابلیت در حالت دمو نیاز به اتصال واقعی به دیتابیس دارد");
      return;
    }
    setOtpRequesting(true);
    let res = await requestBookingOtp(phone); // normal path: Edge Function -> real SMS (or SMS_DRY_RUN)
    if (!res?.ok) {
      // Edge Function unreachable/not deployed, or SMS provider not
      // configured — try the DB-only test path instead. This only ever
      // succeeds if a manager has explicitly enabled sms_test_mode (one
      // SQL line, no deploy needed); otherwise it fails too and we fall
      // through to showing the original real error below, so a genuine
      // production SMS failure is never masked by a confusing "test mode
      // is off" message.
      const testRes = await requestBookingOtpTestMode(phone);
      if (testRes?.ok) res = testRes;
    }
    setOtpRequesting(false);
    if (!res?.ok) { setOtpError(res?.error || "ارسال کد ناموفق بود"); return; }
    // dev_otp: SMS_DRY_RUN path (v2.19). test_otp: DB-only path (v2.20).
    // Either way, only ever present for this same request's own phone —
    // never anyone else's code, and never shown to a real customer unless
    // a manager explicitly turned on a test mode.
    const testCode = res.dev_otp || res.test_otp;
    if (testCode) { setDevOtp(testCode); setOtpCode(testCode); } else { setDevOtp(null); }
    setOtpStep("code");
  }

  async function verifyCode() {
    setOtpError("");
    setOtpVerifying(true);
    try {
      const res = await verifyBookingOtp(phone, otpCode);
      if (!res?.ok) {
        setOtpError(res?.error || "کد اشتباه است");
        return;
      }
      const bookingsRes = await fetchMyBookingsWithToken(res.token);
      setAccessToken(res.token);
      setMyBookings(bookingsRes);
      setOtpStep("verified");
      setSearched(true);
      setSegment("bookings");
    } catch (err) {
      console.error("[salon] verifyCode failed unexpectedly:", err);
      setOtpError("خطایی رخ داد — دوباره امتحان کنید");
    } finally {
      setOtpVerifying(false);
    }
  }


  // v2.19: bookings prop is the PII-free slots view for an anonymous
  // caller — a customer's own bookings come from the token-gated RPCs
  // above only, never filtered client-side from phone number alone.
  const matches = useMemo(
    () => [...myBookings].sort((a, b) => (b.date + String(b.start_min).padStart(4, "0")).localeCompare(a.date + String(a.start_min).padStart(4, "0"))),
    [myBookings]
  );

  const actionBooking = actionFor ? myBookings.find((b) => b.id === actionFor.id) : null;

  // v2.19: cancel/reschedule now require the verified access token — the
  // old anonymous UPDATE policy (any appointment_id, no ownership check)
  // is gone; these are the only paths left for a customer to change their
  // own booking, and each one re-proves ownership server-side via the
  // token on every call.
  async function cancelMyBooking(id) {
    const res = await cancelMyBookingWithToken(accessToken, id);
    if (!res?.ok) { notify(res?.error || "لغو ناموفق بود"); return; }
    setMyBookings((prev) => prev.map((b) => (b.id === id ? { ...b, status: "cancelled" } : b)));
    notify("نوبت شما لغو شد");
  }
  async function rescheduleMyBooking(id, newDate, newStartMin, newEndMin) {
    const res = await rescheduleMyBookingWithToken(accessToken, id, newDate, newStartMin);
    if (!res?.ok) { notify(res?.error || "جابه‌جایی ناموفق بود"); return; }
    setMyBookings((prev) => prev.map((b) => (b.id === id
      ? { ...b, date: newDate, start_min: newStartMin, end_min: newEndMin, status: "rescheduled", pending_date: null, pending_start_min: null, pending_end_min: null }
      : b)));
    notify("نوبت شما جابه‌جا شد");
  }
  // A staff-proposed reschedule the customer accepts as-is (no new time
  // picked) still needs to move through the same server-validated path —
  // reschedule to the exact pending date/time already proposed.
  async function acceptProposedReschedule(b) {
    const svc = services.find((s) => s.id === b.service_id);
    const newStart = b.pending_start_min;
    const newEnd = svc ? newStart + svc.duration_minutes : b.pending_end_min;
    await rescheduleMyBooking(b.id, b.pending_date, newStart, newEnd);
  }

  useEffect(() => {
    if (!searched || !phoneValid || !SUPABASE_ENABLED) { setLoyalty(null); return; }
    let cancelled = false;
    (async () => {
      setLoyaltyLoading(true);
      const res = await fetchCustomerLoyalty(phone);
      if (!cancelled) { setLoyalty(res); setLoyaltyLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [searched, phone, phoneValid]);

  const hasAnything = matches.length > 0 || loyalty?.found;

  return (
    <div className="fade-in">
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>داشبورد من</h2>

      {otpStep !== "verified" && (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            {otpStep === "phone"
              ? "برای مشاهدهٔ نوبت‌های خود، شماره موبایلتان را وارد کنید"
              : `کد تایید ارسال‌شده به ${toFa(phone)} را وارد کنید`}
          </p>

          {otpStep === "phone" && (
            <div className="flex gap-2">
              <input
                dir="ltr"
                type="tel" inputMode="tel" autoComplete="tel"
                value={phone}
                onChange={(e) => { setPhone(normalizeMobile(e.target.value)); setOtpError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && phoneValid && !otpRequesting) requestCode(); }}
                enterKeyHint="send"
                aria-label="شماره موبایل"
                placeholder="09xxxxxxxxx"
                className="tabular"
                style={{ flex: 1, padding: "11px 14px", fontSize: 14, textAlign: "left" }}
              />
              <button
                disabled={!phoneValid || otpRequesting}
                onClick={requestCode}
                className="tap"
                style={{ padding: "0 20px", fontSize: 13, fontWeight: 700, borderRadius: "var(--radius-md)", background: "var(--grad-tab-dash)", color: "white", boxShadow: "0 4px 14px -4px color-mix(in oklch, var(--color-tab-dash) 60%, transparent)" }}
              >
                {otpRequesting ? "..." : "دریافت کد"}
              </button>
            </div>
          )}

          {otpStep === "code" && devOtp && (
            <p className="badge mt-2" style={{ background: "var(--color-warning)", color: "oklch(16% 0.02 70)", display: "inline-flex" }}>
              حالت تست — کد بدون پیامک واقعی: {toFa(devOtp)}
            </p>
          )}

          {otpStep === "code" && (
            <div className="flex gap-2">
              <input
                dir="ltr"
                inputMode="numeric" autoComplete="one-time-code"
                value={otpCode}
                onChange={(e) => { setOtpCode(digitsOnly(e.target.value, 6)); setOtpError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && codeValid && !otpVerifying) verifyCode(); }}
                enterKeyHint="done"
                autoFocus
                aria-label="کد تایید"
                placeholder="۶ رقم"
                className="tabular"
                style={{ flex: 1, padding: "11px 14px", fontSize: 16, textAlign: "center", letterSpacing: "0.3em" }}
              />
              <button
                disabled={!codeValid || otpVerifying}
                onClick={verifyCode}
                className="tap"
                style={{ padding: "0 20px", fontSize: 13, fontWeight: 700, borderRadius: "var(--radius-md)", background: "var(--grad-tab-dash)", color: "white", boxShadow: "0 4px 14px -4px color-mix(in oklch, var(--color-tab-dash) 60%, transparent)" }}
              >
                {otpVerifying ? "..." : "تایید"}
              </button>
            </div>
          )}
          {otpStep === "code" && (
            <button
              className="tap ghost-btn mt-2"
              style={{ fontSize: 11.5, padding: "4px 8px" }}
              onClick={() => { setOtpStep("phone"); setOtpCode(""); setOtpError(""); setDevOtp(null); }}
            >
              تغییر شماره یا ارسال دوبارهٔ کد
            </button>
          )}
          {otpError && <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 8 }}>{otpError}</p>}
        </>
      )}

      {otpStep === "verified" && (
        <button
          className="tap ghost-btn mb-3"
          style={{ fontSize: 11.5, padding: "5px 10px" }}
          onClick={() => {
            revokeBookingToken(accessToken); // best-effort — don't block the UI reset on it
            setOtpStep("phone"); setOtpCode(""); setAccessToken(null); setMyBookings([]); setSearched(false); setPhone(""); setDevOtp(null);
          }}
        >
          خروج از این نشست
        </button>
      )}

      {searched && !hasAnything && (
        <div className="card fade-in mt-4" style={{ padding: 20, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>نوبتی با این شماره پیدا نشد</p>
        </div>
      )}

      {searched && hasAnything && (
        <div className="fade-in mt-4">
          {/* Hero welcome card — one clear, well-organized summary instead of
              scattered stats */}
          <div className="card card-glass mb-3" style={{ padding: 18, background: "var(--grad-tab-dash)" }}>
            <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
            <p className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 700, opacity: 0.9, position: "relative" }}>
              <LayoutDashboard size={15} />
              {loyalty?.name ? `سلام ${loyalty.name} عزیز 👋` : "داشبورد شما"}
            </p>
            {loyalty?.found ? (
              <>
                <div className="flex items-end gap-2 mt-3" style={{ position: "relative" }}>
                  <div className="tabular" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{toFa(loyalty.points)}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 5 }}>امتیاز باشگاه</div>
                </div>
                <div className="flex items-center gap-2 mt-2" style={{ position: "relative", flexWrap: "wrap" }}>
                  {loyalty.discount_percent > 0 && (
                    <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                      <Percent size={11} /> {toFa(loyalty.discount_percent)}٪ تخفیف فعال
                    </span>
                  )}
                  <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                    <CalendarCheck size={11} /> {toFa(matches.length)} نوبت
                  </span>
                  <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                    <UserPlus size={11} /> {toFa(loyalty.referrals?.length || 0)} معرفی
                  </span>
                </div>
                {loyalty.at_cap && (
                  <div className="flex items-center gap-1.5" style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "oklch(100% 0 0 / 0.18)", position: "relative" }}>
                    <Crown size={13} />
                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                      به سقف تخفیف ({toFa(loyalty.max_discount)}٪) رسیدید! دفعهٔ بعد از آرایشگر بخواید اعمالش کنه.
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between mt-3" style={{ position: "relative", paddingTop: 10, borderTop: "1px dashed oklch(100% 0 0 / 0.3)" }}>
                  <span style={{ fontSize: 11, opacity: 0.85 }}>کد معرفی شما</span>
                  <button
                    className="tap flex items-center gap-1"
                    style={{ fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}
                    onClick={() => { navigator.clipboard?.writeText(loyalty.referral_code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  >
                    <span dir="ltr">{loyalty.referral_code}</span>
                    <Copy size={12} />
                    {copied && <span style={{ fontSize: 9.5, opacity: 0.85 }}>· کپی شد</span>}
                  </button>
                </div>
              </>
            ) : (
              <p style={{ fontSize: 12, marginTop: 8, opacity: 0.9, position: "relative" }}>
                {loyaltyLoading ? "در حال بارگذاری..." : `${toFa(matches.length)} نوبت برای این شماره ثبت شده`}
              </p>
            )}
          </div>

          {/* Segment switcher */}
          <div className="flex gap-2 mb-3">
            {DASH_SEGMENTS.map((seg) => {
              const active = segment === seg.id;
              const count = seg.id === "bookings" ? matches.length : seg.id === "points" ? (loyalty?.history?.length || 0) : (loyalty?.referrals?.length || 0);
              return (
                <button
                  key={seg.id}
                  onClick={() => setSegment(seg.id)}
                  className="tap flex-1 flex flex-col items-center gap-1"
                  style={{
                    padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: active ? 800 : 700,
                    background: active ? seg.color : `color-mix(in oklch, ${seg.color} 10%, var(--color-surface))`,
                    color: active ? "white" : seg.color,
                    border: active ? "none" : `1px solid color-mix(in oklch, ${seg.color} 22%, transparent)`,
                    boxShadow: active ? `0 4px 12px -4px color-mix(in oklch, ${seg.color} 55%, transparent)` : "none",
                  }}
                >
                  <seg.Icon size={16} />
                  <span className="flex items-center gap-1">
                    {seg.label}
                    {count > 0 && <span className="tabular" style={{ opacity: 0.85 }}>({toFa(count)})</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Segment: bookings */}
          {segment === "bookings" && (
            <div className="flex flex-col gap-3">
              {matches.length === 0 ? (
                <div className="card" style={{ padding: 20, textAlign: "center" }}>
                  <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبتی ثبت نشده</p>
                </div>
              ) : matches.map((b) => {
                const service = services.find((s) => s.id === b.service_id);
                if (!service) return null;
                const hasDiscount = b.final_price != null && b.original_price > b.final_price;
                const isProposed = b.status === "reschedule_proposed";
                const changeable = ["pending", "confirmed", "rescheduled"].includes(b.status);
                return (
                  <div key={b.id} className="card fade-in" style={{ padding: 16 }}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 style={{ fontSize: 15 }}>{service.name}</h3>
                      <Badge status={b.status} />
                    </div>
                    <Row label="تاریخ" value={jalaliLabel(parseDateKey(b.date), { short: true })} />
                    <Row label="ساعت" value={formatClock(b.start_min)} />
                    {b.staff_name && <Row label="آرایشگر" value={b.staff_name} />}
                    <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
                    {b.final_price == null ? (
                      <Row label="مبلغ" value="قیمت در سالن اعلام می‌شود" bold />
                    ) : (
                      <>
                        {hasDiscount && <Row label="قیمت اصلی" value={formatToman(b.original_price)} strike />}
                        {hasDiscount && <Row label="تخفیف" value={"- " + formatToman(b.original_price - b.final_price)} />}
                        <Row label="مبلغ نهایی" value={formatToman(b.final_price)} bold />
                      </>
                    )}

                    {isProposed ? (
                      <div className="fade-in" style={{ marginTop: 14, padding: 12, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-warning) 12%, transparent)" }}>
                        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-warning)" }}>
                          <Clock size={14} /> آرایشگر پیشنهاد زمان جدید داده
                        </p>
                        <div className="flex items-center gap-2 mt-2" style={{ fontSize: 13 }}>
                          <span className="muted tabular" style={{ textDecoration: "line-through" }}>
                            {jalaliLabel(parseDateKey(b.date), { short: true })} - {formatClock(b.start_min)}
                          </span>
                          <ChevronLeft size={13} color="var(--color-muted)" />
                          <span className="tabular" style={{ fontWeight: 800, color: "var(--color-heading)" }}>
                            {jalaliLabel(parseDateKey(b.pending_date), { short: true })} - {formatClock(b.pending_start_min)}
                          </span>
                        </div>
                        <div className="flex gap-2 mt-3">
                          <button
                            className="tap accent-btn flex-1"
                            style={{ padding: 10, fontSize: 12.5 }}
                            onClick={() => acceptProposedReschedule(b)}
                          >
                            تایید تغییر
                          </button>
                          <button
                            className="tap ghost-btn flex-1"
                            style={{ padding: 10, fontSize: 12.5 }}
                            onClick={() => setActionFor({ id: b.id, type: "reschedule" })}
                          >
                            انتخاب زمان دیگر
                          </button>
                        </div>
                        <button
                          className="tap w-full mt-2"
                          style={{ padding: 9, fontSize: 12, fontWeight: 700, borderRadius: "var(--radius-md)", border: "1px solid var(--color-danger)", background: "transparent", color: "var(--color-danger)" }}
                          onClick={() => setActionFor({ id: b.id, type: "cancel" })}
                        >
                          لغو نوبت
                        </button>
                      </div>
                    ) : changeable ? (
                      <div className="flex gap-2 mt-4">
                        <button className="tap ghost-btn flex-1" style={{ padding: 11, fontSize: 13, fontWeight: 700 }} onClick={() => setActionFor({ id: b.id, type: "reschedule" })}>
                          تغییر زمان
                        </button>
                        <button
                          className="tap flex-1"
                          style={{ padding: 11, fontSize: 13, fontWeight: 700, borderRadius: "var(--radius-md)", border: "1px solid var(--color-danger)", background: "transparent", color: "var(--color-danger)" }}
                          onClick={() => setActionFor({ id: b.id, type: "cancel" })}
                        >
                          لغو نوبت
                        </button>
                      </div>
                    ) : (
                      <p className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: "center" }}>
                        این نوبت دیگر قابل تغییر یا لغو نیست
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Segment: points history */}
          {segment === "points" && (
            <div className="card fade-in" style={{ padding: 16 }}>
              {!loyalty?.history?.length ? (
                <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "10px 0" }}>هنوز تراکنشی ثبت نشده</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {loyalty.history.map((h, i) => {
                    const positive = h.delta >= 0;
                    return (
                      <div key={i} className="flex items-center gap-3" style={{ padding: "9px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                        <div
                          style={{
                            width: 32, height: 32, borderRadius: "var(--radius-md)", flexShrink: 0,
                            background: `color-mix(in oklch, ${positive ? "var(--color-success)" : "var(--color-danger)"} 16%, transparent)`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {positive ? <TrendingUp size={15} color="var(--color-success)" /> : <TrendingDown size={15} color="var(--color-danger)" />}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{LOYALTY_REASON_FA[h.reason] || h.reason || "—"}</div>
                          <div className="muted tabular" style={{ fontSize: 10.5 }}>{jalaliLabel(new Date(h.at), { short: true })}</div>
                        </div>
                        <span className="tabular" style={{ fontSize: 13.5, fontWeight: 800, color: positive ? "var(--color-success)" : "var(--color-danger)" }}>
                          {positive ? "+" : ""}{toFa(h.delta)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Segment: referral network — full name front and center for every member */}
          {segment === "referrals" && (
            <div className="card fade-in" style={{ padding: 16 }}>
              {!loyalty?.referrals?.length ? (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <p className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>هنوز کسی را معرفی نکرده‌اید</p>
                  <p className="muted" style={{ fontSize: 11, lineHeight: 1.8 }}>کد معرفی بالای صفحه را با دوستانتان در میان بگذارید</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {loyalty.referrals.map((r, i) => {
                    const fullName = r.name?.trim() || "بدون نام ثبت‌شده";
                    const initial = r.name?.trim()?.[0] || "?";
                    const avColor = avatarColorFor(r.phone || i);
                    return (
                      <div key={r.phone || i} className="flex items-center gap-3" style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                        <div
                          className="tabular"
                          style={{
                            width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
                            background: `color-mix(in oklch, ${avColor} 20%, transparent)`, color: avColor,
                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800,
                          }}
                        >
                          {initial}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>{fullName}</div>
                          <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 1 }}>
                            {toFa(r.total_visits || 0)} ویزیت
                            {r.joined_at && ` · عضو از ${jalaliLabel(new Date(r.joined_at), { short: true })}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {actionFor?.type === "cancel" && actionBooking && (
        <CancelModal
          booking={actionBooking}
          variant="customer"
          onClose={() => setActionFor(null)}
          onConfirm={() => { cancelMyBooking(actionBooking.id); setActionFor(null); }}
        />
      )}
      {actionFor?.type === "reschedule" && actionBooking && (
        <RescheduleModal
          booking={actionBooking}
          services={services}
          bookings={bookings}
          workingHours={workingHours}
          staffWorkingHours={staffWorkingHours}
          timeOff={timeOff}
          approvedDates={approvedDates}
          variant="customer"
          onClose={() => setActionFor(null)}
          onConfirm={(newStart, newDate) => {
            const svc = services.find((s) => s.id === actionBooking.service_id);
            rescheduleMyBooking(actionBooking.id, newDate, newStart, newStart + svc.duration_minutes);
            setActionFor(null);
          }}
        />
      )}
    </div>
  );
}
