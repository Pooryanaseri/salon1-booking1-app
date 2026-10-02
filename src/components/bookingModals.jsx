import { useState, useMemo } from "react";
import { jalaliLabel, formatClock, hhmmToMin, dateKey, parseDateKey } from "../lib/format";
import { DateStrip, Modal } from "./ui";
import { fitsWithoutOverlap, isOccupied, occupiedEndFor, schemaDayOf } from "../app/shared";

// Shown when marking a booking "انجام شد" (completed) if the customer has a
// referrer on file. The referrer's reward is only awarded once staff
// explicitly confirms here that this is a genuinely new customer — closing
// the fraud path where a fake "new customer" booking could farm referral
// points with no real visit involved.
export function ReferralVerifyModal({ booking, onClose, onConfirm }) {
  const [checked, setChecked] = useState(false);
  return (
    <Modal title="تایید مشتری معرفی‌شده" onClose={onClose}>
      <p style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 14 }}>
        <b>{booking.customer_name}</b> با یک کد معرفی ثبت‌نام کرده. امتیاز معرف و امتیاز خودِ {booking.customer_name} هر دو فقط با تایید شما ثبت می‌شوند.
      </p>
      <label className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 18, height: 18 }} />
        تایید می‌کنم این فرد مشتری کاملاً جدید است
      </label>
      <div className="flex gap-2 mt-4">
        <button className="tap ghost-btn flex-1" style={{ padding: 11 }} onClick={() => onConfirm(false)}>
          بدون تایید ثبت شود
        </button>
        <button disabled={!checked} className="tap accent-btn flex-1" style={{ padding: 11 }} onClick={() => onConfirm(true)}>
          تایید و ثبت
        </button>
      </div>
    </Modal>
  );
}

export function CancelModal({ booking, onClose, onConfirm, variant = "staff" }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal title="لغو نوبت" onClose={onClose} danger>
      <p style={{ fontSize: 13.5, marginBottom: 14 }}>
        {variant === "customer" ? (
          <>
            نوبت شما در تاریخ <b className="tabular">{jalaliLabel(parseDateKey(booking.date), { short: true })}</b> ساعت{" "}
            <b className="tabular">{formatClock(booking.start_min)}</b> لغو می‌شود. برای رزرو نوبت جدید می‌توانید از تب «نوبت‌دهی» استفاده کنید.
          </>
        ) : (
          <>
            نوبت <b>{booking.customer_name}</b> ساعت <span className="tabular">{formatClock(booking.start_min)}</span> لغو می‌شود و پیامک اطلاع‌رسانی همراه با لینک رزرو مجدد برای مشتری ارسال خواهد شد.
          </>
        )}
      </p>
      <label className="flex items-center gap-2" style={{ fontSize: 13, marginBottom: 16 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 16, height: 16 }} />
        متوجه شدم و تایید می‌کنم
      </label>
      <div className="flex gap-2">
        <button className="tap ghost-btn flex-1" style={{ padding: 12, fontWeight: 700 }} onClick={onClose}>بازگشت</button>
        <button
          disabled={!confirmed}
          className="tap flex-1"
          style={{ padding: 12, fontWeight: 700, borderRadius: "var(--radius-md)", background: "var(--color-danger)", color: "white", opacity: confirmed ? 1 : 0.5 }}
          onClick={onConfirm}
        >
          بله، لغو کن
        </button>
      </div>
    </Modal>
  );
}

export function RescheduleModal({ booking, services, bookings, workingHours, staffWorkingHours, timeOff, approvedDates, onClose, onConfirm, variant = "staff" }) {
  const service = services.find((s) => s.id === booking.service_id);
  const [date, setDate] = useState(() => parseDateKey(booking.date));
  const [slot, setSlot] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // Same stylist-aware resolution as the booking flow: a stylist's personal override wins,
  // otherwise fall back to the salon default; time off is combined salon-wide + personal.
  const effectiveWorkingHours = (booking.staff_id && staffWorkingHours && staffWorkingHours[booking.staff_id]) || workingHours;
  const effectiveTimeOff = (timeOff || []).filter((t) => !t.staff_id || t.staff_id === booking.staff_id);

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

  function whFor(d) {
    if (effectiveWorkingHours) return effectiveWorkingHours.find((w) => w.day_of_week === schemaDayOf(d));
    return { start_time: "09:00", end_time: "21:00", is_closed: d.getDay() === 5 };
  }
  // Only a whole-day record (no start/end time) closes the day entirely —
  // a partial-hour closure leaves the rest of the day bookable as normal.
  function isTimeOff(d) {
    return effectiveTimeOff.some((t) => t.date === dateKey(d) && t.start_min == null);
  }
  // Staff can move a booking into any open working day at their own discretion; a customer
  // rescheduling their own appointment is still bound by whatever the salon has released.
  function isApproved(d) {
    if (!approvedDates) return true;
    return approvedDates.includes(dateKey(d));
  }
  function unavailableReason(d) {
    const wh = whFor(d);
    if (!wh || wh.is_closed) return "closed";
    if (isTimeOff(d)) return "timeoff";
    if (variant === "customer" && !isApproved(d)) return "notApproved";
    return null;
  }

  const dayBookings = useMemo(() => {
    const dKey = dateKey(date);
    const sameDay = bookings.filter((b) => b.date === dKey && b.id !== booking.id && (b.status === "confirmed" || b.status === "pending" || b.status === "rescheduled" || b.status === "reschedule_proposed"));
    const scoped = booking.staff_id
      ? sameDay.filter((b) => b.staff_id === booking.staff_id)
      : sameDay.filter((b) => b.customer_gender === booking.customer_gender);
    // Partial-hour closures block time exactly like a booking would — reuse
    // the same overlap-checking mechanics by representing each one as a
    // phantom "booking" with no buffer.
    const partialClosures = effectiveTimeOff
      .filter((t) => t.date === dKey && t.start_min != null)
      .map((t) => ({ start_min: t.start_min, end_min: t.end_min, buffer_minutes: 0 }));
    return [...scoped, ...partialClosures];
  }, [date, bookings, booking.id, booking.staff_id, booking.customer_gender, effectiveTimeOff]);

  const wh = whFor(date);
  const whClosed = !!unavailableReason(date);

  const slotTicks = useMemo(() => {
    if (whClosed) return [];
    const start = hhmmToMin(wh.start_time);
    const end = hhmmToMin(wh.end_time);
    const dKey = dateKey(date);
    const isToday = dKey === dateKey(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

    const candidates = new Set();
    for (let t = start; t + service.duration_minutes <= end; t += 15) candidates.add(t);
    for (const b of dayBookings) {
      const freeAt = occupiedEndFor(b);
      if (freeAt >= start && freeAt + service.duration_minutes <= end) candidates.add(freeAt);
    }

    const out = [];
    for (const t of Array.from(candidates).sort((a, b) => a - b)) {
      if (isToday && t <= nowMin + 10) continue;
      const occupied = isOccupied(t, dayBookings);
      const fits = fitsWithoutOverlap(t, service.duration_minutes, dayBookings, service.buffer_minutes || 0);
      out.push({ t, occupied, fits });
    }
    return out;
  }, [whClosed, wh, date, dayBookings, service]);

  const slots = useMemo(() => slotTicks.filter((x) => x.fits).map((x) => x.t), [slotTicks]);

  if (confirming) {
    return (
      <Modal title="تایید جابه‌جایی" onClose={onClose}>
        <p style={{ fontSize: 13.5, marginBottom: 16 }}>
          {variant === "customer" ? (
            <>
              نوبت شما از ساعت <span className="tabular">{formatClock(booking.start_min)}</span> به{" "}
              <b className="tabular">{jalaliLabel(date, { short: true })} ساعت {formatClock(slot)}</b> منتقل شود؟
            </>
          ) : (
            <>
              پیشنهاد جابه‌جایی نوبت <b>{booking.customer_name}</b> از <span className="tabular">{formatClock(booking.start_min)}</span> به{" "}
              <b className="tabular">{jalaliLabel(date, { short: true })} ساعت {formatClock(slot)}</b> برای مشتری ارسال شود؟ نوبت واقعاً تغییر نمی‌کند تا وقتی مشتری تایید کند.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button className="tap ghost-btn flex-1" style={{ padding: 12, fontWeight: 700 }} onClick={() => setConfirming(false)}>بازگشت</button>
          <button className="tap accent-btn flex-1" style={{ padding: 12 }} onClick={() => onConfirm(slot, dateKey(date))}>
            {variant === "customer" ? "بله، ثبت شود" : "بله، پیشنهاد ارسال شود"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="تغییر زمان نوبت" onClose={onClose}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        {variant === "customer" ? service.name : <>{booking.customer_name} · {service.name}</>}
        {booking.staff_name ? ` · ${booking.staff_name}` : ""}
      </p>
      <DateStrip
        days={days}
        selectedDate={date}
        onSelect={(d) => { setDate(d); setSlot(null); }}
        isClosedFn={(d) => !!unavailableReason(d)}
        reasonFn={unavailableReason}
        compact
      />

      {!whClosed && dayBookings.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-danger)", display: "inline-block", marginLeft: 5, verticalAlign: -1 }} />
          زمان‌های خط‌خورده در این روز قبلاً رزرو شده‌اند
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 12, maxHeight: 220, overflowY: "auto" }}>
        {whClosed && (
          <p className="muted" style={{ fontSize: 12.5, gridColumn: "1/-1" }}>
            {unavailableReason(date) === "timeoff"
              ? "سالن در این روز تعطیل موقت است"
              : unavailableReason(date) === "notApproved"
              ? "این روز هنوز توسط سالن برای رزرو باز نشده است"
              : "سالن در این روز تعطیل است"}
          </p>
        )}
        {!whClosed && slotTicks.length === 0 && <p className="muted" style={{ fontSize: 12.5, gridColumn: "1/-1" }}>زمانی برای این روز باقی نمانده</p>}
        {slotTicks.map(({ t, occupied, fits }) => (
          <button
            key={t}
            disabled={!fits}
            title={occupied ? "این زمان رزرو شده است" : !fits ? "زمان کافی برای این خدمت باقی نمانده" : undefined}
            onClick={() => setSlot(t)}
            className="tap tabular"
            style={{
              padding: "8px 2px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
              border: `1px solid ${occupied ? "var(--color-danger)" : !fits ? "var(--color-border)" : slot === t ? "var(--color-accent-500)" : "var(--color-border)"}`,
              background: occupied
                ? "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))"
                : !fits ? "var(--color-surface-raised)"
                : slot === t ? "var(--color-accent-500)" : "var(--color-surface)",
              color: occupied ? "var(--color-danger)" : !fits ? "var(--color-muted)" : slot === t ? "oklch(16% 0.02 70)" : "var(--color-body)",
              textDecoration: occupied ? "line-through" : "none",
              opacity: !fits ? (occupied ? 0.8 : 0.55) : 1,
              cursor: !fits ? "not-allowed" : "pointer",
            }}
          >
            {formatClock(t)}
          </button>
        ))}
      </div>

      <button disabled={slot == null} className="tap accent-btn w-full mt-4" style={{ padding: 12 }} onClick={() => setConfirming(true)}>
        ادامه
      </button>
    </Modal>
  );
}
