// ============================================================================
//  Data access layer — every read/write the app used to do against in-memory
//  React state now goes through here to Supabase.
//
//  DESIGN GOAL: not one UI component changes.
//  App.jsx keeps exposing the exact same props (`setServices`, `setTimeOff`,
//  `addBooking`, ...) with the exact same signatures — including the updater
//  form `setX(prev => next)`. This module diffs the previous array against the
//  next one and issues the matching insert / update / delete. Children never
//  learn there's a database.
//
//  If Supabase env vars are absent every function resolves to a no-op, so the
//  app degrades to the original demo behaviour instead of crashing.
// ============================================================================
import { supabase, SUPABASE_ENABLED } from "./supabase";

/* ---------------------------------------------------------------- date glue */
// The app's dateKey() produces an UNPADDED key: "2026-8-31".
// Postgres DATE wants "2026-08-31". Convert both ways, never mutate the app's format.
export function keyToISO(key) {
  if (!key) return null;
  const [y, m, d] = String(key).split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function isoToKey(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${y}-${m}-${d}`;
}

const ms = (v) => (v ? new Date(v).getTime() : Date.now());

/* ------------------------------------------------------------------ mappers */
// DB row -> app object, and back. Column names were deliberately chosen to
// match the app's field names, so these are thin on purpose.

const map = {
  services: {
    fromRow: (r) => ({
      id: r.id, name: r.name, gender: r.gender, category: r.category,
      duration_minutes: r.duration_minutes, buffer_minutes: r.buffer_minutes ?? 0,
      price: r.price === null ? null : Number(r.price),
      discount_type: r.discount_type, discount_value: Number(r.discount_value || 0),
      discount_reason: r.discount_reason || "", is_active: r.is_active,
      loyalty_points: r.loyalty_points ?? 10,
    }),
    toRow: (s) => ({
      id: s.id, name: s.name ?? "", gender: s.gender ?? "female", category: s.category ?? "hair",
      duration_minutes: s.duration_minutes ?? 30, buffer_minutes: s.buffer_minutes ?? 0,
      price: s.price ?? null, discount_type: s.discount_type ?? "none",
      discount_value: s.discount_value ?? 0, discount_reason: s.discount_reason ?? "",
      is_active: s.is_active ?? true, loyalty_points: s.loyalty_points ?? 10,
    }),
  },

  stylists: {
    // SECURITY: `password` is intentionally never read from or written to
    // this table — real auth goes through Supabase Auth (bcrypt, in
    // auth.users), and a redundant plaintext copy here was a real
    // vulnerability (see CHANGES.md / migration v2.2). Demo mode still uses
    // an in-memory `password` field on the JS object for its own login
    // simulation, but that never reaches this mapper since demo mode never
    // touches Supabase at all.
    fromRow: (r) => ({
      id: r.id, name: r.name, gender: r.gender, phone: r.phone || "",
      active: r.active,
      reminder_hours_before: r.reminder_hours_before ?? 3,
    }),
    toRow: (s) => ({
      id: s.id, name: s.name ?? "", gender: s.gender ?? "female", phone: s.phone ?? "",
      active: s.active ?? true,
      reminder_hours_before: s.reminder_hours_before ?? 3,
    }),
  },

  appointments: {
    fromRow: (r) => ({
      id: r.id, customer_name: r.customer_name, customer_phone: r.customer_phone,
      customer_gender: r.customer_gender, service_id: r.service_id,
      staff_id: r.staff_id, staff_name: r.staff_name || "",
      date: isoToKey(r.date), start_min: r.start_min, end_min: r.end_min,
      buffer_minutes: r.buffer_minutes ?? 0, status: r.status,
      // A staff-proposed reschedule awaiting customer response — null/null/null
      // once there's no pending proposal (the normal case).
      pending_date: r.pending_date ? isoToKey(r.pending_date) : null,
      pending_start_min: r.pending_start_min ?? null,
      pending_end_min: r.pending_end_min ?? null,
      tracking_code: r.tracking_code,
      original_price: Number(r.original_price || 0),
      discount_type: r.discount_type, discount_value: Number(r.discount_value || 0),
      discount_reason: r.discount_reason || "",
      final_price: r.final_price === null ? null : Number(r.final_price),
      sms_sent_confirmation: r.sms_sent_confirmation,
      sms_sent_reminder: r.sms_sent_reminder,
      campaign_id: r.campaign_id ?? null,
      points_awarded: r.points_awarded ?? 0,
      created_at: ms(r.created_at),
    }),
    toRow: (b) => {
      const row = { ...b };
      if ("date" in row) row.date = keyToISO(row.date);
      if ("pending_date" in row) row.pending_date = row.pending_date ? keyToISO(row.pending_date) : null;
      if ("created_at" in row) delete row.created_at; // let Postgres own it
      delete row.points_awarded;                      // trigger-owned
      return row;
    },
  },

  time_offs: {
    fromRow: (r) => ({ id: r.id, date: isoToKey(r.date), reason: r.reason || "", staff_id: r.staff_id, start_min: r.start_min ?? null, end_min: r.end_min ?? null }),
    toRow: (t) => ({ id: t.id, date: keyToISO(t.date), reason: t.reason ?? "", staff_id: t.staff_id ?? null, start_min: t.start_min ?? null, end_min: t.end_min ?? null }),
  },

  expenses: {
    fromRow: (r) => ({
      id: r.id, title: r.title, category: r.category, amount: Number(r.amount || 0),
      date: isoToKey(r.date), note: r.note || "", created_at: ms(r.created_at),
    }),
    toRow: (e) => ({
      id: e.id, title: e.title ?? "", category: e.category ?? "other",
      amount: e.amount ?? 0, date: keyToISO(e.date), note: e.note ?? "",
    }),
  },

  waitlist: {
    fromRow: (r) => ({
      id: r.id, customer_name: r.customer_name, customer_phone: r.customer_phone,
      customer_gender: r.customer_gender, service_id: r.service_id,
      staff_id: r.staff_id, staff_name: r.staff_name || "",
      date: isoToKey(r.date), created_at: ms(r.created_at),
    }),
    toRow: (w) => ({
      id: w.id, customer_name: w.customer_name ?? "", customer_phone: w.customer_phone ?? "",
      customer_gender: w.customer_gender ?? "female", service_id: w.service_id ?? null,
      staff_id: w.staff_id ?? null, staff_name: w.staff_name ?? "", date: keyToISO(w.date),
    }),
  },
};

/* ------------------------------------------------------------------ helpers */
function fail(where, error) {
  if (error) console.error(`[salon/api] ${where}:`, error.message || error);
  return error || null;
}

// syncCollection/syncApprovedDates/saveWorkingHours run several Supabase
// calls in parallel and log each failure individually via fail() above —
// but fail() always RESOLVES (it returns the error, never throws), so
// `await Promise.all(jobs)` used to succeed even when every single job
// failed. That silently broke the contract usePersistedState relies on:
// its callers (setServices, setApprovedDates, ...) treat persist() settling
// successfully as "the database now matches the UI". Throwing the first
// real error here is what lets usePersistedState notice, notify the user,
// and roll the optimistic change back instead of leaving the UI showing a
// change (e.g. an "approved" day) that a later authoritative check — like
// create_public_booking's own approved_dates lookup — will disagree with.
function throwIfAny(results) {
  const firstError = results.find(Boolean);
  if (firstError) throw firstError;
}

const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));
const shallowEqual = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
};

/* ------------------------------------------------------------------- cache */
// In-memory, TTL-based. Deliberately opt-in and deliberately NOT applied to
// appointments/bookings/availability anywhere in this file — that data
// already has a realtime subscription (subscribeAppointments below) that
// pushes changes instantly, and a stale read of "what's free right now" is
// exactly how a booking system double-books someone. This cache is only
// wired into reads where a few seconds of staleness costs nothing: customer
// lists, campaign history, RFM segments, SMS templates/log, loyalty settings
// — the kind of data a manager glances at and can hit "refresh" on.
const CACHE_TTL_MS = 30_000;
const cacheStore = new Map(); // key -> { value, expiresAt }

function getCached(key) {
  const hit = cacheStore.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { cacheStore.delete(key); return undefined; }
  return hit.value;
}
function setCache(key, value, ttl = CACHE_TTL_MS) {
  cacheStore.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}
/** Drop every cached key whose name includes `pattern` (a plain substring, not regex). */
export function invalidateCache(pattern) {
  for (const key of cacheStore.keys()) {
    if (!pattern || key.includes(pattern)) cacheStore.delete(key);
  }
}
export function clearAllCache() {
  cacheStore.clear();
}
export function getCacheStats() {
  const now = Date.now();
  let live = 0, expired = 0;
  for (const { expiresAt } of cacheStore.values()) (expiresAt > now ? live++ : expired++);
  return { size: cacheStore.size, live, expired };
}

/**
 * Diff two arrays of {id,...} and push inserts / updates / deletes.
 * This is what lets `setServices(prev => ...)` keep working verbatim.
 */
export async function syncCollection(table, prev, next) {
  if (!SUPABASE_ENABLED) return;

  const m = map[table];
  const before = byId(prev), after = byId(next);

  const inserts = [], updates = [], deletes = [];
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) inserts.push(m.toRow(item));
    else if (!shallowEqual(m.toRow(old), m.toRow(item))) updates.push(m.toRow(item));
  }
  for (const id of before.keys()) if (!after.has(id)) deletes.push(id);

  const jobs = [];
  if (inserts.length) jobs.push(supabase.from(table).upsert(inserts).then(({ error }) => fail(`${table}.insert`, error)));
  for (const row of updates) {
    jobs.push(supabase.from(table).update(row).eq("id", row.id).then(({ error }) => fail(`${table}.update`, error)));
  }
  if (deletes.length) jobs.push(supabase.from(table).delete().in("id", deletes).then(({ error }) => fail(`${table}.delete`, error)));
  const results = await Promise.all(jobs);
  invalidateCache(table);
  throwIfAny(results);
}

/* -------------------------------------------------------------- single ops */
export async function insertOne(table, item) {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from(table).upsert(map[table].toRow(item));
  invalidateCache(table);
  return fail(`${table}.insertOne`, error);
}

export async function updateOne(table, id, patch) {
  if (!SUPABASE_ENABLED) return;
  const row = map[table].toRow({ id, ...patch });
  // only send the keys the caller actually patched (plus the converted date)
  const allowed = new Set([...Object.keys(patch), "date"]);
  const slim = Object.fromEntries(Object.entries(row).filter(([k]) => allowed.has(k)));
  const { error } = await supabase.from(table).update(slim).eq("id", id);
  invalidateCache(table);
  return fail(`${table}.updateOne`, error);
}

export async function deleteOne(table, id) {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from(table).delete().eq("id", id);
  invalidateCache(table);
  return fail(`${table}.deleteOne`, error);
}

/* ------------------------------------------------- working hours (special) */
// The app models these as a plain 7-element array with no ids, plus a
// { [stylistId]: array } map of overrides. Persist as a full replace per owner.
const WH_KEYS = ["day_of_week", "start_time", "end_time", "is_closed"];
const whFromRow = (r) => ({
  day_of_week: r.day_of_week, start_time: r.start_time,
  end_time: r.end_time, is_closed: r.is_closed,
});

export async function saveWorkingHours(staffId, hours) {
  if (!SUPABASE_ENABLED) return;
  const rows = (hours || []).map((h) => ({
    id: `wh-${staffId || "salon"}-${h.day_of_week}`,
    staff_id: staffId || null,
    day_of_week: h.day_of_week,
    start_time: h.start_time ?? "09:00",
    end_time: h.end_time ?? "21:00",
    is_closed: !!h.is_closed,
  }));
  const { error } = await supabase.from("working_hours").upsert(rows, { onConflict: "id" });
  const result = fail("working_hours.save", error);
  if (result) throw result;
}

export async function clearStaffWorkingHours(staffId) {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from("working_hours").delete().eq("staff_id", staffId);
  const result = fail("working_hours.clear", error);
  if (result) throw result;
}

/* ------------------------------------------------ approved dates (special) */
export async function syncApprovedDates(prev, next) {
  if (!SUPABASE_ENABLED) return;
  const before = new Set(prev || []), after = new Set(next || []);
  const added = [...after].filter((k) => !before.has(k)).map((k) => ({ date: keyToISO(k) }));
  const removed = [...before].filter((k) => !after.has(k)).map(keyToISO);

  const jobs = [];
  if (added.length) jobs.push(supabase.from("approved_dates").upsert(added, { onConflict: "date" }).then(({ error }) => fail("approved_dates.add", error)));
  if (removed.length) jobs.push(supabase.from("approved_dates").delete().in("date", removed).then(({ error }) => fail("approved_dates.remove", error)));
  const results = await Promise.all(jobs);
  throwIfAny(results);
}

/* ---------------------------------------------------------------- bootstrap */
/**
 * One parallel fetch of everything the app needs at startup.
 * Returns null when Supabase isn't configured, so App.jsx keeps its seed data.
 */
// v2.18 — just the slots (no services/stylists/etc), for re-fetching after
// a slot-change broadcast without re-running the whole bootstrap().
export async function fetchPublicSlots() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.from("appointments_public_slots").select("*").order("date");
  if (error) { fail("fetchPublicSlots", error); return []; }
  return (data || []).map(map.appointments.fromRow);
}

export async function bootstrap() {
  if (!SUPABASE_ENABLED) return null;

  const [svc, sty, appt, off, wh, appr, exp, wait] = await Promise.all([
    supabase.from("services").select("*").order("id"),
    supabase.from("stylists").select("*").order("id"),
    // v2.16: the PII-free slots view, not the raw table — this runs before
    // we know if the caller is staff or an anonymous visitor, and the
    // public booking flow only ever needs occupied-slot data here (who's
    // booked when, not who they are). Staff get the full dataset
    // separately via fetchFullAppointments() once a session is confirmed.
    supabase.from("appointments_public_slots").select("*").order("date"),
    supabase.from("time_offs").select("*"),
    supabase.from("working_hours").select("*").order("day_of_week"),
    supabase.from("approved_dates").select("date"),
    supabase.from("expenses").select("*").order("date", { ascending: false }),
    supabase.from("waitlist").select("*"),
  ]);

  const firstError = [svc, sty, appt, off, wh, appr, exp, wait].find((r) => r.error)?.error;
  if (firstError) {
    fail("bootstrap", firstError);
    return null;
  }

  const allHours = wh.data || [];
  const salonHours = allHours.filter((r) => r.staff_id === null).map(whFromRow)
    .sort((a, b) => a.day_of_week - b.day_of_week);

  const staffHours = {};
  for (const r of allHours.filter((x) => x.staff_id !== null)) {
    (staffHours[r.staff_id] ||= []).push(whFromRow(r));
  }
  for (const k of Object.keys(staffHours)) {
    staffHours[k].sort((a, b) => a.day_of_week - b.day_of_week);
  }

  return {
    services: (svc.data || []).map(map.services.fromRow),
    stylists: (sty.data || []).map(map.stylists.fromRow),
    bookings: (appt.data || []).map(map.appointments.fromRow),
    timeOff: (off.data || []).map(map.time_offs.fromRow),
    workingHours: salonHours.length === 7 ? salonHours : null,
    staffWorkingHours: staffHours,
    approvedDates: (appr.data || []).map((r) => isoToKey(r.date)),
    expenses: (exp.data || []).map(map.expenses.fromRow),
    waitlist: (wait.data || []).map(map.waitlist.fromRow),
  };
}

// v2.16 — the full appointments dataset (with customer PII), for staff
// only. Call once a session is confirmed; RLS scopes the result by role
// (manager: everything, stylist: their own bookings) same as any other
// staff-only read.
export async function fetchFullAppointments() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.from("appointments").select("*").order("date");
  if (error) { fail("fetchFullAppointments", error); return []; }
  return (data || []).map(map.appointments.fromRow);
}

// v2.19 — step 2 of booking-management OTP: verify the code (requested via
// requestBookingOtp in sms.js) and receive a random access token. Phone
// number and appointment_id are never sufficient on their own anymore —
// every booking-management call below requires this token.
export async function verifyBookingOtp(phone, otp) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("verify_booking_otp", { p_phone: phone, p_otp: otp });
  if (error) { fail("verify_booking_otp", error); return { ok: false, error: "خطا در تایید کد" }; }
  return data;
}

// v2.19 — a customer's own bookings, via the token issued by
// verifyBookingOtp (never by phone alone).
export async function fetchMyBookingsWithToken(token) {
  if (!SUPABASE_ENABLED || !token) return [];
  const { data, error } = await supabase.rpc("get_my_bookings_with_token", { p_token: token });
  if (error) { fail("get_my_bookings_with_token", error); return []; }
  return (data || []).map(map.appointments.fromRow);
}

export async function cancelMyBookingWithToken(token, appointmentId) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("cancel_my_booking_with_token", { p_token: token, p_appointment_id: appointmentId });
  if (error) { fail("cancel_my_booking_with_token", error); return { ok: false, error: "لغو ناموفق بود" }; }
  return data;
}

export async function rescheduleMyBookingWithToken(token, appointmentId, newDate, newStartMin) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("reschedule_my_booking_with_token", {
    p_token: token, p_appointment_id: appointmentId, p_new_date: newDate, p_new_start_min: newStartMin,
  });
  if (error) { fail("reschedule_my_booking_with_token", error); return { ok: false, error: "جابه‌جایی ناموفق بود" }; }
  return data;
}

// v2.19 — actually invalidate the access token server-side (not just
// clearing it from local state), so "log out" is a real security
// boundary rather than a UI-only reset.
export async function revokeBookingToken(token) {
  if (!SUPABASE_ENABLED || !token) return { ok: true };
  const { data, error } = await supabase.rpc("revoke_booking_token", { p_token: token });
  if (error) { fail("revoke_booking_token", error); return { ok: false }; }
  return data;
}

// v2.20 — DB-only OTP test path: a direct RPC call, no Edge Function
// involved at all. Refuses unless a manager has explicitly turned
// sms_test_mode on (one SQL line — see DEPLOY.md); safe to always try as
// a fallback since it's a no-op error otherwise.
export async function requestBookingOtpTestMode(phone) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("request_booking_otp_test", { p_phone: phone });
  if (error) { fail("request_booking_otp_test", error); return { ok: false, error: "خطا در دریافت کد تست" }; }
  return data;
}

// v2.19 — booking creation now happens entirely server-side: price,
// discount, end_min, and initial status are computed inside
// create_public_booking from services/loyalty tables, never trusted from
// this call's arguments beyond the customer's own choices (service,
// staff, date, time, name, phone, gender, optional referral code).
export async function createPublicBooking({ serviceId, staffId, date, startMin, customerName, customerPhone, customerGender, referralCode }) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("create_public_booking", {
    p_service_id: serviceId, p_staff_id: staffId ?? null, p_date: date, p_start_min: startMin,
    p_customer_name: customerName, p_customer_phone: customerPhone, p_customer_gender: customerGender,
    p_referral_code: referralCode ?? null,
  });
  if (error) { fail("create_public_booking", error); return { ok: false, error: "ثبت نوبت ناموفق بود" }; }
  return data;
}

/* ----------------------------------------------------------------- realtime */
/** Live-update the calendar when another device books. Returns an unsubscribe fn. */
export function subscribeAppointments(onChange) {
  if (!SUPABASE_ENABLED) return () => {};
  const channel = supabase
    .channel("appointments-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, (payload) => {
      onChange({
        type: payload.eventType || payload.type,
        row: payload.new && Object.keys(payload.new).length
          ? map.appointments.fromRow(payload.new)
          : null,
        oldId: payload.old?.id ?? null,
      });
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/* ----------------------------------- phase 3 & 4 reads (campaigns, loyalty) */
export async function fetchInactiveCustomers(days) {
  if (!SUPABASE_ENABLED) return [];
  const key = `inactive_customers:${days}`;
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("inactive_customers", { p_days: days });
  if (error) { fail("inactive_customers", error); return []; }
  return setCache(key, data || []);
}

export async function fetchRfmSegments() {
  if (!SUPABASE_ENABLED) return [];
  const key = "rfm_segments";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("get_customer_rfm_segments");
  if (error) { fail("get_customer_rfm_segments", error); return []; }
  return setCache(key, data || []);
}

// Per-customer × per-service-category recency (v2.11) — same caching
// pattern as fetchRfmSegments, invalidated together since both derive from
// the same underlying completed-appointments data.
export async function fetchCategoryMatrix() {
  if (!SUPABASE_ENABLED) return [];
  const key = "category_matrix";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("get_customer_category_matrix");
  if (error) { fail("get_customer_category_matrix", error); return []; }
  return setCache(key, data || []);
}

export async function fetchCustomers() {
  if (!SUPABASE_ENABLED) return [];
  const key = "customers";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .order("last_booking_at", { ascending: false })
    .limit(500);
  if (error) { fail("customers", error); return []; }
  return setCache(key, data || []);
}

// Links a new customer to whoever referred them, and awards points to both
// sides — mirrors public.apply_referral() in schema.sql exactly. Call this
// only AFTER the referred customer's first appointment has been inserted
// (their row is created by the sync_customer_from_appointment trigger, so
// calling this any earlier would fail the "referrer.phone = p_new_phone"
// / customer-not-found checks on the database side).
export async function applyReferral(newPhone, code) {
  if (!SUPABASE_ENABLED || !code) return { ok: false, error: "دمو یا کد خالی" };
  const { data, error } = await supabase.rpc("apply_referral", { p_new_phone: newPhone, p_code: code });
  if (error) { fail("apply_referral", error); return { ok: false, error: error.message }; }
  invalidateCache("customers");
  return data || { ok: false };
}

// Anti-fraud check at checkout: does this customer have a referrer on file?
// If so, staff must verify them as genuinely new before the referral reward
// is awarded (see sync_customer_from_appointment / referral_verified).
export async function fetchCustomerReferredBy(phone) {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase.from("customers").select("referred_by").eq("phone", phone).maybeSingle();
  if (error) { fail("fetchCustomerReferredBy", error); return null; }
  return data?.referred_by || null;
}

export async function fetchCampaigns() {
  if (!SUPABASE_ENABLED) return [];
  const key = "campaigns";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { fail("campaigns", error); return []; }
  return setCache(key, data || []);
}

export async function fetchCustomerLoyalty(phone) {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase.rpc("customer_loyalty", { p_phone: phone });
  if (error) { fail("customer_loyalty", error); return null; }
  return data;
}

// Staff-triggered: customer has reached the discount cap and is redeeming it
// in person. Resets their points to zero server-side (see redeem_loyalty_reward
// in schema.sql) — mirrors public.redeem_loyalty_reward's own permission and
// cap checks, so this always reflects exactly what the database allows.
export async function redeemLoyaltyReward(phone) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { data, error } = await supabase.rpc("redeem_loyalty_reward", { p_phone: phone });
  if (error) { fail("redeem_loyalty_reward", error); return { ok: false, error: error.message }; }
  invalidateCache("customers");
  return data || { ok: false };
}

export async function fetchSmsTemplates() {
  if (!SUPABASE_ENABLED) return [];
  const key = "sms_templates";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.from("sms_templates").select("*").order("kind");
  if (error) { fail("sms_templates", error); return []; }
  return setCache(key, data || []);
}

export async function fetchSmsLog(limit = 100) {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase
    .from("sms_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { fail("sms_messages", error); return []; }
  return data || [];
}

/* ------------------------------------------------------- phase 3: campaigns */
export async function createCampaign(campaign) {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      id: campaign.id,
      name: campaign.name,
      inactive_days: campaign.inactive_days,
      discount_percent: campaign.discount_percent,
      template_id: campaign.template_id ?? null,
      valid_until: campaign.valid_until ?? null,
      targeted_count: campaign.targeted_count ?? 0,
      status: "draft",
    })
    .select()
    .maybeSingle();
  if (error) { fail("campaigns.create", error); return null; }
  invalidateCache("campaigns");
  return data;
}

// v2.13 — records one bulk send for per-template conversion tracking,
// independent of the campaigns/campaign_targets pair above. Call this
// BEFORE sendBulkSms, then pass the returned id as campaign_log_id on each
// message so the attribution trigger can later find it by phone number.
// id is DB-generated (not client-side) — we read it back via .select().
export async function logCampaignSend({ templateId, templateLabel, segment, totalSent }) {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase
    .from("campaign_logs")
    .insert({
      template_id: templateId ?? null,
      template_label: templateLabel ?? "",
      segment: segment ?? null,
      total_sent: totalSent ?? 0,
      successful_count: 0, // updated after the send completes, via updateCampaignLogResult
    })
    .select()
    .maybeSingle();
  if (error) { fail("campaign_logs.create", error); return null; }
  return data;
}

// v2.13 — after sendBulkSms resolves, record how many actually succeeded.
export async function updateCampaignLogResult(campaignLogId, successfulCount) {
  if (!SUPABASE_ENABLED || !campaignLogId) return;
  const { error } = await supabase
    .from("campaign_logs")
    .update({ successful_count: successfulCount })
    .eq("id", campaignLogId);
  if (error) fail("campaign_logs.update", error);
  invalidateCache("campaign_performance");
}

// v2.13 — per-template conversion rate and attributed revenue. Pass a
// template_id to scope to one template, or omit for the full breakdown
// (used for the BI comparison chart and the "بهترین عملکرد" suggester).
export async function fetchCampaignPerformance(templateId = null) {
  if (!SUPABASE_ENABLED) return [];
  const key = `campaign_performance:${templateId ?? "all"}`;
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("get_campaign_performance", { p_template_id: templateId });
  if (error) { fail("get_campaign_performance", error); return []; }
  return setCache(key, data || []);
}

export async function addCampaignTargets(campaignId, phones) {
  if (!SUPABASE_ENABLED || !phones.length) return;
  const rows = phones.map((phone) => ({ campaign_id: campaignId, customer_phone: phone }));
  const { error } = await supabase
    .from("campaign_targets")
    .upsert(rows, { onConflict: "campaign_id,customer_phone" });
  invalidateCache("campaigns");
  return fail("campaign_targets.add", error);
}

/* --------------------------------------------------------- phase 4: loyalty */
export async function fetchLoyaltySettings() {
  if (!SUPABASE_ENABLED) return null;
  const key = "loyalty_settings";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.from("loyalty_settings").select("*").eq("id", 1).maybeSingle();
  if (error) { fail("loyalty_settings.fetch", error); return null; }
  return setCache(key, data);
}

export async function updateLoyaltySettings(patch) {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from("loyalty_settings").update(patch).eq("id", 1);
  invalidateCache("loyalty_settings");
  return fail("loyalty_settings.update", error);
}

// Customer segmentation thresholds (manager-only to change; see RLS on
// customer_segment_settings) — same shape as the loyalty_settings pair above.
export async function fetchSegmentSettings() {
  if (!SUPABASE_ENABLED) return null;
  const key = "segment_settings";
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.from("customer_segment_settings").select("*").eq("id", 1).maybeSingle();
  if (error) { fail("segment_settings.fetch", error); return null; }
  return setCache(key, data);
}

export async function updateSegmentSettings(payload) {
  if (!SUPABASE_ENABLED) return;
  const { error } = await supabase.from("customer_segment_settings").update(payload).eq("id", 1);
  invalidateCache("segment_settings");
  // Changing the thresholds changes who falls into which segment, so any
  // already-cached get_customer_rfm_segments() result is now stale too.
  invalidateCache("rfm_segments");
  return fail("segment_settings.update", error);
}

// Live "what would this look like" preview against a hypothetical set of
// thresholds — never cached, since it's driven by in-progress form input
// that changes on every keystroke.
export async function previewSegmentDistribution({ recency, visits, inactive }) {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.rpc("preview_customer_segment_distribution", {
    p_recency: recency, p_visits: visits, p_inactive: inactive,
  });
  if (error) { fail("preview_customer_segment_distribution", error); return []; }
  return data || [];
}

// v2.14 — public feedback submission, no auth. booking_id is the bearer
// token; RLS (p_feedback_insert) enforces it's a completed booking with no
// existing feedback.
export async function submitFeedback({ bookingId, rating, tags, comment }) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { error } = await supabase.from("feedbacks").insert({
    booking_id: bookingId, rating, tags: tags || [], comment: comment?.trim() || "",
  });
  if (error) return { ok: false, error: error.code === "23505" ? "نظر شما قبلاً ثبت شده" : "ثبت نظر ناموفق بود" };
  return { ok: true };
}

// v2.18 — average rating + distribution, for the BI card. Manager-only
// (RLS on the RPC), same rule as any other salon-wide report.
export async function fetchFeedbackStats() {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase.rpc("get_feedback_stats");
  if (error) { fail("get_feedback_stats", error); return null; }
  return Array.isArray(data) ? data[0] : data;
}

// v2.18 — lightweight signal-only replacement for postgres_changes, which
// stopped delivering events to anonymous callers once appointments' RLS
// was scoped to staff only (v2.16, closing the PII leak that RLS-open
// table let anonymous subscribers read too). Broadcast doesn't read table
// rows — it's pure pub/sub messaging on a channel — so it works the same
// for every caller regardless of RLS. A listener just gets a "something
// changed" ping and re-fetches the public slots view itself; no row
// content ever crosses this channel.
const SLOT_CHANGE_CHANNEL = "salon-slot-changes";

export function subscribeSlotChanges(onChange) {
  if (!SUPABASE_ENABLED) return () => {};
  const channel = supabase
    .channel(SLOT_CHANGE_CHANNEL)
    .on("broadcast", { event: "changed" }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export async function broadcastSlotChange() {
  if (!SUPABASE_ENABLED) return;
  const channel = supabase.channel(SLOT_CHANGE_CHANNEL);
  await new Promise((resolve) => channel.subscribe((status) => status === "SUBSCRIBED" && resolve()));
  await channel.send({ type: "broadcast", event: "changed", payload: {} });
  supabase.removeChannel(channel);
}


