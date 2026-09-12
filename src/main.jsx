import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { SUPABASE_ENABLED } from "./lib/supabase.js";
import { getSession, signOut } from "./lib/auth.js";

// ----------------------------------------------------------------------------
//  Idle + absolute session timeout (≈ L7). Only relevant for a real, logged
//  -in owner/manager/stylist session — demo mode has nothing to time out,
//  and an anonymous customer browsing the public booking flow has no
//  session either. 15 minutes idle, 8 hours absolute — matches typical
//  admin-panel norms; both are easy to change below.
// ----------------------------------------------------------------------------
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const SESSION_START_KEY = "salon:sessionStartedAt";

function IdleSessionGuard() {
  React.useEffect(() => {
    if (!SUPABASE_ENABLED) return; // nothing to guard in demo mode

    let idleTimer = null;
    let cancelled = false;

    async function forceSignOut(reason) {
      if (cancelled) return;
      cancelled = true;
      console.info(`[salon] signing out — ${reason}`);
      sessionStorage.removeItem(SESSION_START_KEY);
      await signOut();
      window.location.reload();
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => forceSignOut("idle timeout"), IDLE_TIMEOUT_MS);
    }

    function checkAbsoluteTimeout() {
      const startedAt = Number(sessionStorage.getItem(SESSION_START_KEY) || 0);
      if (startedAt && Date.now() - startedAt > ABSOLUTE_TIMEOUT_MS) {
        forceSignOut("absolute session timeout");
      }
    }

    const activityEvents = ["mousedown", "keydown", "touchstart", "scroll"];
    const onActivity = () => resetIdleTimer();

    (async () => {
      const session = await getSession();
      if (!session || cancelled) return;
      if (!sessionStorage.getItem(SESSION_START_KEY)) {
        sessionStorage.setItem(SESSION_START_KEY, String(Date.now()));
      }
      resetIdleTimer();
      activityEvents.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    })();

    const absoluteCheckInterval = setInterval(checkAbsoluteTimeout, 60_000);

    return () => {
      cancelled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(absoluteCheckInterval);
      activityEvents.forEach((ev) => window.removeEventListener(ev, onActivity));
    };
  }, []);
  return null;
}

// ----------------------------------------------------------------------------
//  Error Boundary — catches render-time crashes anywhere in the tree so the
//  person sees a plain "چیزی اشتباه پیش رفت" screen instead of a blank page,
//  with a button to reload. Deliberately simple: no error-reporting service
//  wired in, just a safety net.
// ----------------------------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error("[salon] Unhandled render error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            minHeight: "100vh", padding: 24, fontFamily: "system-ui, sans-serif", textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>چیزی اشتباه پیش رفت</h1>
          <p style={{ color: "#6b5f57", fontSize: 14, lineHeight: 1.8, marginBottom: 16, maxWidth: 320 }}>
            یک خطای غیرمنتظره رخ داد. می‌توانید صفحه را دوباره بارگذاری کنید.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#c2703a", color: "white", fontWeight: 700, cursor: "pointer" }}
          >
            بارگذاری مجدد
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------------------------------
//  Offline banner — a thin, dismissible-by-reconnect strip at the top when
//  the network drops. Pure browser APIs, no dependency on the Supabase layer.
// ----------------------------------------------------------------------------
function OfflineBanner() {
  const [offline, setOffline] = React.useState(!navigator.onLine);
  React.useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  if (!offline) return null;
  return (
    <div
      dir="rtl"
      style={{
        position: "fixed", top: 0, insetInlineStart: 0, insetInlineEnd: 0, zIndex: 9999,
        background: "#c2703a", color: "white", textAlign: "center", fontSize: 12.5,
        padding: "6px 12px", fontFamily: "system-ui, sans-serif",
      }}
    >
      اتصال اینترنت قطع شده — تغییرات تا اتصال دوباره ذخیره نمی‌شوند
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OfflineBanner />
      <IdleSessionGuard />
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
