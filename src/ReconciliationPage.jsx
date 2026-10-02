import { useEffect, useState } from "react";
import { CheckCircle2, Check, X, Loader2 } from "lucide-react";
import { fetchReconciliationQueue, submitReconciliationBatch } from "./lib/api";

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const toFa = (n) => String(n).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
function formatToman(n) {
  if (n == null) return "—";
  return toFa(Math.round(n).toLocaleString("en-US")) + " تومان";
}
function clockLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return toFa(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
}

/**
 * Reached at /<slug>/reconcile?token=... from the weekly SMS magic link.
 * Loads every pending_verification appointment for the token's salon,
 * lets the owner bulk-approve everything as completed with one tap, or
 * flip individual items to "no-show" first. No login — the token itself
 * is the credential (same trust model as the customer OTP/token flow).
 */
export default function ReconciliationPage({ token }) {
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState([]);
  const [decisions, setDecisions] = useState({}); // { [id]: "completed" | "no_show" }
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchReconciliationQueue(token).then((rows) => {
      if (cancelled) return;
      setQueue(rows);
      setDecisions(Object.fromEntries(rows.map((r) => [r.id, "completed"]))); // default: approve all
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [token]);

  function setDecision(id, decision) {
    setDecisions((prev) => ({ ...prev, [id]: decision }));
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    const payload = queue.map((r) => ({ id: r.id, decision: decisions[r.id] || "completed" }));
    const res = await submitReconciliationBatch(token, payload);
    setSubmitting(false);
    if (!res.ok) { setError(res.error || "ثبت ناموفق بود"); return; }
    setResult(res);
  }

  const wrap = {
    minHeight: "100vh", padding: "20px 16px", background: "#faf7f5",
    fontFamily: "Vazirmatn, system-ui, sans-serif",
  };
  const card = {
    maxWidth: 480, margin: "0 auto", background: "white", borderRadius: 16,
    padding: 18, boxShadow: "0 4px 24px rgba(0,0,0,.06)",
  };

  if (loading) {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 40 }}>
          <Loader2 size={28} style={{ animation: "spin 1s linear infinite", color: "#c98a4b" }} />
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 32 }}>
          <CheckCircle2 size={52} color="#4caf7d" style={{ margin: "0 auto 14px" }} />
          <h2 style={{ fontSize: 18, marginBottom: 10 }}>انجام شد</h2>
          <p style={{ fontSize: 13.5, color: "#555", lineHeight: 2 }}>
            {toFa(result.completed)} نوبت تکمیل‌شده ثبت شد
            {result.no_show > 0 && <><br />{toFa(result.no_show)} نوبت عدم‌حضور ثبت شد</>}
          </p>
        </div>
      </div>
    );
  }

  if (!queue.length) {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 32 }}>
          <CheckCircle2 size={52} color="#4caf7d" style={{ margin: "0 auto 14px" }} />
          <h2 style={{ fontSize: 17, marginBottom: 6 }}>چیزی برای تایید نیست</h2>
          <p style={{ fontSize: 13, color: "#888" }}>یا لینک منقضی شده، یا همه‌چیز از قبل تایید شده.</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" style={wrap}>
      <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
      <div style={{ maxWidth: 480, margin: "0 auto 12px", padding: "0 2px" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>تایید نوبت‌های این هفته</h2>
        <p style={{ fontSize: 12.5, color: "#888" }}>{toFa(queue.length)} نوبت منتظر تایید — پیش‌فرض همه «تکمیل‌شده»، در صورت نیاز تغییر بدید</p>
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {queue.map((r) => {
          const decision = decisions[r.id] || "completed";
          return (
            <div key={r.id} style={{ ...card, padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.customer_name || r.customer_phone}
                </p>
                <p style={{ fontSize: 11.5, color: "#999" }}>
                  {clockLabel(r.start_min)} · {formatToman(r.final_price)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button
                  onClick={() => setDecision(r.id, "completed")}
                  aria-label="تکمیل‌شده"
                  style={{
                    width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer",
                    background: decision === "completed" ? "#4caf7d" : "#f0f0f0",
                    color: decision === "completed" ? "white" : "#999",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Check size={18} />
                </button>
                <button
                  onClick={() => setDecision(r.id, "no_show")}
                  aria-label="عدم حضور"
                  style={{
                    width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer",
                    background: decision === "no_show" ? "#d9534f" : "#f0f0f0",
                    color: decision === "no_show" ? "white" : "#999",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ maxWidth: 480, margin: "16px auto 0" }}>
        {error && <p style={{ color: "#d33", fontSize: 12.5, marginBottom: 10, textAlign: "center" }}>{error}</p>}
        <button
          onClick={submit}
          disabled={submitting}
          style={{
            width: "100%", padding: 14, borderRadius: 12, border: "none", cursor: "pointer",
            background: "#c98a4b", color: "white", fontSize: 14.5, fontWeight: 700, fontFamily: "inherit",
          }}
        >
          {submitting ? "در حال ثبت..." : `ثبت نهایی (${toFa(queue.length)} نوبت)`}
        </button>
      </div>
    </div>
  );
}
