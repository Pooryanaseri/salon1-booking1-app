import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, CalendarClock } from "lucide-react";
import { fetchAttendance, respondAttendance } from "./lib/api";
import { jalaliLabel, formatClock, parseDateKey } from "./lib/format";

/**
 * Reached at /confirm?token=… from the link in a reminder SMS (v2.29).
 * One tap to say "I'll be there" or "I can't make it". Declining cancels
 * the booking server-side, which offers the freed time to that day's
 * waitlist and tells the stylist if it was today — no staff action needed.
 * The token is the only thing trusted for identity.
 */
export default function AttendancePage({ token }) {
  const [state, setState] = useState("loading"); // loading | invalid | ask | confirmDecline | sending | confirmed | declined | inactive
  const [appt, setAppt] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAttendance(token).then((res) => {
      if (!res?.ok) { setError(res?.error || ""); setState("invalid"); return; }
      setAppt(res);
      if (res.customer_response === "declined" || res.status === "cancelled") setState("declined");
      else if (!res.active) setState("inactive");
      else if (res.customer_response === "confirmed") setState("confirmed");
      else setState("ask");
    });
  }, [token]);

  async function send(response) {
    setState("sending");
    setError("");
    const res = await respondAttendance(token, response);
    if (!res?.ok) { setError(res?.error || "ثبت پاسخ ناموفق بود"); setState("ask"); return; }
    setState(response);
  }

  const brand = "#c2703a";
  const wrap = {
    minHeight: "100vh", padding: "24px 16px", background: "#faf7f5", display: "flex",
    alignItems: "center", justifyContent: "center", fontFamily: "Vazirmatn, system-ui, sans-serif",
  };
  const card = {
    width: "100%", maxWidth: 400, background: "white", borderRadius: 18,
    padding: 22, boxShadow: "0 4px 24px rgba(0,0,0,.06)", textAlign: "center",
  };
  const btn = (bg, fg, border) => ({
    width: "100%", padding: "14px 12px", borderRadius: 12, fontSize: 15, fontWeight: 700,
    fontFamily: "inherit", cursor: "pointer", background: bg, color: fg, border: border || "none",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48,
  });

  const summary = appt && (
    <div style={{ background: "#faf7f5", borderRadius: 12, padding: "12px 14px", margin: "14px 0 18px", textAlign: "right", lineHeight: 2, fontSize: 14 }}>
      <div><b>{appt.service_name || "نوبت"}</b>{appt.staff_name ? ` — ${appt.staff_name}` : ""}</div>
      <div style={{ color: "#6b5f57" }}>
        {jalaliLabel(parseDateKey(appt.date))} · ساعت {formatClock(appt.start_min)}
      </div>
    </div>
  );

  let content;
  if (state === "loading" || state === "sending") {
    content = <Loader2 size={26} color={brand} style={{ animation: "spin 0.9s linear infinite", margin: "20px auto" }} />;
  } else if (state === "invalid") {
    content = (
      <>
        <XCircle size={34} color="#b4483a" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 700, fontSize: 16 }}>این لینک معتبر نیست</p>
        <p style={{ color: "#888", fontSize: 13, marginTop: 6 }}>{error || "ممکن است لینک کامل کپی نشده باشد."}</p>
      </>
    );
  } else if (state === "inactive") {
    content = (
      <>
        <CalendarClock size={34} color="#888" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 700, fontSize: 16 }}>این نوبت دیگر فعال نیست</p>
        {summary}
      </>
    );
  } else if (state === "confirmed") {
    content = (
      <>
        <CheckCircle2 size={40} color="#3a8f5c" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 800, fontSize: 17 }}>منتظرتان هستیم!</p>
        {summary}
        <p style={{ color: "#888", fontSize: 12.5 }}>اگر برنامه‌تان تغییر کرد، همین لینک را دوباره باز کنید.</p>
        <button style={{ ...btn("white", "#b4483a", "1px solid #e5c9c3"), marginTop: 14 }} onClick={() => setState("confirmDecline")}>
          نمی‌توانم بیایم
        </button>
      </>
    );
  } else if (state === "declined") {
    content = (
      <>
        <CheckCircle2 size={40} color="#888" style={{ margin: "0 auto 10px" }} />
        <p style={{ fontWeight: 800, fontSize: 17 }}>نوبت شما لغو شد</p>
        <p style={{ color: "#6b5f57", fontSize: 13.5, marginTop: 8, lineHeight: 1.9 }}>
          ممنون که خبر دادید — این زمان به نفر بعدی پیشنهاد می‌شود.
        </p>
      </>
    );
  } else if (state === "confirmDecline") {
    content = (
      <>
        <p style={{ fontWeight: 800, fontSize: 16.5 }}>نوبت لغو شود؟</p>
        {summary}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button style={btn("#b4483a", "white")} onClick={() => send("declined")}>بله، لغو کن</button>
          <button style={btn("white", "#333", "1px solid #e3dcd6")} onClick={() => setState(appt?.customer_response === "confirmed" ? "confirmed" : "ask")}>
            برگشت
          </button>
        </div>
      </>
    );
  } else {
    content = (
      <>
        <p style={{ fontWeight: 800, fontSize: 17 }}>{appt?.customer_name ? `${appt.customer_name} عزیز، ` : ""}می‌آیید؟</p>
        <p style={{ color: "#888", fontSize: 12.5, marginTop: 4 }}>{appt?.salon_name}</p>
        {summary}
        {error && <p style={{ color: "#b4483a", fontSize: 13, marginBottom: 10 }}>{error}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button style={btn(brand, "white")} onClick={() => send("confirmed")}>
            <CheckCircle2 size={18} /> بله، می‌آیم
          </button>
          <button style={btn("white", "#b4483a", "1px solid #e5c9c3")} onClick={() => setState("confirmDecline")}>
            نمی‌توانم بیایم
          </button>
        </div>
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
