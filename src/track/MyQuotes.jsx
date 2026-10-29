import { useState } from "react";
import { MessageSquareText, Loader2 } from "lucide-react";
import { formatToman, toFa } from "../lib/format";
import { myQuoteLink, cancelMyQuote } from "../lib/api";

/* v2.46 — the customer's price quotes in "داشبورد من": waiting, priced
   (pick a time at that price), booked, declined, expired. */
const STATUS = {
  pending: { label: "در انتظار قیمت", color: "var(--color-warning)" },
  quoted: { label: "قیمت اعلام شد", color: "var(--color-success)" },
  booked: { label: "رزرو شد", color: "var(--color-info)" },
  declined: { label: "پذیرفته نشد", color: "var(--color-danger)" },
  cancelled: { label: "لغو شد", color: "var(--color-muted)" },
  expired: { label: "منقضی شد", color: "var(--color-muted)" },
};

export function MyQuotes({ quotes, token, onChanged, notify }) {
  const [busy, setBusy] = useState(null);
  async function book(q) {
    setBusy(q.id);
    const res = await myQuoteLink(token, q.id);
    setBusy(null);
    if (!res?.ok || !res.token) { notify(res?.error || "ساخت لینک ناموفق بود"); onChanged(); return; }
    window.location.assign(`/book?token=${encodeURIComponent(res.token)}`);
  }
  async function cancel(q) {
    if (!window.confirm("این درخواست لغو شود؟")) return;
    setBusy(q.id);
    const res = await cancelMyQuote(token, q.id);
    setBusy(null);
    notify(res?.ok ? "درخواست لغو شد" : res?.error || "لغو ناموفق بود");
    onChanged();
  }
  return (
    <div className="card fade-in mt-4" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5 mb-2" style={{ fontSize: 13.5, fontWeight: 800, color: "var(--color-heading)" }}>
        <MessageSquareText size={15} /> استعلام‌های قیمت
      </p>
      <div className="flex flex-col gap-2">
        {quotes.map((q) => {
          const st = STATUS[q.status] || STATUS.pending;
          return (
            <div key={q.id} style={{ padding: "10px 0", borderTop: "1px dashed var(--color-border)" }}>
              <div className="flex items-center justify-between gap-2">
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{q.pet_name} · {q.services_label}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color, whiteSpace: "nowrap" }}>{st.label}</span>
              </div>
              {q.status === "quoted" && (
                <p className="tabular" style={{ fontSize: 13, marginTop: 4 }}>
                  <b>{formatToman(q.price)}</b> · حدود {toFa(q.duration)} دقیقه
                </p>
              )}
              {q.note && <p className="muted" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.8 }}>{q.note}</p>}
              {(q.status === "quoted" || q.status === "pending") && (
                <div className="flex gap-2 mt-2">
                  {q.status === "quoted" && (
                    <button disabled={busy === q.id} onClick={() => book(q)} className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: "9px 8px", fontSize: 12.5, fontWeight: 700 }}>
                      {busy === q.id && <Loader2 size={13} className="salon-spin" />} انتخاب زمان و رزرو
                    </button>
                  )}
                  <button disabled={busy === q.id} onClick={() => cancel(q)} className="tap ghost-btn" style={{ padding: "9px 12px", fontSize: 12.5 }}>لغو درخواست</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
