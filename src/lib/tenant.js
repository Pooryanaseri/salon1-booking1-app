// ============================================================================
//  Tenant resolution — multi-tenant SaaS (v2.24)
// ============================================================================
//  URL shape: https://yourapp.com/<slug>/... — the salon's own booking page
//  lives at its slug, matching the same plain-path-segment pattern already
//  used for /feedback/:id in main.jsx (no router library needed for this;
//  there's exactly one routing decision the whole app makes: which salon).
//
//  How a request ends up carrying the right salon:
//   - Authenticated staff (owner/manager/stylist): their OWN users.salon_id
//     is what current_salon_id() resolves to on the backend — this module's
//     header is irrelevant for them once logged in, and staff logging in at
//     the wrong salon's URL doesn't leak anything (RLS is keyed off their
//     profile, not the URL).
//   - Anonymous public visitors (the booking flow, OTP, "داشبورد من"): have
//     no users row, so the backend falls back to the x-salon-id header —
//     which is set here, once, right after the slug resolves, and used by
//     every request for the rest of the session.
// ============================================================================
import { supabase, SUPABASE_ENABLED, setCurrentSalonId } from "./supabase.js";

/** Reads the first path segment as the tenant slug. Returns null for the
 *  root path or any reserved path (feedback links, etc.) that isn't a
 *  salon slug. */
export function slugFromLocation() {
  const seg = window.location.pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  if (seg === "feedback") return null; // FeedbackPage's own route, not a salon slug
  return seg;
}

/**
 * Resolves a slug to a salon, and — critically — sets it as the header every
 * subsequent Supabase request carries (see setCurrentSalonId in supabase.js).
 * Call this once, before rendering the app, and again if the user
 * navigates to a different salon's URL without a full page reload.
 *
 * Returns { ok: true, salon: {id, name, slug} } or { ok: false, error }.
 * In demo mode (no Supabase configured) this always resolves to a single
 * fake salon so the existing demo flow keeps working unchanged.
 */
// Display name used when no real salon row is available (demo mode) or a
// salon's row has an empty name.
export const DEFAULT_SALON_NAME = import.meta.env.VITE_SALON_NAME || "آرایشگاه و سالن زیبایی مانا";

// The salon this page belongs to. Resolved once by TenantGate before the app
// renders and never changes afterwards (a different salon means a different
// URL and a full page load), so a plain module value is enough — same
// pattern as setCurrentSalonId in supabase.js.
let currentSalon = { id: "demo", name: DEFAULT_SALON_NAME, slug: "demo" };

/** The resolved salon's display name, e.g. for the header, SMS and calendar files. */
export function getSalonName() {
  return currentSalon.name || DEFAULT_SALON_NAME;
}

function setCurrentSalon(salon) {
  currentSalon = { ...salon, name: (salon.name || "").trim() || DEFAULT_SALON_NAME };
  if (typeof document !== "undefined") document.title = `نوبت‌دهی ${currentSalon.name}`;
}

export async function resolveSalonFromSlug(slug) {
  if (!SUPABASE_ENABLED) {
    setCurrentSalon({ id: "demo", name: DEFAULT_SALON_NAME, slug: slug || "demo" });
    return { ok: true, salon: currentSalon };
  }
  if (!slug) {
    return { ok: false, error: "آدرس سالن مشخص نیست" };
  }
  const { data, error } = await supabase
    .from("salons")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, error: "سالنی با این آدرس پیدا نشد" };
  }
  setCurrentSalonId(data.id);
  setCurrentSalon(data);
  return { ok: true, salon: currentSalon };
}
