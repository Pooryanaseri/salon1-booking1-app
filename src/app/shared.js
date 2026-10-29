import { useState, useRef, useCallback } from "react";
import { Scissors, Palette, Sparkles, Hand, Eye, Droplet, Dog, Cat, PawPrint, Bath, Clock, Check, X, CheckCircle2, XCircle, RotateCcw, CalendarX, Hourglass, Home, Package, Users, Megaphone, Zap, Receipt, CreditCard } from "lucide-react";
import { syncCollection, syncApprovedDates, saveWorkingHours, clearStaffWorkingHours } from "../lib/api";
import { formatToman, dateKey } from "../lib/format";

/* ============================================================
   Seed data
   ============================================================ */
export const SALON_ABBR = "MN";
export const SALON_GENDER_TYPE = "both"; // 'male' | 'female' | 'both'
export const GENDER_TYPE_LABEL = { male: "مردانه", female: "زنانه", both: "زنانه و مردانه", dog: "سگ", cat: "گربه", pet: "سگ و گربه" };
export const LOYALTY_REASON_FA = { visit: "ویزیت تکمیل‌شده", referral: "پاداش معرفی دوست", redeemed: "استفاده از تخفیف" };

// Each customer-facing "section" is modeled independently — its own services, categories and accent tint.
export const SECTION_META = {
  female: { label: "بخش زنانه", short: "زنانه", Icon: Sparkles, color: "var(--color-female-500)", tint: "var(--color-female-100)" },
  male: { label: "بخش مردانه", short: "مردانه", Icon: Scissors, color: "var(--color-male-500)", tint: "var(--color-male-100)" },
  // v2.44 pet grooming salons. "pet" is only a groomer's section (serves both).
  dog: { label: "سگ", short: "سگ", Icon: Dog, color: "var(--color-dog-500)", tint: "var(--color-dog-100)" },
  cat: { label: "گربه", short: "گربه", Icon: Cat, color: "var(--color-cat-500)", tint: "var(--color-cat-100)" },
  pet: { label: "سگ و گربه", short: "سگ و گربه", Icon: PawPrint, color: "var(--color-pet-500)", tint: "var(--color-pet-100)" },
};

/* ---- v2.44: salon types ------------------------------------------------ */
// Customer-facing sections, and the sections a staff member can belong to.
export const BUSINESS_SECTIONS = { beauty: ["female", "male"], pet: ["dog", "cat"] };
export const STAFF_SECTIONS = { beauty: ["female", "male"], pet: ["pet", "dog", "cat"] };
export const sectionsFor = (type) => BUSINESS_SECTIONS[type] || BUSINESS_SECTIONS.beauty;
export const staffSectionsFor = (type) => STAFF_SECTIONS[type] || STAFF_SECTIONS.beauty;
/** Does this staff member take bookings in this section? ("pet" groomers do dogs and cats.) */
export function staffServesSection(stylist, section) {
  return !!stylist && (stylist.gender === section || (stylist.gender === "pet" && (section === "dog" || section === "cat")));
}
export const BUSINESS_TYPE_LABEL = { beauty: "سالن زیبایی", pet: "آرایشگاه حیوانات" };
/** "همه" + one tab per section, for the panel's filter pills. */
export function sectionFilters(sections) {
  return [{ v: "all", l: "همه" }, ...sections.map((g) => ({ v: g, l: SECTION_META[g].short }))];
}

// v2.45: each salon sets its own weight bounds (kg) for small/medium/large.
export const DEFAULT_PET_SIZE_LIMITS = [5, 15, 30];
const faNum = (n) => String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
export function petSizes(limits = DEFAULT_PET_SIZE_LIMITS) {
  const [a, b, c] = Array.isArray(limits) && limits.length === 3 ? limits : DEFAULT_PET_SIZE_LIMITS;
  return [
    { v: "small", label: "کوچک", hint: `تا ${faNum(a)} کیلو` },
    { v: "medium", label: "متوسط", hint: `${faNum(a)} تا ${faNum(b)} کیلو` },
    { v: "large", label: "بزرگ", hint: `${faNum(b)} تا ${faNum(c)} کیلو` },
    { v: "giant", label: "خیلی بزرگ", hint: `بیش از ${faNum(c)} کیلو` },
  ];
}
export const PET_SIZES = petSizes();
export const PET_SIZE_LABEL = Object.fromEntries(PET_SIZES.map((x) => [x.v, x.label]));
export const PET_TEMPERAMENTS = [
  { v: "calm", label: "آرام" },
  { v: "nervous", label: "مضطرب / ترسو" },
  { v: "aggressive", label: "پرخاشگر" },
];
export const PET_TEMPERAMENT_LABEL = Object.fromEntries(PET_TEMPERAMENTS.map((x) => [x.v, x.label]));
/** A size from a weight in kg (the form suggests it; the owner can override). */
export function sizeFromWeight(kg, limits = DEFAULT_PET_SIZE_LIMITS) {
  const w = Number(kg);
  if (!Number.isFinite(w) || w <= 0) return null;
  const [a, b, c] = Array.isArray(limits) && limits.length === 3 ? limits : DEFAULT_PET_SIZE_LIMITS;
  return w <= a ? "small" : w <= b ? "medium" : w <= c ? "large" : "giant";
}

/** Mirrors the server's norm_breed(): spacing, ZWNJ and Arabic ی/ک don't matter. */
export function normBreed(name) {
  const map = { "\u064A": "\u06CC", "\u0643": "\u06A9", "\u06C0": "\u0647", "\u0629": "\u0647" }; // ي ك ۀ ة → ی ک ه ه
  return String(name || "").toLowerCase().replace(/[\u064A\u0643\u06C0\u0629]/g, (ch) => map[ch]).replace(/(?:\s|\u200c|\u200d|_|-)+/g, "");
}
/** The breed tier of a service for this breed, or null. */
export function breedTier(service, breed) {
  const key = normBreed(breed);
  if (!key || !service?.breed_pricing) return null;
  const hit = Object.entries(service.breed_pricing).find(([name]) => normBreed(name) === key);
  return hit && typeof hit[1] === "object" ? hit[1] : null;
}
/** Breed names that have their own price in any of these services. */
export function pricedBreeds(services, species) {
  const names = new Map();
  for (const s of services) {
    if (species && s.gender !== species) continue;
    for (const name of Object.keys(s.breed_pricing || {})) names.set(normBreed(name), name);
  }
  return [...names.values()];
}
/**
 * The service as booked for this animal — mirrors service_for_pet(): the
 * size's price/duration, then the breed's own price/duration on top.
 */
export function petService(service, size, breed) {
  const sized = sizedService(service, size);
  const tier = breedTier(service, breed);
  if (!tier) return sized;
  return {
    ...sized,
    price: Number.isFinite(tier.price) && tier.price >= 0 ? Math.round(tier.price) : sized.price,
    duration_minutes: Number.isFinite(tier.duration) && tier.duration >= 5 && tier.duration <= 600 ? Math.round(tier.duration) : sized.duration_minutes,
    breed_priced: true,
  };
}
/** v2.45: the aggression surcharge (percent of the price after the service's discount). */
export function petSurcharge(priceAfterDiscount, temperament, percent) {
  if (temperament !== "aggressive" || !percent || priceAfterDiscount == null || priceAfterDiscount <= 0) return 0;
  return Math.round((priceAfterDiscount * percent) / 100);
}
export const extraChargesTotal = (b) => (Array.isArray(b?.extra_charges) ? b.extra_charges : []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
/**
 * The service as booked for an animal of this size — mirrors the server's
 * service_at_size(): price/duration from size_pricing when set, otherwise
 * the service's own. Everything downstream (slots, totals) just uses it.
 */
export function sizedService(service, size) {
  const tier = service && size ? service.size_pricing?.[size] : null;
  if (!tier || typeof tier !== "object") return service;
  const price = Number.isFinite(tier.price) && tier.price >= 0 ? Math.round(tier.price) : service.price;
  const duration = Number.isFinite(tier.duration) && tier.duration >= 5 && tier.duration <= 600 ? Math.round(tier.duration) : service.duration_minutes;
  return { ...service, price, duration_minutes: duration };
}
/** "۳۵۰٬۰۰۰ تا ۸۰۰٬۰۰۰" style range for a size-priced service, or null. */
export function sizePriceRange(service) {
  const prices = Object.values(service?.size_pricing || {}).map((t) => t?.price).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

export const CATEGORY_LABEL = {
  hair: "مو", beard: "ریش", color: "رنگ", makeup: "میکاپ", nails: "ناخن", skin: "پوست", permanent_makeup: "خدمات دائم",
  // v2.44 pet salons
  bath: "حمام و شستشو", grooming: "اصلاح و آرایش", nails_pet: "ناخن", hygiene: "بهداشتی", spa: "اسپا و ماساژ",
  addon: "افزودنی (پایان کار)",
};
export const SERVICE_ICONS = {
  hair: Scissors, beard: Scissors, color: Palette, makeup: Sparkles, nails: Hand, skin: Droplet, permanent_makeup: Eye,
  bath: Bath, grooming: Scissors, nails_pet: PawPrint, hygiene: Sparkles, spa: Droplet, addon: Clock,
};
export const CATEGORIES_BY_TYPE = {
  beauty: ["hair", "beard", "color", "makeup", "nails", "skin", "permanent_makeup"],
  pet: ["bath", "grooming", "nails_pet", "hygiene", "spa", "addon"],
};

// Business expenses tracked in the accounting tab — categorized so the dashboard can
// break spending down visually (each category gets its own icon + accent color).
export const EXPENSE_CATEGORY_META = {
  rent: { label: "اجاره", Icon: Home, color: "var(--color-info)" },
  supplies: { label: "مواد مصرفی", Icon: Package, color: "var(--color-accent-700)" },
  salary: { label: "حقوق و دستمزد", Icon: Users, color: "var(--color-female-500)" },
  marketing: { label: "تبلیغات", Icon: Megaphone, color: "var(--color-male-500)" },
  utilities: { label: "قبوض", Icon: Zap, color: "var(--color-warning)" },
  other: { label: "سایر", Icon: Receipt, color: "var(--color-muted)" },
};

export const SEED_SERVICES = [
  // ---- Women's section ----
  { id: "f1", name: "کوتاهی و مدل مو", gender: "female", category: "hair", duration_minutes: 45, price: 250000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "f2", name: "رنگ مو کامل", gender: "female", category: "color", duration_minutes: 120, price: 950000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 15 },
  { id: "f3", name: "رنگ ریشه", gender: "female", category: "color", duration_minutes: 60, price: 450000, is_active: true, discount_type: "percent", discount_value: 10, discount_reason: "تشویقی مشتریان ثابت", buffer_minutes: 10 },
  { id: "f4", name: "کراتینه و بوتاکس مو", gender: "female", category: "hair", duration_minutes: 180, price: 1800000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 20 },
  { id: "f5", name: "میکاپ عروس", gender: "female", category: "makeup", duration_minutes: 90, price: 2500000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "f6", name: "میکاپ روزانه", gender: "female", category: "makeup", duration_minutes: 45, price: 600000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "f7", name: "مانیکور", gender: "female", category: "nails", duration_minutes: 45, price: 350000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "f8", name: "پاکسازی پوست صورت", gender: "female", category: "skin", duration_minutes: 60, price: 700000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "f9", name: "لمینت و کاشت ابرو", gender: "female", category: "permanent_makeup", duration_minutes: 50, price: null, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  // ---- Men's section ----
  { id: "m1", name: "کوتاهی مو مردانه", gender: "male", category: "hair", duration_minutes: 30, price: 180000, is_active: true, discount_type: "fixed", discount_value: 20000, discount_reason: "تخفیف افتتاحیه", buffer_minutes: 0 },
  { id: "m2", name: "اصلاح و فرم ریش", gender: "male", category: "beard", duration_minutes: 20, price: 120000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "m3", name: "پکیج مو و ریش", gender: "male", category: "hair", duration_minutes: 45, price: 270000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
  { id: "m4", name: "رنگ مو و ریش", gender: "male", category: "color", duration_minutes: 40, price: 300000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 10 },
  { id: "m5", name: "پاکسازی پوست صورت", gender: "male", category: "skin", duration_minutes: 40, price: 400000, is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0 },
];

// Demo menu of a pet salon (the /pets demo) — the same starter menu a new
// pet salon gets on the server (seed_pet_services).
const PET_BASE = { is_active: true, discount_type: "none", discount_value: 0, discount_reason: "", buffer_minutes: 0, size_pricing: {}, breed_pricing: {}, is_addon: false };
export const SEED_PET_SERVICES = [
  { ...PET_BASE, id: "pd1", name: "کوتاهی ناخن", gender: "dog", category: "nails_pet", duration_minutes: 15, price: 200000 },
  { ...PET_BASE, id: "pd2", name: "تخلیهٔ کیسهٔ مقعدی", gender: "dog", category: "hygiene", duration_minutes: 15, price: 200000 },
  { ...PET_BASE, id: "pd3", name: "شستشو (حمام)", gender: "dog", category: "bath", duration_minutes: 90, price: 1800000,
    size_pricing: { small: { price: 500000, duration: 45 }, medium: { price: 700000, duration: 60 }, large: { price: 1800000, duration: 90 } } },
  { ...PET_BASE, id: "pd4", name: "اصلاح ساده با موزر", gender: "dog", category: "grooming", duration_minutes: 90, price: 1300000,
    size_pricing: { small: { price: 900000, duration: 60 }, medium: { price: 900000, duration: 75 }, large: { price: 1300000, duration: 90 } } },
  { ...PET_BASE, id: "pd5", name: "اصلاح ساده با قیچی", gender: "dog", category: "grooming", duration_minutes: 90, price: 1000000,
    size_pricing: { medium: { price: 1000000, duration: 90 }, large: { price: 1500000, duration: 120 } } },
  { ...PET_BASE, id: "pd6", name: "اصلاح کامل + حمام", gender: "dog", category: "grooming", duration_minutes: 150, price: null,
    breed_pricing: { "پامرانین": { price: 1900000, duration: 120 }, "پامر": { price: 1900000, duration: 120 }, "چاو چاو": { price: 3500000, duration: 180 } } },
  { ...PET_BASE, id: "pd7", name: "گره‌زدایی (هر نیم ساعت)", gender: "dog", category: "addon", duration_minutes: 30, price: 350000, is_addon: true },
  { ...PET_BASE, id: "pc1", name: "کوتاهی ناخن", gender: "cat", category: "nails_pet", duration_minutes: 15, price: 200000 },
  { ...PET_BASE, id: "pc2", name: "تخلیهٔ کیسهٔ مقعدی", gender: "cat", category: "hygiene", duration_minutes: 15, price: 200000 },
  { ...PET_BASE, id: "pc3", name: "شستشو (حمام) گربه", gender: "cat", category: "bath", duration_minutes: 60, price: 800000 },
  { ...PET_BASE, id: "pc4", name: "شیو سادهٔ گربه", gender: "cat", category: "grooming", duration_minutes: 60, price: 900000 },
  { ...PET_BASE, id: "pc5", name: "گره‌زدایی (هر نیم ساعت)", gender: "cat", category: "addon", duration_minutes: 30, price: 350000, is_addon: true },
];

// schema day_of_week: 0=Saturday .. 6=Friday (Iran week)
export const SEED_WORKING_HOURS = [
  { day_of_week: 0, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 1, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 2, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 3, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 4, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 5, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 6, start_time: "00:00", end_time: "00:00", is_closed: true },
];
export function schemaDayOf(date) {
  return (date.getDay() + 1) % 7;
}
// crypto.randomUUID() throws in non-secure/sandboxed contexts (e.g. some preview
// iframes) — this works everywhere and is plenty unique for a client-only demo.
export function uid() {
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/* ============================================================
   Persistence seam
   ------------------------------------------------------------
   usePersistedState has the EXACT same contract as useState's
   setter — plain value or updater function — but every change is
   also diffed and pushed to Postgres by the `persist` callback.

   This is the single trick that let a real backend land without
   editing one child component: `setServices`, `setTimeOff`,
   `setApprovedDates` etc. are still passed down unchanged.

   `arm(false)` suppresses writes while we hydrate from the server,
   so loading data never echoes straight back as an UPDATE storm.
   ============================================================ */
export function usePersistedState(initial, persist) {
  const [value, setValue] = useState(initial);
  // `initial` may be a lazy initializer function (useState semantics), so seed the
  // ref from the already-resolved first-render value, never from `initial` itself.
  const ref = useRef();
  if (ref.current === undefined) ref.current = value;
  const live = useRef(false);           // false = hydrating, writes suppressed

  const set = useCallback((updater) => {
    const prev = ref.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    ref.current = next;
    setValue(next);
    if (live.current) {
      Promise.resolve(persist(prev, next)).catch((e) =>
        console.error("[salon] ذخیره‌سازی ناموفق:", e)
      );
    }
  }, [persist]);

  const hydrate = useCallback((v) => { ref.current = v; setValue(v); }, []);
  const arm = useCallback((on) => { live.current = on; }, []);

  return [value, set, { hydrate, arm, ref }];
}

/* Stable persist adapters (module scope = referentially stable). */
export const persistServices  = (prev, next) => syncCollection("services", prev, next);
export const persistTimeOff   = (prev, next) => syncCollection("time_offs", prev, next);
export const persistApproved  = (prev, next) => syncApprovedDates(prev, next);
export const persistSalonHours = (_prev, next) => saveWorkingHours(null, next);

// staffWorkingHours is a { [stylistId]: WorkingHoursArray } map, not a list.
export const persistStaffHours = async (prev, next) => {
  const jobs = [];
  for (const id of Object.keys(next)) {
    if (prev[id] !== next[id]) jobs.push(saveWorkingHours(id, next[id]));
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) jobs.push(clearStaffWorkingHours(id));
  }
  await Promise.all(jobs);
};

/* ============================================================
   SMS templates — DB rows win, these are the offline fallback
   so the app still behaves sanely before you seed sms_templates.
   ============================================================ */
export const DEFAULT_REMINDER_HOURS = 3;

export const FALLBACK_SMS_TEMPLATES = {
  confirmation: "{{name}} عزیز، نوبت شما در {{salon}} ثبت شد.\nخدمت: {{service}}\nتاریخ: {{date}} ساعت {{time}}\nآرایشگر: {{stylist}}\nکد پیگیری: {{code}}",
  reminder: "{{name}} عزیز، یادآوری نوبت شما در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما هستیم.",
  cancellation: "{{name}} عزیز، نوبت شما ({{service}} — {{date}} ساعت {{time}}) لغو شد.\nبرای رزرو مجدد به {{salon}} مراجعه کنید.",
  reschedule: "{{name}} عزیز، زمان نوبت شما تغییر کرد.\nزمان جدید: {{date}} ساعت {{time}}\nخدمت: {{service}}\nکد پیگیری: {{code}}",
  reschedule_proposed: "{{name}} عزیز، آرایشگر پیشنهاد داده نوبت شما به {{date}} ساعت {{time}} جابه‌جا بشه.\nبرای تایید یا رد این پیشنهاد، در تب «داشبورد من» شماره‌تون را وارد کنید.",
  campaign: "{{name}} عزیز، جای شما در {{salon}} خالیه!\nبه‌مناسبت بازگشتتون {{discount}}٪ تخفیف روی همه خدمات براتون فعال کردیم.\nهمین حالا رزرو کنید.",
  loyalty: "{{name}} عزیز، امتیاز شما در باشگاه مشتریان {{salon}}: {{points}}\nتخفیف فعال شما: {{discount}}٪",
  feedback_request: "{{name}} عزیز، امیدواریم از {{service}} امروز راضی بوده باشید 🌸\nنظرتون برامون خیلی مهمه: {{link}}",
  feedback_followup: "{{name}} عزیز، یادمون افتاد که هنوز نظرتون رو دربارهٔ {{service}} نگرفتیم 🙏\nاگه وقت داشتید: {{link}}",
  custom: "",
};

export const SMS_KIND_LABEL = {
  confirmation: "تایید رزرو",
  reminder: "یادآوری نوبت",
  cancellation: "لغو نوبت",
  reschedule: "تغییر زمان",
  reschedule_proposed: "پیشنهاد تغییر زمان",
  campaign: "کمپین جذب مجدد",
  loyalty: "باشگاه مشتریان",
  feedback_request: "درخواست نظرسنجی",
  feedback_followup: "یادآوری نظرسنجی",
  staff_new_booking: "اطلاع نوبت جدید به آرایشگر",
  custom: "پیام آزاد",
};

// One-click smart campaign drafts — warm, casual tone, per segment. Only these
// three segments get an actionable draft (per spec); the other RFM buckets are
// informational only in the BI tab.
export const RFM_SMART_DRAFTS = {
  champions: "سلام {{name}} جونم! مرسی که همیشه همراه مایی ❤️ یه هدیه کوچیک برای نوبت بعدیت داری: ۱۰٪ تخفیف روی تمام خدمات سالن. منتظر دیدنتیم!",
  champions_vip: "سلام {{name}} عزیز 💎 شما یکی از ارزشمندترین مشتریان سالن ما هستید و می‌خواستیم این رو بهتون بگیم. به‌عنوان قدردانی، ۲۰٪ تخفیف ویژه VIP روی نوبت بعدیتون منتظرتونه — هر وقت مایل بودید، در اولویت رزرو شما هستیم.",
  at_risk: "سلام {{name}} جان، {{days}} روزه ندیدیمت و دلمون برات تنگ شده! برای اینکه زودتر برگردی، ۲۰٪ تخفیف ویژه برات در نظر گرفتیم 🎁 منتظرتیم.",
  new: "سلام {{name}} عزیز، خیلی خوشحالیم که اومدی پیشمون! امیدواریم از خدمات راضی بوده باشی. برای نوبت بعدیت هم همیشه در خدمتتیم 🌸",
  inactive: "سلام {{name}} عزیز، مدتیه ندیدیمت! هر وقت دلت خواست دوباره سر بزنی، با روی باز منتظرتیم 💛",
};

export const SMS_STATUS_META = {
  queued:    { label: "در صف", color: "var(--color-info)" },
  sent:      { label: "ارسال شد", color: "var(--color-success)" },
  delivered: { label: "تحویل شد", color: "var(--color-success)" },
  failed:    { label: "ناموفق", color: "var(--color-danger)" },
};

export const KNOWN_CUSTOMER = { phone: "09121234567", name: "سارا محمدی", gender: "female" };
export const STAFF_PHONE = "09120000000";

// Stylists working at the salon — each belongs to one section (female/male), same as services.
// A booking can be assigned to a specific stylist, or left as "فرقی ندارد" (staff_id: null).
export const SEED_STYLISTS = [
  { id: "st1", name: "مهسا کریمی", gender: "female", active: true, phone: "09121110001", password: "1234", reminder_hours_before: 3 },
  { id: "st2", name: "نیلوفر صادقی", gender: "female", active: true, phone: "09121110002", password: "1234", reminder_hours_before: 3 },
  { id: "st3", name: "رضا احمدی", gender: "male", active: true, phone: "09121110003", password: "1234", reminder_hours_before: 3 },
];
export const SEED_PET_STYLISTS = [
  { id: "st1", name: "سمیرا نادری", gender: "pet", active: true, phone: "09121110001", password: "1234", reminder_hours_before: 3 },
  { id: "st2", name: "کاوه رحیمی", gender: "dog", active: true, phone: "09121110002", password: "1234", reminder_hours_before: 3 },
];
export function makeSeedStylist(overrides) {
  return { id: uid(), name: "", gender: "female", active: true, phone: "", password: "", reminder_hours_before: 3, ...overrides };
}

export function randomTrackingCode() {
  // Not itself an access-control token (lookup is by phone, never by this
  // code — see CHANGES.md), but it's customer-facing and sent via SMS, so
  // it should still come from a real random source rather than Math.random().
  let n;
  try {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    n = 10000 + (arr[0] % 90000);
  } catch {
    n = Math.floor(10000 + Math.random() * 90000); // sandboxed/old-browser fallback
  }
  return `${SALON_ABBR}-${n}`;
}

// Price and discount are both optional — a stylist can leave a service unpriced
// ("price announced in salon") and/or skip the discount entirely.
export function hasPrice(service) {
  return !!service && service.price != null && service.price > 0;
}
// Discount now lives on the SERVICE, not the booking/customer — compute the effective price from it.
export function discountAmountFor(service) {
  if (!hasPrice(service) || service.discount_type === "none" || !service.discount_value) return 0;
  return service.discount_type === "percent"
    ? Math.round((service.price * service.discount_value) / 100)
    : service.discount_value;
}
export function finalPriceFor(service) {
  if (!hasPrice(service)) return null;
  return Math.max(0, service.price - discountAmountFor(service));
}
export function priceLabel(service) {
  return hasPrice(service) ? formatToman(service.price) : "قیمت در سالن اعلام می‌شود";
}

export function makeSeedBooking(overrides) {
  const today = new Date();
  return {
    id: uid(),
    customer_name: "",
    customer_phone: "",
    customer_gender: "female",
    service_id: "f1",
    staff_id: null,
    staff_name: "",
    date: dateKey(today),
    start_min: 10 * 60,
    end_min: 10 * 60 + 45,
    buffer_minutes: 0, // snapshot of the service's touch-up/cleanup time at booking time
    status: "confirmed",
    pending_date: null,
    pending_start_min: null,
    pending_end_min: null,
    tracking_code: randomTrackingCode(),
    original_price: 0,
    discount_type: "none",
    discount_value: 0,
    discount_reason: "",
    final_price: 0,
    sms_sent_confirmation: true,
    sms_sent_reminder: false,
    created_at: Date.now(),
    ...overrides,
  };
}

export function makeSeedExpense(overrides) {
  return {
    id: uid(),
    title: "",
    category: "other",
    amount: 0,
    date: dateKey(new Date()),
    note: "",
    created_at: Date.now(),
    ...overrides,
  };
}

// A booking blocks the calendar until its service ends *plus* any touch-up/cleanup buffer.
export function occupiedEndFor(booking) {
  return booking.end_min + (booking.buffer_minutes || 0);
}

// Is this exact minute literally inside an existing booking's blocked range?
// (independent of whatever service the *next* customer might want — this is what "someone
// already has this time" actually means, and the only thing that should render as reserved/red.)
export function isOccupied(t, dayBookings) {
  return dayBookings.some((b) => t >= b.start_min && t < occupiedEndFor(b));
}

// Could a service of the given duration (plus its OWN touch-up buffer, since that occupies
// the calendar too) start at t without overlapping ANY booking that day? This is a strict
// superset of isOccupied — a tick can fail this while still being free (e.g. a 15-minute gap
// that's too short for a 40-minute service), and that case must never be presented to the
// customer as "reserved" — it just doesn't fit *this* selection.
export function fitsWithoutOverlap(t, durationMinutes, dayBookings, bufferMinutes = 0) {
  const candidateEnd = t + durationMinutes + bufferMinutes;
  return !dayBookings.some((b) => t < occupiedEndFor(b) && candidateEnd > b.start_min);
}

// Status badge styling per spec: confirmed -> accent-500 bg, completed -> success,
// cancelled -> muted + strikethrough, no_show -> warning. pending/rescheduled use info/accent-700.
export const STATUS_META = {
  pending: { label: "در انتظار تایید", bg: "var(--color-info)", fg: "white", Icon: Clock, strike: false },
  confirmed: { label: "تایید شده", bg: "var(--color-accent-500)", fg: "oklch(16% 0.02 70)", Icon: CheckCircle2, strike: false },
  cancelled: { label: "لغو شده", bg: "var(--color-muted)", fg: "white", Icon: XCircle, strike: true },
  cancelled_by_salon: { label: "لغو توسط سالن", bg: "var(--color-muted)", fg: "white", Icon: XCircle, strike: true },
  rescheduled: { label: "تغییر زمان", bg: "var(--color-accent-700)", fg: "white", Icon: RotateCcw, strike: false },
  reschedule_proposed: { label: "پیشنهاد تغییر زمان", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: Clock, strike: false },
  completed: { label: "انجام شده", bg: "var(--color-success)", fg: "white", Icon: Check, strike: false },
  no_show: { label: "عدم حضور", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: X, strike: false },
  awaiting_payment: { label: "در انتظار پرداخت بیعانه", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: CreditCard, strike: false },
  pending_verification: { label: "در انتظار تایید نهایی", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: Hourglass, strike: false },
  archived_unconfirmed: { label: "بایگانی‌شده (تاییدنشده)", bg: "var(--color-muted)", fg: "white", Icon: CalendarX, strike: true },
};

// Statuses that hold a time slot — must match the appointments_no_overlap
// constraint (v2.37): an unpaid deposit hold blocks the slot like a booking.
export const OCCUPYING_STATUSES = ["pending", "confirmed", "rescheduled", "reschedule_proposed", "awaiting_payment"];
