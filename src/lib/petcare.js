/* ============================================================
   v2.49 — pet care data layer: grooming status, visit reports
   (photos + health checklist + product picks), consent/transport
   settings, prepaid packages. Demo mode keeps everything in memory.
   ============================================================ */
import { supabase, SUPABASE_ENABLED, getCurrentSalonId } from "./supabase";
import { shrinkImage } from "./api";

const BUCKET = "pet-photos";
const log = (where, e) => console.error(`[petcare] ${where}:`, e?.message || e);
const rid = () => (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9-]/g, "");

export const GROOM_STAGES = [
  { id: "arrived", label: "رسید" },
  { id: "bathing", label: "حمام" },
  { id: "grooming", label: "اصلاح" },
  { id: "ready", label: "آماده" },
];
export const STAGE_LABEL = { arrived: "تحویل گرفته شد", bathing: "در حال حمام", grooming: "در حال اصلاح", ready: "آمادهٔ تحویل" };

export const HEALTH_CHECKS = [
  { id: "fleas", label: "کک", hint: "کک دیده شد" },
  { id: "ticks", label: "کنه", hint: "کنه دیده شد" },
  { id: "skin", label: "مشکل پوستی", hint: "قرمزی، زخم یا ریزش موی موضعی" },
  { id: "ears", label: "گوش", hint: "گوش کثیف یا ملتهب" },
  { id: "eyes", label: "چشم", hint: "ترشح یا قرمزی چشم" },
  { id: "teeth", label: "دندان", hint: "جرم یا بوی بد دهان" },
  { id: "matting", label: "گره شدید", hint: "موها گره‌خورده بود" },
  { id: "nails", label: "ناخن بلند", hint: "ناخن‌ها خیلی بلند بود" },
];
export const BEHAVIOR_LABEL = { calm: "آرام و همکار", nervous: "کمی مضطرب", aggressive: "پرخاشگر" };

export const DEFAULT_PET_CARE = {
  pet_ready_sms: true, pet_reminders_enabled: true, pet_cycle_days: 42, pet_birthday_message: "",
  pet_consent_mode: "risky",
  pet_consent_text: "صحت اطلاعات حیوان را تایید می‌کنم. در صورت گره‌خوردگی شدید، تراشیدن موها و در صورت لزوم استفاده از پوزه‌بند را می‌پذیرم. مسئولیت بیماری‌های پنهان یا حساسیت‌هایی که اعلام نشده‌اند با سالن نیست.",
  pet_transport_enabled: false, pet_transport_fee: 0, pet_transport_area: "", pet_large_capacity: null,
  pet_vet_partner: "", // v2.51
};
const SETTING_KEYS = Object.keys(DEFAULT_PET_CARE);

/** Is consent needed for this pet? risky = aggressive or 10+ years old. */
export function consentRequired(mode, pet) {
  if (mode === "always") return true;
  if (mode !== "risky" || !pet) return false;
  if (pet.temperament === "aggressive") return true;
  if (pet.birth_date) {
    const age = (Date.now() - new Date(pet.birth_date).getTime()) / (365.25 * 86400000);
    if (age >= 10) return true;
  }
  return false;
}

/** Large/giant dogs already booked over [start, end) on a day (all groomers). */
export function largeDogsAt(bookings, dateKey, start, end, exceptId) {
  const ACTIVE = ["pending", "confirmed", "rescheduled", "reschedule_proposed", "awaiting_payment"];
  return bookings.filter((b) => b.id !== exceptId && b.date === dateKey && ACTIVE.includes(b.status)
    && (b.pet_size === "large" || b.pet_size === "giant") && b.start_min < end && b.end_min > start).length;
}

/* -------------------------------------------------------------- demo ---- */
const demo = {
  settings: { ...DEFAULT_PET_CARE, pet_transport_enabled: true, pet_transport_fee: 150000, pet_transport_area: "تا شعاع ۵ کیلومتری سالن", pet_large_capacity: 2 },
  reports: {},      // appointment_id → report
  packages: null,
  purchases: [],
};
function demoPackages() {
  if (!demo.packages) demo.packages = [];
  return demo.packages;
}

/* ---------------------------------------------------------- settings ---- */
export async function fetchPublicPetCare() {
  if (!SUPABASE_ENABLED) {
    const s = demo.settings;
    return { consent_mode: s.pet_consent_mode, consent_text: s.pet_consent_text, transport_enabled: s.pet_transport_enabled,
      transport_fee: s.pet_transport_fee, transport_area: s.pet_transport_area, large_capacity: s.pet_large_capacity };
  }
  const { data, error } = await supabase.rpc("pet_care_settings");
  if (error) { if (!/pet_care_settings|function/i.test(error.message || "")) log("pet_care_settings", error); return null; }
  return data;
}
export async function fetchPetCareSettings() {
  if (!SUPABASE_ENABLED) return { ...demo.settings };
  let { data, error } = await supabase.from("app_settings").select(SETTING_KEYS.join(", ")).eq("salon_id", getCurrentSalonId()).maybeSingle();
  if (error && /pet_vet_partner/.test(error.message || "")) { // database before v2.51
    ({ data, error } = await supabase.from("app_settings").select(SETTING_KEYS.filter((k) => k !== "pet_vet_partner").join(", ")).eq("salon_id", getCurrentSalonId()).maybeSingle());
  }
  if (error) { log("app_settings pet care", error); return null; }
  return { ...DEFAULT_PET_CARE, ...(data || {}) };
}
export async function savePetCareSettings(patch) {
  const row = Object.fromEntries(Object.entries(patch).filter(([k]) => SETTING_KEYS.includes(k)));
  if (!SUPABASE_ENABLED) { Object.assign(demo.settings, row); return { ok: true }; }
  const { error } = await supabase.from("app_settings").update(row).eq("salon_id", getCurrentSalonId());
  if (error) { log("app_settings pet care save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}

/* ------------------------------------------------------ grooming stage ---- */
export async function setGroomStage(appointmentId, stage) {
  if (!SUPABASE_ENABLED) return { ok: true, demo: true };
  const { data, error } = await supabase.rpc("set_groom_stage", { p_appt: appointmentId, p_stage: stage });
  if (error) { log("set_groom_stage", error); return { ok: false, error: "ثبت ناموفق بود" }; }
  return data;
}

/* -------------------------------------------------------- visit report ---- */
export function petPhotoUrl(path) {
  if (!path) return null;
  if (path.startsWith("blob:") || path.startsWith("data:")) return path;
  if (!SUPABASE_ENABLED) return null;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data?.publicUrl || null;
}
/** kind: "before" | "after" | "vaccine" → {ok, path} */
export async function uploadPetPhoto(appointmentIdOrPetId, kind, file) {
  if (!SUPABASE_ENABLED) return { ok: true, path: URL.createObjectURL(file) };
  const blob = await shrinkImage(file, 1400, 0.82);
  if (!blob) return { ok: false, error: "این عکس قابل استفاده نیست" };
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  const path = kind === "vaccine"
    ? `${getCurrentSalonId()}/vaccine/${rid()}.${ext}`
    : `${getCurrentSalonId()}/${appointmentIdOrPetId}/${kind}-${rid()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
  if (error) { log("pet photo upload", error); return { ok: false, error: "آپلود عکس ناموفق بود" }; }
  return { ok: true, path };
}
export async function fetchVisitReport(appointmentId) {
  if (!SUPABASE_ENABLED) return demo.reports[appointmentId] || null;
  const { data, error } = await supabase.from("pet_visit_reports").select("*").eq("appointment_id", appointmentId).maybeSingle();
  if (error) { if (!/pet_visit_reports/i.test(error.message || "")) log("pet_visit_reports", error); return null; }
  return data;
}
/** All reports of one pet (newest first) — the profile's history & gallery. */
export async function fetchPetReports(petId, appointmentIds = []) {
  if (!SUPABASE_ENABLED) {
    return Object.values(demo.reports).filter((r) => r.pet_id === petId || appointmentIds.includes(r.appointment_id))
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }
  if (!petId) return [];
  const { data, error } = await supabase.from("pet_visit_reports").select("*").eq("pet_id", petId).order("created_at", { ascending: false }).limit(50);
  if (error) { log("pet reports", error); return []; }
  return data || [];
}
export async function saveVisitReport(booking, { checks, note, photos, before, after, productIds, send }) {
  if (!SUPABASE_ENABLED) {
    demo.reports[booking.id] = {
      appointment_id: booking.id, pet_id: booking.pet_id || null, pet_name: booking.pet_name, date: booking.date,
      checks, note, photos, demoBefore: before, demoAfter: after, product_ids: productIds, created_at: new Date().toISOString(), sent_at: send ? new Date().toISOString() : null,
    };
    return { ok: true, sent: !!send, demo: true };
  }
  const { data, error } = await supabase.rpc("save_visit_report", {
    p_appt: booking.id, p_checks: checks, p_note: note || "", p_photos: photos, p_product_ids: productIds, p_send: !!send,
  });
  if (error) { log("save_visit_report", error); return { ok: false, error: "ذخیرهٔ گزارش ناموفق بود" }; }
  return data;
}
/** The owner's page (/visit?token=…). */
export async function getVisitReport(token) {
  if (!SUPABASE_ENABLED) return { ok: false };
  const { data, error } = await supabase.rpc("get_visit_report", { p_token: token });
  if (error) { log("get_visit_report", error); return { ok: false }; }
  return data;
}
export async function fetchMyVisitReports(token) {
  if (!SUPABASE_ENABLED || !token) return [];
  const { data, error } = await supabase.rpc("my_visit_reports_with_token", { p_token: token });
  if (error) { if (!/my_visit_reports/i.test(error.message || "")) log("my_visit_reports", error); return []; }
  return Array.isArray(data) ? data : [];
}

/* ---------------------------------------------------------- transport ---- */
export async function requestPetTransport(appointmentId, phone, address) {
  if (!SUPABASE_ENABLED) return { ok: true, fee: demo.settings.pet_transport_fee, demo: true };
  const { data, error } = await supabase.rpc("request_pet_transport", { p_appt: appointmentId, p_phone: phone, p_address: address });
  if (error) { log("request_pet_transport", error); return { ok: false, error: "ثبت سرویس رفت‌وبرگشت ناموفق بود" }; }
  return data;
}

/* ----------------------------------------------------------- packages ---- */
export async function fetchPublicPackages() {
  if (!SUPABASE_ENABLED) return demoPackages().filter((k) => k.active).map((k) => ({ ...k }));
  const { data, error } = await supabase.rpc("get_pet_packages");
  if (error) { if (!/get_pet_packages|function/i.test(error.message || "")) log("get_pet_packages", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function fetchPackages() {
  if (!SUPABASE_ENABLED) return demoPackages().map((k) => ({ ...k }));
  const { data, error } = await supabase.from("pet_packages").select("*").order("created_at");
  if (error) { log("pet_packages", error); return []; }
  return data || [];
}
export async function savePackage(k, services) {
  const row = { name: (k.name || "").trim(), service_id: k.service_id, sessions: Number(k.sessions), price: Math.round(Number(k.price) || 0),
    valid_days: Number(k.valid_days) || 180, active: k.active !== false };
  if (!row.name || !row.service_id) return { ok: false, error: "نام و خدمت بسته لازم است" };
  if (!(row.sessions >= 2 && row.sessions <= 50)) return { ok: false, error: "تعداد جلسات ۲ تا ۵۰" };
  if (row.price < 1000) return { ok: false, error: "قیمت بسته را وارد کنید" };
  if (!SUPABASE_ENABLED) {
    const svc = services.find((s) => s.id === row.service_id);
    const extra = { service_name: svc?.name || "", single_price: svc?.price || 0 };
    if (k.id) Object.assign(demoPackages().find((x) => x.id === k.id), row, extra);
    else demoPackages().push({ id: `demo-k-${rid().slice(0, 8)}`, ...row, ...extra });
    return { ok: true };
  }
  const q = k.id ? supabase.from("pet_packages").update(row).eq("id", k.id)
    : supabase.from("pet_packages").insert({ ...row, salon_id: getCurrentSalonId() });
  const { error } = await q;
  if (error) { log("pet_packages.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function fetchPurchases(phone) {
  if (!SUPABASE_ENABLED) return demo.purchases.filter((p) => !phone || p.customer_phone === phone).map((p) => ({ ...p }));
  let q = supabase.from("package_purchases").select("*").order("created_at", { ascending: false }).limit(200);
  if (phone) q = q.eq("customer_phone", phone);
  const { data, error } = await q;
  if (error) { if (!/package_purchases/i.test(error.message || "")) log("package_purchases", error); return []; }
  return data || [];
}
export async function sellPackage(pkg, phone, name) {
  if (!/^09\d{9}$/.test(phone || "")) return { ok: false, error: "شماره موبایل نامعتبر است" };
  if (!SUPABASE_ENABLED) {
    const exp = new Date(Date.now() + pkg.valid_days * 86400000).toISOString().slice(0, 10);
    demo.purchases.unshift({ id: `demo-pu-${rid().slice(0, 8)}`, package_id: pkg.id, package_name: pkg.name, service_id: pkg.service_id,
      customer_phone: phone, customer_name: name || "", sessions_total: pkg.sessions, sessions_left: pkg.sessions, price_paid: pkg.price,
      expires_at: exp, created_at: new Date().toISOString() });
    return { ok: true };
  }
  const { data, error } = await supabase.rpc("sell_package", { p_package: pkg.id, p_phone: phone, p_name: name || "" });
  if (error) { log("sell_package", error); return { ok: false, error: "ثبت فروش ناموفق بود" }; }
  return data;
}
export async function redeemPackageSession(purchase, booking) {
  if (!SUPABASE_ENABLED) {
    const p = demo.purchases.find((x) => x.id === purchase.id);
    if (!p || p.sessions_left <= 0) return { ok: false, error: "بسته تمام شده" };
    p.sessions_left -= 1;
    const extras = (booking.extra_charges || []).reduce((t, x) => t + (Number(x.amount) || 0), 0);
    return { ok: true, left: p.sessions_left, final_price: extras };
  }
  const { data, error } = await supabase.rpc("use_package_session", { p_purchase: purchase.id, p_appt: booking.id });
  if (error) { log("use_package_session", error); return { ok: false, error: "ثبت ناموفق بود" }; }
  return data;
}
export async function fetchMyPackages(token) {
  if (!SUPABASE_ENABLED || !token) return [];
  const { data, error } = await supabase.rpc("my_packages_with_token", { p_token: token });
  if (error) { if (!/my_packages/i.test(error.message || "")) log("my_packages", error); return []; }
  return Array.isArray(data) ? data : [];
}
