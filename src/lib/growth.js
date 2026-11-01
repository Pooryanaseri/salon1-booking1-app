/* ============================================================
   v2.53 — growth tools: off-peak pricing, add-on offers, booking
   sources, events, review routing, staff targets, platform plans.
   Demo mode keeps small in-memory versions so every screen works.
   ============================================================ */
import { supabase, SUPABASE_ENABLED, getCurrentSalonId } from "./supabase";

const log = (where, e) => console.error(`[growth] ${where}:`, e?.message || e);
const missing = (e, name) => new RegExp(name, "i").test(e?.message || "");
const DEMO_OFF = { ok: false, error: "در حالت دمو (بدون دیتابیس) در دسترس نیست" };
const rid = () => Math.random().toString(36).slice(2, 10);
async function rpc(name, args, fallback = "انجام نشد — دوباره امتحان کنید") {
  const { data, error } = await supabase.rpc(name, args);
  if (error) { if (!missing(error, name)) log(name, error); return { ok: false, error: fallback }; }
  return data;
}
async function invokePayment(body) {
  try {
    const { data, error } = await supabase.functions.invoke("payment", { body });
    if (error) {
      const ctx = await error.context?.json?.().catch(() => null);
      return { ok: false, error: ctx?.error || "اتصال به درگاه پرداخت ناموفق بود" };
    }
    return data;
  } catch {
    return { ok: false, error: "اتصال به درگاه پرداخت ناموفق بود" };
  }
}

/* ------------------------------------------------------------- demo ---- */
const demo = {
  offpeak: [{ id: "demo-op1", day_of_week: null, start_min: 10 * 60, end_min: 13 * 60, percent: 15, label: "ساعت طلایی", active: true }],
  upsell: [], // filled lazily from the services list (ids differ per salon type)
  events: [],
  eventPayments: [],
  targets: {}, // `${stylist}|${month}` → {revenue_target, visits_target, bonus}
  settings: { slot_offer_lapsed: false, slot_offer_lapsed_days: 45, low_rating_alert: true },
};

/* ------------------------------------------------------- 4. off-peak ---- */
export const SCHEMA_DAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
/** Schema weekday (0 = Saturday) of an unpadded/padded "YYYY-M-D" key. */
export function schemaDowOfKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 1) % 7;
}
/** Best matching rule {percent,label} or null — mirrors offpeak_percent(). */
export function offpeakFor(rules, dateKeyStr, startMin) {
  if (!rules?.length || startMin == null) return null;
  const dow = schemaDowOfKey(dateKeyStr);
  let best = null;
  for (const r of rules) {
    const day = r.day ?? r.day_of_week;
    const start = r.start ?? r.start_min; const end = r.end ?? r.end_min;
    if (r.active === false) continue;
    if (day != null && day !== dow) continue;
    if (startMin < start || startMin >= end) continue;
    if (!best || r.percent > best.percent) best = { percent: r.percent, label: r.label || "ساعت طلایی" };
  }
  return best;
}
export async function fetchPublicOffpeak() {
  if (!SUPABASE_ENABLED) return demo.offpeak.filter((r) => r.active).map((r) => ({ day: r.day_of_week, start: r.start_min, end: r.end_min, percent: r.percent, label: r.label }));
  const { data, error } = await supabase.rpc("get_offpeak_rules");
  if (error) { if (!missing(error, "get_offpeak_rules")) log("get_offpeak_rules", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function applyOffpeak(appointmentId, phone, booking) {
  if (!SUPABASE_ENABLED) {
    const hit = offpeakFor(demo.offpeak, booking.date, booking.start_min);
    if (!hit || booking.final_price == null) return { ok: false };
    const base = Math.max(0, booking.final_price - (booking.transport_fee || 0));
    const discount = Math.round((base * hit.percent) / 100);
    return { ok: true, percent: hit.percent, discount, final_price: booking.final_price - discount };
  }
  return rpc("apply_offpeak", { p_appt: appointmentId, p_phone: phone });
}
export async function fetchOffpeakRules() {
  if (!SUPABASE_ENABLED) return demo.offpeak.map((r) => ({ ...r }));
  const { data, error } = await supabase.from("offpeak_rules").select("*").order("created_at");
  if (error) { if (!missing(error, "offpeak_rules")) log("offpeak_rules", error); return []; }
  return data || [];
}
export async function saveOffpeakRule(r) {
  const row = {
    day_of_week: r.day_of_week === "" || r.day_of_week == null ? null : Number(r.day_of_week),
    start_min: Number(r.start_min), end_min: Number(r.end_min), percent: Math.round(Number(r.percent) || 0),
    label: (r.label || "ساعت طلایی").trim().slice(0, 30), active: r.active !== false,
  };
  if (!(row.end_min > row.start_min)) return { ok: false, error: "ساعت پایان باید بعد از شروع باشد" };
  if (!(row.percent >= 5 && row.percent <= 50)) return { ok: false, error: "تخفیف بین ۵ تا ۵۰ درصد" };
  if (!SUPABASE_ENABLED) {
    if (r.id) Object.assign(demo.offpeak.find((x) => x.id === r.id), row);
    else demo.offpeak.push({ id: `demo-op-${rid()}`, ...row });
    return { ok: true };
  }
  const q = r.id ? supabase.from("offpeak_rules").update(row).eq("id", r.id) : supabase.from("offpeak_rules").insert({ ...row, salon_id: getCurrentSalonId() });
  const { error } = await q;
  if (error) { log("offpeak.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function deleteOffpeakRule(id) {
  if (!SUPABASE_ENABLED) { demo.offpeak = demo.offpeak.filter((x) => x.id !== id); return { ok: true }; }
  const { error } = await supabase.from("offpeak_rules").delete().eq("id", id);
  return error ? { ok: false, error: "حذف ناموفق بود" } : { ok: true };
}
/** Quiet hours from the last 60 days of bookings: [{dow, hour, count}] lowest first. */
export function quietHours(bookings, open = 9, close = 20) {
  const since = Date.now() - 60 * 86400000;
  const grid = new Map();
  for (let d = 0; d < 7; d++) for (let h = open; h < close; h++) grid.set(`${d}|${h}`, 0);
  for (const b of bookings) {
    if (["cancelled", "cancelled_by_salon"].includes(b.status) || !b.date) continue;
    const [y, m, d] = String(b.date).split("-").map(Number);
    if (new Date(y, m - 1, d).getTime() < since) continue;
    const k = `${schemaDowOfKey(b.date)}|${Math.floor(b.start_min / 60)}`;
    if (grid.has(k)) grid.set(k, grid.get(k) + 1);
  }
  return [...grid.entries()].map(([k, count]) => { const [dow, hour] = k.split("|").map(Number); return { dow, hour, count }; })
    .sort((a, b) => a.count - b.count || a.dow - b.dow || a.hour - b.hour);
}

/* ---------------------------------------------------- 7. add-on offers ---- */
function demoUpsell(services) {
  if (!demo.upsell.length && services?.length) {
    const byName = (re) => services.find((s) => re.test(s.name) && s.is_active !== false);
    const pairs = [[/کوتاهی و مدل مو/, /کراتینه/, 1200000, 60, "موهای براق و صاف تا ۳ ماه"], [/کوتاهی مو مردانه/, /اصلاح و فرم ریش/, 90000, 15, "ریش مرتب در همان نوبت"]];
    for (const [a, b, price, extra, pitch] of pairs) {
      const s = byName(a); const t = byName(b);
      if (s && t) demo.upsell.push({ id: `demo-up-${rid()}`, service_id: s.id, addon_service_id: t.id, price, extra_minutes: extra, pitch, active: true, accepted_count: 0 });
    }
  }
  return demo.upsell;
}
export async function fetchPublicUpsells(services) {
  if (!SUPABASE_ENABLED) {
    return demoUpsell(services).filter((o) => o.active).map((o) => {
      const add = services.find((s) => s.id === o.addon_service_id);
      return { id: o.id, service_id: o.service_id, addon_name: add?.name || "", addon_price: add?.price ?? null, price: o.price, extra_minutes: o.extra_minutes, pitch: o.pitch };
    });
  }
  const { data, error } = await supabase.rpc("get_upsell_offers");
  if (error) { if (!missing(error, "get_upsell_offers")) log("get_upsell_offers", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function applyUpsell(appointmentId, phone, offer) {
  if (!SUPABASE_ENABLED) {
    const o = demo.upsell.find((x) => x.id === offer.id);
    if (o) o.accepted_count += 1;
    return { ok: true, label: offer.addon_name, amount: offer.price, extra_minutes: offer.extra_minutes };
  }
  return rpc("apply_upsell", { p_appt: appointmentId, p_phone: phone, p_offer: offer.id });
}
export async function fetchUpsellAdmin(services) {
  if (!SUPABASE_ENABLED) return demoUpsell(services).map((o) => ({ ...o }));
  const { data, error } = await supabase.from("upsell_offers").select("*").order("created_at");
  if (error) { if (!missing(error, "upsell_offers")) log("upsell_offers", error); return []; }
  return data || [];
}
export async function saveUpsell(o) {
  const row = { service_id: o.service_id, addon_service_id: o.addon_service_id, price: Math.round(Number(o.price) || 0),
    extra_minutes: Math.max(0, Math.min(240, Math.round(Number(o.extra_minutes) || 0))), pitch: (o.pitch || "").trim().slice(0, 120), active: o.active !== false };
  if (!row.service_id || !row.addon_service_id || row.service_id === row.addon_service_id) return { ok: false, error: "خدمت اصلی و افزودنی را انتخاب کنید" };
  if (row.price < 1000) return { ok: false, error: "قیمت پیشنهادی را وارد کنید" };
  if (!SUPABASE_ENABLED) {
    if (o.id) Object.assign(demo.upsell.find((x) => x.id === o.id), row);
    else demo.upsell.push({ id: `demo-up-${rid()}`, accepted_count: 0, ...row });
    return { ok: true };
  }
  const q = o.id ? supabase.from("upsell_offers").update(row).eq("id", o.id) : supabase.from("upsell_offers").insert({ ...row, salon_id: getCurrentSalonId() });
  const { error } = await q;
  if (error) { log("upsell.save", error); return { ok: false, error: /duplicate|unique/i.test(error.message || "") ? "این پیشنهاد قبلاً ساخته شده" : "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function deleteUpsell(id) {
  if (!SUPABASE_ENABLED) { demo.upsell = demo.upsell.filter((x) => x.id !== id); return { ok: true }; }
  const { error } = await supabase.from("upsell_offers").delete().eq("id", id);
  return error ? { ok: false, error: "حذف ناموفق بود" } : { ok: true };
}

/* ------------------------------------------------------- 10. sources ---- */
export const SOURCES = [
  ["instagram", "اینستاگرام"], ["google", "گوگل و نقشه"], ["neshan", "نشان / بلد"], ["ads", "تبلیغات"],
  ["card", "کارت ویزیت / QR"], ["sms", "پیامک"], ["whatsapp", "واتساپ / تلگرام"],
];
export function sourceLabel(src) {
  if (!src) return "مستقیم / نامشخص";
  return (SOURCES.find(([k]) => k === src) || [src, src])[1];
}
const SRC_KEY = "salon.src";
/** First touch wins for 7 days: ?src=instagram on any page of the salon. */
export function captureSource(search = typeof window !== "undefined" ? window.location.search : "") {
  try {
    const src = (new URLSearchParams(search).get("src") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    const cur = JSON.parse(localStorage.getItem(SRC_KEY) || "null");
    if (src && (!cur || Date.now() - cur.at > 7 * 86400000)) localStorage.setItem(SRC_KEY, JSON.stringify({ src, at: Date.now() }));
  } catch { /* storage unavailable */ }
}
export function currentSource() {
  try {
    const cur = JSON.parse(localStorage.getItem(SRC_KEY) || "null");
    return cur && Date.now() - cur.at <= 7 * 86400000 ? cur.src : null;
  } catch { return null; }
}
export async function setBookingSource(appointmentId, phone, src) {
  if (!src) return { ok: false };
  if (!SUPABASE_ENABLED) return { ok: true };
  return rpc("set_booking_source", { p_appt: appointmentId, p_phone: phone, p_source: src });
}
/** Pure: bookings by source in the last `days` — count, completed revenue, new clients. */
export function sourceStats(bookings, days = 90) {
  const since = Date.now() - days * 86400000;
  const firstSeen = new Map();
  const ts = (b) => { const [y, m, d] = String(b.date).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
  for (const b of [...bookings].sort((a, c) => ts(a) - ts(c))) if (!firstSeen.has(b.customer_phone)) firstSeen.set(b.customer_phone, b.id);
  const rows = new Map();
  for (const b of bookings) {
    if (!b.date || ts(b) < since || ["cancelled", "cancelled_by_salon"].includes(b.status)) continue;
    const k = b.source || "";
    const r = rows.get(k) || { source: k, label: sourceLabel(k), bookings: 0, revenue: 0, newClients: 0 };
    r.bookings += 1;
    if (b.status === "completed" && b.final_price != null) r.revenue += b.final_price;
    if (firstSeen.get(b.customer_phone) === b.id) r.newClients += 1;
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);
}

/* -------------------------------------------------------- 8. events ---- */
export const EVENT_KINDS = [["bride", "عروس"], ["groom", "داماد"], ["engagement", "نامزدی / عقد"], ["party", "مهمانی و جشن"], ["other", "سایر"]];
export const eventKindLabel = (k) => (EVENT_KINDS.find(([x]) => x === k) || [k, "مراسم"])[1];
export const EVENT_STATUS = {
  new: { label: "درخواست جدید", color: "var(--color-accent-500)" },
  quoted: { label: "پیش‌فاکتور ارسال شد", color: "var(--color-info)" },
  accepted: { label: "تایید شد", color: "var(--color-success)" },
  done: { label: "انجام شد", color: "var(--color-muted)" },
  declined: { label: "رد شد", color: "var(--color-danger)" },
  cancelled: { label: "لغو شد", color: "var(--color-danger)" },
};
export async function createEventRequest(f) {
  if (!/^09\d{9}$/.test(f.phone || "")) return { ok: false, error: "شماره موبایل نامعتبر است" };
  if (!(f.name || "").trim()) return { ok: false, error: "نام لازم است" };
  if (!SUPABASE_ENABLED) {
    demo.events.unshift({ id: `demo-ev-${rid()}`, kind: f.kind, event_date: f.date, guests: Number(f.guests) || 1, customer_name: f.name.trim(), customer_phone: f.phone,
      services: f.services || "", note: f.note || "", status: "new", quote_total: null, deposit_amount: null, quote_terms: "", quote_note: "", created_at: new Date().toISOString() });
    return { ok: true, demo: true };
  }
  return rpc("create_event_request", { p_kind: f.kind, p_date: f.date, p_guests: Number(f.guests) || 1, p_name: f.name, p_phone: f.phone, p_services: f.services || "", p_note: f.note || "" });
}
export async function fetchEventRequests() {
  if (!SUPABASE_ENABLED) return demo.events.map((e) => ({ ...e, paid: demo.eventPayments.filter((p) => p.event_id === e.id).reduce((t, p) => t + p.amount, 0) }));
  const [{ data, error }, { data: pays }] = await Promise.all([
    supabase.from("event_requests").select("*").order("event_date").limit(200),
    supabase.from("event_payments").select("event_id, amount"),
  ]);
  if (error) { if (!missing(error, "event_requests")) log("event_requests", error); return []; }
  const paid = new Map();
  for (const p of pays || []) paid.set(p.event_id, (paid.get(p.event_id) || 0) + Number(p.amount));
  return (data || []).map((e) => ({ ...e, paid: paid.get(e.id) || 0 }));
}
export async function quoteEvent(id, total, deposit, terms, note) {
  if (!SUPABASE_ENABLED) {
    const e = demo.events.find((x) => x.id === id);
    if (!(total >= 1000) || deposit > total) return { ok: false, error: "مبلغ کل و بیعانه را درست وارد کنید" };
    Object.assign(e, { status: "quoted", quote_total: total, deposit_amount: deposit, quote_terms: terms, quote_note: note });
    return { ok: true, sent: true, demo: true };
  }
  return rpc("quote_event", { p_id: id, p_total: Math.round(total), p_deposit: Math.round(deposit), p_terms: terms || "", p_note: note || "" });
}
export async function setEventStatus(id, status) {
  if (!SUPABASE_ENABLED) { demo.events.find((x) => x.id === id).status = status; return { ok: true }; }
  return rpc("set_event_status", { p_id: id, p_status: status });
}
export async function recordEventPayment(id, amount, note) {
  if (!SUPABASE_ENABLED) {
    const e = demo.events.find((x) => x.id === id);
    demo.eventPayments.push({ event_id: id, amount: Math.round(amount), method: "desk", note });
    if (["new", "quoted"].includes(e.status)) e.status = "accepted";
    const paid = demo.eventPayments.filter((p) => p.event_id === id).reduce((t, p) => t + p.amount, 0);
    return { ok: true, paid, left: Math.max(0, (e.quote_total || 0) - paid) };
  }
  return rpc("record_event_payment", { p_id: id, p_amount: Math.round(amount), p_note: note || "" });
}
export async function getEventQuote(token) {
  if (!SUPABASE_ENABLED) return { ok: false };
  return rpc("get_event_quote", { p_token: token });
}
export async function acceptEventQuote(token) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("accept_event_quote", { p_token: token });
}
export function startEventPayment(token) {
  if (!SUPABASE_ENABLED) return Promise.resolve(DEMO_OFF);
  return invokePayment({ action: "request", event_token: token });
}

/* ---------------------------------------------------- 9. reviews etc ---- */
export async function feedbackFollowup(bookingId) {
  if (!SUPABASE_ENABLED || !bookingId) return null;
  const { data, error } = await supabase.rpc("feedback_followup", { p_booking: bookingId });
  if (error) { if (!missing(error, "feedback_followup")) log("feedback_followup", error); return null; }
  return data;
}
/** Settings of v2.53 (read on their own so an older database still loads). */
export async function fetchGrowthSettings() {
  if (!SUPABASE_ENABLED) return { ...demo.settings };
  const { data, error } = await supabase.from("app_settings").select("slot_offer_lapsed, slot_offer_lapsed_days, low_rating_alert").eq("salon_id", getCurrentSalonId()).maybeSingle();
  if (error) { if (!missing(error, "slot_offer|low_rating")) log("growth settings", error); return null; }
  return data;
}
export async function saveGrowthSettings(patch) {
  if (!SUPABASE_ENABLED) { Object.assign(demo.settings, patch); return { ok: true }; }
  const { error } = await supabase.from("app_settings").update(patch).eq("salon_id", getCurrentSalonId());
  if (error) { log("growth settings.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}

/* -------------------------------------------------- 12. staff targets ---- */
export function monthStart(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
export async function fetchTargetsProgress(month, bookings = [], stylists = [], onlyStylistId = null) {
  if (!SUPABASE_ENABLED) {
    const [y, m] = month.split("-").map(Number);
    const rows = stylists.filter((s) => s.active !== false && (!onlyStylistId || s.id === onlyStylistId)).map((s) => {
      const done = bookings.filter((b) => b.staff_id === s.id && b.status === "completed" && (() => { const [by, bm] = String(b.date).split("-").map(Number); return by === y && bm === m; })());
      const t = demo.targets[`${s.id}|${month}`] || {};
      return { id: s.id, name: s.name, revenue_target: t.revenue_target || 0, visits_target: t.visits_target || 0, bonus: t.bonus || 0,
        revenue: done.reduce((a, b) => a + (b.final_price || 0) - (b.transport_fee || 0), 0), visits: done.length };
    });
    return { ok: true, month, rows };
  }
  return rpc("targets_progress", { p_month: month });
}
export async function saveTarget(stylistId, month, t) {
  const row = { revenue_target: Math.max(0, Math.round(Number(t.revenue_target) || 0)), visits_target: Math.max(0, Math.round(Number(t.visits_target) || 0)), bonus: Math.max(0, Math.round(Number(t.bonus) || 0)) };
  if (!SUPABASE_ENABLED) { demo.targets[`${stylistId}|${month}`] = row; return { ok: true }; }
  const { error } = await supabase.from("staff_targets").upsert({ salon_id: getCurrentSalonId(), stylist_id: stylistId, month, ...row }, { onConflict: "stylist_id,month" });
  if (error) { log("staff_targets.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
/** Pure: how far a stylist is, and whether the bonus is earned. */
export function targetStatus(r) {
  const parts = [];
  if (r.revenue_target > 0) parts.push(Math.min(1, r.revenue / r.revenue_target));
  if (r.visits_target > 0) parts.push(Math.min(1, r.visits / r.visits_target));
  const progress = parts.length ? Math.min(...parts) : 0;
  return { hasTarget: parts.length > 0, progress, earned: parts.length > 0 && progress >= 1 ? r.bonus || 0 : 0 };
}

/* ------------------------------------------------------- 13. plans ---- */
export async function fetchMyPlan() {
  if (!SUPABASE_ENABLED) {
    const st = demoSubscription();
    return { ok: true, demo: true, plan_id: "pro", plan_name: "حرفه‌ای (نمونه)", expires_at: st.expires_at, state: st.state, days_left: st.days_left, grace_until: st.grace_until,
      discounts: { 3: 5, 6: 10, 12: 20 }, support_phone: "", sms_quota: 2000, sms_used: 0, online_volume: 0, payment_fee_pct: 1, payment_fee: 0, online: false,
      plans: [{ id: "pro", name: "حرفه‌ای (نمونه)", monthly_price: 490000, sms_quota: 2000 }] };
  }
  return rpc("my_plan", {});
}

/* v2.58: subscription state — active / grace / locked (server-enforced). */
const DEMO_SUB_KEY = "salon-demo-sub";
/** Demo only: `?sub=soon|grace|locked` previews each state. */
function demoSubscription() {
  let mode = "";
  try {
    const q = new URLSearchParams(window.location.search).get("sub");
    if (q) sessionStorage.setItem(DEMO_SUB_KEY, q);
    mode = sessionStorage.getItem(DEMO_SUB_KEY) || "";
  } catch { /* no storage */ }
  const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  const make = (days, state) => ({ ok: true, demo: true, enforced: true, state, days_left: days, expires_at: iso(days), grace_until: iso(days + 5), warn_days: 14, support_phone: "02100000000" });
  if (mode === "soon") return make(6, "active");
  if (mode === "grace") return make(-2, "grace");
  if (mode === "locked") return make(-9, "locked");
  return { ok: true, demo: true, enforced: false, state: "active", days_left: null, expires_at: null, grace_until: null, warn_days: 14, support_phone: "" };
}
export async function fetchSubscriptionStatus() {
  if (!SUPABASE_ENABLED) return demoSubscription();
  const { data, error } = await supabase.rpc("subscription_status");
  if (error) { if (!missing(error, "subscription_status")) log("subscription_status", error); return { ok: false, state: "active" }; }
  return data || { ok: false, state: "active" };
}
/** Pure: the reminder banner for the panel (null when nothing to say). */
export function subscriptionNotice(st) {
  if (!st || !st.enforced || st.days_left == null) return null;
  if (st.state === "locked") return { tone: "danger", text: "اشتراک به پایان رسیده و سرویس غیرفعال است" };
  if (st.state === "grace") {
    const left = Math.max(0, Math.round((new Date(st.grace_until) - new Date(new Date().toISOString().slice(0, 10))) / 86400000));
    return { tone: "danger", text: left > 0 ? `اشتراک تمام شده — ${toFaNum(left)} روز تا غیرفعال شدن فرصت تمدید دارید` : "امروز آخرین روز مهلت تمدید است" };
  }
  if (st.days_left === 0) return { tone: "warning", text: "امروز آخرین روز اشتراک است" };
  if (st.days_left > 0 && st.days_left <= (st.warn_days || 14)) return { tone: "warning", text: `${toFaNum(st.days_left)} روز تا پایان اشتراک` };
  return null;
}
const toFaNum = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
export async function adminSubscriptionOverview() {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("admin_subscription_overview", {});
}
export async function buyPlan(planId, months) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const inv = await rpc("create_plan_invoice", { p_plan: planId, p_months: months });
  if (!inv?.ok) return inv;
  return invokePayment({ action: "request", plan_invoice_id: inv.id });
}
export async function adminFetchPlans() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.from("platform_plans").select("*").order("sort_order").order("monthly_price");
  if (error) { if (!missing(error, "platform_plans")) log("platform_plans", error); return []; }
  return data || [];
}
export async function adminSavePlan(p) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const row = { id: (p.id || "").trim().toLowerCase(), name: (p.name || "").trim(), monthly_price: Math.round(Number(p.monthly_price) || 0),
    sms_quota: Math.round(Number(p.sms_quota) || 0), payment_fee_pct: Number(p.payment_fee_pct) || 0, active: p.active !== false, sort_order: Number(p.sort_order) || 0 };
  if (!/^[a-z0-9_-]{2,20}$/.test(row.id)) return { ok: false, error: "شناسه: ۲ تا ۲۰ حرف کوچک انگلیسی یا عدد" };
  if (!row.name) return { ok: false, error: "نام پلن لازم است" };
  const { error } = await supabase.from("platform_plans").upsert(row);
  if (error) { log("platform_plans.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function adminFetchPlatformSettings() {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase.from("platform_settings").select("*").maybeSingle();
  if (error) { if (!missing(error, "platform_settings")) log("platform_settings", error); return null; }
  return data;
}
export async function adminSavePlatformSettings(s) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const merchant = (s.zarinpal_merchant_id || "").trim();
  if (merchant && !/^[0-9a-fA-F-]{36}$/.test(merchant)) return { ok: false, error: "مرچنت‌کد زرین‌پال ۳۶ کاراکتر است" };
  const days = String(s.reminder_days ?? "").split(/[,،\s]+/).map((x) => Number(String(x).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)))).filter((x) => x > 0);
  if (days.some((d) => d > 60) || days.length > 8) return { ok: false, error: "روزهای یادآوری: حداکثر ۸ عدد بین ۱ تا ۶۰" };
  const phone = String(s.support_phone || "").trim();
  if (phone && !/^0[0-9]{10}$/.test(phone)) return { ok: false, error: "شمارهٔ پشتیبانی ۱۱ رقم و با ۰ شروع شود" };
  const pct = (v, d) => Math.min(50, Math.max(0, Number(v ?? d) || 0));
  const row = { zarinpal_merchant_id: merchant, trial_days: Math.min(90, Math.max(0, Number(s.trial_days) || 0)),
    enforce_subscription: !!s.enforce_subscription, grace_days: Math.min(30, Math.max(0, Number(s.grace_days) || 0)),
    reminder_days: [...new Set(days)].sort((a, b) => b - a), discount_3: pct(s.discount_3, 5), discount_6: pct(s.discount_6, 10), discount_12: pct(s.discount_12, 20),
    support_phone: phone };
  const { error } = await supabase.from("platform_settings").update(row).eq("id", true);
  if (error) { log("platform_settings.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function adminSetPlan(salonId, planId, expires) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("admin_set_plan", { p_salon: salonId, p_plan: planId || null, p_expires: expires || null });
}
export async function adminBillingReport(month) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("admin_billing_report", { p_month: month });
}
