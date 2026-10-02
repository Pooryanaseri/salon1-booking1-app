import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, CreditCard } from "lucide-react";
import { verifyDepositPayment, startDepositPayment } from "./lib/api";
import { jalaliLabel, formatClock, formatToman, parseDateKey } from "./lib/format";

/**
 * Zarinpal sends the customer back to /payment/callback?Authority=…&Status=OK|NOK
 * (v2.37). The Edge Function verifies the payment with Zarinpal itself —
 * the Status parameter alone proves nothing — and only then confirms the
 * booking. On failure the slot stays held for the rest of the 20 minutes,
 * so the customer can simply try again.
 */
export default function PaymentCallbackPage({ authority, status }) {
  const [state, setState] = useState("loading"); // loading | paid | refund | failed | invalid
  const [appt, setAppt] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authority) { setState("invalid"); return; }
    verifyDepositPayment(authority, status).then((r) => {
      if (!r?.ok) { setError(r?.error || ""); setState("invalid"); return; }
      setAppt(r.appointment || null);
      setState(r.paid ? (r.refund ? "refund" : "paid") : "failed");
    });
  }, [authority, status]);

  async function retry() {
    if (!appt?.id) return;
    setRetrying(true); setError("");
    const r = await startDepositPayment(appt.id);
    if (r?.ok && r.url) { window.location.assign(r.url); return; }
    setRetrying(false);
    setError(r?.error || "اتصال به درگاه پرداخت ناموفق بود");
  }

  const brand = "#c2703a";
  const wrap = {
    minHeight: "100vh", padding: "24px 16px", background: "#faf7f5", display: "flex",
    alignItems: "center", justifyContent: "center", fontFamily: "Vazirmatn, system-ui, sans-serif",
  };
  const card = { width: "100%", maxWidth: 400, background: "white", borderRadius: 18, padding: 22, boxShadow: "0 4px 24px rgba(0,0,0,.06)", textAlign: "center" };
  const btn = { width: "100%", padding: "14px 12px", borderRadius: 12, fontSize: 15, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", background: brand, color: "white", border: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, marginTop: 16 };

  const summary = appt && appt.date && (
    <div style={{ background: "#faf7f5", borderRadius: 12, padding: "12px 14px", margin: "14px 0 4px", textAlign: "right", lineHeight: 2, fontSize: 14 }}>
      <div>{jalaliLabel(parseDateKey(appt.date))} · ساعت {formatClock(appt.start_min)}</div>
      {appt.deposit_amount ? <div style={{ color: "#6b5f57" }}>بیعانه: {formatToman(appt.deposit_amount)}</div> : null}
      {appt.tracking_code ? <div style={{ color: "#6b5f57" }}>کد پیگیری: {appt.tracking_code}</div> : null}
    </div>
  );

  let content;
  if (state === "loading") {
    content = (
      <>
        <Loader2 size={28} color={brand} style={{ animation: "spin 0.9s linear infinite", margin: "12px auto" }} />
        <p style={{ fontSize: 14 }}>در حال بررسی پرداخت…</p>
      </>
    );
  } else if (state === "paid") {
    content = (
      <>
        <CheckCircle2 size={42} color="#3a8f5c" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 800, fontSize: 17 }}>پرداخت انجام شد — نوبت شما قطعی است</p>
        {summary}
        <p style={{ color: "#888", fontSize: 12.5, marginTop: 8 }}>پیامک تایید برایتان ارسال می‌شود. باقی مبلغ در سالن پرداخت می‌شود.</p>
      </>
    );
  } else if (state === "refund") {
    content = (
      <>
        <XCircle size={40} color="#b4483a" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 800, fontSize: 16 }}>پرداخت انجام شد ولی این زمان دیگر خالی نبود</p>
        <p style={{ color: "#6b5f57", fontSize: 13.5, marginTop: 8, lineHeight: 1.9 }}>
          مبلغ به شما بازگردانده می‌شود — سالن خبردار شد و با شما تماس می‌گیرد.
        </p>
      </>
    );
  } else if (state === "failed") {
    content = (
      <>
        <CreditCard size={38} color="#b4483a" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 800, fontSize: 16 }}>پرداخت انجام نشد</p>
        <p style={{ color: "#6b5f57", fontSize: 13.5, marginTop: 8, lineHeight: 1.9 }}>
          اگر مبلغی از حسابتان کم شده، طبق قوانین بانکی ظرف ۷۲ ساعت برمی‌گردد.
          نوبت تا ۲۰ دقیقه پس از ثبت برایتان نگه داشته می‌شود.
        </p>
        {summary}
        {error && <p style={{ color: "#b4483a", fontSize: 13, marginTop: 10 }}>{error}</p>}
        {appt?.status === "awaiting_payment" && (
          <button style={{ ...btn, opacity: retrying ? 0.6 : 1 }} disabled={retrying} onClick={retry}>
            {retrying ? <Loader2 size={16} style={{ animation: "spin 0.9s linear infinite" }} /> : <CreditCard size={16} />} پرداخت دوباره
          </button>
        )}
      </>
    );
  } else {
    content = (
      <>
        <XCircle size={36} color="#888" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 700, fontSize: 16 }}>اطلاعات پرداخت پیدا نشد</p>
        {error && <p style={{ color: "#888", fontSize: 13, marginTop: 6 }}>{error}</p>}
      </>
    );
  }

  return (
    <div dir="rtl" style={wrap}>
      <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
      <div style={card}>{content}</div>
    </div>
  );
}
