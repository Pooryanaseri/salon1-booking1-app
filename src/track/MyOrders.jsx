import { useState } from "react";
import { ShoppingBag, Loader2 } from "lucide-react";
import { formatToman, toFa } from "../lib/format";
import { startOrderPayment } from "../lib/api";
import { cancelMyOrder, ORDER_STATUS } from "../lib/shop";

/* v2.48 — the customer's shop orders in "داشبورد من". */
export function MyOrders({ orders, token, onChanged, notify }) {
  const [busy, setBusy] = useState(null);
  async function cancel(o) {
    if (!window.confirm(`سفارش ${toFa(o.code)} لغو شود؟`)) return;
    setBusy(o.id);
    const res = await cancelMyOrder(token, o.id);
    setBusy(null);
    notify(res?.ok ? "سفارش لغو شد" : res?.error || "لغو ناموفق بود");
    onChanged();
  }
  async function pay(o) {
    setBusy(o.id);
    const res = await startOrderPayment(o.id);
    if (res?.ok && res.url) { window.location.assign(res.url); return; }
    setBusy(null);
    notify(res?.error || "اتصال به درگاه پرداخت ناموفق بود");
    onChanged();
  }
  return (
    <div className="card fade-in mt-4" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5 mb-2" style={{ fontSize: 13.5, fontWeight: 800, color: "var(--color-heading)" }}>
        <ShoppingBag size={15} /> سفارش‌های فروشگاه
      </p>
      <div className="flex flex-col gap-2">
        {orders.map((o) => {
          const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
          return (
            <div key={o.id} data-order={o.code} style={{ padding: "10px 0", borderTop: "1px dashed var(--color-border)" }}>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular" style={{ fontWeight: 700, fontSize: 13.5 }}>سفارش {toFa(o.code)}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color, whiteSpace: "nowrap" }}>{st.label}</span>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.8 }}>
                {(o.items || []).map((i) => `${i.name}${i.qty > 1 ? ` ×${toFa(i.qty)}` : ""}`).join("، ")}
              </p>
              <p className="tabular" style={{ fontSize: 12.5, marginTop: 2 }}>
                <b>{formatToman(o.total)}</b> · {o.delivery === "shipping" ? "ارسال" : "تحویل در سالن"} · {o.paid ? "پرداخت‌شده" : o.payment_method === "online" ? "پرداخت آنلاین" : "پرداخت هنگام تحویل"}
              </p>
              {o.staff_note && o.status !== "cancelled" && <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>{o.staff_note}</p>}
              {o.status === "cancelled" && o.cancel_reason && o.cancel_reason !== "expired" && (
                <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>دلیل لغو: {o.cancel_reason}</p>
              )}
              {o.refund_needed && <p style={{ fontSize: 12, marginTop: 2, color: "var(--color-warning)" }}>مبلغ پرداختی به حسابتان برگردانده می‌شود.</p>}
              {(o.status === "awaiting_payment" || (o.status === "pending" && !o.paid)) && (
                <div className="flex gap-2 mt-2">
                  {o.status === "awaiting_payment" && (
                    <button disabled={busy === o.id} onClick={() => pay(o)} className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: "9px 8px", fontSize: 12.5, fontWeight: 700 }}>
                      {busy === o.id && <Loader2 size={13} className="salon-spin" />} پرداخت
                    </button>
                  )}
                  <button disabled={busy === o.id} onClick={() => cancel(o)} className="tap ghost-btn flex-1" style={{ padding: "9px 8px", fontSize: 12.5, color: "var(--color-danger)" }}>
                    لغو سفارش
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
