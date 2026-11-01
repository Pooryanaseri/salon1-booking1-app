import { CalendarX } from "lucide-react";

/** Customer side when the salon is locked. */
export function ClosedNotice({ status }) {
  return (
    <div className="card fade-in" style={{ padding: 22, textAlign: "center", marginTop: 8 }} data-card="closed">
      <CalendarX size={34} color="var(--color-muted)" style={{ margin: "0 auto 10px" }} />
      <h2 style={{ fontSize: 17 }}>رزرو آنلاین موقتاً در دسترس نیست</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.9, marginTop: 6 }}>
        برای گرفتن نوبت لطفاً مستقیم با سالن تماس بگیرید.
      </p>
      {status?.demo && <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>نمونهٔ حالت «اشتراک تمام‌شده» در دمو</p>}
    </div>
  );
}
