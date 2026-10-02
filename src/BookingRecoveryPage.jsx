import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Calendar } from "lucide-react";
import { resolveRebookingToken, fetchRebookingSlots, createBookingFromRebookingToken } from "./lib/api";

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const toFa = (n) => String(n).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
const WEEKDAYS_FA = ["ی", "د", "س", "چ", "پ", "ج", "ش"];
function clockLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return toFa(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
}
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
}

/**
 * Reached at /book?token=... from an SMS rebooking link (a closure
 * cancellation or the predictive engine's "it's time" nudge). The token
 * is the ONLY thing this page trusts for identity — everything shown
 * (salon, service, customer name) comes from resolving it server-side;
 * nothing here reads or passes along any other URL parameter.
 */
export default function BookingRecoveryPage({ token }) {
  const [state, setState] = useState("loading"); // loading | invalid | picking | confirming | done | error
  const [offer, setOffer] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    resolveRebookingToken(token).then((res) => {
      if (!res.ok) { setState("invalid"); return; }
      setOffer(res);
      // v2.29 waitlist offers point at the exact day that just freed up.
      if (res.preferred_date) {
        const [y, m, d] = String(res.preferred_date).split("-").map(Number);
        setSelectedDate(new Date(y, m - 1, d));
      }
      setState("picking");
    });
  }, [token]);

  useEffect(() => {
    if (!selectedDate || state !== "picking") return;
    setSlotsLoading(true);
    setSelectedSlot(null);
    fetchRebookingSlots(token, dateKey(selectedDate), offer?.staff_id).then((s) => {
      setSlots(s);
      setSlotsLoading(false);
    });
  }, [selectedDate, token, offer, state]);

  async function confirm() {
    setState("confirming");
    setError("");
    const res = await createBookingFromRebookingToken(token, dateKey(selectedDate), selectedSlot, offer?.staff_id);
    if (!res.ok) { setError(res.error || "ثبت نوبت ناموفق بود"); setState("picking"); return; }
    setResult(res);
    setState("done");
  }

  const wrap = {
    minHeight: "100vh", padding: "20px 16px", background: "#faf7f5",
    fontFamily: "Vazirmatn, system-ui, sans-serif",
  };
  const card = {
    maxWidth: 440, margin: "0 auto", background: "white", borderRadius: 16,
    padding: 20, boxShadow: "0 4px 24px rgba(0,0,0,.06)",
  };

  if (state === "loading") {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 40 }}>
          <Loader2 size={28} style={{ animation: "spin 1s linear infinite", color: "#c98a4b" }} />
        </div>
      </div>
    );
  }

  if (state === "invalid") {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 32 }}>
          <h2 style={{ fontSize: 17, marginBottom: 6 }}>این لینک دیگر معتبر نیست</h2>
          <p style={{ fontSize: 13, color: "#888" }}>ممکن است منقضی شده یا قبلاً استفاده شده باشد.</p>
        </div>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center", padding: 32 }}>
          <CheckCircle2 size={52} color="#4caf7d" style={{ margin: "0 auto 14px" }} />
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>نوبت شما تایید شد!</h2>
          <p style={{ fontSize: 13.5, color: "#555" }}>کد پیگیری: {result?.tracking_code}</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" style={wrap}>
      <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
      <div style={{ ...card, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>
          {offer?.customer_name ? `سلام ${offer.customer_name}` : "رزرو نوبت جدید"}
        </h2>
        <p style={{ fontSize: 12.5, color: "#888" }}>
          {offer?.salon_name} · {offer?.service_name}{offer?.staff_name ? ` · ${offer.staff_name}` : ""}
        </p>
        {offer?.reason === "waitlist" && (
          <p style={{ fontSize: 13, color: "#3a8f5c", fontWeight: 700, marginTop: 8 }}>
            نوبتی که منتظرش بودید خالی شد — هر کس زودتر رزرو کند، نوبت مال اوست.
          </p>
        )}
      </div>

      <div style={{ ...card, marginBottom: 12 }}>
        <p style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
          <Calendar size={14} /> یک روز انتخاب کنید
        </p>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
          {nextDays(14).map((d) => {
            const key = dateKey(d);
            const active = selectedDate && dateKey(selectedDate) === key;
            return (
              <button
                key={key}
                onClick={() => setSelectedDate(d)}
                style={{
                  flexShrink: 0, minWidth: 48, padding: "8px 6px", borderRadius: 10, border: "none", cursor: "pointer",
                  background: active ? "#c98a4b" : "#f3f0ee", color: active ? "white" : "#555",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 10, opacity: 0.8 }}>{WEEKDAYS_FA[d.getDay()]}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{toFa(d.getDate())}</div>
              </button>
            );
          })}
        </div>
      </div>

      {selectedDate && (
        <div style={{ ...card, marginBottom: 12 }}>
          <p style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>یک ساعت انتخاب کنید</p>
          {slotsLoading ? (
            <p style={{ fontSize: 12.5, color: "#999", textAlign: "center", padding: 16 }}>در حال بارگذاری...</p>
          ) : slots.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "#999", textAlign: "center", padding: 16 }}>برای این روز زمان خالی نیست</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {slots.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedSlot(s)}
                  style={{
                    padding: "8px 4px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12.5,
                    background: selectedSlot === s ? "#c98a4b" : "#f3f0ee",
                    color: selectedSlot === s ? "white" : "#555",
                  }}
                >
                  {clockLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p style={{ color: "#d33", fontSize: 12.5, marginBottom: 10, textAlign: "center" }}>{error}</p>}

      <div style={{ maxWidth: 440, margin: "0 auto" }}>
        <button
          onClick={confirm}
          disabled={!selectedSlot || state === "confirming"}
          style={{
            width: "100%", padding: 14, borderRadius: 12, border: "none",
            cursor: selectedSlot ? "pointer" : "not-allowed",
            background: selectedSlot ? "#c98a4b" : "#ddd", color: "white",
            fontSize: 14.5, fontWeight: 700, fontFamily: "inherit",
          }}
        >
          {state === "confirming" ? "در حال ثبت..." : "تایید نهایی نوبت"}
        </button>
      </div>
    </div>
  );
}
