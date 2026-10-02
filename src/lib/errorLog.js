// ============================================================================
//  Client error reporting (v2.36) — into the project's own Supabase
//  (public.client_errors via log_client_error). Hosted trackers like Sentry
//  refuse traffic from Iran, and this needs no extra CSP origin.
//  Best-effort by design: reporting never throws and never blocks the UI.
// ============================================================================
import { supabase, SUPABASE_ENABLED } from "./supabase";

const MAX_PER_PAGE = 10;       // a looping error shouldn't spam the server
const sent = new Set();        // same message once per page load
let count = 0;

export function reportError(kind, error) {
  try {
    if (!SUPABASE_ENABLED || count >= MAX_PER_PAGE) return;
    const message = String(error?.message || error || "").slice(0, 500);
    const key = `${kind}:${message}`;
    if (!message || sent.has(key)) return;
    sent.add(key);
    count++;
    supabase.rpc("log_client_error", {
      p_kind: kind,
      p_message: message,
      p_stack: String(error?.stack || "").slice(0, 2000),
      p_url: window.location.pathname,  // path only — query strings carry tokens
      p_user_agent: navigator.userAgent.slice(0, 300),
    }).then(() => {}, () => {});
  } catch {
    // never let error reporting itself break anything
  }
}

/** Global hooks: uncaught errors, unhandled promise rejections, failed saves. */
export function installErrorReporting() {
  window.addEventListener("error", (e) => reportError("runtime", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));
  window.addEventListener("salon:save-error", (e) => reportError("save", `${e.detail?.where}: ${e.detail?.message}`));
}
