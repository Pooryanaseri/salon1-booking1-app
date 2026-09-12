// ============================================================================
//  Supabase client
//  If the env vars are missing the app falls back to the original in-memory
//  demo mode instead of white-screening — so you can deploy the frontend before
//  the database is wired up, and nothing breaks if a key rotates.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SUPABASE_ENABLED = Boolean(url && anonKey);

export const supabase = SUPABASE_ENABLED
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: "salon-auth",
      },
      realtime: { params: { eventsPerSecond: 3 } },
      global: { headers: { "x-application-name": "salon-booking" } },
    })
  : null;

if (!SUPABASE_ENABLED && typeof console !== "undefined") {
  console.warn(
    "[salon] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY تنظیم نشده — برنامه در حالت دمو (حافظه‌ی موقت) اجرا می‌شود."
  );
}

// Login stays "phone + password" in the UI. Supabase Auth wants an email, so we
// derive a stable synthetic one. Nothing about the form or the roles changes.
export const AUTH_EMAIL_DOMAIN =
  import.meta.env.VITE_AUTH_EMAIL_DOMAIN || "salon.local";

export function phoneToEmail(phone) {
  return `${String(phone).trim()}@${AUTH_EMAIL_DOMAIN}`;
}

// ----------------------------------------------------------------------------
//  Reliability layer — offline detection, last-error tracking, and an
//  opt-in retry+timeout wrapper. Purely additive: nothing above this line
//  changed, and every existing call in api.js/auth.js keeps working exactly
//  as before whether or not it uses withRetry().
// ----------------------------------------------------------------------------
let offline = typeof navigator !== "undefined" ? !navigator.onLine : false;
let lastError = null;

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { offline = false; });
  window.addEventListener("offline", () => { offline = true; });
}

/** Best-effort — `navigator.onLine` only reflects the network interface, not
 *  whether Supabase itself is reachable, so treat this as a hint, not proof. */
export function isOffline() {
  return offline;
}

export function getLastError() {
  return lastError;
}

function recordError(err) {
  lastError = { message: err?.message || String(err), at: Date.now() };
  return lastError;
}

/**
 * Wraps a Supabase call with a timeout and exponential-backoff retry.
 * Usage: `const { data, error } = await withRetry(() => supabase.from("x").select());`
 * `fn` must be a function that RETURNS a promise (not the promise itself),
 * since it may need to be invoked again on retry.
 *
 * This is opt-in — existing call sites that just do
 * `await supabase.from(...).select()` directly are unaffected. Wrap the
 * ones where a transient network blip matters most (writes to appointments,
 * anything the booking flow depends on) rather than every call in the file.
 */
export async function withRetry(fn, { retries = 2, timeoutMs = 15000, baseDelayMs = 400 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)
      );
      const result = await Promise.race([fn(), timeout]);
      if (result?.error) { recordError(result.error); }
      // Supabase errors don't throw — they come back as { data, error }.
      // Only network/timeout failures (which DO throw) get retried; a real
      // Postgres/RLS error (e.g. a constraint violation) retrying wouldn't fix.
      return result;
    } catch (err) {
      recordError(err);
      attempt += 1;
      if (attempt > retries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

