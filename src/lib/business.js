/* ============================================================
   v2.50 / v2.51 — client data layer for the business tools:
   revenue extras, salon profile, coupons, gift cards, commission,
   online packages, supplies, check-in, branches, two-step login,
   backups. Demo mode keeps a small in-memory store where it helps
   the flow make sense; server-only features say so.
   ============================================================ */
import { supabase, SUPABASE_ENABLED, getCurrentSalonId } from "./supabase";
import { shrinkImage } from "./api";

const log = (where, e) => console.error(`[business] ${where}:`, e?.message || e);
const missing = (e, name) => new RegExp(name, "i").test(e?.message || "");
const DEMO_OFF = { ok: false, error: "در حالت دمو (بدون دیتابیس) در دسترس نیست" };
const rid = () => (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9-]/g, "");

async function rpc(name, args, fallbackError = "انجام نشد — دوباره امتحان کنید") {
  const { data, error } = await supabase.rpc(name, args);
  if (error) { if (!missing(error, name)) log(name, error); return { ok: false, error: fallbackError }; }
  return data;
}

/* ------------------------------------------------------------- demo ---- */
const demo = {
  coupons: [{ id: "demo-c1", code: "YALDA20", percent: 20, amount: null, scope: "both", min_total: 0, max_uses: 100, used_count: 3, valid_until: null, active: true }],
  gifts: [],
  supplies: [
    { id: "demo-s1", name: "شامپو", unit: "لیتر", qty: 6, low_at: 2, active: true },
    { id: "demo-s2", name: "تیغ ماشین اصلاح", unit: "عدد", qty: 1, low_at: 2, active: true },
  ],
  profile: { about: "", address: "", phone: "", instagram: "", map_url: "", gallery: [], show_reviews: true },
};

/* ---------------------------------------------------------- revenue ---- */
export async function fetchRevenueExtras(from, to) {
  if (!SUPABASE_ENABLED) return { ok: true, demo: true, shop_revenue: 0, shop_orders: 0, packages_revenue: 0, packages_count: 0, gift_cards_revenue: 0, gift_cards_outstanding: 0, top_products: [], low_stock: [] };
  return rpc("revenue_extras", { p_from: from, p_to: to });
}

/* ---------------------------------------------------------- profile ---- */
export const GALLERY_BUCKET = "salon-gallery";
export function galleryUrl(path) {
  if (!path) return null;
  if (path.startsWith("blob:")) return path;
  if (!SUPABASE_ENABLED) return null;
  return supabase.storage.from(GALLERY_BUCKET).getPublicUrl(path).data?.publicUrl || null;
}
export async function fetchPublicProfile() {
  if (!SUPABASE_ENABLED) return { demo: true, name: "", about: "این صفحه در نسخهٔ واقعی از اطلاعات سالن پر می‌شود.", address: "", phone: "", instagram: "", map_url: "", gallery: [], hours: [], rating: { avg: null, count: 0 }, reviews: [], shop: true, ...demo.profile };
  const { data, error } = await supabase.rpc("get_salon_profile");
  if (error) { log("get_salon_profile", error); return null; }
  return data;
}
export async function fetchProfileSettings() {
  if (!SUPABASE_ENABLED) return { ...demo.profile };
  const { data, error } = await supabase.from("salon_profiles").select("*").maybeSingle();
  if (error) { if (!missing(error, "salon_profiles")) log("salon_profiles", error); return null; }
  return { ...demo.profile, ...(data || {}) };
}
export async function saveProfileSettings(p) {
  const row = {
    about: (p.about || "").trim().slice(0, 1500), address: (p.address || "").trim().slice(0, 300), phone: (p.phone || "").trim().slice(0, 20),
    instagram: (p.instagram || "").trim().replace(/^@/, "").slice(0, 30), map_url: (p.map_url || "").trim(),
    gallery: (p.gallery || []).slice(0, 24), show_reviews: p.show_reviews !== false,
    // v2.53: where 5-star clients are sent (sent only when set, for older databases)
    ...(p.review_url != null && (p.review_url || p.hadReviewUrl) ? { review_url: (p.review_url || "").trim() } : {}),
  };
  if (row.map_url && !/^https:\/\//.test(row.map_url)) return { ok: false, error: "لینک نقشه باید با https شروع شود" };
  if (row.review_url && !/^https:\/\/\S{4,250}$/.test(row.review_url)) return { ok: false, error: "لینک ثبت نظر باید با https شروع شود" };
  if (row.instagram && !/^[A-Za-z0-9._]+$/.test(row.instagram)) return { ok: false, error: "نام کاربری اینستاگرام نامعتبر است" };
  if (!SUPABASE_ENABLED) { Object.assign(demo.profile, row); return { ok: true }; }
  const { error } = await supabase.from("salon_profiles").upsert({ salon_id: getCurrentSalonId(), ...row, updated_at: new Date().toISOString() }, { onConflict: "salon_id" });
  if (error) { log("salon_profiles.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}
export async function uploadGalleryPhoto(file) {
  if (!SUPABASE_ENABLED) return { ok: true, path: URL.createObjectURL(file) };
  const blob = await shrinkImage(file, 1600, 0.82);
  if (!blob) return { ok: false, error: "این عکس قابل استفاده نیست" };
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  const path = `${getCurrentSalonId()}/${rid()}.${ext}`;
  const { error } = await supabase.storage.from(GALLERY_BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg" });
  if (error) { log("gallery upload", error); return { ok: false, error: "آپلود ناموفق بود" }; }
  return { ok: true, path };
}

/* ---------------------------------------------------------- coupons ---- */
function demoCouponValue(code, scope, total) {
  const c = demo.coupons.find((x) => x.code === String(code || "").trim().toUpperCase() && x.active);
  if (!c) return { ok: false, error: "کد تخفیف معتبر نیست" };
  if (c.scope !== "both" && c.scope !== scope) return { ok: false, error: scope === "shop" ? "این کد برای فروشگاه نیست" : "این کد برای نوبت نیست" };
  if (total < c.min_total) return { ok: false, error: "مبلغ خرید برای این کد کم است" };
  return { ok: true, code: c.code, discount: c.percent ? Math.round((total * c.percent) / 100) : Math.min(c.amount, total) };
}
export async function checkCoupon(code, scope, total, phone) {
  if (!String(code || "").trim()) return { ok: false, error: "کد را وارد کنید" };
  if (!SUPABASE_ENABLED) return demoCouponValue(code, scope, total);
  return rpc("check_coupon", { p_code: code, p_scope: scope, p_total: Math.round(total), p_phone: phone || null });
}
export async function applyBookingCoupon(appointmentId, phone, code, total) {
  if (!SUPABASE_ENABLED) return demoCouponValue(code, "booking", total || 0);
  return rpc("apply_booking_coupon", { p_appt: appointmentId, p_phone: phone, p_code: code });
}
export async function fetchCoupons() {
  if (!SUPABASE_ENABLED) return demo.coupons.map((c) => ({ ...c }));
  const { data, error } = await supabase.from("coupons").select("*").order("created_at", { ascending: false });
  if (error) { if (!missing(error, "coupons")) log("coupons", error); return []; }
  return data || [];
}
export async function saveCoupon(c) {
  const kind = c.kind === "amount" ? "amount" : "percent";
  const row = {
    code: String(c.code || "").trim().toUpperCase(), scope: c.scope || "both",
    percent: kind === "percent" ? Number(c.value) || null : null, amount: kind === "amount" ? Number(c.value) || null : null,
    min_total: Number(c.min_total) || 0, max_uses: c.max_uses === "" || c.max_uses == null ? null : Number(c.max_uses),
    valid_until: c.valid_until || null, active: c.active !== false,
  };
  if (!/^[A-Z0-9آ-ی]{3,20}$/.test(row.code)) return { ok: false, error: "کد ۳ تا ۲۰ حرف یا رقم بدون فاصله" };
  if (kind === "percent" && !(row.percent >= 1 && row.percent <= 100)) return { ok: false, error: "درصد بین ۱ تا ۱۰۰" };
  if (kind === "amount" && !(row.amount >= 1000)) return { ok: false, error: "مبلغ تخفیف را وارد کنید" };
  if (!SUPABASE_ENABLED) {
    if (c.id) Object.assign(demo.coupons.find((x) => x.id === c.id), row);
    else demo.coupons.unshift({ id: `demo-c-${rid().slice(0, 6)}`, used_count: 0, ...row });
    return { ok: true };
  }
  const q = c.id ? supabase.from("coupons").update(row).eq("id", c.id) : supabase.from("coupons").insert({ ...row, salon_id: getCurrentSalonId() });
  const { error } = await q;
  if (error) { log("coupons.save", error); return { ok: false, error: /duplicate|unique/i.test(error.message || "") ? "این کد قبلاً ساخته شده" : "ذخیره ناموفق بود" }; }
  return { ok: true };
}

/* ------------------------------------------------------- gift cards ---- */
export async function fetchGiftCards() {
  if (!SUPABASE_ENABLED) return demo.gifts.map((g) => ({ ...g }));
  const { data, error } = await supabase.from("gift_cards").select("*").neq("status", "cancelled").order("created_at", { ascending: false }).limit(200);
  if (error) { if (!missing(error, "gift_cards")) log("gift_cards", error); return []; }
  return data || [];
}
export async function issueGiftCard({ amount, recipientPhone, recipientName, buyerName, message }) {
  if (!SUPABASE_ENABLED) {
    const code = "G" + Math.random().toString(36).slice(2, 10).toUpperCase().replace(/[01OIL]/g, "7");
    demo.gifts.unshift({ id: rid(), code, amount, balance: amount, recipient_phone: recipientPhone, recipient_name: recipientName, buyer_name: buyerName,
      message, status: "active", sold_at_desk: true, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) });
    return { ok: true, code };
  }
  return rpc("issue_gift_card", { p_amount: Math.round(amount), p_recipient_phone: recipientPhone, p_recipient_name: recipientName || "", p_buyer_name: buyerName || "", p_message: message || "" });
}
export async function buyGiftCardOnline({ amount, buyerName, buyerPhone, recipientName, recipientPhone, message }) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("create_gift_card", { p_amount: Math.round(amount), p_buyer_name: buyerName, p_buyer_phone: buyerPhone, p_recipient_name: recipientName, p_recipient_phone: recipientPhone, p_message: message || "" });
}
export async function giftCardBalance(code) {
  if (!SUPABASE_ENABLED) {
    const g = demo.gifts.find((x) => x.code === String(code || "").trim().toUpperCase());
    return g ? { ok: true, balance: g.balance, expires_at: g.expires_at } : { ok: false, error: "کارت هدیه پیدا نشد" };
  }
  return rpc("gift_card_balance", { p_code: code });
}
export async function redeemGiftCard(code, booking) {
  if (!SUPABASE_ENABLED) {
    const g = demo.gifts.find((x) => x.code === String(code || "").trim().toUpperCase() && x.status === "active");
    if (!g || g.balance <= 0) return { ok: false, error: "کارت هدیه معتبر نیست یا اعتبارش تمام شده" };
    const used = Math.min(g.balance, booking.final_price || 0);
    g.balance -= used;
    return { ok: true, used, balance: g.balance, final_price: (booking.final_price || 0) - used };
  }
  return rpc("redeem_gift_card", { p_code: code, p_appt: booking.id });
}

/* ------------------------------------------------- online purchases ---- */
export async function buyPackageOnline(pkgId, phone, name) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("buy_package_online", { p_package: pkgId, p_phone: phone, p_name: name || "" });
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
/** kind: "gift" | "package" → {ok, url} */
export function startPurchasePayment(kind, id) {
  if (!SUPABASE_ENABLED) return Promise.resolve(DEMO_OFF);
  return invokePayment({ action: "request", ...(kind === "gift" ? { gift_card_id: id } : { package_purchase_id: id }) });
}

/* ------------------------------------------------------- commission ---- */
export async function fetchCommissionReport(from, to, bookings = [], stylists = []) {
  if (!SUPABASE_ENABLED) {
    // demo: computed from the in-memory bookings
    const t = (k) => { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
    const rows = stylists.map((s) => {
      const done = bookings.filter((b) => b.staff_id === s.id && b.status === "completed" && t(b.date) >= t(from) && t(b.date) <= t(to));
      const revenue = done.reduce((t, b) => t + (b.final_price || 0) - (b.transport_fee || 0), 0);
      const pct = s.commission_pct || 0;
      return { id: s.id, name: s.name, commission_pct: pct, package_commission_pct: s.package_commission_pct || 0, services_count: done.length,
        services_revenue: revenue, services_commission: Math.round((revenue * pct) / 100), packages_count: 0, packages_revenue: 0, packages_commission: 0,
        total_commission: Math.round((revenue * pct) / 100) };
    });
    return { ok: true, rows };
  }
  return rpc("commission_report", { p_from: from, p_to: to });
}

/* --------------------------------------------------------- supplies ---- */
export async function fetchSupplies() {
  if (!SUPABASE_ENABLED) return demo.supplies.map((s) => ({ ...s }));
  const { data, error } = await supabase.from("supplies").select("*").order("name");
  if (error) { if (!missing(error, "supplies")) log("supplies", error); return []; }
  return (data || []).map((s) => ({ ...s, qty: Number(s.qty), low_at: Number(s.low_at) }));
}
export async function saveSupply(s) {
  const row = { name: (s.name || "").trim().slice(0, 60), unit: (s.unit || "عدد").trim().slice(0, 15), low_at: Math.max(0, Number(s.low_at) || 0), active: s.active !== false };
  if (!row.name) return { ok: false, error: "نام لازم است" };
  if (!SUPABASE_ENABLED) {
    if (s.id) Object.assign(demo.supplies.find((x) => x.id === s.id), row);
    else demo.supplies.push({ id: `demo-s-${rid().slice(0, 6)}`, qty: 0, ...row });
    return { ok: true };
  }
  const q = s.id ? supabase.from("supplies").update(row).eq("id", s.id) : supabase.from("supplies").insert({ ...row, salon_id: getCurrentSalonId() });
  const { error } = await q;
  if (error) { log("supplies.save", error); return { ok: false, error: /duplicate|unique/i.test(error.message || "") ? "این قلم قبلاً ثبت شده" : "ذخیره ناموفق بود" }; }
  return { ok: true };
}
/** kind: purchase | use | adjust */
export async function supplyMove(supply, kind, qty, cost, note) {
  if (!SUPABASE_ENABLED) {
    const s = demo.supplies.find((x) => x.id === supply.id);
    const delta = kind === "purchase" ? qty : kind === "use" ? -qty : qty - s.qty;
    if (s.qty + delta < 0) return { ok: false, error: "موجودی کافی نیست" };
    s.qty = Math.round((s.qty + delta) * 100) / 100;
    return { ok: true, qty: s.qty, low: s.qty <= s.low_at };
  }
  return rpc("supply_move", { p_supply: supply.id, p_kind: kind, p_qty: qty, p_cost: cost ? Math.round(cost) : null, p_note: note || "" });
}

/* --------------------------------------------------------- check-in ---- */
export async function checkIn(code, bookings = []) {
  if (!SUPABASE_ENABLED) {
    const c = String(code || "").replace(/^.*[?&]code=/i, "").trim().toUpperCase();
    const b = bookings.find((x) => (x.tracking_code || "").toUpperCase() === c);
    return b ? { ok: true, id: b.id, customer_name: b.customer_name, pet_name: b.pet_name, start_min: b.start_min, demo: true } : { ok: false, error: "نوبت امروز با این کد پیدا نشد" };
  }
  return rpc("check_in", { p_code: code });
}

/* --------------------------------------------------------- branches ---- */
export async function fetchBranches() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.rpc("my_branches");
  if (error) { if (!missing(error, "my_branches")) log("my_branches", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function fetchBranchesSummary() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.rpc("branches_summary");
  if (error) { log("branches_summary", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function switchBranch(salonId) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("switch_branch", { p_salon: salonId });
}
export async function adminLinkBranch(ownerPhone, slug) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("admin_link_branch", { p_owner_phone: ownerPhone, p_branch_slug: slug });
}

/* ------------------------------------------------------ two-step login --- */
export async function mfaStatus() {
  if (!SUPABASE_ENABLED || !supabase.auth.mfa) return { available: false };
  const [{ data: lvl }, { data: factors }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  const totp = (factors?.totp || []).filter((f) => f.status === "verified");
  return { available: true, enabled: totp.length > 0, factorId: totp[0]?.id || null, current: lvl?.currentLevel, next: lvl?.nextLevel };
}
/** → {ok, factorId, qr (svg data url), secret} */
export async function mfaEnroll() {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `salon-${Date.now()}` });
  if (error) { log("mfa.enroll", error); return { ok: false, error: "فعال‌سازی ممکن نشد — در تنظیمات Supabase، MFA باید روشن باشد" }; }
  return { ok: true, factorId: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret };
}
export async function mfaVerify(factorId, code) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  if (error) return { ok: false, error: "کد اشتباه است یا منقضی شده" };
  return { ok: true };
}
export async function mfaDisable(factorId) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) { log("mfa.unenroll", error); return { ok: false, error: "غیرفعال کردن ممکن نشد" }; }
  return { ok: true };
}

/* ---------------------------------------------------------- backups ---- */
export async function fetchBackups() {
  if (!SUPABASE_ENABLED) return [];
  const { data, error } = await supabase.rpc("my_backups");
  if (error) { if (!missing(error, "my_backups")) log("my_backups", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function backupNow() {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  return rpc("backup_now", {});
}
export async function downloadBackup(id, name) {
  if (!SUPABASE_ENABLED) return DEMO_OFF;
  const { data, error } = await supabase.rpc("get_backup", { p_id: id });
  if (error || !data) { if (error) log("get_backup", error); return { ok: false, error: "دریافت نسخهٔ پشتیبان ناموفق بود" }; }
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name || `backup-${id}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return { ok: true };
}

/* ----------------------------------------------------------- pet health --- */
export async function recordPetWeight(petId, kg) {
  if (!SUPABASE_ENABLED || !petId) return { ok: true, demo: true };
  return rpc("record_pet_weight", { p_pet: petId, p_kg: Number(kg) });
}
export async function fetchPetWeights(petId) {
  if (!SUPABASE_ENABLED || !petId) return [];
  const { data, error } = await supabase.from("pet_weights").select("date, kg").eq("pet_id", petId).order("date").limit(60);
  if (error) { if (!missing(error, "pet_weights")) log("pet_weights", error); return []; }
  return (data || []).map((w) => ({ date: w.date, kg: Number(w.kg) }));
}

/* ---------------------------------------------------------- watermark ---- */
/** Draws the salon's name on a photo (bottom corner) → JPEG blob, or the original on failure. */
export async function watermark(file, text) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const size = Math.max(16, Math.round(c.width / 26));
    g.font = `800 ${size}px "Estedad Variable", "Vazirmatn Variable", sans-serif`;
    g.direction = "rtl"; g.textAlign = "right"; g.textBaseline = "bottom";
    const pad = Math.round(size * 0.7);
    const w = g.measureText(text).width;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(c.width - w - pad * 2, c.height - size - pad * 1.6, w + pad * 1.4, size + pad);
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.fillText(text, c.width - pad * 1.3, c.height - pad);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/* ------------------------------------------- v2.52 client records ---- */
const demoRecords = new Map([
  ["09121234567", { phone: "09121234567", allergies: "حساسیت به آمونیاک", hair_type: "فر و خشک", skin_type: "", color_formula: "۷٫۱ + اکسیدان ۶٪ — ۳۵ دقیقه", patch_test_at: null, notes: "" }],
]);
export const CLIENT_RECORD_FIELDS = [
  ["allergies", "حساسیت‌ها (رنگ، مواد، عطر…)", 300],
  ["hair_type", "نوع مو", 60],
  ["skin_type", "نوع پوست", 60],
  ["color_formula", "فرمول رنگ / مواد استفاده‌شده", 400],
  ["notes", "یادداشت (سلیقه، نکته‌ها)", 600],
];
/** phone → record, for the given phones (staff; RLS limits a stylist to their clients). */
export async function fetchClientRecords(phones) {
  const list = [...new Set((phones || []).filter((p) => /^09\d{9}$/.test(p || "")))];
  if (!list.length) return new Map();
  if (!SUPABASE_ENABLED) return new Map(list.filter((p) => demoRecords.has(p)).map((p) => [p, { ...demoRecords.get(p) }]));
  const { data, error } = await supabase.from("client_records").select("*").in("phone", list.slice(0, 200));
  if (error) { if (!missing(error, "client_records")) log("client_records", error); return new Map(); }
  return new Map((data || []).map((r) => [r.phone, r]));
}
export async function saveClientRecord(r) {
  if (!/^09\d{9}$/.test(r.phone || "")) return { ok: false, error: "شمارهٔ مشتری نامعتبر است" };
  const row = { phone: r.phone, patch_test_at: r.patch_test_at || null };
  for (const [k, , max] of CLIENT_RECORD_FIELDS) row[k] = String(r[k] || "").trim().slice(0, max);
  if (!SUPABASE_ENABLED) { demoRecords.set(r.phone, row); return { ok: true }; }
  const { error } = await supabase.from("client_records").upsert({ ...row, salon_id: getCurrentSalonId() }, { onConflict: "salon_id,phone" });
  if (error) { log("client_records.save", error); return { ok: false, error: "ذخیره ناموفق بود — فقط مدیر یا آرایشگر همین مشتری می‌تواند پرونده را ویرایش کند" }; }
  return { ok: true };
}
