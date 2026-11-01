import { Lock, AlertTriangle, Phone } from "lucide-react";
import { subscriptionNotice } from "../lib/growth";
import { PlanCard } from "./GrowthTools";
import { toFa } from "../lib/format";

/* v2.58 — subscription states in the UI. The server enforces the lock
   (no data, bookings, orders or SMS once locked); these screens explain it. */

/** Panel banner: N days left / renewal window / last day. */
export function SubscriptionBanner({ status, onRenew }) {
  const n = subscriptionNotice(status);
  if (!n) return null;
  const color = n.tone === "danger" ? "var(--color-danger)" : "var(--color-warning)";
  return (
    <div className="flex items-center gap-2 mb-3" role="status" data-card="sub-banner"
      style={{ padding: "8px 10px 8px 12px", borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${color} 12%, var(--color-surface))`, border: `1px solid color-mix(in oklch, ${color} 40%, transparent)` }}>
      <AlertTriangle size={15} color={color} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{n.text}</span>
      {onRenew && <button className="tap accent-btn" style={{ padding: "6px 12px", fontSize: 12, minHeight: 34 }} onClick={onRenew}>تمدید</button>}
    </div>
  );
}

function SupportLine({ phone }) {
  if (!phone) return null;
  return (
    <a href={`tel:${phone}`} className="flex items-center gap-1.5" style={{ fontSize: 12.5, marginTop: 8, color: "var(--color-accent-700)", fontWeight: 700 }}>
      <Phone size={13} /> پشتیبانی: <span className="tabular" dir="ltr">{toFa(phone)}</span>
    </a>
  );
}

/** Panel when the salon is locked: the manager can only renew. */
export function SubscriptionLock({ status, isManager, notify }) {
  return (
    <div className="fade-in" data-card="sub-lock">
      <div className="card mb-4" style={{ padding: 18, textAlign: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", margin: "0 auto 10px", display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))" }}>
          <Lock size={24} color="var(--color-danger)" />
        </div>
        <h2 style={{ fontSize: 18 }}>اشتراک سالن به پایان رسیده است</h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.9, marginTop: 6 }}>
          {isManager
            ? "تا تمدید اشتراک، پنل، رزرو آنلاین، فروشگاه و پیامک‌ها غیرفعال هستند. اطلاعات سالن محفوظ است و با پرداخت، همه چیز همان لحظه برمی‌گردد."
            : "تا وقتی مدیر سالن اشتراک را تمدید نکند، پنل در دسترس نیست. لطفاً به مدیر سالن اطلاع دهید."}
        </p>
        <SupportLine phone={status?.support_phone} />
      </div>
      {isManager && <PlanCard notify={notify} />}
    </div>
  );
}
