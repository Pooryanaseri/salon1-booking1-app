import { useState, useEffect, useMemo, useRef } from "react";
import { Sparkles, Phone, Check, Sun, Moon, ArrowRight, CheckCircle2, User, CalendarX, Users, Bell, Loader2, Info, CalendarPlus, LayoutDashboard } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { getSalonName } from "../lib/tenant";
import { fetchCustomerLoyalty, applyReferral } from "../lib/api";
import { WEEKDAYS_FA_FULL, toFa, normalizeMobile, formatToman, jalaliLabel, formatClock, hhmmToMin, dateKey } from "../lib/format";
import { CATEGORY_LABEL, KNOWN_CUSTOMER, SECTION_META, SERVICE_ICONS, discountAmountFor, finalPriceFor, fitsWithoutOverlap, hasPrice, isOccupied, occupiedEndFor, priceLabel, schemaDayOf, uid } from "../app/shared";
import { DateStrip, Row } from "../components/ui";

/* ============================================================
   Booking flow (customer) — gender section chosen first, each
   section then shows only its own services/categories.
   ============================================================ */
// Shown when a customer's chosen day has no open slots left — lets them leave a
// phone number instead of just turning them away. Staff see these in the panel.
export function WaitlistJoinCard({ onJoin, alreadyJoined }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const phoneValid = /^09\d{9}$/.test(phone);

  if (alreadyJoined || done) {
    return (
      <div className="card fade-in" style={{ padding: 18, textAlign: "center" }}>
        <CheckCircle2 size={20} color="var(--color-success)" style={{ margin: "0 auto 6px" }} />
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>در لیست انتظار این روز ثبت شدید</p>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>در صورت خالی شدن نوبت، سالن با شما تماس می‌گیرد</p>
      </div>
    );
  }

  return (
    <div className="card fade-in" style={{ padding: 16, textAlign: "center" }}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: open ? 10 : 0 }}>
        {open ? "شماره‌تان را برای اطلاع‌رسانی وارد کنید" : "می‌خواهید در صورت خالی شدن نوبت باخبر شوید؟"}
      </p>
      {!open ? (
        <button className="tap accent-btn flex items-center gap-1.5 mt-3" style={{ padding: "9px 16px", fontSize: 12.5, margin: "10px auto 0" }} onClick={() => setOpen(true)}>
          <Bell size={13} /> ثبت در لیست انتظار
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone}
            onChange={(e) => setPhone(normalizeMobile(e.target.value))}
            placeholder="09xxxxxxxxx" className="tabular"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, textAlign: "center" }}
          />
          <input
            value={name} onChange={(e) => setName(e.target.value)} placeholder="نام (اختیاری)"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, textAlign: "center" }}
          />
          <button
            disabled={!phoneValid}
            className="tap accent-btn w-full"
            style={{ padding: 11, fontSize: 13 }}
            onClick={() => { onJoin({ phone, name }); setDone(true); }}
          >
            ثبت درخواست
          </button>
        </div>
      )}
    </div>
  );
}

export const BOOKING_STEP_LABELS = { 2: "انتخاب خدمت", 3: "انتخاب آرایشگر", 4: "تاریخ و ساعت", 5: "اطلاعات تماس", 6: "تایید نهایی" };

// Groups a day's time slots so a long grid of 40+ buttons reads as three
// short, scannable rows instead of one wall of numbers.
export const DAY_PERIODS = [
  { id: "morning", label: "صبح", Icon: Sun, test: (t) => t < 12 * 60 },
  { id: "afternoon", label: "ظهر و بعدازظهر", Icon: Sun, test: (t) => t >= 12 * 60 && t < 17 * 60 },
  { id: "evening", label: "عصر و شب", Icon: Moon, test: (t) => t >= 17 * 60 },
];

// Builds a one-event .ics file — opens straight into the phone's calendar
// app (iOS/Android/Google/Outlook all accept it), so the customer gets the
// device's own reminder on top of the SMS one. Floating local time on
// purpose: salon and customer are always in the same timezone.
export function downloadBookingIcs({ title, date, startMin, endMin, description }) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (mins) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(Math.floor(mins / 60))}${pad(mins % 60)}00`;
  const esc = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//salon-booking//FA", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid()}@salon-booking`, `DTSTAMP:${dtstamp}`,
    `DTSTART:${stamp(startMin)}`, `DTEND:${stamp(endMin)}`,
    `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(description)}`, `LOCATION:${esc(getSalonName())}`,
    "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", `DESCRIPTION:${esc(title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "salon-booking.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BookingFlow({ services, stylists, bookings, workingHours, staffWorkingHours, timeOff, approvedDates, addBooking, waitlist, addWaitlistEntry, notify, onSectionChange, onTrack }) {
  const [step, setStep] = useState(1); // 1 gender, 2 service, 3 stylist, 4 date/time, 5 phone, 6 confirm, 7 done
  const [gender, setGender] = useState(null);
  const [category, setCategory] = useState("all");
  const [serviceId, setServiceId] = useState(null);
  const [staffId, setStaffId] = useState(null); // null = "فرقی ندارد"
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [phone, setPhone] = useState("");
  const [lookedUp, setLookedUp] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [knownCustomer, setKnownCustomer] = useState(false);
  const [knownCustomerName, setKnownCustomerName] = useState("");
  const [loyaltyDiscountPct, setLoyaltyDiscountPct] = useState(0);
  const [name, setName] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const sectionServices = services.filter((s) => s.is_active && s.gender === gender);
  const categories = ["all", ...Array.from(new Set(sectionServices.map((s) => s.category)))];
  const visibleServices = category === "all" ? sectionServices : sectionServices.filter((s) => s.category === category);
  const service = services.find((s) => s.id === serviceId);
  const section = gender ? SECTION_META[gender] : null;
  const sectionStaff = useMemo(() => stylists.filter((s) => s.active && s.gender === gender), [stylists, gender]);
  const selectedStaff = stylists.find((s) => s.id === staffId) || null;
  // Once a time is picked under "فرقی ندارد", this holds whichever stylist actually
  // got assigned to it — see the slot-click handler below.
  const [assignedStaffId, setAssignedStaffId] = useState(null);
  const effectiveStaff = selectedStaff || stylists.find((s) => s.id === assignedStaffId) || null;

  function whForId(stId, date) {
    const list = (stId && staffWorkingHours[stId]) || workingHours;
    return list.find((w) => w.day_of_week === schemaDayOf(date));
  }
  // Only a WHOLE-day record (no start/end time) closes the day entirely — a
  // partial-hour closure (e.g. "closed 14:00–16:00 for a break") leaves the
  // rest of the day bookable as normal, so it must NOT trip this check.
  function isTimeOffForId(stId, date) {
    return timeOff.some((t) => (!t.staff_id || t.staff_id === stId) && t.date === dateKey(date) && t.start_min == null);
  }
  function isApproved(date) {
    return approvedDates.includes(dateKey(date));
  }
  function unavailableReasonForId(stId, date) {
    const wh = whForId(stId, date);
    if (!wh || wh.is_closed) return "closed";
    if (isTimeOffForId(stId, date)) return "timeoff";
    if (!isApproved(date)) return "notApproved";
    return null;
  }
  function dayBookingsForId(stId, date) {
    const dKey = dateKey(date);
    // A booking awaiting customer confirmation of a proposed reschedule still
    // occupies its ORIGINAL slot until resolved — include it in the occupied set.
    const realBookings = bookings.filter(
      (b) => b.date === dKey && b.staff_id === stId && (b.status === "confirmed" || b.status === "pending" || b.status === "rescheduled" || b.status === "reschedule_proposed")
    );
    // Partial-hour closures block time exactly like a booking would — reuse
    // the same overlap-checking mechanics (fitsWithoutOverlap/isOccupied)
    // by representing each one as a phantom "booking" with no buffer.
    const partialClosures = timeOff
      .filter((t) => (!t.staff_id || t.staff_id === stId) && t.date === dKey && t.start_min != null)
      .map((t) => ({ start_min: t.start_min, end_min: t.end_min, buffer_minutes: 0 }));
    return [...realBookings, ...partialClosures];
  }
  // The same 15-min-grid + gap-closing-candidate logic used everywhere else,
  // scoped to one specific stylist's own calendar.
  function slotTicksForId(stId, date) {
    if (!service || unavailableReasonForId(stId, date)) return [];
    const wh = whForId(stId, date);
    const start = hhmmToMin(wh.start_time);
    const end = hhmmToMin(wh.end_time);
    const dayB = dayBookingsForId(stId, date);
    const dKey = dateKey(date);
    const isToday = dKey === dateKey(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const candidates = new Set();
    for (let t = start; t + service.duration_minutes <= end; t += 15) candidates.add(t);
    for (const b of dayB) {
      const freeAt = occupiedEndFor(b);
      if (freeAt >= start && freeAt + service.duration_minutes <= end) candidates.add(freeAt);
    }
    const out = [];
    for (const t of Array.from(candidates).sort((a, b) => a - b)) {
      if (isToday && t <= nowMin + 10) continue;
      out.push({ t, fits: fitsWithoutOverlap(t, service.duration_minutes, dayB, service.buffer_minutes || 0), dayCount: dayB.length });
    }
    return out;
  }

  // Backward-compatible aliases used by the date-strip / "closed today" messaging,
  // which still need a single yes/no per day — for "فرقی ندارد" a day only reads as
  // closed if it's closed for *every* stylist in the section, not just one.
  function whFor(date) { return whForId(staffId, date); }
  function unavailableReason(date) {
    if (staffId) return unavailableReasonForId(staffId, date);
    if (sectionStaff.length === 0) return "closed";
    return sectionStaff.every((st) => unavailableReasonForId(st.id, date)) ? unavailableReasonForId(sectionStaff[0].id, date) : null;
  }

  const days = useMemo(() => {
    const arr = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, []);

  const dayBookings = useMemo(() => dayBookingsForId(staffId, selectedDate), [bookings, selectedDate, staffId]);

  const slotTicks = useMemo(() => {
    if (!service) return [];

    // A specific stylist was chosen — their own calendar only, occupied/fits both shown.
    if (staffId) {
      if (unavailableReasonForId(staffId, selectedDate)) return [];
      return slotTicksForId(staffId, selectedDate).map(({ t, fits }) => ({ t, fits, occupied: isOccupied(t, dayBookings) }));
    }

    // "فرقی ندارد" — union across every active stylist in the section: a time is
    // offerable the moment AT LEAST ONE of them is actually free then, not only when
    // the whole section happens to be simultaneously free.
    if (sectionStaff.length === 0) return [];
    const merged = new Map(); // t -> { fits, availableStaffIds: [] }
    for (const st of sectionStaff) {
      for (const { t, fits, dayCount } of slotTicksForId(st.id, selectedDate)) {
        const entry = merged.get(t) || { t, fits: false, availableStaffIds: [] };
        if (fits) { entry.fits = true; entry.availableStaffIds.push({ id: st.id, dayCount }); }
        merged.set(t, entry);
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => a.t - b.t)
      .map((x) => ({ t: x.t, fits: x.fits, occupied: false, availableStaffIds: x.availableStaffIds }));
  }, [service, selectedDate, staffId, sectionStaff, dayBookings, workingHours, staffWorkingHours, timeOff, approvedDates, bookings]);

  const slots = useMemo(() => slotTicks.filter((x) => x.fits).map((x) => x.t), [slotTicks]);

  // Which of the next 30 days still have at least one bookable time for this
  // service/stylist — drives the "پر" marker on the date strip and the
  // jump to the nearest open day below.
  const dayHasFreeSlot = useMemo(() => {
    const map = {};
    if (!service) return map;
    const ids = staffId ? [staffId] : sectionStaff.map((st) => st.id);
    for (const d of days) {
      map[dateKey(d)] = ids.some((id) => slotTicksForId(id, d).some((x) => x.fits));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, staffId, sectionStaff, days, bookings, workingHours, staffWorkingHours, timeOff, approvedDates]);

  function nextOpenDay(after) {
    const afterKey = after ? after.getTime() : -Infinity;
    return days.find((d) => d.getTime() > afterKey && dayHasFreeSlot[dateKey(d)]) || null;
  }
  function pickDate(d) {
    setSelectedDate(d); setSelectedSlot(null); setAssignedStaffId(null);
  }

  // Landing on the time step used to always open on today — even when today
  // is a closed day or already full — leaving the customer to hunt for an
  // open date themselves. Jump straight to the nearest day with free time.
  useEffect(() => {
    if (step !== 4 || !service) return;
    if (dayHasFreeSlot[dateKey(selectedDate)]) return;
    const first = nextOpenDay(null);
    if (first) pickDate(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, staffId]);

  // Picking a time under "فرقی ندارد" must resolve to one real stylist right away —
  // otherwise the booking would be created with no one actually assigned to do it.
  // Ties go to whoever has fewer bookings that day, for a simple fairness spread.
  function selectSlot(t) {
    setSelectedSlot(t);
    if (staffId) { setAssignedStaffId(null); return; }
    const tick = slotTicks.find((x) => x.t === t);
    const candidates = tick?.availableStaffIds || [];
    if (candidates.length === 0) { setAssignedStaffId(null); return; }
    const best = [...candidates].sort((a, b) => a.dayCount - b.dayCount)[0];
    setAssignedStaffId(best.id);
  }

  // Real customer lookup — this used to just compare against a single
  // hardcoded demo phone number (KNOWN_CUSTOMER), meaning every actual
  // returning customer was always treated as brand new. Now it queries the
  // real customer_loyalty() RPC, same source of truth the "داشبورد من" tab
  // already uses, so a real returning customer is correctly recognized and
  // doesn't need to re-type their name on every booking.
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  async function lookupPhone() {
    setLookedUp(true);
    setLookingUp(true);
    if (SUPABASE_ENABLED) {
      const asked = phone;
      const res = await fetchCustomerLoyalty(phone).catch(() => null);
      // The number was edited while this was in flight — drop the stale answer.
      if (phoneRef.current !== asked) return;
      if (res?.found && res.name?.trim()) {
        setKnownCustomer(true);
        setKnownCustomerName(res.name.trim());
        setName(res.name.trim());
        setLoyaltyDiscountPct(res.discount_percent || 0);
      } else {
        setKnownCustomer(false);
        setKnownCustomerName("");
        setName("");
        setLoyaltyDiscountPct(0);
      }
    } else if (phone === KNOWN_CUSTOMER.phone) {
      setKnownCustomer(true);
      setKnownCustomerName(KNOWN_CUSTOMER.name);
      setName(KNOWN_CUSTOMER.name);
      setLoyaltyDiscountPct(0); // demo mode has no real loyalty_settings to compute a tier from
    } else {
      setKnownCustomer(false);
      setKnownCustomerName("");
      setName("");
      setLoyaltyDiscountPct(0);
    }
    setLookingUp(false);
  }

  const phoneValid = /^09\d{9}$/.test(phone);
  const canContinueContact = lookedUp && !lookingUp && phoneValid && (knownCustomer || !!name.trim());
  // Recognize returning customers as soon as the number is complete.
  useEffect(() => {
    if (step === 5 && phoneValid && !lookedUp && !lookingUp) lookupPhone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phone]);
  const discount = service ? discountAmountFor(service) : 0;
  // Loyalty discount stacks AFTER the service's own discount (applied to
  // the already-discounted price) — the common, customer-friendly pattern,
  // and keeps original_price/discount_type/discount_value/final_price
  // meaning exactly what they already mean (the service-level discount
  // only); the loyalty layer is tracked separately as loyalty_discount_pct/
  // loyalty_discount_amount so nothing about the existing columns changes.
  const servicePrice = service ? finalPriceFor(service) : 0;
  const loyaltyDiscountAmount = service && hasPrice(service) && servicePrice != null
    ? Math.round((servicePrice * loyaltyDiscountPct) / 100)
    : 0;
  const finalPrice = servicePrice != null ? Math.max(0, servicePrice - loyaltyDiscountAmount) : null;

  async function confirmBooking() {
    if (confirming) return;
    setConfirming(true);
    try {
      const finalStaffId = staffId || assignedStaffId || null;
      const booking = await addBooking(
        {
          serviceId: service.id,
          staffId: finalStaffId,
          date: dateKey(selectedDate),
          startMin: selectedSlot,
          endMin: selectedSlot + service.duration_minutes,
          bufferMinutes: service.buffer_minutes || 0,
          customerName: name.trim(),
          customerPhone: phone,
          customerGender: gender,
          // Demo-mode-only fields (ignored by create_public_booking in real
          // mode, which computes these itself) — kept so the demo flow still
          // shows a realistic price breakdown with no backend to compute it.
          originalPrice: service.price,
          discountType: service.discount_type,
          discountValue: service.discount_value,
          discountReason: [service.discount_reason, loyaltyDiscountAmount > 0 ? `${toFa(loyaltyDiscountPct)}٪ تخفیف باشگاه مشتریان` : ""].filter(Boolean).join(" · "),
          finalPrice,
        },
        !knownCustomer && referralCode.trim()
          ? async () => {
              const res = await applyReferral(phone, referralCode.trim());
              if (res.ok) notify("کد معرفی ثبت شد — بعد از اولین نوبت شما، پاداش معرف فعال می‌شود");
            }
          : null
      );
      if (!booking) return; // addBooking already notified the error
      // Not "SMS sent" — addBooking already reports that specifically (and
      // only on actual failure); this is the one thing that's always true
      // once we reach here: the booking itself is confirmed.
      setResult(booking);
      notify("نوبت شما ثبت شد");
      goTo(7);
    } catch (err) {
      console.error("[salon] confirmBooking failed unexpectedly:", err);
      notify("ثبت نوبت با خطا مواجه شد — لطفاً دوباره امتحان کنید");
    } finally {
      setConfirming(false);
    }
  }

  function resetState() {
    setStep(1); setGender(null); setServiceId(null); setStaffId(null); setSelectedSlot(null); setAssignedStaffId(null); setPhone(""); setLookedUp(false);
    setKnownCustomer(false); setKnownCustomerName(""); setLoyaltyDiscountPct(0);
    setName(""); setReferralCode(""); setResult(null); setCopied(false); setCategory("all");
    onSectionChange(null);
  }

  /* ---- navigation ---------------------------------------------------------
     The phone's back button (and browser back) used to leave the page
     entirely from the middle of a booking. Now one guard history entry is
     pushed when the flow starts; popping it steps back one screen (and
     re-arms the guard while there's still somewhere to go back to). */
  const stepRef = useRef(step);
  stepRef.current = step;
  const skipPopRef = useRef(false);
  const hasGuard = () => !!window.history.state?.salonBookingFlow;

  function applyBackStep(target) {
    if (target <= 1) { setServiceId(null); onSectionChange(null); }
    setStep(Math.max(1, target));
  }
  function goTo(n) {
    if (n >= 2 && !hasGuard()) window.history.pushState({ salonBookingFlow: true }, "");
    setStep(n);
  }
  function goBack() {
    const target = step - 1;
    if (target <= 1 && hasGuard()) { window.history.back(); return; } // popstate handler applies it
    applyBackStep(target);
  }
  function reset() {
    if (hasGuard()) { skipPopRef.current = true; window.history.back(); }
    resetState();
  }
  const onPopRef = useRef(null);
  onPopRef.current = () => {
    if (skipPopRef.current) { skipPopRef.current = false; return; }
    const cur = stepRef.current;
    if (cur <= 1) return;
    if (cur === 7) { resetState(); return; } // never step back into an already-submitted confirm screen
    const target = cur - 1;
    applyBackStep(target);
    if (target > 1) window.history.pushState({ salonBookingFlow: true }, "");
  };
  useEffect(() => {
    const handler = () => onPopRef.current?.();
    window.addEventListener("popstate", handler);
    return () => {
      window.removeEventListener("popstate", handler);
      // Leaving the booking tab mid-flow: drop the guard entry so the next
      // back press isn't silently swallowed.
      if (hasGuard()) window.history.back();
    };
  }, []);

  // Every new step starts at the top — otherwise picking a service near the
  // bottom of a long list lands the next screen already scrolled down.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return; }
    window.scrollTo({ top: 0 });
  }, [step]);

  return (
    <div className="fade-in">
      {step >= 2 && step <= 6 && (
        <div className="mb-4" role="progressbar" aria-valuemin={1} aria-valuemax={5} aria-valuenow={step - 1} aria-valuetext={`مرحله ${step - 1} از ۵ — ${BOOKING_STEP_LABELS[step]}`}>
          <div className="flex items-center justify-between mb-1.5" style={{ fontSize: 11.5 }}>
            <span style={{ fontWeight: 700, color: "var(--color-heading)" }}>{BOOKING_STEP_LABELS[step]}</span>
            <span className="muted tabular">مرحله {toFa(step - 1)} از {toFa(5)}</span>
          </div>
          <div className="flex items-center gap-1">
            {[2, 3, 4, 5, 6].map((n) => (
              <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: n <= step ? (section ? section.color : "var(--color-accent-500)") : "var(--color-border)", transition: "background var(--duration-base) var(--ease-standard)" }} />
            ))}
          </div>
        </div>
      )}

      {/* Step 1 — choose section (this is what makes the two salons feel like separate models) */}
      {step === 1 && (
        <div>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>بخش مورد نظر را انتخاب کنید</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{getSalonName()} دارای دو بخش مجزای زنانه و مردانه است</p>
          <div className="flex flex-col gap-3">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              const count = services.filter((s) => s.is_active && s.gender === g).length;
              return (
                <button
                  key={g}
                  onClick={() => { setGender(g); setCategory("all"); goTo(2); onSectionChange(g); }}
                  className="tap card"
                  style={{ padding: 18, display: "flex", alignItems: "center", gap: 14, textAlign: "right", borderColor: "var(--color-border)" }}
                >
                  <div style={{ width: 52, height: 52, borderRadius: "var(--radius-lg)", background: meta.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={26} color={meta.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--color-heading)" }}>{meta.label}</div>
                    <div className="muted tabular" style={{ fontSize: 12, marginTop: 2 }}>{toFa(count)} خدمت فعال</div>
                  </div>
                  <ArrowRight size={16} className="muted" style={{ transform: "rotate(180deg)" }} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2 — service selection, scoped to the chosen section */}
      {step === 2 && section && (
        <div>
          <button
            className="flex items-center gap-1.5 mb-3"
            style={{ fontSize: 12.5, fontWeight: 700, color: section.color }}
            onClick={goBack}
          >
            <section.Icon size={14} /> {section.label} <span className="muted" style={{ fontWeight: 400 }}>· تغییر بخش</span>
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب خدمت</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>خدمت مورد نظرتان را انتخاب کنید</p>

          {categories.length > 2 && (
            <div className="flex gap-2 scrollbar-none mb-3" style={{ overflowX: "auto", paddingBottom: 4 }}>
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className="tap"
                  style={{
                    flexShrink: 0, padding: "7px 14px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
                    border: `1px solid ${category === c ? section.color : "var(--color-border)"}`,
                    background: category === c ? section.color : "var(--color-surface)",
                    color: category === c ? "white" : "var(--color-body)",
                  }}
                >
                  {c === "all" ? "همه" : CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {visibleServices.map((s) => {
              const Icon = SERVICE_ICONS[s.category] || Sparkles;
              const dAmt = discountAmountFor(s);
              const fPrice = finalPriceFor(s);
              return (
                <button
                  key={s.id}
                  onClick={() => { setServiceId(s.id); setStaffId(null); goTo(3); }}
                  className="tap card"
                  style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right" }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: section.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={19} color={section.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>{s.name}</div>
                    <div className="muted tabular" style={{ fontSize: 12, marginTop: 2 }}>
                      {toFa(s.duration_minutes)} دقیقه
                      {!hasPrice(s) ? (
                        <> · {priceLabel(s)}</>
                      ) : dAmt > 0 ? (
                        <>
                          {" · "}<span style={{ textDecoration: "line-through" }}>{formatToman(s.price)}</span>{" "}
                          <span style={{ color: "var(--color-danger)", fontWeight: 700 }}>{formatToman(fPrice)}</span>
                        </>
                      ) : (
                        <> · {formatToman(s.price)}</>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {visibleServices.length === 0 && (
              <div className="card" style={{ padding: 20, textAlign: "center" }}>
                <p className="muted" style={{ fontSize: 13 }}>خدمتی در این دسته یافت نشد</p>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 3 && service && section && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={goBack}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب آرایشگر</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{service.name} · می‌توانید آرایشگر دلخواه‌تان را انتخاب کنید</p>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => { setStaffId(null); setSelectedSlot(null); setAssignedStaffId(null); goTo(4); }}
              className="tap card"
              style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right", borderColor: staffId === null ? section.color : "var(--color-border)" }}
            >
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--color-surface-raised)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Users size={18} color="var(--color-muted)" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>فرقی ندارد</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>بهترین زمان خالی بین همهٔ آرایشگرهای این بخش را نشان می‌دهیم؛ پس از انتخاب ساعت، آرایشگر به‌طور خودکار تعیین می‌شود</div>
              </div>
            </button>

            {sectionStaff.map((st) => (
              <button
                key={st.id}
                onClick={() => { setStaffId(st.id); setSelectedSlot(null); setAssignedStaffId(null); goTo(4); }}
                className="tap card"
                style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right", borderColor: staffId === st.id ? section.color : "var(--color-border)" }}
              >
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: section.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <User size={18} color={section.color} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>{st.name}</div>
                </div>
              </button>
            ))}

            {sectionStaff.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "8px 0" }}>
                هنوز آرایشگری برای این بخش ثبت نشده — می‌توانید ادامه دهید
              </p>
            )}
          </div>
        </div>
      )}

      {step === 4 && service && section && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={goBack}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب تاریخ و ساعت</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            {service.name} · {toFa(service.duration_minutes)} دقیقه{selectedStaff ? ` · ${selectedStaff.name}` : ""}
          </p>

          <DateStrip
            days={days}
            selectedDate={selectedDate}
            onSelect={pickDate}
            isClosedFn={(d) => !!unavailableReason(d)}
            reasonFn={unavailableReason}
            isFullFn={(d) => !dayHasFreeSlot[dateKey(d)]}
            accentColor={section.color}
          />

          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)", margin: "16px 0 8px" }}>
            {jalaliLabel(selectedDate)}
          </p>

          {slots.length === 0 && (() => {
            const reason = unavailableReason(selectedDate);
            const next = nextOpenDay(selectedDate);
            const isTodaySel = dateKey(selectedDate) === dateKey(new Date());
            return (
              <div className="card fade-in mb-3" style={{ padding: 20, textAlign: "center" }}>
                <CalendarX size={22} color="var(--color-muted)" style={{ margin: "0 auto 8px" }} />
                <p className="muted" style={{ fontSize: 13 }}>
                  {reason === "timeoff"
                    ? "سالن در این روز تعطیل موقت است"
                    : reason === "notApproved"
                    ? "این روز هنوز توسط سالن برای رزرو باز نشده است"
                    : reason === "closed"
                    ? "سالن در این روز تعطیل است"
                    : isTodaySel
                    ? "زمان خالی برای امروز باقی نمانده"
                    : "همهٔ زمان‌های این روز رزرو شده است"}
                </p>
                {next && (
                  <button
                    className="tap ghost-btn mt-3"
                    style={{ padding: "8px 16px", fontSize: 12.5, fontWeight: 700, color: section.color, borderColor: section.color }}
                    onClick={() => pickDate(next)}
                  >
                    نزدیک‌ترین روز خالی: {jalaliLabel(next, { short: true })} ({WEEKDAYS_FA_FULL[next.getDay()]})
                  </button>
                )}
              </div>
            );
          })()}

          {slots.length === 0 && !unavailableReason(selectedDate) && (
            <WaitlistJoinCard
              key={dateKey(selectedDate)}
              alreadyJoined={waitlist.some(
                (w) => w.date === dateKey(selectedDate) && w.service_id === service.id && (w.staff_id || null) === (staffId || null)
              )}
              onJoin={({ phone, name }) => {
                addWaitlistEntry({
                  id: uid(),
                  customer_name: name.trim(),
                  customer_phone: phone,
                  customer_gender: gender,
                  service_id: service.id,
                  staff_id: staffId,
                  staff_name: selectedStaff ? selectedStaff.name : "",
                  date: dateKey(selectedDate),
                  created_at: Date.now(),
                });
              }}
            />
          )}

          {slots.length > 0 && (
            <>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-danger)", opacity: 0.5, display: "inline-block" }} /> رزرو شده
                </span>
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-border)", display: "inline-block" }} /> زمان کافی نیست
                </span>
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: section.color, display: "inline-block" }} /> زمان انتخابی شما
                </span>
              </div>
              {DAY_PERIODS.map((period) => {
                const ticks = slotTicks.filter(({ t }) => period.test(t));
                if (ticks.length === 0) return null;
                const freeCount = ticks.filter((x) => x.fits).length;
                return (
                  <div key={period.id} className="mb-3">
                    <div className="flex items-center justify-between mb-2" style={{ fontSize: 12 }}>
                      <span className="flex items-center gap-1.5" style={{ fontWeight: 700, color: "var(--color-heading)" }}>
                        <period.Icon size={13} color={section.color} /> {period.label}
                      </span>
                      <span className="muted tabular" style={{ fontSize: 11 }}>
                        {freeCount > 0 ? `${toFa(freeCount)} زمان خالی` : "پر"}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                      {ticks.map(({ t, occupied, fits }) => (
                        <button
                          key={t}
                          disabled={!fits}
                          title={occupied ? "این زمان رزرو شده است" : !fits ? "زمان کافی برای این خدمت باقی نمانده" : undefined}
                          aria-pressed={selectedSlot === t}
                          onClick={() => selectSlot(t)}
                          className="tap tabular"
                          style={{
                            padding: "10px 2px", borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                            border: `1px solid ${occupied ? "var(--color-danger)" : !fits ? "var(--color-border)" : selectedSlot === t ? section.color : "var(--color-border)"}`,
                            background: occupied
                              ? "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))"
                              : !fits ? "var(--color-surface-raised)"
                              : selectedSlot === t ? section.color : "var(--color-surface)",
                            color: occupied ? "var(--color-danger)" : !fits ? "var(--color-muted)" : selectedSlot === t ? "white" : "var(--color-body)",
                            textDecoration: occupied ? "line-through" : "none",
                            opacity: !fits ? (occupied ? 0.8 : 0.55) : 1,
                            cursor: !fits ? "not-allowed" : "pointer",
                          }}
                        >
                          {formatClock(t)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {selectedSlot != null && (
            <p className="muted tabular fade-in" style={{ fontSize: 12, marginTop: 10 }}>
              پایان تقریبی: {formatClock(selectedSlot + service.duration_minutes)}
            </p>
          )}

          {selectedSlot != null && !staffId && effectiveStaff && (
            <div className="fade-in flex items-center gap-2" style={{ marginTop: 10, padding: "10px 12px", borderRadius: "var(--radius-md)", background: section.tint }}>
              <User size={15} color={section.color} />
              <span style={{ fontSize: 12.5, color: "var(--color-heading)" }}>
                در این ساعت، <b>{effectiveStaff.name}</b> برای شما در دسترس است
              </span>
            </div>
          )}
          {selectedSlot != null && !staffId && !effectiveStaff && (
            <p className="fade-in muted" style={{ fontSize: 11.5, marginTop: 10 }}>
              آرایشگر شما هنگام تایید نهایی مشخص می‌شود
            </p>
          )}

          <div className="sticky-cta mt-5">
            <button disabled={selectedSlot == null} onClick={() => goTo(5)} className="tap accent-btn w-full" style={{ padding: "13px" }}>
              {selectedSlot == null
                ? "یک ساعت را انتخاب کنید"
                : `ادامه — ${jalaliLabel(selectedDate, { short: true })}، ساعت ${formatClock(selectedSlot)}`}
            </button>
          </div>
        </div>
      )}

      {step === 5 && service && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={goBack}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>شماره تماس</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>پیامک تایید و یادآوری نوبت به این شماره ارسال می‌شود</p>

          <form
            onSubmit={(e) => { e.preventDefault(); if (canContinueContact) goTo(6); }}
            noValidate
          >
          <label htmlFor="booking-phone" className="muted" style={{ fontSize: 12 }}>شماره موبایل</label>
          <div style={{ position: "relative", marginTop: 4 }}>
            <input
              id="booking-phone"
              dir="ltr"
              type="tel" inputMode="tel" autoComplete="tel"
              enterKeyHint="next"
              autoFocus
              value={phone}
              onChange={(e) => { setPhone(normalizeMobile(e.target.value)); setLookedUp(false); setLookingUp(false); setKnownCustomer(false); setKnownCustomerName(""); }}
              placeholder="09xxxxxxxxx"
              className="tabular"
              aria-invalid={phone.length === 11 && !phoneValid}
              style={{ width: "100%", padding: "11px 14px 11px 40px", fontSize: 14, textAlign: "left" }}
            />
            {/* Lookup now runs on its own the moment the number is complete —
                no separate "بررسی" tap needed. */}
            <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", display: "flex" }} aria-hidden="true">
              {lookingUp ? <Loader2 size={16} className="salon-spin" color="var(--color-muted)" />
                : lookedUp && phoneValid ? <CheckCircle2 size={16} color="var(--color-success)" /> : null}
            </span>
          </div>
          {phone.length > 0 && !phoneValid && (
            <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 6 }}>
              {phone.length === 11 || !phone.startsWith("09")
                ? "شماره باید با ۰۹ شروع شود و ۱۱ رقم باشد"
                : `${toFa(11 - phone.length)} رقم دیگر`}
            </p>
          )}

          {lookedUp && knownCustomer && (
            <div className="card fade-in mt-3" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <User size={18} color="var(--color-accent-500)" />
              <p style={{ fontSize: 13 }}>خوش برگشتید، <b style={{ color: "var(--color-heading)" }}>{knownCustomerName}</b> عزیز</p>
            </div>
          )}

          {lookedUp && !knownCustomer && phoneValid && (
            <div className="fade-in mt-3 flex flex-col gap-3">
              <div>
                <label htmlFor="booking-name" className="muted" style={{ fontSize: 12 }}>نام و نام‌خانوادگی</label>
                <input id="booking-name" autoComplete="name" enterKeyHint="next" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً مریم کریمی" style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 }} />
              </div>
              <div>
                <label htmlFor="booking-referral" className="muted" style={{ fontSize: 12 }}>کد معرفی (اختیاری)</label>
                <input
                  id="booking-referral" autoComplete="off" autoCapitalize="characters" enterKeyHint="done"
                  dir="ltr" value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  placeholder="مثلاً A1B2C3" className="tabular"
                  style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4, textAlign: "left" }}
                />
              </div>
            </div>
          )}

          <div className="sticky-cta mt-5">
            <button
              type="submit"
              disabled={!canContinueContact}
              className="tap accent-btn w-full"
              style={{ padding: "13px" }}
            >
              ادامه
            </button>
          </div>
          </form>
        </div>
      )}

      {step === 6 && service && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={goBack}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 14 }}>تایید نهایی</h2>

          <div className="card" style={{ padding: 16 }}>
            <Row label="بخش" value={section.label} />
            <Row label="خدمت" value={service.name} />
            {effectiveStaff && <Row label="آرایشگر" value={effectiveStaff.name} />}
            <Row label="تاریخ" value={jalaliLabel(selectedDate, { short: true })} />
            <Row label="ساعت" value={formatClock(selectedSlot)} />
            <Row label="مشتری" value={knownCustomer ? knownCustomerName : name} />
            <Row label="شماره تماس" value={<span dir="ltr">{toFa(phone)}</span>} />
            <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
            {!hasPrice(service) && <Row label="مبلغ" value={priceLabel(service)} bold />}
            {hasPrice(service) && (discount > 0 || loyaltyDiscountAmount > 0) && <Row label="قیمت اصلی" value={formatToman(service.price)} strike />}
            {hasPrice(service) && discount > 0 && <Row label="تخفیف" value={"- " + formatToman(discount)} />}
            {hasPrice(service) && loyaltyDiscountAmount > 0 && (
              <Row label={`تخفیف باشگاه مشتریان (${toFa(loyaltyDiscountPct)}٪)`} value={"- " + formatToman(loyaltyDiscountAmount)} />
            )}
            {hasPrice(service) && <Row label="مبلغ نهایی" value={formatToman(finalPrice)} bold />}
          </div>

          <p className="muted flex items-center gap-1.5 mt-3" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            <Info size={13} style={{ flexShrink: 0 }} />
            تا قبل از نوبت می‌توانید از تب «داشبورد من» آن را لغو یا جابه‌جا کنید.
          </p>

          <div className="sticky-cta mt-5">
            <button onClick={confirmBooking} disabled={confirming} className="tap accent-btn w-full flex items-center justify-center gap-1.5" style={{ padding: "13px" }}>
              {confirming && <Loader2 size={15} className="salon-spin" />}
              {confirming ? "در حال ثبت..." : "ثبت نهایی نوبت"}
            </button>
          </div>
        </div>
      )}

      {step === 7 && result && (
        <div className="fade-in" style={{ textAlign: "center", paddingTop: 12 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "color-mix(in oklch, var(--color-success) 18%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <Check size={30} color="var(--color-success)" />
          </div>
          <h2 style={{ fontSize: 18 }}>نوبت شما ثبت شد</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>پیامک تایید ارسال شد</p>

          <div className="card mt-4" style={{ padding: 16, textAlign: "right" }}>
            <Row label="خدمت" value={service.name} />
            {result.staff_name && <Row label="آرایشگر" value={result.staff_name} />}
            <Row label="تاریخ" value={jalaliLabel(selectedDate, { short: true })} />
            <Row label="ساعت" value={formatClock(selectedSlot)} />
            <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
            {result.final_price == null ? (
              <Row label="مبلغ" value="قیمت در سالن اعلام می‌شود" bold />
            ) : (
              <>
                {result.original_price > result.final_price && (
                  <>
                    <Row label="قیمت اصلی" value={formatToman(result.original_price)} strike />
                    <Row label="تخفیف" value={"- " + formatToman(result.original_price - result.final_price)} />
                  </>
                )}
                <Row label="مبلغ نهایی" value={formatToman(result.final_price)} bold />
              </>
            )}
          </div>

          <div className="card mt-3" style={{ padding: 14, background: "var(--color-surface-raised)", border: "1px dashed var(--color-accent-500)", textAlign: "center" }}>
            <Phone size={16} color="var(--color-accent-700)" style={{ margin: "0 auto 6px" }} />
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>برای پیگیری نوبت</p>
            <p className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.8 }}>
              کافی است در تب «داشبورد من»، همین شماره موبایل (<span dir="ltr" className="tabular">{toFa(phone)}</span>) را وارد کنید
            </p>
          </div>

          <div className="flex gap-2 mt-5">
            <button
              onClick={() => downloadBookingIcs({
                title: `${service.name} — ${getSalonName()}`,
                date: selectedDate,
                startMin: selectedSlot,
                endMin: selectedSlot + service.duration_minutes,
                description: result.staff_name ? `آرایشگر: ${result.staff_name}` : "",
              })}
              className="tap ghost-btn flex-1 flex items-center justify-center gap-1.5"
              style={{ padding: "11px 8px", fontSize: 13, fontWeight: 700 }}
            >
              <CalendarPlus size={15} /> افزودن به تقویم
            </button>
            {onTrack && (
              <button
                onClick={() => onTrack(phone)}
                className="tap ghost-btn flex-1 flex items-center justify-center gap-1.5"
                style={{ padding: "11px 8px", fontSize: 13, fontWeight: 700 }}
              >
                <LayoutDashboard size={15} /> پیگیری نوبت
              </button>
            )}
          </div>

          <button onClick={reset} className="tap accent-btn w-full mt-3" style={{ padding: "12px", fontWeight: 700 }}>
            رزرو نوبت جدید
          </button>
        </div>
      )}
    </div>
  );
}
