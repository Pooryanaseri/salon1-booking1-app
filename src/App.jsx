import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useData } from "./hooks/useData";
import {
  Scissors, Palette, Sparkles, Hand, Eye, Droplet,
  Clock, Phone, Check, X, Calendar as CalendarIcon,
  Sun, Moon, MoreVertical, Search, ArrowRight, Percent, Banknote,
  CheckCircle2, XCircle, RotateCcw, MessageSquareText, User,
  Copy, Lock, Plus, Trash2, Pencil, CalendarX, Settings, LayoutList, SlidersHorizontal, LayoutGrid,
  Brain, TrendingUp, TrendingDown, BarChart3, Wand2, Hourglass,
  ChevronLeft, ChevronRight, History, CalendarClock,
  Wallet, Coins, CalendarCheck,
  Home, Package, Users, Megaphone, Zap, Receipt, PiggyBank, UserPlus, Repeat2,
  Award, Layers, ReceiptText, Bell,
  Send, Loader2, AlertTriangle, Gift, CreditCard,
  Crown, RefreshCw, Link2, ChevronDown, ChevronUp, Medal, Star,
  Target, Info, CalendarPlus, LayoutDashboard, ShieldCheck
} from "lucide-react";

/* ============================================================
   Backend wiring — NEW in this version.
   Everything below is additive: no existing component signature
   changed, so the whole UI tree is byte-for-byte the same.
   ============================================================ */
import { SUPABASE_ENABLED } from "./lib/supabase";
import {
  bootstrap, subscribeAppointments, fetchFullAppointments, fetchMyBookings,
  fetchPublicSlots, subscribeSlotChanges, broadcastSlotChange, fetchFeedbackStats,
  syncCollection, syncApprovedDates, saveWorkingHours, clearStaffWorkingHours,
  insertOne, updateOne, deleteOne,
  fetchSmsTemplates, fetchSmsLog, fetchCustomers, fetchInactiveCustomers,
  fetchCampaigns, fetchCustomerLoyalty, fetchLoyaltySettings, updateLoyaltySettings, redeemLoyaltyReward,
  fetchRfmSegments, applyReferral, fetchCustomerReferredBy, fetchCategoryMatrix,
  logCampaignSend, updateCampaignLogResult, fetchCampaignPerformance,
  fetchSegmentSettings, updateSegmentSettings, previewSegmentDistribution,
  createCampaign, addCampaignTargets,
} from "./lib/api";
import {
  signIn, signOut as authSignOut, restoreSession,
  registerOwner as authRegisterOwner, registerStylist as authRegisterStylist,
} from "./lib/auth";
import {
  sendSms, sendBulkSms, scheduleReminder, cancelScheduledReminders,
  renderTemplate, smsParts, SMS_PLACEHOLDERS,
} from "./lib/sms";

/* ============================================================
   Jalali (Persian) calendar conversion — pure math, no deps
   ============================================================ */
function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) -
    80 +
    gd +
    g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm, jd;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    jd = 1 + ((days - 186) % 30);
  }
  return { jy, jm, jd };
}
// Just the Jalali day-of-month number for a JS Date — every date-strip/grid in
// this app is meant to show the Persian calendar day, never the raw Gregorian
// one (which is what date.getDate() gives you).
function jalaliDayNum(date) {
  return gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate()).jd;
}

const MONTHS_FA = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const WEEKDAYS_FA_SHORT = ["ی", "د", "س", "چ", "پ", "ج", "ش"]; // JS getDay index 0..6 (Sun..Sat)
const WEEKDAYS_FA_FULL = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const SCHEMA_DAY_LABELS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"]; // day_of_week 0..6, 0=Saturday

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
function toFa(input) {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
}
function formatToman(n) {
  return toFa(Math.round(n).toLocaleString("en-US")) + " تومان";
}
function jalaliLabel(date, { withWeekday = true, short = false } = {}) {
  const { jy, jm, jd } = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const day = toFa(jd);
  const month = MONTHS_FA[jm - 1];
  if (short) return `${day} ${month}`;
  const wd = WEEKDAYS_FA_FULL[date.getDay()];
  return withWeekday ? `${wd} ${day} ${month} ${toFa(jy)}` : `${day} ${month} ${toFa(jy)}`;
}
function formatClock(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return toFa(String(h).padStart(2, "0")) + ":" + toFa(String(m).padStart(2, "0"));
}
function hhmmToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function dateKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function bookingTimestamp(b) {
  return parseDateKey(b.date).getTime() + b.start_min * 60000;
}

/* ============================================================
   Design tokens (from spec) — applied via CSS variables
   ============================================================ */
const TOKENS_CSS = `
.salon-app {
  --color-bg: oklch(96% 0.008 70);
  --color-surface: oklch(100% 0 0);
  --color-surface-raised: oklch(95% 0.010 65);
  --color-border: oklch(88% 0.012 65);
  --color-muted: oklch(60% 0.014 60);
  --color-body: oklch(26% 0.016 60);
  --color-heading: oklch(15% 0.014 55);

  --color-accent-50: oklch(97% 0.035 75);
  --color-accent-100: oklch(93% 0.07 75);
  --color-accent-300: oklch(82% 0.14 72);
  --color-accent-500: oklch(69% 0.20 62);
  --color-accent-700: oklch(50% 0.18 48);
  --color-accent-900: oklch(30% 0.12 42);

  --color-success: oklch(62% 0.17 150);
  --color-warning: oklch(74% 0.18 78);
  --color-danger: oklch(56% 0.22 22);
  --color-info: oklch(60% 0.17 250);

  /* Section tints — women's (rose) / men's (teal) so each area feels distinct */
  --color-female-500: oklch(64% 0.19 6);
  --color-female-100: oklch(93% 0.04 10);
  --color-male-500: oklch(54% 0.13 235);
  --color-male-100: oklch(92% 0.025 225);

  /* Brand + status gradients — the "reporting" surfaces (hero cards, KPI tiles,
     chart fills) lean on these instead of flat fills for a richer, more premium look. */
  --grad-brand: linear-gradient(135deg, oklch(72% 0.18 75) 0%, oklch(62% 0.21 40) 55%, oklch(56% 0.20 22) 100%);
  --grad-brand-soft: linear-gradient(135deg, oklch(95% 0.05 75), oklch(92% 0.05 45));
  --grad-success: linear-gradient(135deg, oklch(68% 0.16 155), oklch(56% 0.15 168));
  --grad-info: linear-gradient(135deg, oklch(66% 0.15 245), oklch(54% 0.19 268));
  --grad-danger: linear-gradient(135deg, oklch(64% 0.21 25), oklch(50% 0.22 8));
  --grad-warning: linear-gradient(135deg, oklch(78% 0.16 82), oklch(66% 0.19 55));
  --grad-female: linear-gradient(135deg, oklch(70% 0.16 10), oklch(58% 0.19 350));
  --grad-male: linear-gradient(135deg, oklch(60% 0.12 230), oklch(46% 0.13 250));

  /* Per-tab identity colors — each of the 3 top-level tabs gets its own hue
     instead of one flat accent + gray-for-everything-else scheme. */
  --color-tab-book: var(--color-accent-500);
  --color-tab-dash: oklch(58% 0.15 200);
  --color-tab-panel: oklch(52% 0.19 300);
  --grad-tab-book: var(--grad-brand);
  --grad-tab-dash: linear-gradient(135deg, oklch(66% 0.13 195), oklch(52% 0.15 215));
  --grad-tab-panel: linear-gradient(135deg, oklch(60% 0.17 295), oklch(46% 0.20 310));
  --color-tab-services: oklch(58% 0.18 20);

  --shadow-sm: 0 1px 2px oklch(20% 0.02 60 / 0.06), 0 1px 1px oklch(20% 0.02 60 / 0.04);
  --shadow-md: 0 6px 16px -4px oklch(20% 0.02 60 / 0.14), 0 2px 6px -2px oklch(20% 0.02 60 / 0.08);
  --shadow-lg: 0 16px 32px -8px oklch(20% 0.02 60 / 0.20), 0 4px 12px -4px oklch(20% 0.02 60 / 0.10);
  --shadow-glow-accent: 0 8px 24px -6px oklch(69% 0.20 62 / 0.45);
  --shadow-glow-success: 0 8px 24px -6px oklch(62% 0.17 150 / 0.4);
  --shadow-glow-danger: 0 8px 24px -6px oklch(56% 0.22 22 / 0.4);
  --shadow-glow-info: 0 8px 24px -6px oklch(60% 0.17 250 / 0.4);

  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --space-10: 40px; --space-12: 48px; --space-16: 64px;

  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 18px; --radius-xl: 24px; --radius-full: 9999px;

  --font-sans: 'Vazirmatn', system-ui, sans-serif;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem;
  --text-lg: 1.125rem; --text-xl: 1.25rem; --text-2xl: 1.5rem; --text-3xl: 1.875rem;
  --leading-tight: 1.35; --leading-normal: 1.6; --leading-relaxed: 1.75;

  --duration-fast: 120ms; --duration-base: 200ms; --ease-standard: cubic-bezier(.4,0,.2,1);

  background: var(--color-bg);
  color: var(--color-body);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  direction: rtl;
  min-height: 100%;
}
.salon-app[data-theme="dark"] {
  --color-bg: oklch(13% 0.014 55);
  --color-surface: oklch(17% 0.016 55);
  --color-surface-raised: oklch(21% 0.018 55);
  --color-border: oklch(29% 0.018 55);
  --color-muted: oklch(56% 0.014 55);
  --color-body: oklch(88% 0.012 60);
  --color-heading: oklch(96% 0.008 60);
  --color-accent-500: oklch(73% 0.18 68);
  --color-female-100: oklch(27% 0.05 10);
  --color-male-100: oklch(25% 0.035 225);
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.3);
  --shadow-md: 0 6px 16px -4px oklch(0% 0 0 / 0.45);
  --shadow-lg: 0 16px 32px -8px oklch(0% 0 0 / 0.55);
}
.salon-app * { font-family: var(--font-sans); box-sizing: border-box; }
.salon-app .tabular { font-variant-numeric: tabular-nums; }
.salon-app .card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: box-shadow var(--duration-base) var(--ease-standard), transform var(--duration-base) var(--ease-standard);
}
.salon-app .card-glass {
  border-radius: var(--radius-xl);
  color: white;
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
  border: 1px solid oklch(100% 0 0 / 0.14);
}
.salon-app .card-glass::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(120% 90% at 8% -10%, oklch(100% 0 0 / 0.22), transparent 55%),
              radial-gradient(90% 70% at 100% 120%, oklch(0% 0 0 / 0.18), transparent 60%);
}
.salon-app .surface-raised { background: var(--color-surface-raised); }
.salon-app .tap {
  min-height: 44px;
  transition: transform var(--duration-fast) var(--ease-standard), background var(--duration-base) var(--ease-standard), opacity var(--duration-base) var(--ease-standard), border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard);
}
.salon-app .tap:active { transform: scale(0.97); }
.salon-app .accent-btn {
  background: var(--grad-brand);
  color: white;
  border-radius: var(--radius-md);
  font-weight: 700;
  box-shadow: var(--shadow-glow-accent);
}
.salon-app .accent-btn:hover { filter: brightness(1.06); }
.salon-app .accent-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.salon-app .ghost-btn {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-body);
  border-radius: var(--radius-md);
}
.salon-app .ghost-btn:hover { border-color: var(--color-accent-500); }
.salon-app h1 { color: var(--color-heading); font-weight: 800; letter-spacing: -0.01em; }
.salon-app h2 { color: var(--color-heading); font-weight: 800; letter-spacing: -0.005em; }
.salon-app h3 { color: var(--color-heading); font-weight: 700; }
.salon-app h4 { color: var(--color-heading); font-weight: 600; }
.salon-app .muted { color: var(--color-muted); }
.salon-app .badge { border-radius: var(--radius-full); font-weight: 700; font-size: var(--text-xs); padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px; }
@media (prefers-reduced-motion: reduce) {
  .salon-app * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
.salon-app input, .salon-app select, .salon-app textarea {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-heading);
  font-family: var(--font-sans);
}
.salon-app input:focus, .salon-app select:focus, .salon-app textarea:focus {
  outline: 2px solid var(--color-accent-500);
  outline-offset: 1px;
  border-color: var(--color-accent-500);
}
.salon-app .fade-in { animation: salonFadeIn 260ms var(--ease-standard); }
@keyframes salonFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.salon-app .sheet-up { animation: salonSheetUp 320ms cubic-bezier(.2,.9,.3,1); }
@keyframes salonSheetUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
.salon-app .backdrop-in { animation: salonBackdropIn 200ms var(--ease-standard); }
@keyframes salonBackdropIn { from { opacity: 0; } to { opacity: 1; } }
.salon-app .scrollbar-none::-webkit-scrollbar { display: none; }
.salon-app .switch { width: 40px; height: 24px; border-radius: var(--radius-full); position: relative; transition: background var(--duration-fast) var(--ease-standard); flex-shrink: 0; }
.salon-app .salon-spin { animation: salonSpin 900ms linear infinite; }
@keyframes salonSpin { to { transform: rotate(360deg); } }
.salon-app .switch-knob { width: 18px; height: 18px; border-radius: 50%; background: white; position: absolute; top: 3px; transition: transform var(--duration-fast) var(--ease-standard); }

/* ---- Mobile-native shell: bottom tab bar + bottom sheets ---- */
.salon-app .safe-top { padding-top: env(safe-area-inset-top, 0px); }
.salon-app .safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
.salon-app .bottom-nav {
  position: fixed; bottom: 0; inset-inline: 0; z-index: 80;
  display: flex; justify-content: space-around;
  background: color-mix(in oklch, var(--color-surface) 92%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--color-border);
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
  box-shadow: 0 -8px 24px -12px oklch(20% 0.02 60 / 0.18);
}
.salon-app .bottom-nav-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 6px 4px; border-radius: var(--radius-md); min-height: 52px;
  color: var(--color-muted); position: relative;
  transition: color var(--duration-base) var(--ease-standard);
}
.salon-app .bottom-nav-item.active { color: var(--color-accent-700); }
.salon-app .bottom-nav-icon-wrap {
  width: 34px; height: 26px; border-radius: var(--radius-full);
  display: flex; align-items: center; justify-content: center;
  transition: background var(--duration-base) var(--ease-standard), transform var(--duration-fast) var(--ease-standard);
}
.salon-app .bottom-nav-item.active .bottom-nav-icon-wrap {
  background: color-mix(in oklch, var(--color-accent-500) 16%, transparent);
}
.salon-app .bottom-nav-item:active .bottom-nav-icon-wrap { transform: scale(0.88); }
.salon-app .header-blur {
  background: color-mix(in oklch, var(--color-surface) 88%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
.salon-app .sheet-handle {
  width: 36px; height: 4px; border-radius: var(--radius-full);
  background: var(--color-border); margin: 0 auto 10px;
}

/* ----------------------------------------------------------------------
   Layout utilities — this file has NO Tailwind installed and generates NO
   separate CSS file (everything ships as this one injected <style> tag).
   Every className like "flex items-center gap-2 mb-3" used throughout the
   app assumes Tailwind-equivalent rules exist; without them these classes
   were pure no-ops, so this block is what actually makes 186+ flex/grid
   layouts across the whole app render as intended. Values match the sizes
   actually used in the codebase (checked programmatically), not a generic
   Tailwind scale.
   ---------------------------------------------------------------------- */
.salon-app .flex { display: flex; }
.salon-app .grid { display: grid; }
.salon-app .flex-1 { flex: 1 1 0%; }
.salon-app .flex-col { flex-direction: column; }
.salon-app .flex-wrap { flex-wrap: wrap; }
.salon-app .items-center { align-items: center; }
.salon-app .items-end { align-items: flex-end; }
.salon-app .items-start { align-items: flex-start; }
.salon-app .justify-between { justify-content: space-between; }
.salon-app .justify-center { justify-content: center; }
.salon-app .w-full { width: 100%; }
.salon-app .mx-auto { margin-left: auto; margin-right: auto; }

.salon-app .gap-0\\.5 { gap: 2px; }
.salon-app .gap-1 { gap: 4px; }
.salon-app .gap-1\\.5 { gap: 6px; }
.salon-app .gap-2 { gap: 8px; }
.salon-app .gap-2\\.5 { gap: 10px; }
.salon-app .gap-3 { gap: 12px; }
.salon-app .gap-4 { gap: 16px; }
.salon-app .gap-x-3 { column-gap: 12px; }
.salon-app .gap-y-1\\.5 { row-gap: 6px; }

.salon-app .mb-1 { margin-bottom: 4px; }
.salon-app .mb-2 { margin-bottom: 8px; }
.salon-app .mb-2\\.5 { margin-bottom: 10px; }
.salon-app .mb-3 { margin-bottom: 12px; }
.salon-app .mb-4 { margin-bottom: 16px; }
.salon-app .mb-6 { margin-bottom: 24px; }

.salon-app .mt-1 { margin-top: 4px; }
.salon-app .mt-1\\.5 { margin-top: 6px; }
.salon-app .mt-2 { margin-top: 8px; }
.salon-app .mt-3 { margin-top: 12px; }
.salon-app .mt-4 { margin-top: 16px; }
.salon-app .mt-5 { margin-top: 20px; }
`;

/* ============================================================
   Seed data
   ============================================================ */
const SALON_NAME = "آرایشگاه و سالن زیبایی مانا";
const SALON_ABBR = "MN";
const SALON_GENDER_TYPE = "both"; // 'male' | 'female' | 'both'
const GENDER_TYPE_LABEL = { male: "مردانه", female: "زنانه", both: "زنانه و مردانه" };
const LOYALTY_REASON_FA = { visit: "ویزیت تکمیل‌شده", referral: "پاداش معرفی دوست", redeemed: "استفاده از تخفیف" };

// Each customer-facing "section" is modeled independently — its own services, categories and accent tint.
const SECTION_META = {
  female: { label: "بخش زنانه", short: "زنانه", Icon: Sparkles, color: "var(--color-female-500)", tint: "var(--color-female-100)" },
  male: { label: "بخش مردانه", short: "مردانه", Icon: Scissors, color: "var(--color-male-500)", tint: "var(--color-male-100)" },
};

const CATEGORY_LABEL = { hair: "مو", beard: "ریش", color: "رنگ", makeup: "میکاپ", nails: "ناخن", skin: "پوست", permanent_makeup: "خدمات دائم" };
const SERVICE_ICONS = { hair: Scissors, beard: Scissors, color: Palette, makeup: Sparkles, nails: Hand, skin: Droplet, permanent_makeup: Eye };

// Business expenses tracked in the accounting tab — categorized so the dashboard can
// break spending down visually (each category gets its own icon + accent color).
const EXPENSE_CATEGORY_META = {
  rent: { label: "اجاره", Icon: Home, color: "var(--color-info)" },
  supplies: { label: "مواد مصرفی", Icon: Package, color: "var(--color-accent-700)" },
  salary: { label: "حقوق و دستمزد", Icon: Users, color: "var(--color-female-500)" },
  marketing: { label: "تبلیغات", Icon: Megaphone, color: "var(--color-male-500)" },
  utilities: { label: "قبوض", Icon: Zap, color: "var(--color-warning)" },
  other: { label: "سایر", Icon: Receipt, color: "var(--color-muted)" },
};

const SEED_SERVICES = [
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

// schema day_of_week: 0=Saturday .. 6=Friday (Iran week)
const SEED_WORKING_HOURS = [
  { day_of_week: 0, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 1, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 2, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 3, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 4, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 5, start_time: "09:00", end_time: "21:00", is_closed: false },
  { day_of_week: 6, start_time: "00:00", end_time: "00:00", is_closed: true },
];
function schemaDayOf(date) {
  return (date.getDay() + 1) % 7;
}
// crypto.randomUUID() throws in non-secure/sandboxed contexts (e.g. some preview
// iframes) — this works everywhere and is plenty unique for a client-only demo.
function uid() {
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
function usePersistedState(initial, persist) {
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
const persistServices  = (prev, next) => syncCollection("services", prev, next);
const persistTimeOff   = (prev, next) => syncCollection("time_offs", prev, next);
const persistApproved  = (prev, next) => syncApprovedDates(prev, next);
const persistSalonHours = (_prev, next) => saveWorkingHours(null, next);

// staffWorkingHours is a { [stylistId]: WorkingHoursArray } map, not a list.
const persistStaffHours = async (prev, next) => {
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
const DEFAULT_REMINDER_HOURS = 3;

const FALLBACK_SMS_TEMPLATES = {
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

const SMS_KIND_LABEL = {
  confirmation: "تایید رزرو",
  reminder: "یادآوری نوبت",
  cancellation: "لغو نوبت",
  reschedule: "تغییر زمان",
  reschedule_proposed: "پیشنهاد تغییر زمان",
  campaign: "کمپین جذب مجدد",
  loyalty: "باشگاه مشتریان",
  feedback_request: "درخواست نظرسنجی",
  feedback_followup: "یادآوری نظرسنجی",
  custom: "پیام آزاد",
};

// One-click smart campaign drafts — warm, casual tone, per segment. Only these
// three segments get an actionable draft (per spec); the other RFM buckets are
// informational only in the BI tab.
const RFM_SMART_DRAFTS = {
  champions: "سلام {{name}} جونم! مرسی که همیشه همراه مایی ❤️ یه هدیه کوچیک برای نوبت بعدیت داری: ۱۰٪ تخفیف روی تمام خدمات سالن. منتظر دیدنتیم!",
  champions_vip: "سلام {{name}} عزیز 💎 شما یکی از ارزشمندترین مشتریان سالن ما هستید و می‌خواستیم این رو بهتون بگیم. به‌عنوان قدردانی، ۲۰٪ تخفیف ویژه VIP روی نوبت بعدیتون منتظرتونه — هر وقت مایل بودید، در اولویت رزرو شما هستیم.",
  at_risk: "سلام {{name}} جان، {{days}} روزه ندیدیمت و دلمون برات تنگ شده! برای اینکه زودتر برگردی، ۲۰٪ تخفیف ویژه برات در نظر گرفتیم 🎁 منتظرتیم.",
  new: "سلام {{name}} عزیز، خیلی خوشحالیم که اومدی پیشمون! امیدواریم از خدمات راضی بوده باشی. برای نوبت بعدیت هم همیشه در خدمتتیم 🌸",
  inactive: "سلام {{name}} عزیز، مدتیه ندیدیمت! هر وقت دلت خواست دوباره سر بزنی، با روی باز منتظرتیم 💛",
};

const SMS_STATUS_META = {
  queued:    { label: "در صف", color: "var(--color-info)" },
  sent:      { label: "ارسال شد", color: "var(--color-success)" },
  delivered: { label: "تحویل شد", color: "var(--color-success)" },
  failed:    { label: "ناموفق", color: "var(--color-danger)" },
};

const KNOWN_CUSTOMER = { phone: "09121234567", name: "سارا محمدی", gender: "female" };
const STAFF_PHONE = "09120000000";

// Stylists working at the salon — each belongs to one section (female/male), same as services.
// A booking can be assigned to a specific stylist, or left as "فرقی ندارد" (staff_id: null).
const SEED_STYLISTS = [
  { id: "st1", name: "مهسا کریمی", gender: "female", active: true, phone: "09121110001", password: "1234", reminder_hours_before: 3 },
  { id: "st2", name: "نیلوفر صادقی", gender: "female", active: true, phone: "09121110002", password: "1234", reminder_hours_before: 3 },
  { id: "st3", name: "رضا احمدی", gender: "male", active: true, phone: "09121110003", password: "1234", reminder_hours_before: 3 },
];
function makeSeedStylist(overrides) {
  return { id: uid(), name: "", gender: "female", active: true, phone: "", password: "", reminder_hours_before: 3, ...overrides };
}

function randomTrackingCode() {
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
function hasPrice(service) {
  return !!service && service.price != null && service.price > 0;
}
// Discount now lives on the SERVICE, not the booking/customer — compute the effective price from it.
function discountAmountFor(service) {
  if (!hasPrice(service) || service.discount_type === "none" || !service.discount_value) return 0;
  return service.discount_type === "percent"
    ? Math.round((service.price * service.discount_value) / 100)
    : service.discount_value;
}
function finalPriceFor(service) {
  if (!hasPrice(service)) return null;
  return Math.max(0, service.price - discountAmountFor(service));
}
function priceLabel(service) {
  return hasPrice(service) ? formatToman(service.price) : "قیمت در سالن اعلام می‌شود";
}

function makeSeedBooking(overrides) {
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

function makeSeedExpense(overrides) {
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
function occupiedEndFor(booking) {
  return booking.end_min + (booking.buffer_minutes || 0);
}

// Is this exact minute literally inside an existing booking's blocked range?
// (independent of whatever service the *next* customer might want — this is what "someone
// already has this time" actually means, and the only thing that should render as reserved/red.)
function isOccupied(t, dayBookings) {
  return dayBookings.some((b) => t >= b.start_min && t < occupiedEndFor(b));
}

// Could a service of the given duration (plus its OWN touch-up buffer, since that occupies
// the calendar too) start at t without overlapping ANY booking that day? This is a strict
// superset of isOccupied — a tick can fail this while still being free (e.g. a 15-minute gap
// that's too short for a 40-minute service), and that case must never be presented to the
// customer as "reserved" — it just doesn't fit *this* selection.
function fitsWithoutOverlap(t, durationMinutes, dayBookings, bufferMinutes = 0) {
  const candidateEnd = t + durationMinutes + bufferMinutes;
  return !dayBookings.some((b) => t < occupiedEndFor(b) && candidateEnd > b.start_min);
}

// Status badge styling per spec: confirmed -> accent-500 bg, completed -> success,
// cancelled -> muted + strikethrough, no_show -> warning. pending/rescheduled use info/accent-700.
const STATUS_META = {
  pending: { label: "در انتظار تایید", bg: "var(--color-info)", fg: "white", Icon: Clock, strike: false },
  confirmed: { label: "تایید شده", bg: "var(--color-accent-500)", fg: "oklch(16% 0.02 70)", Icon: CheckCircle2, strike: false },
  cancelled: { label: "لغو شده", bg: "var(--color-muted)", fg: "white", Icon: XCircle, strike: true },
  rescheduled: { label: "تغییر زمان", bg: "var(--color-accent-700)", fg: "white", Icon: RotateCcw, strike: false },
  reschedule_proposed: { label: "پیشنهاد تغییر زمان", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: Clock, strike: false },
  completed: { label: "انجام شده", bg: "var(--color-success)", fg: "white", Icon: Check, strike: false },
  no_show: { label: "عدم حضور", bg: "var(--color-warning)", fg: "oklch(16% 0.02 70)", Icon: X, strike: false },
};

/* ============================================================
   Small shared UI atoms
   ============================================================ */
function Badge({ status }) {
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  return (
    <span className="badge" style={{ background: meta.bg, color: meta.fg }}>
      <Icon size={13} /> {meta.label}
    </span>
  );
}

function GenderBadge({ gender }) {
  const meta = SECTION_META[gender];
  if (!meta) return null;
  const Icon = meta.Icon;
  return (
    <span className="badge" style={{ background: meta.tint, color: meta.color }}>
      <Icon size={12} /> {meta.short}
    </span>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="switch tap"
      style={{ background: checked ? "var(--color-accent-500)" : "var(--color-border)", border: "none", padding: 0 }}
      aria-pressed={checked}
    >
      <span className="switch-knob" style={{ transform: checked ? "translateX(-19px)" : "translateX(-3px)", right: 0 }} />
    </button>
  );
}

function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div
      className="fade-in tap"
      style={{
        position: "fixed", bottom: "calc(20px + env(safe-area-inset-bottom, 0px))", left: "50%", transform: "translateX(-50%)",
        background: "var(--color-heading)", color: "var(--color-bg)",
        padding: "10px 18px", borderRadius: "var(--radius-md)", fontSize: 14,
        display: "flex", alignItems: "center", gap: 8, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        maxWidth: "92vw",
      }}
    >
      <MessageSquareText size={16} />
      {message}
    </div>
  );
}

function Modal({ title, onClose, children, danger, wide }) {
  return (
    <div
      className="backdrop-in"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 90 }}
      onClick={onClose}
    >
      <div
        className="card sheet-up safe-bottom"
        style={{
          width: "100%", maxWidth: wide ? 520 : 480, margin: "0 auto 0",
          borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          borderTopLeftRadius: "var(--radius-xl)", borderTopRightRadius: "var(--radius-xl)",
          padding: "10px 20px 20px", maxHeight: "88vh", overflowY: "auto",
          boxShadow: "0 -16px 40px -12px oklch(20% 0.02 60 / 0.28)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontSize: 17, color: danger ? "var(--color-danger)" : undefined }}>{title}</h3>
          <button className="tap ghost-btn" style={{ width: 36, height: 36, padding: 0 }} onClick={onClose}>
            <X size={18} style={{ margin: "auto" }} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, bold, strike }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "6px 0", fontSize: 13.5 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: bold ? 800 : 600, color: "var(--color-heading)", fontSize: bold ? 15 : 13.5, textDecoration: strike ? "line-through" : "none", opacity: strike ? 0.6 : 1 }}>
        {value}
      </span>
    </div>
  );
}

// A consistent, colorful page header for panel tabs — icon badge + title +
// one-line description. Each tab passes its own color so the whole panel
// doesn't read as one flat gray surface; the color also visually matches
// that tab's icon in the sub-nav below, so the two reinforce each other.
function PanelSectionHeader({ Icon, title, subtitle, color }) {
  return (
    <div
      className="flex items-center gap-3 mb-4"
      style={{ padding: "14px 16px", borderRadius: "var(--radius-lg)", background: `linear-gradient(135deg, color-mix(in oklch, ${color} 12%, var(--color-surface)), var(--color-surface))`, border: `1px solid color-mix(in oklch, ${color} 18%, var(--color-border))` }}
    >
      <div
        style={{
          width: 40, height: 40, borderRadius: "var(--radius-md)", flexShrink: 0,
          background: color, display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 4px 14px -4px color-mix(in oklch, ${color} 60%, transparent)`,
        }}
      >
        <Icon size={19} color="white" />
      </div>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 16.5, color: "var(--color-heading)" }}>{title}</h2>
        {subtitle && <p className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.6 }}>{subtitle}</p>}
      </div>
    </div>
  );
}

// Horizontal, RTL-aware day timeline. Renders a soft pill-shaped track with hour ticks,
// shadowed rounded blocks for booked ranges, a tinted dashed outline for the range the
// customer is about to pick, and a live "now" marker — so busy vs. free reads at a glance.
function DayTimeline({ startMin, endMin, blocks, selectedRange, compact }) {
  const trackHeight = compact ? 40 : 46;
  const tickAreaHeight = compact ? 20 : 22;
  const trackTop = tickAreaHeight + 4;
  const rowHeight = trackTop + trackHeight + 6;
  const totalMin = Math.max(1, endMin - startMin);
  const pct = (min) => `${(min / totalMin) * 100}%`;
  const minBlockPx = compact ? 34 : 40;

  const firstHour = Math.ceil(startMin / 60);
  const lastHour = Math.floor(endMin / 60);
  const totalHours = lastHour - firstHour;
  // Thin out hour labels on wide ranges so they never overlap on a narrow screen —
  // the whole day always fits in view, so density has to adapt instead of scrolling.
  const hourStep = totalHours > 9 ? 3 : totalHours > 5 ? 2 : 1;
  const hourMarks = [];
  for (let h = firstHour; h <= lastHour; h += hourStep) hourMarks.push(h);
  if (hourMarks[hourMarks.length - 1] !== lastHour) hourMarks.push(lastHour);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const showNow = nowMin >= startMin && nowMin <= endMin;

  return (
    <div className="surface-raised" style={{ borderRadius: "var(--radius-lg)", padding: "10px 10px 14px" }}>
      <div style={{ position: "relative", width: "100%", height: rowHeight }}>
        {/* baseline pill track */}
        <div style={{ position: "absolute", right: 0, left: 0, top: trackTop, height: trackHeight, background: "var(--color-bg)", borderRadius: "var(--radius-full)", border: "1px solid var(--color-border)" }} />

        {/* hour ticks */}
        {hourMarks.map((h) => (
          <div key={h} style={{ position: "absolute", right: pct(h * 60 - startMin), top: 0, transform: "translateX(50%)", textAlign: "center" }}>
            <div style={{ width: 1, height: 8, background: "var(--color-border)", margin: "0 auto" }} />
            <span className="muted tabular" style={{ fontSize: compact ? 9 : 10, whiteSpace: "nowrap", display: "block", marginTop: 1 }}>{formatClock(h * 60)}</span>
          </div>
        ))}

        {/* booked blocks — span the whole day, sized generously so they're unmistakable even for short bookings */}
        {blocks.map((b, i) => {
          const spanFrac = (Math.min(b.end, endMin) - Math.max(b.start, startMin)) / totalMin;
          const roomy = spanFrac * 100 > 14; // wide enough to fit the "رزرو شده" label
          return (
            <div
              key={i}
              title={b.title}
              style={{
                position: "absolute",
                right: pct(Math.max(0, b.start - startMin)),
                width: `max(${pct(Math.min(b.end, endMin) - Math.max(b.start, startMin))}, ${minBlockPx}px)`,
                top: trackTop + 1, height: trackHeight - 2,
                background: b.color, borderRadius: "var(--radius-full)",
                border: "2px solid var(--color-surface)",
                boxShadow: "0 3px 10px -1px rgba(0,0,0,.35)",
                display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                fontSize: compact ? 10.5 : 11.5, color: b.textColor || "white", fontWeight: 800, whiteSpace: "nowrap", padding: "0 8px",
              }}
            >
              {roomy ? b.label : <Lock size={compact ? 13 : 15} />}
            </div>
          );
        })}

        {/* selected range highlight */}
        {selectedRange && (
          <div
            className="fade-in"
            style={{
              position: "absolute",
              right: pct(Math.max(0, selectedRange.start - startMin)),
              width: `max(${pct(selectedRange.end - selectedRange.start)}, ${minBlockPx}px)`,
              top: trackTop - 3, height: trackHeight + 6,
              border: "2px dashed var(--color-accent-500)", borderRadius: "var(--radius-full)",
              background: "color-mix(in oklch, var(--color-accent-500) 16%, transparent)",
            }}
          />
        )}

        {/* live "now" marker */}
        {showNow && (
          <div style={{ position: "absolute", right: pct(nowMin - startMin), top: trackTop - 5, height: trackHeight + 10, width: 2, background: "var(--color-danger)", borderRadius: 1, transform: "translateX(50%)" }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-danger)", position: "absolute", top: -4, right: -2.5, boxShadow: "0 0 0 2px var(--color-surface-raised)" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// Horizontal, RTL-aware date picker. Each day is a soft rounded card that lifts with a
// tinted shadow when selected, dims and labels itself "تعطیل" when the salon is closed
// that day, and shows a small dot under today's date when it isn't the active selection.
function DateStrip({ days, selectedDate, onSelect, isClosedFn, reasonFn, accentColor = "var(--color-accent-500)", compact }) {
  const todayKey = dateKey(new Date());
  const size = compact ? 50 : 60;
  return (
    <div className="flex gap-2 scrollbar-none" style={{ overflowX: "auto", padding: "4px 2px 8px" }}>
      {days.map((d) => {
        const key = dateKey(d);
        const closed = isClosedFn(d);
        const reason = reasonFn ? reasonFn(d) : null;
        const active = key === dateKey(selectedDate);
        const isToday = key === todayKey;
        return (
          <button
            key={key}
            disabled={closed}
            onClick={() => onSelect(d)}
            className="tap"
            style={{
              minWidth: size, width: size, flexShrink: 0, textAlign: "center",
              padding: compact ? "8px 2px 7px" : "10px 2px 9px",
              borderRadius: "var(--radius-lg)",
              border: `1px solid ${active ? accentColor : "var(--color-border)"}`,
              background: active ? accentColor : "var(--color-surface)",
              color: active ? "white" : closed ? "var(--color-muted)" : "var(--color-heading)",
              opacity: closed ? 0.5 : 1,
              boxShadow: active ? `0 8px 16px -6px color-mix(in oklch, ${accentColor} 60%, transparent)` : "none",
              transform: active ? "translateY(-2px)" : "none",
            }}
          >
            <div style={{ fontSize: compact ? 9.5 : 10.5, fontWeight: 700, opacity: active ? 0.9 : 0.7, letterSpacing: 0.3 }}>
              {WEEKDAYS_FA_SHORT[d.getDay()]}
            </div>
            {closed ? (
              <div style={{ fontSize: compact ? 9 : 9.5, fontWeight: 700, marginTop: 5 }}>{reason === "notApproved" ? "به‌زودی" : "تعطیل"}</div>
            ) : (
              <div className="tabular" style={{ fontSize: compact ? 14 : 16, fontWeight: 800, marginTop: 3 }}>{toFa(jalaliDayNum(d))}</div>
            )}
            {isToday && !active && !closed && (
              <div style={{ width: 4, height: 4, borderRadius: "50%", background: accentColor, margin: "4px auto 0" }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   Main App
   ============================================================ */
export default function App() {
  const [theme, setTheme] = useState("light");
  const [tab, setTab] = useState("book"); // book | track | panel
  const [toast, setToast] = useState("");
  const [panelAuthed, setPanelAuthed] = useState(false);
  const [currentStylistId, setCurrentStylistId] = useState(null); // null = salon owner/manager
  // NEW: the authenticated role, resolved from public.users.role at login.
  // The RBAC model itself is untouched — owner/manager/stylist, same as before.
  const [currentRole, setCurrentRole] = useState(null); // 'owner' | 'manager' | 'stylist' | null
  // Which section (زنانه/مردانه) the customer has committed to inside the current
  // booking flow — used to make the header reflect just that section instead of
  // always advertising "both" once they're actually inside one of them.
  const [activeSection, setActiveSection] = useState(null);
  // Kept only as the offline/demo fallback credential. When Supabase is
  // configured, auth is real and this is never consulted.
  const [ownerAccount, setOwnerAccount] = useState({ phone: STAFF_PHONE, password: "1234" });

  // ---- backend status -------------------------------------------------------
  const [dataReady, setDataReady] = useState(false);
  const [backendNote, setBackendNote] = useState("");

  // ---- collections wired to Postgres (setter contract unchanged) ------------
  const [services, setServices, servicesCtl] = usePersistedState(SEED_SERVICES, persistServices);
  const [stylists, setStylists] = useState(SEED_STYLISTS);
  const [workingHours, setWorkingHours, hoursCtl] = usePersistedState(SEED_WORKING_HOURS, persistSalonHours);
  const [staffWorkingHours, setStaffWorkingHours, staffHoursCtl] = usePersistedState({}, persistStaffHours);
  const [timeOff, setTimeOff, timeOffCtl] = usePersistedState([], persistTimeOff);
  // A day only accepts new customer bookings once the stylist has explicitly opened it —
  // by day, by week, or by month (all of which just add date keys to this same flat set).
  const [approvedDates, setApprovedDates, approvedCtl] = usePersistedState(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const arr = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(dateKey(d));
    }
    return arr;
  }, persistApproved);

  const [bookings, setBookings] = useState(() => {
    const t = new Date();
    return [
      makeSeedBooking({
        customer_name: "الهام رضایی", customer_phone: "09351112233", customer_gender: "female",
        service_id: "f2", date: dateKey(t), start_min: 11 * 60, end_min: 13 * 60,
        status: "confirmed", original_price: 950000, final_price: 950000,
      }),
      makeSeedBooking({
        customer_name: "نگار احمدی", customer_phone: "09121112233", customer_gender: "female",
        service_id: "f7", date: dateKey(t), start_min: 14 * 60, end_min: 14 * 60 + 45,
        status: "pending", original_price: 350000, final_price: 350000,
      }),
      makeSeedBooking({
        customer_name: "سارا محمدی", customer_phone: KNOWN_CUSTOMER.phone, customer_gender: "female",
        service_id: "f1", date: dateKey(t), start_min: 9 * 60, end_min: 9 * 60 + 45,
        status: "completed", original_price: 250000, final_price: 250000,
      }),
      makeSeedBooking({
        customer_name: "کیان تهرانی", customer_phone: "09190001122", customer_gender: "male",
        service_id: "m2", date: dateKey(t), start_min: 16 * 60, end_min: 16 * 60 + 20,
        status: "no_show", original_price: 120000, final_price: 120000,
      }),
      makeSeedBooking({
        customer_name: "آرش نوری", customer_phone: "09190002233", customer_gender: "male",
        service_id: "m1", date: dateKey(t), start_min: 17 * 60, end_min: 17 * 60 + 30,
        status: "confirmed", original_price: 180000, final_price: 160000, discount_type: "fixed", discount_value: 20000, discount_reason: "تخفیف افتتاحیه",
      }),
    ];
  });

  const [expenses, setExpenses] = useState(() => {
    const t = new Date();
    const daysAgo = (n) => {
      const d = new Date(t);
      d.setDate(d.getDate() - n);
      return dateKey(d);
    };
    return [
      makeSeedExpense({ title: "اجارهٔ ماهانهٔ سالن", category: "rent", amount: 45000000, date: daysAgo(5) }),
      makeSeedExpense({ title: "خرید مواد رنگ مو و مراقبتی", category: "supplies", amount: 3200000, date: daysAgo(2) }),
      makeSeedExpense({ title: "حقوق دستیار سالن", category: "salary", amount: 12000000, date: daysAgo(1) }),
      makeSeedExpense({ title: "تبلیغات اینستاگرام", category: "marketing", amount: 1500000, date: daysAgo(3) }),
      makeSeedExpense({ title: "قبض برق و آب", category: "utilities", amount: 950000, date: daysAgo(6) }),
    ];
  });

  // Waitlist: when a customer's desired day is fully booked, they can leave their
  // phone number instead — staff see the list per-day and reach out if a slot opens up.
  const [waitlist, setWaitlist] = useState([]);

  // SMS templates, loaded from public.sms_templates (falls back to the constants).
  const [smsTemplates, setSmsTemplates] = useState([]);

  /* --------------------------------------------------------------- live refs */
  // Read-your-writes without stale closures, and without touching child props.
  const bookingsRef = useRef(bookings);
  const stylistsRef = useRef(stylists);
  const servicesRef = useRef(services);
  const templatesRef = useRef(smsTemplates);
  useEffect(() => { bookingsRef.current = bookings; }, [bookings]);
  useEffect(() => { stylistsRef.current = stylists; }, [stylists]);
  useEffect(() => { servicesRef.current = services; }, [services]);
  useEffect(() => { templatesRef.current = smsTemplates; }, [smsTemplates]);

  /* Font is loaded directly in index.html now — see the <link> there. Loading
     it via a JS effect (the old approach) meant the page always painted once
     in the fallback system font first, then flashed to Vazirmatn once the
     effect ran and the stylesheet finished fetching; a plain <link> in <head>
     starts the fetch immediately, in parallel with everything else. */

  /* ------------------------------------------------------------- BOOTSTRAP */
  // One parallel load of every table, then arm the write path. Until this
  // resolves the app shows its seed data, so first paint is never blank.
  useEffect(() => {
    let cancelled = false;

    function armAll() {
      servicesCtl.arm(true); hoursCtl.arm(true); staffHoursCtl.arm(true);
      timeOffCtl.arm(true); approvedCtl.arm(true);
    }

    (async () => {
      if (!SUPABASE_ENABLED) {
        setBackendNote("حالت دمو — دیتابیس متصل نیست، داده‌ها ذخیره نمی‌شوند");
        armAll();
        setDataReady(true);
        return;
      }

      const [session, data, templates] = await Promise.all([
        restoreSession(),
        bootstrap(),
        fetchSmsTemplates(),
      ]);
      if (cancelled) return;

      if (!data) {
        setBackendNote("اتصال به دیتابیس برقرار نشد — نمایش داده‌های نمونه");
        armAll();
        setDataReady(true);
        return;
      }

      if (data.services.length) servicesCtl.hydrate(data.services);
      if (data.stylists.length) setStylists(data.stylists);
      if (data.workingHours) hoursCtl.hydrate(data.workingHours);
      staffHoursCtl.hydrate(data.staffWorkingHours || {});
      timeOffCtl.hydrate(data.timeOff || []);
      if (data.approvedDates.length) approvedCtl.hydrate(data.approvedDates);
      setBookings(data.bookings || []);
      setExpenses(data.expenses || []);
      setWaitlist(data.waitlist || []);
      setSmsTemplates(templates || []);

      if (session) {
        setPanelAuthed(true);
        setCurrentRole(session.role);
        setCurrentStylistId(session.stylistId ?? null);
        // bootstrap() only loaded the PII-free slots view (safe for the
        // anonymous booking flow) — staff need the real dataset, RLS-scoped
        // to their role.
        fetchFullAppointments().then((full) => { if (!cancelled && full.length) setBookings(full); });
      }

      armAll();
      setDataReady(true);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------------------- REALTIME */
  // Another device books → this calendar updates without a refresh.
  useEffect(() => {
    if (!SUPABASE_ENABLED) return;
    return subscribeAppointments(({ type, row, oldId }) => {
      setBookings((prev) => {
        if (type === "DELETE") return prev.filter((b) => b.id !== oldId);
        if (!row) return prev;
        return prev.some((b) => b.id === row.id)
          ? prev.map((b) => (b.id === row.id ? row : b))
          : [...prev, row];
      });
    });
  }, []);

  // v2.18 — anonymous visitors lost live updates when appointments' RLS was
  // scoped to staff only (v2.16); postgres_changes above now delivers
  // nothing to them. This broadcast-based signal replaces it: no row
  // content crosses the wire, just a ping to re-fetch the PII-free slots
  // view. Scoped to !panelAuthed only — a staff session already has full
  // row updates above, and merging slot-only data into it would strip
  // customer fields from what's already loaded.
  useEffect(() => {
    if (!SUPABASE_ENABLED || panelAuthed) return;
    return subscribeSlotChanges(async () => {
      const slots = await fetchPublicSlots();
      if (slots.length) setBookings(slots);
    });
  }, [panelAuthed]);

  function notify(msg) {
    setToast(msg);
  }

  /* ============================================================
     SMS dispatch — centralised here on purpose. Every booking
     mutation in the app already funnels through addBooking /
     updateBooking, so wiring SMS at this one point covers the
     customer flow, the staff panel and the tracking tab at once.
     ============================================================ */
  function templateBody(kind) {
    const row = (templatesRef.current || []).find((t) => t.kind === kind && t.is_default)
      || (templatesRef.current || []).find((t) => t.kind === kind);
    return (row && row.body) || FALLBACK_SMS_TEMPLATES[kind] || "";
  }

  function bookingSmsVars(b) {
    const svc = (servicesRef.current || []).find((s) => s.id === b.service_id);
    return {
      name: b.customer_name || "مشتری",
      service: svc ? svc.name : "خدمت",
      date: jalaliLabel(parseDateKey(b.date), { withWeekday: false }),
      time: formatClock(b.start_min),
      stylist: b.staff_name || "بدون آرایشگر مشخص",
      code: b.tracking_code || "",
      link: `${window.location.origin}/feedback/${b.id}`,
    };
  }

  async function sendBookingSms(booking, kind) {
    if (!/^09\d{9}$/.test(booking.customer_phone || "")) return;
    const body = renderTemplate(templateBody(kind), bookingSmsVars(booking));
    if (!body.trim()) return;
    await sendSms({ to: booking.customer_phone, body, kind, appointmentId: booking.id });
  }

  // Reminder timing comes from the stylist's own reminder_hours_before field —
  // the one that already existed on every stylist record.
  async function queueReminder(booking) {
    if (!SUPABASE_ENABLED) return;
    if (!["pending", "confirmed", "rescheduled"].includes(booking.status)) return;
    if (!/^09\d{9}$/.test(booking.customer_phone || "")) return;

    const stylist = (stylistsRef.current || []).find((s) => s.id === booking.staff_id);
    const hours = stylist?.reminder_hours_before ?? DEFAULT_REMINDER_HOURS;
    const sendAt = bookingTimestamp(booking) - hours * 3600000;
    if (sendAt <= Date.now()) return; // window already passed — the cron sweep handles it

    await scheduleReminder({
      to: booking.customer_phone,
      body: renderTemplate(templateBody("reminder"), bookingSmsVars(booking)),
      appointmentId: booking.id,
      scheduledFor: new Date(sendAt).toISOString(),
    });
  }

  // v2.18 — a second, softer nudge 24h after the first feedback request,
  // in case the customer missed it or hasn't gotten to it yet. Cancelled
  // automatically if they submit before it fires (see FeedbackPage.jsx,
  // which calls cancelScheduledReminders on successful submit) — this
  // reuses the exact same queue/cancel mechanism as booking reminders, no
  // new infrastructure.
  async function queueFeedbackFollowup(booking) {
    if (!SUPABASE_ENABLED) return;
    if (!/^09\d{9}$/.test(booking.customer_phone || "")) return;
    await scheduleReminder({
      to: booking.customer_phone,
      body: renderTemplate(templateBody("feedback_followup"), bookingSmsVars(booking)),
      appointmentId: booking.id,
      scheduledFor: new Date(Date.now() + 24 * 3600000).toISOString(),
      kind: "feedback_followup",
    });
  }

  /* ------------------------------------------------------------- mutations */
  function addBooking(b, onInserted) {
    setBookings((prev) => [...prev, b]);
    (async () => {
      const err = await insertOne("appointments", b);
      if (err) { notify("ثبت نوبت روی سرور ناموفق بود"); return; }
      await sendBookingSms(b, "confirmation");
      await queueReminder(b);
      broadcastSlotChange();
      if (onInserted) await onInserted();
    })();
  }

  function updateBooking(id, patch, logMsg) {
    const before = (bookingsRef.current || []).find((b) => b.id === id);
    const after = before ? { ...before, ...patch } : null;

    setBookings((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    if (logMsg) notify(logMsg);

    (async () => {
      const err = await updateOne("appointments", id, patch);
      if (err) { notify("ذخیره‌ی تغییر روی سرور ناموفق بود"); return; }
      if (!after || !patch.status || patch.status === before.status) return;

      if (patch.status === "cancelled") {
        await cancelScheduledReminders(id);
        await sendBookingSms(after, "cancellation");
        broadcastSlotChange();
      } else if (patch.status === "rescheduled") {
        await cancelScheduledReminders(id);
        await sendBookingSms(after, "reschedule");
        await queueReminder(after);
        broadcastSlotChange();
      } else if (patch.status === "reschedule_proposed") {
        // The actual date/start_min haven't moved yet — only the pending_*
        // fields carry the proposed new time, so swap those in just for
        // building this one message (bookingSmsVars reads .date/.start_min).
        await sendBookingSms({ ...after, date: after.pending_date, start_min: after.pending_start_min }, "reschedule_proposed");
      } else if (patch.status === "confirmed") {
        await sendBookingSms(after, "confirmation");
        await queueReminder(after);
      } else if (patch.status === "no_show") {
        await cancelScheduledReminders(id);
      } else if (patch.status === "completed") {
        await sendBookingSms(after, "feedback_request");
        await queueFeedbackFollowup(after);
      }
    })();
  }

  function addExpense(e) {
    setExpenses((prev) => [...prev, e]);
    insertOne("expenses", e);
    notify("هزینه ثبت شد");
  }

  function removeExpense(id) {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    deleteOne("expenses", id);
    notify("هزینه حذف شد");
  }

  function addWaitlistEntry(entry) {
    setWaitlist((prev) => [...prev, entry]);
    insertOne("waitlist", entry);
  }

  function removeWaitlistEntry(id) {
    setWaitlist((prev) => prev.filter((w) => w.id !== id));
    deleteOne("waitlist", id);
  }

  function addStylist(s) {
    setStylists((prev) => [...prev, s]);
    insertOne("stylists", s);
    notify("آرایشگر اضافه شد");
  }

  function updateStylist(id, patch) {
    setStylists((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    updateOne("stylists", id, patch);
  }

  function removeStylist(id) {
    setStylists((prev) => prev.filter((s) => s.id !== id));
    deleteOne("stylists", id);
    notify("آرایشگر حذف شد");
  }

  // Offline fallback only — real registration happens in OwnerAuthPanel via Supabase Auth.
  function registerOwner(phone, password) {
    setOwnerAccount({ phone, password });
    notify("ثبت‌نام مدیر سالن با موفقیت انجام شد");
  }

  async function handleLogout() {
    await authSignOut();
    // Full reload, not just clearing auth state — bootstrap() loads
    // bookings/customers/etc. into React state, and that state must not
    // persist into a different account's session in the same tab.
    window.location.reload();
  }

  const tabs = [
    { id: "book", label: "نوبت‌دهی", Icon: CalendarPlus, color: "var(--color-tab-book)", grad: "var(--grad-tab-book)" },
    { id: "track", label: "داشبورد من", Icon: LayoutDashboard, color: "var(--color-tab-dash)", grad: "var(--grad-tab-dash)" },
    { id: "panel", label: "پنل مدیریت", Icon: ShieldCheck, color: "var(--color-tab-panel)", grad: "var(--grad-tab-panel)" },
  ];

  return (
    <div className="salon-app" data-theme={theme} style={{ minHeight: 640, paddingBottom: 24 }}>
      <style>{TOKENS_CSS}</style>

      {/* Header — sticky, blurred; tabs live here at the top */}
      <header className="header-blur safe-top" style={{ position: "sticky", top: 0, zIndex: 70, borderBottom: "1px solid var(--color-border)" }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "12px 16px" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                style={{
                  width: 34, height: 34, borderRadius: "var(--radius-md)",
                  background: "var(--grad-brand)", display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "var(--shadow-glow-accent)",
                }}
              >
                <Sparkles size={17} color="white" />
              </div>
              <div>
                <h1 style={{ fontSize: 14.5, lineHeight: 1.2 }}>{SALON_NAME}</h1>
                <p className="muted" style={{ fontSize: 10.5 }}>
                  رزرو آنلاین نوبت · {tab === "book" && activeSection ? GENDER_TYPE_LABEL[activeSection] : GENDER_TYPE_LABEL[SALON_GENDER_TYPE]}
                </p>
              </div>
            </div>
            <button
              className="tap ghost-btn"
              style={{ width: 38, height: 38, padding: 0 }}
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              aria-label="تغییر پوسته"
            >
              {theme === "light" ? <Moon size={16} style={{ margin: "auto" }} /> : <Sun size={16} style={{ margin: "auto" }} />}
            </button>
          </div>

          {/* Tabs — each has its own color identity, active or not */}
          <div className="flex gap-1.5 mt-3" role="tablist" aria-label="ناوبری اصلی">
            {tabs.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setTab(t.id); setActiveSection(null); }}
                  className="tap flex items-center justify-center gap-1.5"
                  style={{
                    flex: 1, padding: "9px 4px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: active ? 800 : 700,
                    background: active ? t.grad : `color-mix(in oklch, ${t.color} 12%, var(--color-surface))`,
                    color: active ? "white" : t.color,
                    boxShadow: active ? `0 4px 14px -4px color-mix(in oklch, ${t.color} 60%, transparent)` : "none",
                    border: active ? "none" : `1px solid color-mix(in oklch, ${t.color} 22%, transparent)`,
                  }}
                >
                  <t.Icon size={14} strokeWidth={active ? 2.4 : 2.2} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: "0 auto", padding: "16px" }}>
        {/* Backend status — only shown when something is off, never in the happy path */}
        {backendNote && (
          <div
            className="card fade-in flex items-center gap-2 mb-3"
            style={{ padding: "9px 12px", borderColor: "var(--color-warning)", background: "var(--color-accent-50)" }}
          >
            <AlertTriangle size={14} color="var(--color-warning)" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: 11.5, color: "var(--color-body)" }}>{backendNote}</p>
          </div>
        )}

        {!dataReady && (
          <div className="card fade-in flex items-center justify-center gap-2" style={{ padding: 28 }}>
            <Loader2 size={16} className="salon-spin" color="var(--color-accent-500)" />
            <p className="muted" style={{ fontSize: 12.5 }}>در حال بارگذاری اطلاعات سالن…</p>
          </div>
        )}

        {dataReady && tab === "book" && (
          <BookingFlow services={services} stylists={stylists} bookings={bookings} workingHours={workingHours} staffWorkingHours={staffWorkingHours} timeOff={timeOff} approvedDates={approvedDates} addBooking={addBooking} waitlist={waitlist} addWaitlistEntry={addWaitlistEntry} notify={notify} onSectionChange={setActiveSection} />
        )}
        {dataReady && tab === "track" && (
          <TrackView bookings={bookings} services={services} stylists={stylists} workingHours={workingHours} staffWorkingHours={staffWorkingHours} timeOff={timeOff} approvedDates={approvedDates} updateBooking={updateBooking} notify={notify} />
        )}
        {dataReady && tab === "panel" && !panelAuthed && (
          <LoginScreen
            stylists={stylists}
            addStylist={addStylist}
            ownerAccount={ownerAccount}
            registerOwner={registerOwner}
            notify={notify}
            onSuccess={({ role, stylistId }) => {
              setPanelAuthed(true);
              setCurrentRole(role);
              setCurrentStylistId(stylistId ?? null);
            }}
          />
        )}
        {dataReady && tab === "panel" && panelAuthed && (
          <PanelView
            bookings={bookings}
            services={services}
            setServices={setServices}
            stylists={stylists}
            addStylist={addStylist}
            updateStylist={updateStylist}
            removeStylist={removeStylist}
            currentStylistId={currentStylistId}
            currentRole={currentRole}
            smsTemplates={smsTemplates}
            workingHours={workingHours}
            setWorkingHours={setWorkingHours}
            staffWorkingHours={staffWorkingHours}
            setStaffWorkingHours={setStaffWorkingHours}
            timeOff={timeOff}
            setTimeOff={setTimeOff}
            approvedDates={approvedDates}
            setApprovedDates={setApprovedDates}
            updateBooking={updateBooking}
            expenses={expenses}
            addExpense={addExpense}
            removeExpense={removeExpense}
            waitlist={waitlist}
            removeWaitlistEntry={removeWaitlistEntry}
            notify={notify}
            onLogout={handleLogout}
          />
        )}
      </main>

      <Toast message={toast} onDone={() => setToast("")} />
    </div>
  );
}

/* ============================================================
   Login screen (staff — phone + OTP, demo only)
   ============================================================ */
function LoginScreen({ stylists, addStylist, ownerAccount, registerOwner, notify, onSuccess }) {
  const [mode, setMode] = useState("stylist"); // "stylist" | "owner"

  return (
    <div className="fade-in" style={{ paddingTop: 24, textAlign: "center" }}>
      <div
        style={{
          width: 56, height: 56, borderRadius: "50%", background: "var(--color-accent-100)",
          display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
        }}
      >
        <Lock size={24} color="var(--color-accent-700)" />
      </div>
      <h2 style={{ fontSize: 18 }}>ورود پرسنل سالن</h2>

      <div className="flex gap-1 mx-auto mt-4 mb-2" style={{ width: "fit-content", background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
        {[{ v: "stylist", l: "ورود آرایشگر" }, { v: "owner", l: "ورود مدیر سالن" }].map((o) => (
          <button
            key={o.v}
            onClick={() => setMode(o.v)}
            className="tap"
            style={{
              padding: "6px 12px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700,
              background: mode === o.v ? "var(--color-surface)" : "transparent",
              color: mode === o.v ? "var(--color-heading)" : "var(--color-muted)",
            }}
          >
            {o.l}
          </button>
        ))}
      </div>

      {mode === "owner" ? (
        <OwnerAuthPanel ownerAccount={ownerAccount} registerOwner={registerOwner} notify={notify} onSuccess={(role) => onSuccess({ role: role || "owner", stylistId: null })} />
      ) : (
        <StylistAuthPanel stylists={stylists} addStylist={addStylist} notify={notify} onSuccess={(id) => onSuccess({ role: "stylist", stylistId: id })} />
      )}
    </div>
  );
}

// Username IS the phone number, plus a password — same model as stylists. Only one
// manager account exists per salon (single-tenant demo), so registration is only
// offered while no account has been created yet.
function OwnerAuthPanel({ ownerAccount, registerOwner, notify, onSuccess }) {
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const phoneValid = /^09\d{9}$/.test(phone);

  // Real auth against Supabase. When Supabase isn't configured we fall back to
  // the original in-memory credential check so the demo still works offline.
  async function handleLogin() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await signIn(phone, password, "owner");
      setBusy(false);
      if (!res.ok) { setError(res.error || "ورود ناموفق بود"); return; }
      if (res.role === "stylist") { setError("این حساب آرایشگر است — از تب «ورود آرایشگر» وارد شوید"); return; }
      onSuccess(res.role);
      return;
    }
    setBusy(false);
    if (!ownerAccount || ownerAccount.phone !== phone || ownerAccount.password !== password) {
      setError("شماره موبایل یا رمز عبور اشتباه است");
      return;
    }
    onSuccess("owner");
  }

  async function handleRegister() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await authRegisterOwner(phone, password);
      setBusy(false);
      if (!res.ok) { setError(res.error || "ثبت‌نام ناموفق بود"); return; }
      notify("ثبت‌نام مدیر سالن با موفقیت انجام شد");
      onSuccess(res.role);
      return;
    }
    setBusy(false);
    if (ownerAccount) { setError("برای این سالن قبلاً یک مدیر ثبت‌نام کرده — وارد شوید"); return; }
    registerOwner(phone, password);
    onSuccess("owner");
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 16 }}>
        {authMode === "login" ? "با شماره موبایل و رمز عبور خود وارد شوید" : "برای ساخت حساب مدیریتی سالن ثبت‌نام کنید"}
      </p>

      <div className="flex flex-col gap-3">
        <input
          dir="ltr" inputMode="numeric" value={phone}
          onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 11)); setError(""); }}
          placeholder="09xxxxxxxxx (نام کاربری)" className="tabular" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
        <input
          type="password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          placeholder="رمز عبور" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
      </div>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <button
        disabled={busy || !phoneValid || password.trim().length < 4}
        onClick={authMode === "login" ? handleLogin : handleRegister}
        className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
        style={{ padding: 13 }}
      >
        {busy && <Loader2 size={14} className="salon-spin" />}
        {authMode === "login" ? "ورود" : "ثبت‌نام و ورود"}
      </button>

      <button
        className="muted mt-3"
        style={{ fontSize: 12.5 }}
        onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}
      >
        {authMode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "قبلاً ثبت‌نام کرده‌اید؟ وارد شوید"}
      </button>

      {authMode === "login" && !SUPABASE_ENABLED && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
          برای دمو از شماره <span className="tabular" dir="ltr">{toFa(STAFF_PHONE)}</span> و رمز <span className="tabular">{toFa("1234")}</span> استفاده کنید
        </p>
      )}
    </div>
  );
}

function StylistAuthPanel({ stylists, addStylist, notify, onSuccess }) {
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  // Registration fields
  const [name, setName] = useState("");
  const [gender, setGender] = useState("female");

  const [busy, setBusy] = useState(false);
  const phoneValid = /^09\d{9}$/.test(phone);

  async function handleLogin() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await signIn(phone, password, "stylist");
      setBusy(false);
      if (!res.ok) { setError(res.error || "ورود ناموفق بود"); return; }
      if (res.role !== "stylist") { setError("این حساب مدیر است — از تب «ورود مدیر سالن» وارد شوید"); return; }
      onSuccess(res.stylistId);
      return;
    }
    setBusy(false);
    const match = stylists.find((s) => s.phone === phone && s.password === password);
    if (!match) { setError("شماره موبایل یا رمز عبور اشتباه است"); return; }
    if (!match.active) { setError("حساب شما غیرفعال شده — با مدیر سالن تماس بگیرید"); return; }
    onSuccess(match.id);
  }

  async function handleRegister() {
    setBusy(true); setError("");
    const s = makeSeedStylist({ name: name.trim(), gender, phone, password, active: true });

    if (SUPABASE_ENABLED) {
      const res = await authRegisterStylist({ phone, password, name: name.trim(), gender, stylistId: s.id });
      setBusy(false);
      if (!res.ok) { setError(res.error || "ثبت‌نام ناموفق بود"); return; }
      notify("ثبت‌نام با موفقیت انجام شد");
      onSuccess(res.stylistId);
      return;
    }
    setBusy(false);
    if (stylists.some((x) => x.phone === phone)) { setError("این شماره قبلاً ثبت شده — وارد شوید"); return; }
    addStylist(s);
    notify("ثبت‌نام با موفقیت انجام شد");
    onSuccess(s.id);
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 16 }}>
        {authMode === "login" ? "با شماره موبایل و رمز عبور خود وارد شوید" : "برای ساخت پنل شخصی خودتان ثبت‌نام کنید"}
      </p>

      {authMode === "register" && (
        <div className="flex flex-col gap-3 fade-in" style={{ marginBottom: 12 }}>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>بخش</label>
            <div className="flex gap-2 mt-1">
              {["female", "male"].map((g) => {
                const meta = SECTION_META[g];
                const Icon = meta.Icon;
                return (
                  <button
                    key={g}
                    onClick={() => setGender(g)}
                    className="tap flex-1 flex items-center justify-center gap-1.5"
                    style={{
                      padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                      border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                      background: gender === g ? meta.tint : "var(--color-surface)",
                      color: gender === g ? meta.color : "var(--color-body)",
                    }}
                  >
                    <Icon size={14} /> {meta.short}
                  </button>
                );
              })}
            </div>
          </div>
          <input
            value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
            placeholder="نام و نام‌خانوادگی" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "right" }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <input
          dir="ltr" inputMode="numeric" value={phone}
          onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 11)); setError(""); }}
          placeholder="09xxxxxxxxx" className="tabular" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
        <input
          type="password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          placeholder="رمز عبور" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
      </div>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <button
        disabled={busy || !phoneValid || password.trim().length < 4 || (authMode === "register" && !name.trim())}
        onClick={authMode === "login" ? handleLogin : handleRegister}
        className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
        style={{ padding: 13 }}
      >
        {busy && <Loader2 size={14} className="salon-spin" />}
        {authMode === "login" ? "ورود" : "ثبت‌نام و ورود"}
      </button>

      <button
        className="muted mt-3"
        style={{ fontSize: 12.5 }}
        onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}
      >
        {authMode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "قبلاً ثبت‌نام کرده‌اید؟ وارد شوید"}
      </button>
    </div>
  );
}

/* ============================================================
   Booking flow (customer) — gender section chosen first, each
   section then shows only its own services/categories.
   ============================================================ */
// Shown when a customer's chosen day has no open slots left — lets them leave a
// phone number instead of just turning them away. Staff see these in the panel.
function WaitlistJoinCard({ onJoin, alreadyJoined }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const phoneValid = /^09\d{9}$/.test(phone);

  if (alreadyJoined || done) {
    return (
      <div className="card fade-in" style={{ padding: 18, textAlign: "center" }}>
        <CheckCircle2 size={20} color="var(--color-success)" style={{ margin: "0 auto 6px" }} />
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>در لیست انتظار این روز ثبت شدید</p>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>در صورت خالی شدن نوبت، سالن با شما تماس می‌گیرد</p>
      </div>
    );
  }

  return (
    <div className="card fade-in" style={{ padding: 16, textAlign: "center" }}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: open ? 10 : 0 }}>
        {open ? "شماره‌تان را برای اطلاع‌رسانی وارد کنید" : "می‌خواهید در صورت خالی شدن نوبت باخبر شوید؟"}
      </p>
      {!open ? (
        <button className="tap accent-btn flex items-center gap-1.5 mt-3" style={{ padding: "9px 16px", fontSize: 12.5, margin: "10px auto 0" }} onClick={() => setOpen(true)}>
          <Bell size={13} /> ثبت در لیست انتظار
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            dir="ltr" inputMode="numeric" value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            placeholder="09xxxxxxxxx" className="tabular"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, textAlign: "center" }}
          />
          <input
            value={name} onChange={(e) => setName(e.target.value)} placeholder="نام (اختیاری)"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, textAlign: "center" }}
          />
          <button
            disabled={!phoneValid}
            className="tap accent-btn w-full"
            style={{ padding: 11, fontSize: 13 }}
            onClick={() => { onJoin({ phone, name }); setDone(true); }}
          >
            ثبت درخواست
          </button>
        </div>
      )}
    </div>
  );
}

function BookingFlow({ services, stylists, bookings, workingHours, staffWorkingHours, timeOff, approvedDates, addBooking, waitlist, addWaitlistEntry, notify, onSectionChange }) {
  const [step, setStep] = useState(1); // 1 gender, 2 service, 3 stylist, 4 date/time, 5 phone, 6 confirm, 7 done
  const [gender, setGender] = useState(null);
  const [category, setCategory] = useState("all");
  const [serviceId, setServiceId] = useState(null);
  const [staffId, setStaffId] = useState(null); // null = "فرقی ندارد"
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [phone, setPhone] = useState("");
  const [lookedUp, setLookedUp] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [knownCustomer, setKnownCustomer] = useState(false);
  const [knownCustomerName, setKnownCustomerName] = useState("");
  const [loyaltyDiscountPct, setLoyaltyDiscountPct] = useState(0);
  const [name, setName] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const sectionServices = services.filter((s) => s.is_active && s.gender === gender);
  const categories = ["all", ...Array.from(new Set(sectionServices.map((s) => s.category)))];
  const visibleServices = category === "all" ? sectionServices : sectionServices.filter((s) => s.category === category);
  const service = services.find((s) => s.id === serviceId);
  const section = gender ? SECTION_META[gender] : null;
  const sectionStaff = stylists.filter((s) => s.active && s.gender === gender);
  const selectedStaff = stylists.find((s) => s.id === staffId) || null;
  // Once a time is picked under "فرقی ندارد", this holds whichever stylist actually
  // got assigned to it — see the slot-click handler below.
  const [assignedStaffId, setAssignedStaffId] = useState(null);
  const effectiveStaff = selectedStaff || stylists.find((s) => s.id === assignedStaffId) || null;

  function whForId(stId, date) {
    const list = (stId && staffWorkingHours[stId]) || workingHours;
    return list.find((w) => w.day_of_week === schemaDayOf(date));
  }
  // Only a WHOLE-day record (no start/end time) closes the day entirely — a
  // partial-hour closure (e.g. "closed 14:00–16:00 for a break") leaves the
  // rest of the day bookable as normal, so it must NOT trip this check.
  function isTimeOffForId(stId, date) {
    return timeOff.some((t) => (!t.staff_id || t.staff_id === stId) && t.date === dateKey(date) && t.start_min == null);
  }
  function isApproved(date) {
    return approvedDates.includes(dateKey(date));
  }
  function unavailableReasonForId(stId, date) {
    const wh = whForId(stId, date);
    if (!wh || wh.is_closed) return "closed";
    if (isTimeOffForId(stId, date)) return "timeoff";
    if (!isApproved(date)) return "notApproved";
    return null;
  }
  function dayBookingsForId(stId, date) {
    const dKey = dateKey(date);
    // A booking awaiting customer confirmation of a proposed reschedule still
    // occupies its ORIGINAL slot until resolved — include it in the occupied set.
    const realBookings = bookings.filter(
      (b) => b.date === dKey && b.staff_id === stId && (b.status === "confirmed" || b.status === "pending" || b.status === "rescheduled" || b.status === "reschedule_proposed")
    );
    // Partial-hour closures block time exactly like a booking would — reuse
    // the same overlap-checking mechanics (fitsWithoutOverlap/isOccupied)
    // by representing each one as a phantom "booking" with no buffer.
    const partialClosures = timeOff
      .filter((t) => (!t.staff_id || t.staff_id === stId) && t.date === dKey && t.start_min != null)
      .map((t) => ({ start_min: t.start_min, end_min: t.end_min, buffer_minutes: 0 }));
    return [...realBookings, ...partialClosures];
  }
  // The same 15-min-grid + gap-closing-candidate logic used everywhere else,
  // scoped to one specific stylist's own calendar.
  function slotTicksForId(stId, date) {
    if (!service || unavailableReasonForId(stId, date)) return [];
    const wh = whForId(stId, date);
    const start = hhmmToMin(wh.start_time);
    const end = hhmmToMin(wh.end_time);
    const dayB = dayBookingsForId(stId, date);
    const dKey = dateKey(date);
    const isToday = dKey === dateKey(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const candidates = new Set();
    for (let t = start; t + service.duration_minutes <= end; t += 15) candidates.add(t);
    for (const b of dayB) {
      const freeAt = occupiedEndFor(b);
      if (freeAt >= start && freeAt + service.duration_minutes <= end) candidates.add(freeAt);
    }
    const out = [];
    for (const t of Array.from(candidates).sort((a, b) => a - b)) {
      if (isToday && t <= nowMin + 10) continue;
      out.push({ t, fits: fitsWithoutOverlap(t, service.duration_minutes, dayB, service.buffer_minutes || 0), dayCount: dayB.length });
    }
    return out;
  }

  // Backward-compatible aliases used by the date-strip / "closed today" messaging,
  // which still need a single yes/no per day — for "فرقی ندارد" a day only reads as
  // closed if it's closed for *every* stylist in the section, not just one.
  function whFor(date) { return whForId(staffId, date); }
  function unavailableReason(date) {
    if (staffId) return unavailableReasonForId(staffId, date);
    if (sectionStaff.length === 0) return "closed";
    return sectionStaff.every((st) => unavailableReasonForId(st.id, date)) ? unavailableReasonForId(sectionStaff[0].id, date) : null;
  }

  const days = useMemo(() => {
    const arr = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, []);

  const dayBookings = useMemo(() => dayBookingsForId(staffId, selectedDate), [bookings, selectedDate, staffId]);

  const slotTicks = useMemo(() => {
    if (!service) return [];

    // A specific stylist was chosen — their own calendar only, occupied/fits both shown.
    if (staffId) {
      if (unavailableReasonForId(staffId, selectedDate)) return [];
      return slotTicksForId(staffId, selectedDate).map(({ t, fits }) => ({ t, fits, occupied: isOccupied(t, dayBookings) }));
    }

    // "فرقی ندارد" — union across every active stylist in the section: a time is
    // offerable the moment AT LEAST ONE of them is actually free then, not only when
    // the whole section happens to be simultaneously free.
    if (sectionStaff.length === 0) return [];
    const merged = new Map(); // t -> { fits, availableStaffIds: [] }
    for (const st of sectionStaff) {
      for (const { t, fits, dayCount } of slotTicksForId(st.id, selectedDate)) {
        const entry = merged.get(t) || { t, fits: false, availableStaffIds: [] };
        if (fits) { entry.fits = true; entry.availableStaffIds.push({ id: st.id, dayCount }); }
        merged.set(t, entry);
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => a.t - b.t)
      .map((x) => ({ t: x.t, fits: x.fits, occupied: false, availableStaffIds: x.availableStaffIds }));
  }, [service, selectedDate, staffId, sectionStaff, dayBookings, workingHours, staffWorkingHours, timeOff, approvedDates, bookings]);

  const slots = useMemo(() => slotTicks.filter((x) => x.fits).map((x) => x.t), [slotTicks]);

  // Picking a time under "فرقی ندارد" must resolve to one real stylist right away —
  // otherwise the booking would be created with no one actually assigned to do it.
  // Ties go to whoever has fewer bookings that day, for a simple fairness spread.
  function selectSlot(t) {
    setSelectedSlot(t);
    if (staffId) { setAssignedStaffId(null); return; }
    const tick = slotTicks.find((x) => x.t === t);
    const candidates = tick?.availableStaffIds || [];
    if (candidates.length === 0) { setAssignedStaffId(null); return; }
    const best = [...candidates].sort((a, b) => a.dayCount - b.dayCount)[0];
    setAssignedStaffId(best.id);
  }

  // Real customer lookup — this used to just compare against a single
  // hardcoded demo phone number (KNOWN_CUSTOMER), meaning every actual
  // returning customer was always treated as brand new. Now it queries the
  // real customer_loyalty() RPC, same source of truth the "داشبورد من" tab
  // already uses, so a real returning customer is correctly recognized and
  // doesn't need to re-type their name on every booking.
  async function lookupPhone() {
    setLookedUp(true);
    setLookingUp(true);
    if (SUPABASE_ENABLED) {
      const res = await fetchCustomerLoyalty(phone);
      if (res?.found && res.name?.trim()) {
        setKnownCustomer(true);
        setKnownCustomerName(res.name.trim());
        setName(res.name.trim());
        setLoyaltyDiscountPct(res.discount_percent || 0);
      } else {
        setKnownCustomer(false);
        setKnownCustomerName("");
        setName("");
        setLoyaltyDiscountPct(0);
      }
    } else if (phone === KNOWN_CUSTOMER.phone) {
      setKnownCustomer(true);
      setKnownCustomerName(KNOWN_CUSTOMER.name);
      setName(KNOWN_CUSTOMER.name);
      setLoyaltyDiscountPct(0); // demo mode has no real loyalty_settings to compute a tier from
    } else {
      setKnownCustomer(false);
      setKnownCustomerName("");
      setName("");
      setLoyaltyDiscountPct(0);
    }
    setLookingUp(false);
  }

  const phoneValid = /^09\d{9}$/.test(phone);
  const discount = service ? discountAmountFor(service) : 0;
  // Loyalty discount stacks AFTER the service's own discount (applied to
  // the already-discounted price) — the common, customer-friendly pattern,
  // and keeps original_price/discount_type/discount_value/final_price
  // meaning exactly what they already mean (the service-level discount
  // only); the loyalty layer is tracked separately as loyalty_discount_pct/
  // loyalty_discount_amount so nothing about the existing columns changes.
  const servicePrice = service ? finalPriceFor(service) : 0;
  const loyaltyDiscountAmount = service && hasPrice(service) && servicePrice != null
    ? Math.round((servicePrice * loyaltyDiscountPct) / 100)
    : 0;
  const finalPrice = servicePrice != null ? Math.max(0, servicePrice - loyaltyDiscountAmount) : null;

  function confirmBooking() {
    const code = randomTrackingCode();
    const finalStaffId = staffId || assignedStaffId || null;
    const finalStaff = stylists.find((s) => s.id === finalStaffId) || null;
    const loyaltyNote = loyaltyDiscountAmount > 0 ? `${toFa(loyaltyDiscountPct)}٪ تخفیف باشگاه مشتریان` : "";
    const booking = makeSeedBooking({
      customer_name: name.trim(),
      customer_phone: phone,
      customer_gender: gender,
      service_id: service.id,
      staff_id: finalStaffId,
      staff_name: finalStaff ? finalStaff.name : "",
      date: dateKey(selectedDate),
      start_min: selectedSlot,
      end_min: selectedSlot + service.duration_minutes,
      buffer_minutes: service.buffer_minutes || 0,
      status: "pending",
      original_price: service.price,
      discount_type: service.discount_type,
      discount_value: service.discount_value,
      discount_reason: [service.discount_reason, loyaltyNote].filter(Boolean).join(" · "),
      final_price: finalPrice,
      tracking_code: code,
      sms_sent_confirmation: true,
    });
    addBooking(
      booking,
      !knownCustomer && referralCode.trim()
        ? async () => {
            const res = await applyReferral(phone, referralCode.trim());
            if (res.ok) notify("کد معرفی ثبت شد — بعد از اولین نوبت شما، پاداش معرف فعال می‌شود");
          }
        : null
    );
    setResult(booking);
    notify("پیامک تایید نوبت ارسال شد");
    setStep(7);
  }

  function reset() {
    setStep(1); setGender(null); setServiceId(null); setStaffId(null); setSelectedSlot(null); setAssignedStaffId(null); setPhone(""); setLookedUp(false);
    setName(""); setReferralCode(""); setResult(null); setCopied(false); setCategory("all");
    onSectionChange(null);
  }

  return (
    <div className="fade-in">
      {step >= 2 && step <= 6 && (
        <div className="flex items-center gap-1 mb-4">
          {[2, 3, 4, 5, 6].map((n) => (
            <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: n <= step ? "var(--color-accent-500)" : "var(--color-border)" }} />
          ))}
        </div>
      )}

      {/* Step 1 — choose section (this is what makes the two salons feel like separate models) */}
      {step === 1 && (
        <div>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>بخش مورد نظر را انتخاب کنید</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{SALON_NAME} دارای دو بخش مجزای زنانه و مردانه است</p>
          <div className="flex flex-col gap-3">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              const count = services.filter((s) => s.is_active && s.gender === g).length;
              return (
                <button
                  key={g}
                  onClick={() => { setGender(g); setCategory("all"); setStep(2); onSectionChange(g); }}
                  className="tap card"
                  style={{ padding: 18, display: "flex", alignItems: "center", gap: 14, textAlign: "right", borderColor: "var(--color-border)" }}
                >
                  <div style={{ width: 52, height: 52, borderRadius: "var(--radius-lg)", background: meta.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={26} color={meta.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--color-heading)" }}>{meta.label}</div>
                    <div className="muted tabular" style={{ fontSize: 12, marginTop: 2 }}>{toFa(count)} خدمت فعال</div>
                  </div>
                  <ArrowRight size={16} className="muted" style={{ transform: "rotate(180deg)" }} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2 — service selection, scoped to the chosen section */}
      {step === 2 && section && (
        <div>
          <button
            className="flex items-center gap-1.5 mb-3"
            style={{ fontSize: 12.5, fontWeight: 700, color: section.color }}
            onClick={() => { setStep(1); setServiceId(null); onSectionChange(null); }}
          >
            <section.Icon size={14} /> {section.label} <span className="muted" style={{ fontWeight: 400 }}>· تغییر بخش</span>
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب خدمت</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>خدمت مورد نظرتان را انتخاب کنید</p>

          {categories.length > 2 && (
            <div className="flex gap-2 scrollbar-none mb-3" style={{ overflowX: "auto", paddingBottom: 4 }}>
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className="tap"
                  style={{
                    flexShrink: 0, padding: "7px 14px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
                    border: `1px solid ${category === c ? section.color : "var(--color-border)"}`,
                    background: category === c ? section.color : "var(--color-surface)",
                    color: category === c ? "white" : "var(--color-body)",
                  }}
                >
                  {c === "all" ? "همه" : CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {visibleServices.map((s) => {
              const Icon = SERVICE_ICONS[s.category] || Sparkles;
              const dAmt = discountAmountFor(s);
              const fPrice = finalPriceFor(s);
              return (
                <button
                  key={s.id}
                  onClick={() => { setServiceId(s.id); setStaffId(null); setStep(3); }}
                  className="tap card"
                  style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right" }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: section.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={19} color={section.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>{s.name}</div>
                    <div className="muted tabular" style={{ fontSize: 12, marginTop: 2 }}>
                      {toFa(s.duration_minutes)} دقیقه
                      {!hasPrice(s) ? (
                        <> · {priceLabel(s)}</>
                      ) : dAmt > 0 ? (
                        <>
                          {" · "}<span style={{ textDecoration: "line-through" }}>{formatToman(s.price)}</span>{" "}
                          <span style={{ color: "var(--color-danger)", fontWeight: 700 }}>{formatToman(fPrice)}</span>
                        </>
                      ) : (
                        <> · {formatToman(s.price)}</>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {visibleServices.length === 0 && (
              <div className="card" style={{ padding: 20, textAlign: "center" }}>
                <p className="muted" style={{ fontSize: 13 }}>خدمتی در این دسته یافت نشد</p>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 3 && service && section && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={() => setStep(2)}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب آرایشگر</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{service.name} · می‌توانید آرایشگر دلخواه‌تان را انتخاب کنید</p>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => { setStaffId(null); setSelectedSlot(null); setAssignedStaffId(null); setStep(4); }}
              className="tap card"
              style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right", borderColor: staffId === null ? section.color : "var(--color-border)" }}
            >
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--color-surface-raised)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Users size={18} color="var(--color-muted)" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>فرقی ندارد</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>بهترین زمان خالی بین همهٔ آرایشگرهای این بخش را نشان می‌دهیم؛ پس از انتخاب ساعت، آرایشگر به‌طور خودکار تعیین می‌شود</div>
              </div>
            </button>

            {sectionStaff.map((st) => (
              <button
                key={st.id}
                onClick={() => { setStaffId(st.id); setSelectedSlot(null); setAssignedStaffId(null); setStep(4); }}
                className="tap card"
                style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right", borderColor: staffId === st.id ? section.color : "var(--color-border)" }}
              >
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: section.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <User size={18} color={section.color} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>{st.name}</div>
                </div>
              </button>
            ))}

            {sectionStaff.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "8px 0" }}>
                هنوز آرایشگری برای این بخش ثبت نشده — می‌توانید ادامه دهید
              </p>
            )}
          </div>
        </div>
      )}

      {step === 4 && service && section && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={() => setStep(3)}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>انتخاب تاریخ و ساعت</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            {service.name} · {toFa(service.duration_minutes)} دقیقه{selectedStaff ? ` · ${selectedStaff.name}` : ""}
          </p>

          <DateStrip
            days={days}
            selectedDate={selectedDate}
            onSelect={(d) => { setSelectedDate(d); setSelectedSlot(null); setAssignedStaffId(null); }}
            isClosedFn={(d) => !!unavailableReason(d)}
            reasonFn={unavailableReason}
            accentColor={section.color}
          />

          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)", margin: "16px 0 8px" }}>
            {jalaliLabel(selectedDate)}
          </p>

          {slotTicks.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: "center" }}>
              <p className="muted" style={{ fontSize: 13 }}>
                {unavailableReason(selectedDate) === "timeoff"
                  ? "سالن در این روز تعطیل موقت است"
                  : unavailableReason(selectedDate) === "notApproved"
                  ? "این روز هنوز توسط سالن برای رزرو باز نشده است"
                  : unavailableReason(selectedDate) === "closed"
                  ? "سالن در این روز تعطیل است"
                  : "زمان خالی برای امروز باقی نمانده"}
              </p>
            </div>
          ) : null}

          {slotTicks.length === 0 && !unavailableReason(selectedDate) && (
            <WaitlistJoinCard
              key={dateKey(selectedDate)}
              alreadyJoined={waitlist.some(
                (w) => w.date === dateKey(selectedDate) && w.service_id === service.id && (w.staff_id || null) === (staffId || null)
              )}
              onJoin={({ phone, name }) => {
                addWaitlistEntry({
                  id: uid(),
                  customer_name: name.trim(),
                  customer_phone: phone,
                  customer_gender: gender,
                  service_id: service.id,
                  staff_id: staffId,
                  staff_name: selectedStaff ? selectedStaff.name : "",
                  date: dateKey(selectedDate),
                  created_at: Date.now(),
                });
              }}
            />
          )}

          {slotTicks.length > 0 && (
            <>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-danger)", opacity: 0.5, display: "inline-block" }} /> رزرو شده
                </span>
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-border)", display: "inline-block" }} /> زمان کافی نیست
                </span>
                <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: section.color, display: "inline-block" }} /> زمان انتخابی شما
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {slotTicks.map(({ t, occupied, fits }) => (
                  <button
                    key={t}
                    disabled={!fits}
                    title={occupied ? "این زمان رزرو شده است" : !fits ? "زمان کافی برای این خدمت باقی نمانده" : undefined}
                    onClick={() => selectSlot(t)}
                    className="tap tabular"
                    style={{
                      padding: "10px 2px", borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                      border: `1px solid ${occupied ? "var(--color-danger)" : !fits ? "var(--color-border)" : selectedSlot === t ? section.color : "var(--color-border)"}`,
                      background: occupied
                        ? "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))"
                        : !fits ? "var(--color-surface-raised)"
                        : selectedSlot === t ? section.color : "var(--color-surface)",
                      color: occupied ? "var(--color-danger)" : !fits ? "var(--color-muted)" : selectedSlot === t ? "white" : "var(--color-body)",
                      textDecoration: occupied ? "line-through" : "none",
                      opacity: !fits ? (occupied ? 0.8 : 0.55) : 1,
                      cursor: !fits ? "not-allowed" : "pointer",
                    }}
                  >
                    {formatClock(t)}
                  </button>
                ))}
              </div>
            </>
          )}

          {selectedSlot != null && (
            <p className="muted tabular fade-in" style={{ fontSize: 12, marginTop: 10 }}>
              پایان تقریبی: {formatClock(selectedSlot + service.duration_minutes)}
            </p>
          )}

          {selectedSlot != null && !staffId && effectiveStaff && (
            <div className="fade-in flex items-center gap-2" style={{ marginTop: 10, padding: "10px 12px", borderRadius: "var(--radius-md)", background: section.tint }}>
              <User size={15} color={section.color} />
              <span style={{ fontSize: 12.5, color: "var(--color-heading)" }}>
                در این ساعت، <b>{effectiveStaff.name}</b> برای شما در دسترس است
              </span>
            </div>
          )}
          {selectedSlot != null && !staffId && !effectiveStaff && (
            <p className="fade-in muted" style={{ fontSize: 11.5, marginTop: 10 }}>
              آرایشگر شما هنگام تایید نهایی مشخص می‌شود
            </p>
          )}

          <button disabled={selectedSlot == null} onClick={() => setStep(5)} className="tap accent-btn w-full mt-5" style={{ padding: "13px" }}>
            ادامه
          </button>
        </div>
      )}

      {step === 5 && service && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={() => setStep(4)}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>شماره تماس</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>برای پیگیری و اطلاع‌رسانی نوبت لازم است</p>

          <div className="flex gap-2">
            <input
              dir="ltr"
              inputMode="numeric"
              value={phone}
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 11)); setLookedUp(false); setKnownCustomer(false); setKnownCustomerName(""); }}
              placeholder="09xxxxxxxxx"
              className="tabular"
              style={{ flex: 1, padding: "11px 14px", fontSize: 14, textAlign: "left" }}
            />
            <button disabled={!phoneValid || lookingUp} onClick={lookupPhone} className="tap ghost-btn" style={{ padding: "0 16px", fontSize: 13, fontWeight: 700 }}>
              {lookingUp ? "..." : "بررسی"}
            </button>
          </div>

          {lookedUp && knownCustomer && (
            <div className="card fade-in mt-3" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <User size={18} color="var(--color-accent-500)" />
              <p style={{ fontSize: 13 }}>خوش برگشتید، <b style={{ color: "var(--color-heading)" }}>{knownCustomerName}</b> عزیز</p>
            </div>
          )}

          {lookedUp && !knownCustomer && phoneValid && (
            <div className="fade-in mt-3 flex flex-col gap-3">
              <div>
                <label className="muted" style={{ fontSize: 12 }}>نام و نام‌خانوادگی</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً مریم کریمی" style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 }} />
              </div>
              <div>
                <label className="muted" style={{ fontSize: 12 }}>کد معرفی (اختیاری)</label>
                <input
                  dir="ltr" value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  placeholder="مثلاً A1B2C3" className="tabular"
                  style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4, textAlign: "left" }}
                />
              </div>
            </div>
          )}

          <button
            disabled={!lookedUp || !phoneValid || (!knownCustomer && !name.trim())}
            onClick={() => setStep(6)}
            className="tap accent-btn w-full mt-5"
            style={{ padding: "13px" }}
          >
            ادامه
          </button>
        </div>
      )}

      {step === 6 && service && (
        <div>
          <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={() => setStep(5)}>
            <ArrowRight size={14} /> بازگشت
          </button>
          <h2 style={{ fontSize: 18, marginBottom: 14 }}>تایید نهایی</h2>

          <div className="card" style={{ padding: 16 }}>
            <Row label="بخش" value={section.label} />
            <Row label="خدمت" value={service.name} />
            {effectiveStaff && <Row label="آرایشگر" value={effectiveStaff.name} />}
            <Row label="تاریخ" value={jalaliLabel(selectedDate, { short: true })} />
            <Row label="ساعت" value={formatClock(selectedSlot)} />
            <Row label="مشتری" value={knownCustomer ? knownCustomerName : name} />
            <Row label="شماره تماس" value={<span dir="ltr">{toFa(phone)}</span>} />
            <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
            {!hasPrice(service) && <Row label="مبلغ" value={priceLabel(service)} bold />}
            {hasPrice(service) && (discount > 0 || loyaltyDiscountAmount > 0) && <Row label="قیمت اصلی" value={formatToman(service.price)} strike />}
            {hasPrice(service) && discount > 0 && <Row label="تخفیف" value={"- " + formatToman(discount)} />}
            {hasPrice(service) && loyaltyDiscountAmount > 0 && (
              <Row label={`تخفیف باشگاه مشتریان (${toFa(loyaltyDiscountPct)}٪)`} value={"- " + formatToman(loyaltyDiscountAmount)} />
            )}
            {hasPrice(service) && <Row label="مبلغ نهایی" value={formatToman(finalPrice)} bold />}
          </div>

          <button onClick={confirmBooking} className="tap accent-btn w-full mt-5" style={{ padding: "13px" }}>
            ثبت نهایی نوبت
          </button>
        </div>
      )}

      {step === 7 && result && (
        <div className="fade-in" style={{ textAlign: "center", paddingTop: 12 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "color-mix(in oklch, var(--color-success) 18%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <Check size={30} color="var(--color-success)" />
          </div>
          <h2 style={{ fontSize: 18 }}>نوبت شما ثبت شد</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>پیامک تایید ارسال شد</p>

          <div className="card mt-4" style={{ padding: 16, textAlign: "right" }}>
            <Row label="خدمت" value={service.name} />
            {result.staff_name && <Row label="آرایشگر" value={result.staff_name} />}
            <Row label="تاریخ" value={jalaliLabel(selectedDate, { short: true })} />
            <Row label="ساعت" value={formatClock(selectedSlot)} />
            <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
            {result.final_price == null ? (
              <Row label="مبلغ" value="قیمت در سالن اعلام می‌شود" bold />
            ) : (
              <>
                {result.original_price > result.final_price && (
                  <>
                    <Row label="قیمت اصلی" value={formatToman(result.original_price)} strike />
                    <Row label="تخفیف" value={"- " + formatToman(result.original_price - result.final_price)} />
                  </>
                )}
                <Row label="مبلغ نهایی" value={formatToman(result.final_price)} bold />
              </>
            )}
          </div>

          <div className="card mt-3" style={{ padding: 14, background: "var(--color-surface-raised)", border: "1px dashed var(--color-accent-500)", textAlign: "center" }}>
            <Phone size={16} color="var(--color-accent-700)" style={{ margin: "0 auto 6px" }} />
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>برای پیگیری نوبت</p>
            <p className="muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.8 }}>
              کافی است در تب «داشبورد من»، همین شماره موبایل (<span dir="ltr" className="tabular">{toFa(phone)}</span>) را وارد کنید
            </p>
          </div>

          <button onClick={reset} className="tap ghost-btn w-full mt-5" style={{ padding: "12px", fontWeight: 700 }}>
            رزرو نوبت جدید
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Track view (public, restricted fields only)
   ============================================================ */
// Public-facing (no login needed — customer_loyalty() is granted to `anon`).
// This is the only place a customer can see their own referral code, which
// is the whole point of having one: without this, applyReferral() has no
// codes for anyone to actually enter.
const DASH_SEGMENTS = [
  { id: "bookings", label: "نوبت‌ها", Icon: CalendarCheck, color: "var(--color-tab-book)" },
  { id: "points", label: "امتیازات", Icon: Award, color: "var(--color-success)" },
  { id: "referrals", label: "معرفی‌ها", Icon: UserPlus, color: "var(--color-tab-panel)" },
];

// Small deterministic color picker for referral-member avatars — same person
// always gets the same color, and the palette stays varied (not all one hue).
const AVATAR_PALETTE = [
  "var(--color-tab-book)", "var(--color-tab-dash)", "var(--color-tab-panel)",
  "var(--color-success)", "var(--color-warning)", "var(--color-female-500)",
];
function avatarColorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[h];
}

function TrackView({ bookings, services, stylists, workingHours, staffWorkingHours, timeOff, approvedDates, updateBooking, notify }) {
  const [phone, setPhone] = useState("");
  const [searched, setSearched] = useState(false);
  const [actionFor, setActionFor] = useState(null); // { id, type: "cancel" | "reschedule" }
  const [segment, setSegment] = useState("bookings");

  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [myBookings, setMyBookings] = useState([]);
  const [searching, setSearching] = useState(false);

  const phoneValid = /^09\d{9}$/.test(phone);
  // v2.16: bookings prop is now the PII-free slots view for an anonymous
  // caller — a customer's own bookings come from get_my_bookings(phone)
  // instead, fetched on search rather than filtered client-side.
  const matches = useMemo(
    () => [...myBookings].sort((a, b) => (b.date + String(b.start_min).padStart(4, "0")).localeCompare(a.date + String(a.start_min).padStart(4, "0"))),
    [myBookings]
  );

  const actionBooking = actionFor ? myBookings.find((b) => b.id === actionFor.id) : null;

  // v2.16: myBookings is a local fetch result now (from get_my_bookings),
  // not derived from the global bookings state — updateBooking alone won't
  // update it, so every cancel/reschedule action in this view goes through
  // this instead to keep the UI in sync immediately.
  function updateMyBooking(id, patch, logMsg) {
    updateBooking(id, patch, logMsg);
    setMyBookings((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  useEffect(() => {
    if (!searched || !phoneValid || !SUPABASE_ENABLED) { setLoyalty(null); return; }
    let cancelled = false;
    (async () => {
      setLoyaltyLoading(true);
      const res = await fetchCustomerLoyalty(phone);
      if (!cancelled) { setLoyalty(res); setLoyaltyLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [searched, phone, phoneValid]);

  const hasAnything = matches.length > 0 || loyalty?.found;

  return (
    <div className="fade-in">
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>داشبورد من</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>شماره موبایلی که با آن نوبت گرفته‌اید را وارد کنید</p>

      <div className="flex gap-2">
        <input
          dir="ltr"
          inputMode="numeric"
          value={phone}
          onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 11)); setSearched(false); setMyBookings([]); }}
          placeholder="09xxxxxxxxx"
          className="tabular"
          style={{ flex: 1, padding: "11px 14px", fontSize: 14, textAlign: "left" }}
        />
        <button
          disabled={!phoneValid || searching}
          onClick={async () => {
            setSearching(true);
            setMyBookings(SUPABASE_ENABLED ? await fetchMyBookings(phone) : bookings.filter((b) => b.customer_phone === phone));
            setSearching(false);
            setSearched(true);
            setSegment("bookings");
          }}
          className="tap"
          style={{ padding: "0 20px", fontSize: 13, fontWeight: 700, borderRadius: "var(--radius-md)", background: "var(--grad-tab-dash)", color: "white", boxShadow: "0 4px 14px -4px color-mix(in oklch, var(--color-tab-dash) 60%, transparent)" }}
        >
          <Search size={16} style={{ display: "inline", marginLeft: 4 }} /> {searching ? "..." : "پیگیری"}
        </button>
      </div>

      {searched && !hasAnything && (
        <div className="card fade-in mt-4" style={{ padding: 20, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>نوبتی با این شماره پیدا نشد</p>
        </div>
      )}

      {searched && hasAnything && (
        <div className="fade-in mt-4">
          {/* Hero welcome card — one clear, well-organized summary instead of
              scattered stats */}
          <div className="card card-glass mb-3" style={{ padding: 18, background: "var(--grad-tab-dash)" }}>
            <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
            <p className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 700, opacity: 0.9, position: "relative" }}>
              <LayoutDashboard size={15} />
              {loyalty?.name ? `سلام ${loyalty.name} عزیز 👋` : "داشبورد شما"}
            </p>
            {loyalty?.found ? (
              <>
                <div className="flex items-end gap-2 mt-3" style={{ position: "relative" }}>
                  <div className="tabular" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{toFa(loyalty.points)}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 5 }}>امتیاز باشگاه</div>
                </div>
                <div className="flex items-center gap-2 mt-2" style={{ position: "relative", flexWrap: "wrap" }}>
                  {loyalty.discount_percent > 0 && (
                    <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                      <Percent size={11} /> {toFa(loyalty.discount_percent)}٪ تخفیف فعال
                    </span>
                  )}
                  <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                    <CalendarCheck size={11} /> {toFa(matches.length)} نوبت
                  </span>
                  <span className="badge" style={{ background: "oklch(100% 0 0 / 0.22)", color: "white" }}>
                    <UserPlus size={11} /> {toFa(loyalty.referrals?.length || 0)} معرفی
                  </span>
                </div>
                {loyalty.at_cap && (
                  <div className="flex items-center gap-1.5" style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "oklch(100% 0 0 / 0.18)", position: "relative" }}>
                    <Crown size={13} />
                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                      به سقف تخفیف ({toFa(loyalty.max_discount)}٪) رسیدید! دفعهٔ بعد از آرایشگر بخواید اعمالش کنه.
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between mt-3" style={{ position: "relative", paddingTop: 10, borderTop: "1px dashed oklch(100% 0 0 / 0.3)" }}>
                  <span style={{ fontSize: 11, opacity: 0.85 }}>کد معرفی شما</span>
                  <button
                    className="tap flex items-center gap-1"
                    style={{ fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}
                    onClick={() => { navigator.clipboard?.writeText(loyalty.referral_code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  >
                    <span dir="ltr">{loyalty.referral_code}</span>
                    <Copy size={12} />
                    {copied && <span style={{ fontSize: 9.5, opacity: 0.85 }}>· کپی شد</span>}
                  </button>
                </div>
              </>
            ) : (
              <p style={{ fontSize: 12, marginTop: 8, opacity: 0.9, position: "relative" }}>
                {loyaltyLoading ? "در حال بارگذاری..." : `${toFa(matches.length)} نوبت برای این شماره ثبت شده`}
              </p>
            )}
          </div>

          {/* Segment switcher */}
          <div className="flex gap-2 mb-3">
            {DASH_SEGMENTS.map((seg) => {
              const active = segment === seg.id;
              const count = seg.id === "bookings" ? matches.length : seg.id === "points" ? (loyalty?.history?.length || 0) : (loyalty?.referrals?.length || 0);
              return (
                <button
                  key={seg.id}
                  onClick={() => setSegment(seg.id)}
                  className="tap flex-1 flex flex-col items-center gap-1"
                  style={{
                    padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: active ? 800 : 700,
                    background: active ? seg.color : `color-mix(in oklch, ${seg.color} 10%, var(--color-surface))`,
                    color: active ? "white" : seg.color,
                    border: active ? "none" : `1px solid color-mix(in oklch, ${seg.color} 22%, transparent)`,
                    boxShadow: active ? `0 4px 12px -4px color-mix(in oklch, ${seg.color} 55%, transparent)` : "none",
                  }}
                >
                  <seg.Icon size={16} />
                  <span className="flex items-center gap-1">
                    {seg.label}
                    {count > 0 && <span className="tabular" style={{ opacity: 0.85 }}>({toFa(count)})</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Segment: bookings */}
          {segment === "bookings" && (
            <div className="flex flex-col gap-3">
              {matches.length === 0 ? (
                <div className="card" style={{ padding: 20, textAlign: "center" }}>
                  <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبتی ثبت نشده</p>
                </div>
              ) : matches.map((b) => {
                const service = services.find((s) => s.id === b.service_id);
                if (!service) return null;
                const hasDiscount = b.final_price != null && b.original_price > b.final_price;
                const isProposed = b.status === "reschedule_proposed";
                const changeable = ["pending", "confirmed", "rescheduled"].includes(b.status);
                return (
                  <div key={b.id} className="card fade-in" style={{ padding: 16 }}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 style={{ fontSize: 15 }}>{service.name}</h3>
                      <Badge status={b.status} />
                    </div>
                    <Row label="تاریخ" value={jalaliLabel(parseDateKey(b.date), { short: true })} />
                    <Row label="ساعت" value={formatClock(b.start_min)} />
                    {b.staff_name && <Row label="آرایشگر" value={b.staff_name} />}
                    <div style={{ borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
                    {b.final_price == null ? (
                      <Row label="مبلغ" value="قیمت در سالن اعلام می‌شود" bold />
                    ) : (
                      <>
                        {hasDiscount && <Row label="قیمت اصلی" value={formatToman(b.original_price)} strike />}
                        {hasDiscount && <Row label="تخفیف" value={"- " + formatToman(b.original_price - b.final_price)} />}
                        <Row label="مبلغ نهایی" value={formatToman(b.final_price)} bold />
                      </>
                    )}

                    {isProposed ? (
                      <div className="fade-in" style={{ marginTop: 14, padding: 12, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-warning) 12%, transparent)" }}>
                        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-warning)" }}>
                          <Clock size={14} /> آرایشگر پیشنهاد زمان جدید داده
                        </p>
                        <div className="flex items-center gap-2 mt-2" style={{ fontSize: 13 }}>
                          <span className="muted tabular" style={{ textDecoration: "line-through" }}>
                            {jalaliLabel(parseDateKey(b.date), { short: true })} - {formatClock(b.start_min)}
                          </span>
                          <ChevronLeft size={13} color="var(--color-muted)" />
                          <span className="tabular" style={{ fontWeight: 800, color: "var(--color-heading)" }}>
                            {jalaliLabel(parseDateKey(b.pending_date), { short: true })} - {formatClock(b.pending_start_min)}
                          </span>
                        </div>
                        <div className="flex gap-2 mt-3">
                          <button
                            className="tap accent-btn flex-1"
                            style={{ padding: 10, fontSize: 12.5 }}
                            onClick={() => updateMyBooking(
                              b.id,
                              { date: b.pending_date, start_min: b.pending_start_min, end_min: b.pending_end_min, status: "rescheduled", pending_date: null, pending_start_min: null, pending_end_min: null },
                              "زمان جدید تایید شد"
                            )}
                          >
                            تایید تغییر
                          </button>
                          <button
                            className="tap ghost-btn flex-1"
                            style={{ padding: 10, fontSize: 12.5 }}
                            onClick={() => setActionFor({ id: b.id, type: "reschedule" })}
                          >
                            انتخاب زمان دیگر
                          </button>
                        </div>
                        <button
                          className="tap w-full mt-2"
                          style={{ padding: 9, fontSize: 12, fontWeight: 700, borderRadius: "var(--radius-md)", border: "1px solid var(--color-danger)", background: "transparent", color: "var(--color-danger)" }}
                          onClick={() => setActionFor({ id: b.id, type: "cancel" })}
                        >
                          لغو نوبت
                        </button>
                      </div>
                    ) : changeable ? (
                      <div className="flex gap-2 mt-4">
                        <button className="tap ghost-btn flex-1" style={{ padding: 11, fontSize: 13, fontWeight: 700 }} onClick={() => setActionFor({ id: b.id, type: "reschedule" })}>
                          تغییر زمان
                        </button>
                        <button
                          className="tap flex-1"
                          style={{ padding: 11, fontSize: 13, fontWeight: 700, borderRadius: "var(--radius-md)", border: "1px solid var(--color-danger)", background: "transparent", color: "var(--color-danger)" }}
                          onClick={() => setActionFor({ id: b.id, type: "cancel" })}
                        >
                          لغو نوبت
                        </button>
                      </div>
                    ) : (
                      <p className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: "center" }}>
                        این نوبت دیگر قابل تغییر یا لغو نیست
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Segment: points history */}
          {segment === "points" && (
            <div className="card fade-in" style={{ padding: 16 }}>
              {!loyalty?.history?.length ? (
                <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "10px 0" }}>هنوز تراکنشی ثبت نشده</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {loyalty.history.map((h, i) => {
                    const positive = h.delta >= 0;
                    return (
                      <div key={i} className="flex items-center gap-3" style={{ padding: "9px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                        <div
                          style={{
                            width: 32, height: 32, borderRadius: "var(--radius-md)", flexShrink: 0,
                            background: `color-mix(in oklch, ${positive ? "var(--color-success)" : "var(--color-danger)"} 16%, transparent)`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {positive ? <TrendingUp size={15} color="var(--color-success)" /> : <TrendingDown size={15} color="var(--color-danger)" />}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{LOYALTY_REASON_FA[h.reason] || h.reason || "—"}</div>
                          <div className="muted tabular" style={{ fontSize: 10.5 }}>{jalaliLabel(new Date(h.at), { short: true })}</div>
                        </div>
                        <span className="tabular" style={{ fontSize: 13.5, fontWeight: 800, color: positive ? "var(--color-success)" : "var(--color-danger)" }}>
                          {positive ? "+" : ""}{toFa(h.delta)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Segment: referral network — full name front and center for every member */}
          {segment === "referrals" && (
            <div className="card fade-in" style={{ padding: 16 }}>
              {!loyalty?.referrals?.length ? (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <p className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>هنوز کسی را معرفی نکرده‌اید</p>
                  <p className="muted" style={{ fontSize: 11, lineHeight: 1.8 }}>کد معرفی بالای صفحه را با دوستانتان در میان بگذارید</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {loyalty.referrals.map((r, i) => {
                    const fullName = r.name?.trim() || "بدون نام ثبت‌شده";
                    const initial = r.name?.trim()?.[0] || "?";
                    const avColor = avatarColorFor(r.phone || i);
                    return (
                      <div key={r.phone || i} className="flex items-center gap-3" style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                        <div
                          className="tabular"
                          style={{
                            width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
                            background: `color-mix(in oklch, ${avColor} 20%, transparent)`, color: avColor,
                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800,
                          }}
                        >
                          {initial}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>{fullName}</div>
                          <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 1 }}>
                            {toFa(r.total_visits || 0)} ویزیت
                            {r.joined_at && ` · عضو از ${jalaliLabel(new Date(r.joined_at), { short: true })}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {actionFor?.type === "cancel" && actionBooking && (
        <CancelModal
          booking={actionBooking}
          variant="customer"
          onClose={() => setActionFor(null)}
          onConfirm={() => { updateMyBooking(actionBooking.id, { status: "cancelled" }, "نوبت شما لغو شد"); setActionFor(null); }}
        />
      )}
      {actionFor?.type === "reschedule" && actionBooking && (
        <RescheduleModal
          booking={actionBooking}
          services={services}
          bookings={bookings}
          workingHours={workingHours}
          staffWorkingHours={staffWorkingHours}
          timeOff={timeOff}
          approvedDates={approvedDates}
          variant="customer"
          onClose={() => setActionFor(null)}
          onConfirm={(newStart, newDate) => {
            const svc = services.find((s) => s.id === actionBooking.service_id);
            updateMyBooking(
              actionBooking.id,
              { start_min: newStart, end_min: newStart + svc.duration_minutes, date: newDate, status: "rescheduled", pending_date: null, pending_start_min: null, pending_end_min: null },
              "نوبت شما جابه‌جا شد"
            );
            setActionFor(null);
          }}
        />
      )}
    </div>
  );
}


/* ============================================================
   Panel view (staff) — dashboard / services / schedule
   ============================================================ */
function PanelView({ bookings, services, setServices, stylists, addStylist, updateStylist, removeStylist, currentStylistId, currentRole, smsTemplates, workingHours, setWorkingHours, staffWorkingHours, setStaffWorkingHours, timeOff, setTimeOff, approvedDates, setApprovedDates, updateBooking, expenses, addExpense, removeExpense, waitlist, removeWaitlistEntry, notify, onLogout }) {
  const [subTab, setSubTab] = useState("dashboard");
  const [pendingSmsSegment, setPendingSmsSegment] = useState(null);
  const currentStylist = stylists.find((s) => s.id === currentStylistId) || null;

  // Everyone gets the same tabs — each one shows only what belongs to the logged-in
  // person (their own bookings/revenue/hours). Only staff management is owner-only,
  // since letting a stylist add/remove colleagues doesn't make sense.
  const subTabs = [
    { id: "dashboard", label: currentStylist ? "نوبت‌های من" : "نوبت‌های امروز", Icon: LayoutList, color: "var(--color-tab-book)" },
    ...(currentStylist ? [] : [{ id: "accounting", label: "حسابداری", Icon: Wallet, color: "var(--color-warning)" }]),
    ...(currentStylist ? [] : [{ id: "services", label: "خدمات", Icon: Settings, color: "var(--color-tab-services)" }]),
    ...(currentStylist ? [] : [{ id: "staff", label: "آرایشگرها", Icon: Users, color: "var(--color-info)" }]),
    { id: "schedule", label: currentStylist ? "ساعات کاری من" : "ساعات کاری", Icon: CalendarIcon, color: "var(--color-tab-dash)" },
    // NEW — پنل ارسال پیامک: owner/manager only, same rule as staff management.
    ...(currentStylist ? [] : [{ id: "sms", label: "پیامک", Icon: MessageSquareText, color: "var(--color-tab-panel)" }]),
    // باشگاه مشتریان: owner/manager AND stylist (discount settings should be
    // adjustable by either, per explicit request — stylists interact with
    // customers directly about redeeming rewards). Segment/category views
    // within this tab are separately gated to manager-only (they expose the
    // full customer bank, not just the stylist's own customers).
    { id: "loyalty", label: "باشگاه مشتریان", Icon: Gift, color: "var(--color-success)" },
    // v2.15: AIAnalysisTab includes a salon-wide revenue forecast —
    // owner/manager only, same rule as accounting/BI.
    ...(currentStylist ? [] : [{ id: "ai", label: "تحلیل هوشمند", Icon: Brain, color: "var(--color-tab-dash)" }]),
    ...(currentStylist ? [] : [{ id: "bi", label: "هوش تجاری", Icon: BarChart3, color: "var(--color-tab-panel)" }]),
  ];

  return (
    <div className="fade-in">
      <div
        className="flex items-center justify-between mb-3"
        style={{ padding: "12px 14px", borderRadius: "var(--radius-lg)", background: "var(--grad-tab-panel)" }}
      >
        <p className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 800, color: "white" }}>
          <ShieldCheck size={16} />
          {currentStylist ? <>پنل شخصی {currentStylist.name}</> : "پنل مدیر سالن"}
        </p>
        <button
          className="tap flex items-center gap-1"
          style={{ fontSize: 11.5, fontWeight: 700, color: "white", background: "oklch(100% 0 0 / 0.18)", padding: "6px 11px", borderRadius: "var(--radius-full)" }}
          onClick={onLogout}
        >
          خروج
        </button>
      </div>

      {/* Sub-nav — a grid, not a scrolling strip, so every tab is visible at
          once with nothing hidden off-screen. Each tab keeps its own color
          identity (solid fill when active, soft tint when inactive). */}
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(3, 1fr)" }} role="tablist" aria-label="بخش‌های پنل">
        {subTabs.map((t) => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setSubTab(t.id)}
              className="tap flex flex-col items-center justify-center gap-1"
              style={{
                padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 10.5, fontWeight: active ? 800 : 700, textAlign: "center",
                background: active ? t.color : `color-mix(in oklch, ${t.color} 11%, var(--color-surface))`,
                color: active ? "white" : t.color,
                border: active ? "none" : `1px solid color-mix(in oklch, ${t.color} 22%, transparent)`,
                boxShadow: active ? `0 3px 10px -3px color-mix(in oklch, ${t.color} 55%, transparent)` : "none",
                lineHeight: 1.3,
              }}
            >
              <t.Icon size={17} />
              {t.label}
            </button>
          );
        })}
      </div>

      {subTab === "dashboard" && (
        <DashboardTab bookings={bookings} services={services} stylists={stylists} defaultStaffId={currentStylistId} workingHours={workingHours} timeOff={timeOff} updateBooking={updateBooking} waitlist={waitlist} removeWaitlistEntry={removeWaitlistEntry} />
      )}
      {subTab === "accounting" && !currentStylist && (
        <AccountingTab
          bookings={bookings}
          services={services}
          stylists={stylists}
          expenses={expenses}
          addExpense={addExpense}
          removeExpense={removeExpense}
          notify={notify}
          staffId={currentStylistId}
          canEditExpenses={!currentStylist}
        />
      )}
      {subTab === "services" && !currentStylist && <ServicesTab services={services} setServices={setServices} notify={notify} />}
      {subTab === "staff" && !currentStylist && (
        <StaffTab stylists={stylists} addStylist={addStylist} updateStylist={updateStylist} removeStylist={removeStylist} notify={notify} />
      )}
      {subTab === "schedule" && (
        <ScheduleTab
          workingHours={workingHours}
          setWorkingHours={setWorkingHours}
          staffWorkingHours={staffWorkingHours}
          setStaffWorkingHours={setStaffWorkingHours}
          currentStylistId={currentStylistId}
          currentStylist={currentStylist}
          updateStylist={updateStylist}
          timeOff={timeOff}
          setTimeOff={setTimeOff}
          approvedDates={approvedDates}
          setApprovedDates={setApprovedDates}
          notify={notify}
        />
      )}
      {subTab === "sms" && !currentStylist && (
        <SmsTab
          bookings={bookings}
          services={services}
          stylists={stylists}
          smsTemplates={smsTemplates}
          notify={notify}
          presetSegment={pendingSmsSegment}
          onConsumePresetSegment={() => setPendingSmsSegment(null)}
        />
      )}
      {subTab === "loyalty" && (
        <LoyaltyTab
          notify={notify}
          currentStylist={currentStylist}
          onNavigateToSmsSegment={(segment) => { setPendingSmsSegment(segment); setSubTab("sms"); }}
        />
      )}
      {subTab === "ai" && !currentStylist && <AIAnalysisTab bookings={bookings} />}
      {subTab === "bi" && !currentStylist && (
        <BITab
          bookings={bookings}
          services={services}
          stylists={stylists}
          workingHours={workingHours}
          staffWorkingHours={staffWorkingHours}
          timeOff={timeOff}
          approvedDates={approvedDates}
        />
      )}
    </div>
  );
}

/* ============================================================
   Staff tab — each stylist belongs to one section (female/male),
   same as services. Customers pick from this list during booking.
   ============================================================ */
function StaffTab({ stylists, addStylist, updateStylist, removeStylist, notify }) {
  const [editing, setEditing] = useState(null); // stylist object or 'new'
  const [genderFilter, setGenderFilter] = useState("all");

  function saveStylist(data) {
    if (data.id) {
      updateStylist(data.id, data);
      notify("مشخصات آرایشگر ویرایش شد");
    } else {
      addStylist(makeSeedStylist(data));
    }
    setEditing(null);
  }

  const filtered = genderFilter === "all" ? stylists : stylists.filter((s) => s.gender === genderFilter);

  return (
    <div>
      <PanelSectionHeader Icon={Users} title="آرایشگرها" subtitle="افزودن، ویرایش، و مدیریت وضعیت فعال بودن هر آرایشگر" color="var(--color-info)" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
            <button
              key={f.v}
              onClick={() => setGenderFilter(f.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
        <button className="tap accent-btn flex items-center gap-1" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => setEditing("new")}>
          <Plus size={15} /> افزودن آرایشگر
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((s) => (
          <div key={s.id} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, opacity: s.active ? 1 : 0.55 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: SECTION_META[s.gender].tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <User size={17} color={SECTION_META[s.gender].color} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-1.5">
                <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)" }}>{s.name}</span>
                <GenderBadge gender={s.gender} />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>{s.active ? "فعال" : "غیرفعال"}</div>
            </div>
            <Switch checked={s.active} onChange={() => updateStylist(s.id, { active: !s.active })} />
            <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => setEditing(s)}>
              <Pencil size={14} style={{ margin: "auto" }} />
            </button>
            <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0, color: "var(--color-danger)" }} onClick={() => removeStylist(s.id)}>
              <Trash2 size={14} style={{ margin: "auto" }} />
            </button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>آرایشگری در این بخش ثبت نشده</p>
          </div>
        )}
      </div>

      {editing && <StylistEditModal stylist={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveStylist} />}
    </div>
  );
}

function StylistEditModal({ stylist, onClose, onSave }) {
  const [name, setName] = useState(stylist?.name || "");
  const [gender, setGender] = useState(stylist?.gender || "female");
  const [phone, setPhone] = useState(stylist?.phone || "");
  const [password, setPassword] = useState(stylist?.password || "");

  const phoneValid = /^09\d{9}$/.test(phone);
  // A password is only meaningful in demo mode (compared locally for the demo
  // login simulation). In real/Supabase mode, a stylist's actual login is
  // created separately when THEY self-register from "ورود آرایشگر" using
  // this same phone number — this admin form only manages their business
  // record (name/phone/gender/active), never a credential.
  const needsPassword = !SUPABASE_ENABLED;
  const canSave = name.trim().length > 0 && phoneValid && (!needsPassword || password.trim().length >= 4);

  return (
    <Modal title={stylist ? "ویرایش آرایشگر" : "افزودن آرایشگر جدید"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>بخش</label>
          <div className="flex gap-2 mt-1">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              return (
                <button
                  key={g}
                  onClick={() => setGender(g)}
                  className="tap flex-1 flex items-center justify-center gap-1.5"
                  style={{
                    padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                    border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                    background: gender === g ? meta.tint : "var(--color-surface)",
                    color: gender === g ? meta.color : "var(--color-body)",
                  }}
                >
                  <Icon size={14} /> {meta.short}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>نام آرایشگر</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً مهسا کریمی" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>شماره موبایل (برای ورود به پنل)</label>
          <input
            dir="ltr" inputMode="numeric" value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            placeholder="09xxxxxxxxx" className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4, textAlign: "left" }}
          />
        </div>
        {needsPassword ? (
          <div>
            <label className="muted" style={{ fontSize: 12 }}>رمز عبور (حداقل ۴ رقم/کاراکتر)</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="رمز ورود به پنل" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
            رمز عبور اینجا تنظیم نمی‌شود — خودِ آرایشگر با همین شماره موبایل از «ورود آرایشگر ← ثبت‌نام» وارد می‌شود و رمز خودش را انتخاب می‌کند.
          </p>
        )}
        <button
          disabled={!canSave}
          className="tap accent-btn w-full"
          style={{ padding: 12, fontSize: 14, marginTop: 4 }}
          onClick={() => canSave && onSave({ id: stylist?.id, name: name.trim(), gender, phone, password: needsPassword ? password : undefined, active: stylist?.active ?? true })}
        >
          {stylist ? "ذخیره تغییرات" : "افزودن آرایشگر"}
        </button>
      </div>
    </Modal>
  );
}

function DashboardTab({ bookings, services, stylists, defaultStaffId, workingHours, timeOff, updateBooking, waitlist, removeWaitlistEntry }) {
  const [menuFor, setMenuFor] = useState(null);
  const [action, setAction] = useState(null);
  const [verifyAction, setVerifyAction] = useState(null); // { booking } — pending referral-verification prompt
  const [genderFilter, setGenderFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState(defaultStaffId || "all");
  const [view, setView] = useState("list"); // "list" | "timeline"
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const locked = !!defaultStaffId; // a stylist viewing their OWN panel — can't switch to see others

  const viewDateKey = dateKey(viewDate);
  const isToday = viewDateKey === dateKey(new Date());

  function shiftDay(delta) {
    setViewDate((d) => { const n = new Date(d); n.setDate(n.getDate() + delta); return n; });
  }

  // "انجام شد" — most bookings have no referrer involved and complete
  // immediately as before. Only when this customer was referred does staff
  // need to confirm (in ReferralVerifyModal) that they're genuinely new
  // before the referrer's reward can be awarded.
  async function handleComplete(b) {
    setMenuFor(null);
    const referredBy = await fetchCustomerReferredBy(b.customer_phone);
    if (referredBy) {
      setVerifyAction({ booking: b });
    } else {
      updateBooking(b.id, { status: "completed" }, "وضعیت به «انجام شده» تغییر کرد");
    }
  }

  const dayBookings = bookings
    .filter((b) => b.date === viewDateKey)
    .sort((a, b) => a.start_min - b.start_min);
  const todays = dayBookings.filter(
    (b) => (genderFilter === "all" || b.customer_gender === genderFilter) && (staffFilter === "all" || b.staff_id === staffFilter)
  );

  const dayWaitlist = (waitlist || []).filter(
    (w) => w.date === viewDateKey
      && (genderFilter === "all" || w.customer_gender === genderFilter)
      && (!locked || !w.staff_id || w.staff_id === defaultStaffId)
  );

  const billable = todays.filter((b) => b.status !== "cancelled");
  const summary = {
    total: todays.length,
    confirmed: todays.filter((b) => b.status === "confirmed").length,
    pending: todays.filter((b) => b.status === "pending").length,
    revenue: billable.filter((b) => b.final_price != null).reduce((s, b) => s + b.final_price, 0),
    unpriced: billable.filter((b) => b.final_price == null).length,
  };

  const dayWH = workingHours.find((w) => w.day_of_week === schemaDayOf(viewDate));
  const timelineRange = dayWH && !dayWH.is_closed
    ? { start: hhmmToMin(dayWH.start_time), end: hhmmToMin(dayWH.end_time) }
    : { start: 9 * 60, end: 21 * 60 };

  return (
    <div>
      <PanelSectionHeader
        Icon={LayoutList}
        title={defaultStaffId ? "نوبت‌های من" : "نوبت‌های امروز"}
        subtitle="مدیریت وضعیت نوبت‌ها بر اساس روز — تایید، تکمیل، یا لغو"
        color="var(--color-tab-book)"
      />
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => shiftDay(-1)} aria-label="روز قبل">
            <ChevronRight size={15} style={{ margin: "auto" }} />
          </button>
          <div style={{ minWidth: 92, textAlign: "center" }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{jalaliLabel(viewDate, { short: true })}</p>
          </div>
          <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => shiftDay(1)} aria-label="روز بعد">
            <ChevronLeft size={15} style={{ margin: "auto" }} />
          </button>
          {!isToday && (
            <button className="muted" style={{ fontSize: 11.5, marginRight: 4 }} onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setViewDate(d); }}>
              امروز
            </button>
          )}
        </div>
        {!locked && (
          <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
            {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
              <button
                key={f.v}
                onClick={() => setGenderFilter(f.v)}
                className="tap"
                style={{
                  padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                  background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                  color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
                }}
              >
                {f.l}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between mb-2" style={{ flexWrap: "wrap", gap: 8 }}>
        <p className="muted" style={{ fontSize: 11.5 }}>{jalaliLabel(viewDate)}</p>
        {!locked && stylists.length > 0 && (
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            style={{ padding: "5px 10px", fontSize: 11.5, fontWeight: 700, borderRadius: "var(--radius-md)" }}
          >
            <option value="all">همه آرایشگرها</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex gap-2 mb-4">
        <StatCard label="تعداد" value={toFa(summary.total)} icon={LayoutList} color="var(--color-accent-700)" />
        <StatCard label="تایید شده" value={toFa(summary.confirmed)} icon={CheckCircle2} color="var(--color-accent-500)" />
        <StatCard label="در انتظار" value={toFa(summary.pending)} icon={Clock} color="var(--color-info)" />
      </div>
      <div className="card mb-4" style={{ padding: 14 }}>
        <Row label={isToday ? "مجموع درآمد امروز" : "مجموع درآمد این روز"} value={formatToman(summary.revenue)} bold />
        {summary.unpriced > 0 && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            + {toFa(summary.unpriced)} نوبت بدون قیمت تعیین‌شده (در محاسبه لحاظ نشده)
          </p>
        )}
      </div>

      {dayWaitlist.length > 0 && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-info) 8%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)" }}>
            <Bell size={13} /> لیست انتظار این روز ({toFa(dayWaitlist.length)} نفر)
          </p>
          <div className="flex flex-col gap-2">
            {dayWaitlist.map((w) => {
              const svc = services.find((s) => s.id === w.service_id);
              return (
                <div key={w.id} className="flex items-center gap-2 surface-raised" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                      {w.customer_name || "بدون نام"} <span dir="ltr" className="tabular muted" style={{ fontSize: 11 }}>{toFa(w.customer_phone)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 10.5, marginTop: 1 }}>
                      {svc?.name}{w.staff_name ? ` · ${w.staff_name}` : ""}
                    </div>
                  </div>
                  <a href={`tel:${w.customer_phone}`} className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }}>
                    <Phone size={13} style={{ margin: "auto" }} />
                  </a>
                  <button className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }} onClick={() => removeWaitlistEntry(w.id)}>
                    <X size={13} style={{ margin: "auto" }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <p className="muted" style={{ fontSize: 11.5 }}>نمای نوبت‌ها</p>
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "list", l: "لیست", Icon: LayoutList }, { v: "timeline", l: "جدول زمانی", Icon: CalendarClock }].map((o) => (
            <button
              key={o.v}
              onClick={() => setView(o.v)}
              className="tap flex items-center gap-1"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: view === o.v ? "var(--color-surface)" : "transparent",
                color: view === o.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              <o.Icon size={12} /> {o.l}
            </button>
          ))}
        </div>
      </div>

      {view === "timeline" && (
        <div className="fade-in mb-4">
          {todays.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: "center" }}>
              <p className="muted" style={{ fontSize: 13 }}>نوبتی برای این بخش {isToday ? "امروز" : "این روز"} ثبت نشده</p>
            </div>
          ) : (
            <DayTimeline
              startMin={timelineRange.start}
              endMin={timelineRange.end}
              blocks={todays.map((b) => ({
                start: b.start_min,
                end: occupiedEndFor(b),
                color: STATUS_META[b.status].bg,
                textColor: STATUS_META[b.status].fg,
                label: b.customer_name,
                title: `${b.customer_name} · ${formatClock(b.start_min)}`,
              }))}
            />
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <span key={key} className="flex items-center gap-1 muted" style={{ fontSize: 10.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: meta.bg, display: "inline-block" }} /> {meta.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {view === "list" && (
      <div className="flex flex-col gap-2">
        {todays.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>نوبتی برای این بخش {isToday ? "امروز" : "این روز"} ثبت نشده</p>
          </div>
        )}
        {todays.map((b, idx) => {
          const service = services.find((s) => s.id === b.service_id);
          const meta = STATUS_META[b.status];
          const prevB = todays[idx - 1];
          const nextB = todays[idx + 1];
          const gapBefore = prevB ? b.start_min - occupiedEndFor(prevB) : null;
          return (
            <React.Fragment key={b.id}>
              {prevB && gapBefore != null && gapBefore > 0 && (
                <div className="muted flex items-center justify-center gap-1" style={{ fontSize: 10.5, padding: "1px 0" }}>
                  <History size={10} /> {toFa(gapBefore)} دقیقه فاصله تا نوبت قبل
                </div>
              )}
              <div className="card" style={{ padding: 12, position: "relative" }}>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="tabular" style={{ textAlign: "center", minWidth: 44 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: "var(--color-heading)" }}>{formatClock(b.start_min)}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{toFa(service?.duration_minutes)} د</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)", textDecoration: meta.strike ? "line-through" : "none" }}>
                        {b.customer_name}
                      </span>
                      <GenderBadge gender={b.customer_gender} />
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 1, textDecoration: meta.strike ? "line-through" : "none" }}>
                      {service?.name}{b.staff_name ? ` · ${b.staff_name}` : ""}
                    </div>
                    <div className="mt-1.5"><Badge status={b.status} /></div>
                    {b.status === "reschedule_proposed" && (
                      <div className="flex items-center gap-1 tabular" style={{ fontSize: 10.5, marginTop: 3, color: "var(--color-warning)" }}>
                        <Clock size={11} /> پیشنهاد: {jalaliLabel(parseDateKey(b.pending_date), { short: true })} - {formatClock(b.pending_start_min)} — در انتظار پاسخ مشتری
                      </div>
                    )}
                    <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 4 }}>
                      {prevB ? <>قبلی: {formatClock(prevB.start_min)} · {prevB.customer_name}</> : "اولین نوبت این روز"}
                      {" — "}
                      {nextB ? <>بعدی: {formatClock(nextB.start_min)} · {nextB.customer_name}</> : "آخرین نوبت این روز"}
                    </div>
                  </div>
                </div>
                <button onClick={() => setMenuFor(menuFor === b.id ? null : b.id)} className="tap" style={{ width: 32, height: 32, borderRadius: "var(--radius-sm)" }}>
                  <MoreVertical size={16} style={{ margin: "auto" }} />
                </button>
              </div>

              {menuFor === b.id && (
                <div className="fade-in card" style={{ position: "absolute", left: 12, top: 44, zIndex: 20, minWidth: 170, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,.15)" }}>
                  {b.status === "pending" && (
                    <MenuItem positive label="تایید نوبت" onClick={() => { updateBooking(b.id, { status: "confirmed" }, "نوبت تایید شد؛ پیامک برای مشتری ارسال شد"); setMenuFor(null); }} />
                  )}
                  <MenuItem label="تغییر زمان" onClick={() => { setAction({ type: "reschedule", booking: b }); setMenuFor(null); }} />
                  <MenuItem label="انجام شد" onClick={() => handleComplete(b)} />
                  <MenuItem label="عدم حضور" onClick={() => { updateBooking(b.id, { status: "no_show" }, "وضعیت به «عدم حضور» تغییر کرد"); setMenuFor(null); }} />
                  <MenuItem danger label="لغو نوبت" onClick={() => { setAction({ type: "cancel", booking: b }); setMenuFor(null); }} />
                </div>
              )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      )}

      {action?.type === "cancel" && (
        <CancelModal
          booking={action.booking}
          onClose={() => setAction(null)}
          onConfirm={() => { updateBooking(action.booking.id, { status: "cancelled" }, "نوبت لغو شد؛ پیامک برای مشتری ارسال شد"); setAction(null); }}
        />
      )}
      {action?.type === "reschedule" && (
        <RescheduleModal
          booking={action.booking}
          services={services}
          bookings={bookings}
          workingHours={workingHours}
          timeOff={timeOff}
          onClose={() => setAction(null)}
          onConfirm={(newStart, newDate) => {
            const svc = services.find((s) => s.id === action.booking.service_id);
            updateBooking(
              action.booking.id,
              { pending_date: newDate, pending_start_min: newStart, pending_end_min: newStart + svc.duration_minutes, status: "reschedule_proposed" },
              "پیشنهاد زمان جدید ثبت شد؛ برای تایید نهایی منتظر پاسخ مشتری بمانید"
            );
            setAction(null);
          }}
        />
      )}
      {verifyAction && (
        <ReferralVerifyModal
          booking={verifyAction.booking}
          onClose={() => setVerifyAction(null)}
          onConfirm={(verified) => {
            updateBooking(
              verifyAction.booking.id,
              { status: "completed", referral_verified: verified },
              verified ? "وضعیت به «انجام شده» تغییر کرد؛ امتیاز معرف و مشتری ثبت شد" : "وضعیت به «انجام شده» تغییر کرد؛ بدون امتیاز معرفی"
            );
            setVerifyAction(null);
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone = "default", color, trend }) {
  const toneColor = tone === "success" ? "var(--color-success)" : tone === "danger" ? "var(--color-danger)" : "var(--color-heading)";
  const iconColor = color || (tone !== "default" ? toneColor : "var(--color-accent-700)");
  const iconGrad =
    tone === "success" ? "var(--grad-success)" :
    tone === "danger" ? "var(--grad-danger)" :
    color === "var(--color-info)" ? "var(--grad-info)" :
    color === "var(--color-warning)" ? "var(--grad-warning)" :
    "var(--grad-brand)";
  return (
    <div className="card" style={{ flex: 1, padding: "12px 12px 10px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, color-mix(in oklch, ${iconColor} 9%, transparent), transparent 65%)`, pointerEvents: "none" }} />
      <div className="flex items-center justify-between" style={{ position: "relative" }}>
        {Icon && (
          <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: iconGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 10px -2px color-mix(in oklch, ${iconColor} 55%, transparent)` }}>
            <Icon size={15} color="white" />
          </div>
        )}
        {trend && (
          <div className="tabular" style={{ fontSize: 10, fontWeight: 800, color: toneColor, whiteSpace: "nowrap", background: `color-mix(in oklch, ${toneColor} 14%, transparent)`, padding: "2px 7px", borderRadius: "var(--radius-full)" }}>
            {trend}
          </div>
        )}
      </div>
      <div className="tabular" style={{ fontSize: 19, fontWeight: 800, color: toneColor, marginTop: 8, position: "relative", letterSpacing: "-0.01em" }}>{value}</div>
      <div className="muted" style={{ fontSize: 11, marginTop: 1, position: "relative" }}>{label}</div>
    </div>
  );
}

function MenuItem({ label, onClick, danger, positive }) {
  return (
    <button onClick={onClick} className="tap w-full" style={{ padding: "9px 12px", textAlign: "right", fontSize: 13, borderRadius: "var(--radius-sm)", color: danger ? "var(--color-danger)" : positive ? "var(--color-success)" : "var(--color-body)" }}>
      {label}
    </button>
  );
}

// Shown when marking a booking "انجام شد" (completed) if the customer has a
// referrer on file. The referrer's reward is only awarded once staff
// explicitly confirms here that this is a genuinely new customer — closing
// the fraud path where a fake "new customer" booking could farm referral
// points with no real visit involved.
function ReferralVerifyModal({ booking, onClose, onConfirm }) {
  const [checked, setChecked] = useState(false);
  return (
    <Modal title="تایید مشتری معرفی‌شده" onClose={onClose}>
      <p style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 14 }}>
        <b>{booking.customer_name}</b> با یک کد معرفی ثبت‌نام کرده. امتیاز معرف و امتیاز خودِ {booking.customer_name} هر دو فقط با تایید شما ثبت می‌شوند.
      </p>
      <label className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 18, height: 18 }} />
        تایید می‌کنم این فرد مشتری کاملاً جدید است
      </label>
      <div className="flex gap-2 mt-4">
        <button className="tap ghost-btn flex-1" style={{ padding: 11 }} onClick={() => onConfirm(false)}>
          بدون تایید ثبت شود
        </button>
        <button disabled={!checked} className="tap accent-btn flex-1" style={{ padding: 11 }} onClick={() => onConfirm(true)}>
          تایید و ثبت
        </button>
      </div>
    </Modal>
  );
}

function CancelModal({ booking, onClose, onConfirm, variant = "staff" }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal title="لغو نوبت" onClose={onClose} danger>
      <p style={{ fontSize: 13.5, marginBottom: 14 }}>
        {variant === "customer" ? (
          <>
            نوبت شما در تاریخ <b className="tabular">{jalaliLabel(parseDateKey(booking.date), { short: true })}</b> ساعت{" "}
            <b className="tabular">{formatClock(booking.start_min)}</b> لغو می‌شود. برای رزرو نوبت جدید می‌توانید از تب «نوبت‌دهی» استفاده کنید.
          </>
        ) : (
          <>
            نوبت <b>{booking.customer_name}</b> ساعت <span className="tabular">{formatClock(booking.start_min)}</span> لغو می‌شود و پیامک اطلاع‌رسانی همراه با لینک رزرو مجدد برای مشتری ارسال خواهد شد.
          </>
        )}
      </p>
      <label className="flex items-center gap-2" style={{ fontSize: 13, marginBottom: 16 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 16, height: 16 }} />
        متوجه شدم و تایید می‌کنم
      </label>
      <div className="flex gap-2">
        <button className="tap ghost-btn flex-1" style={{ padding: 12, fontWeight: 700 }} onClick={onClose}>بازگشت</button>
        <button
          disabled={!confirmed}
          className="tap flex-1"
          style={{ padding: 12, fontWeight: 700, borderRadius: "var(--radius-md)", background: "var(--color-danger)", color: "white", opacity: confirmed ? 1 : 0.5 }}
          onClick={onConfirm}
        >
          بله، لغو کن
        </button>
      </div>
    </Modal>
  );
}

function RescheduleModal({ booking, services, bookings, workingHours, staffWorkingHours, timeOff, approvedDates, onClose, onConfirm, variant = "staff" }) {
  const service = services.find((s) => s.id === booking.service_id);
  const [date, setDate] = useState(() => parseDateKey(booking.date));
  const [slot, setSlot] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // Same stylist-aware resolution as the booking flow: a stylist's personal override wins,
  // otherwise fall back to the salon default; time off is combined salon-wide + personal.
  const effectiveWorkingHours = (booking.staff_id && staffWorkingHours && staffWorkingHours[booking.staff_id]) || workingHours;
  const effectiveTimeOff = (timeOff || []).filter((t) => !t.staff_id || t.staff_id === booking.staff_id);

  const days = useMemo(() => {
    const arr = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, []);

  function whFor(d) {
    if (effectiveWorkingHours) return effectiveWorkingHours.find((w) => w.day_of_week === schemaDayOf(d));
    return { start_time: "09:00", end_time: "21:00", is_closed: d.getDay() === 5 };
  }
  // Only a whole-day record (no start/end time) closes the day entirely —
  // a partial-hour closure leaves the rest of the day bookable as normal.
  function isTimeOff(d) {
    return effectiveTimeOff.some((t) => t.date === dateKey(d) && t.start_min == null);
  }
  // Staff can move a booking into any open working day at their own discretion; a customer
  // rescheduling their own appointment is still bound by whatever the salon has released.
  function isApproved(d) {
    if (!approvedDates) return true;
    return approvedDates.includes(dateKey(d));
  }
  function unavailableReason(d) {
    const wh = whFor(d);
    if (!wh || wh.is_closed) return "closed";
    if (isTimeOff(d)) return "timeoff";
    if (variant === "customer" && !isApproved(d)) return "notApproved";
    return null;
  }

  const dayBookings = useMemo(() => {
    const dKey = dateKey(date);
    const sameDay = bookings.filter((b) => b.date === dKey && b.id !== booking.id && (b.status === "confirmed" || b.status === "pending" || b.status === "rescheduled" || b.status === "reschedule_proposed"));
    const scoped = booking.staff_id
      ? sameDay.filter((b) => b.staff_id === booking.staff_id)
      : sameDay.filter((b) => b.customer_gender === booking.customer_gender);
    // Partial-hour closures block time exactly like a booking would — reuse
    // the same overlap-checking mechanics by representing each one as a
    // phantom "booking" with no buffer.
    const partialClosures = effectiveTimeOff
      .filter((t) => t.date === dKey && t.start_min != null)
      .map((t) => ({ start_min: t.start_min, end_min: t.end_min, buffer_minutes: 0 }));
    return [...scoped, ...partialClosures];
  }, [date, bookings, booking.id, booking.staff_id, booking.customer_gender, effectiveTimeOff]);

  const wh = whFor(date);
  const whClosed = !!unavailableReason(date);

  const slotTicks = useMemo(() => {
    if (whClosed) return [];
    const start = hhmmToMin(wh.start_time);
    const end = hhmmToMin(wh.end_time);
    const dKey = dateKey(date);
    const isToday = dKey === dateKey(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

    const candidates = new Set();
    for (let t = start; t + service.duration_minutes <= end; t += 15) candidates.add(t);
    for (const b of dayBookings) {
      const freeAt = occupiedEndFor(b);
      if (freeAt >= start && freeAt + service.duration_minutes <= end) candidates.add(freeAt);
    }

    const out = [];
    for (const t of Array.from(candidates).sort((a, b) => a - b)) {
      if (isToday && t <= nowMin + 10) continue;
      const occupied = isOccupied(t, dayBookings);
      const fits = fitsWithoutOverlap(t, service.duration_minutes, dayBookings, service.buffer_minutes || 0);
      out.push({ t, occupied, fits });
    }
    return out;
  }, [whClosed, wh, date, dayBookings, service]);

  const slots = useMemo(() => slotTicks.filter((x) => x.fits).map((x) => x.t), [slotTicks]);

  if (confirming) {
    return (
      <Modal title="تایید جابه‌جایی" onClose={onClose}>
        <p style={{ fontSize: 13.5, marginBottom: 16 }}>
          {variant === "customer" ? (
            <>
              نوبت شما از ساعت <span className="tabular">{formatClock(booking.start_min)}</span> به{" "}
              <b className="tabular">{jalaliLabel(date, { short: true })} ساعت {formatClock(slot)}</b> منتقل شود؟
            </>
          ) : (
            <>
              پیشنهاد جابه‌جایی نوبت <b>{booking.customer_name}</b> از <span className="tabular">{formatClock(booking.start_min)}</span> به{" "}
              <b className="tabular">{jalaliLabel(date, { short: true })} ساعت {formatClock(slot)}</b> برای مشتری ارسال شود؟ نوبت واقعاً تغییر نمی‌کند تا وقتی مشتری تایید کند.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button className="tap ghost-btn flex-1" style={{ padding: 12, fontWeight: 700 }} onClick={() => setConfirming(false)}>بازگشت</button>
          <button className="tap accent-btn flex-1" style={{ padding: 12 }} onClick={() => onConfirm(slot, dateKey(date))}>
            {variant === "customer" ? "بله، ثبت شود" : "بله، پیشنهاد ارسال شود"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="تغییر زمان نوبت" onClose={onClose}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        {variant === "customer" ? service.name : <>{booking.customer_name} · {service.name}</>}
        {booking.staff_name ? ` · ${booking.staff_name}` : ""}
      </p>
      <DateStrip
        days={days}
        selectedDate={date}
        onSelect={(d) => { setDate(d); setSlot(null); }}
        isClosedFn={(d) => !!unavailableReason(d)}
        reasonFn={unavailableReason}
        compact
      />

      {!whClosed && dayBookings.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-danger)", display: "inline-block", marginLeft: 5, verticalAlign: -1 }} />
          زمان‌های خط‌خورده در این روز قبلاً رزرو شده‌اند
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 12, maxHeight: 220, overflowY: "auto" }}>
        {whClosed && (
          <p className="muted" style={{ fontSize: 12.5, gridColumn: "1/-1" }}>
            {unavailableReason(date) === "timeoff"
              ? "سالن در این روز تعطیل موقت است"
              : unavailableReason(date) === "notApproved"
              ? "این روز هنوز توسط سالن برای رزرو باز نشده است"
              : "سالن در این روز تعطیل است"}
          </p>
        )}
        {!whClosed && slotTicks.length === 0 && <p className="muted" style={{ fontSize: 12.5, gridColumn: "1/-1" }}>زمانی برای این روز باقی نمانده</p>}
        {slotTicks.map(({ t, occupied, fits }) => (
          <button
            key={t}
            disabled={!fits}
            title={occupied ? "این زمان رزرو شده است" : !fits ? "زمان کافی برای این خدمت باقی نمانده" : undefined}
            onClick={() => setSlot(t)}
            className="tap tabular"
            style={{
              padding: "8px 2px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
              border: `1px solid ${occupied ? "var(--color-danger)" : !fits ? "var(--color-border)" : slot === t ? "var(--color-accent-500)" : "var(--color-border)"}`,
              background: occupied
                ? "color-mix(in oklch, var(--color-danger) 12%, var(--color-surface))"
                : !fits ? "var(--color-surface-raised)"
                : slot === t ? "var(--color-accent-500)" : "var(--color-surface)",
              color: occupied ? "var(--color-danger)" : !fits ? "var(--color-muted)" : slot === t ? "oklch(16% 0.02 70)" : "var(--color-body)",
              textDecoration: occupied ? "line-through" : "none",
              opacity: !fits ? (occupied ? 0.8 : 0.55) : 1,
              cursor: !fits ? "not-allowed" : "pointer",
            }}
          >
            {formatClock(t)}
          </button>
        ))}
      </div>

      <button disabled={slot == null} className="tap accent-btn w-full mt-4" style={{ padding: 12 }} onClick={() => setConfirming(true)}>
        ادامه
      </button>
    </Modal>
  );
}

/* ============================================================
   Services management tab — discounts are configured HERE, per
   service, and apply to every booking of that service.
   ============================================================ */
function ServicesTab({ services, setServices, notify }) {
  const [editing, setEditing] = useState(null); // service object or 'new'
  const [genderFilter, setGenderFilter] = useState("all");

  function toggleActive(id) {
    setServices((prev) => prev.map((s) => (s.id === id ? { ...s, is_active: !s.is_active } : s)));
  }
  function removeService(id) {
    setServices((prev) => prev.filter((s) => s.id !== id));
    notify("خدمت حذف شد");
  }
  function saveService(data) {
    if (data.id) {
      setServices((prev) => prev.map((s) => (s.id === data.id ? { ...s, ...data } : s)));
      notify("خدمت ویرایش شد");
    } else {
      setServices((prev) => [...prev, { ...data, id: uid() }]);
      notify("خدمت جدید اضافه شد");
    }
    setEditing(null);
  }

  const filtered = genderFilter === "all" ? services : services.filter((s) => s.gender === genderFilter);

  return (
    <div>
      <PanelSectionHeader Icon={Settings} title="خدمات" subtitle="افزودن، قیمت‌گذاری، و مدیریت خدمات هر بخش" color="var(--color-tab-services)" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
            <button
              key={f.v}
              onClick={() => setGenderFilter(f.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
        <button className="tap accent-btn flex items-center gap-1" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => setEditing("new")}>
          <Plus size={15} /> افزودن خدمت
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((s) => {
          const Icon = SERVICE_ICONS[s.category] || Sparkles;
          const dAmt = discountAmountFor(s);
          const fPrice = finalPriceFor(s);
          return (
            <div key={s.id} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, opacity: s.is_active ? 1 : 0.55 }}>
              <div style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: SECTION_META[s.gender].tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={16} color={SECTION_META[s.gender].color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)" }}>{s.name}</span>
                  <GenderBadge gender={s.gender} />
                </div>
                <div className="muted tabular" style={{ fontSize: 11.5, marginTop: 1 }}>
                  {CATEGORY_LABEL[s.category]} · {toFa(s.duration_minutes)} د
                  {s.buffer_minutes > 0 && <> (+{toFa(s.buffer_minutes)} د تایم اصلاح)</>}
                  {" · "}
                  {!hasPrice(s) ? (
                    priceLabel(s)
                  ) : dAmt > 0 ? (
                    <>
                      <span style={{ textDecoration: "line-through" }}>{formatToman(s.price)}</span>{" "}
                      <span style={{ color: "var(--color-danger)", fontWeight: 700 }}>{formatToman(fPrice)}</span>
                    </>
                  ) : (
                    formatToman(s.price)
                  )}
                </div>
              </div>
              <Switch checked={s.is_active} onChange={() => toggleActive(s.id)} />
              <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => setEditing(s)}>
                <Pencil size={14} style={{ margin: "auto" }} />
              </button>
              <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0, color: "var(--color-danger)" }} onClick={() => removeService(s.id)}>
                <Trash2 size={14} style={{ margin: "auto" }} />
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>خدمتی در این بخش ثبت نشده</p>
          </div>
        )}
      </div>

      {editing && <ServiceEditModal service={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveService} />}
    </div>
  );
}

function ServiceEditModal({ service, onClose, onSave }) {
  const [name, setName] = useState(service?.name || "");
  const [gender, setGender] = useState(service?.gender || "female");
  const [category, setCategory] = useState(service?.category || "hair");
  const [duration, setDuration] = useState(service?.duration_minutes || 30);
  // Buffer ("touch-up"/cleanup time) is optional and stylist-defined per service — added after the
  // appointment before the next one can start; not shown to the customer as part of the duration.
  const [buffer, setBuffer] = useState(service?.buffer_minutes ? String(service.buffer_minutes) : "");
  // Price is optional — an empty field means "price announced in salon", not zero.
  const [price, setPrice] = useState(service?.price != null ? String(service.price) : "");
  const [discountType, setDiscountType] = useState(service?.discount_type || "none");
  const [discountValue, setDiscountValue] = useState(service?.discount_value || 0);
  const [discountReason, setDiscountReason] = useState(service?.discount_reason || "");

  const priceNum = price === "" ? null : Number(price);
  const priceSet = priceNum != null && priceNum > 0;
  const previewAmount = !priceSet || discountType === "none" || !discountValue ? 0
    : discountType === "percent" ? Math.round((priceNum * discountValue) / 100) : discountValue;
  const previewFinal = priceSet ? Math.max(0, priceNum - previewAmount) : 0;

  return (
    <Modal title={service ? "ویرایش خدمت" : "افزودن خدمت جدید"} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>بخش</label>
          <div className="flex gap-2 mt-1">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              return (
                <button
                  key={g}
                  onClick={() => setGender(g)}
                  className="tap flex-1 flex items-center justify-center gap-1.5"
                  style={{
                    padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                    border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                    background: gender === g ? meta.tint : "var(--color-surface)",
                    color: gender === g ? meta.color : "var(--color-body)",
                  }}
                >
                  <Icon size={14} /> {meta.short}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="muted" style={{ fontSize: 12 }}>نام خدمت</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>دسته‌بندی</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
            {Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>مدت (دقیقه)</label>
            <input type="number" min={5} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>تایم اصلاح (دقیقه) — اختیاری</label>
            <input
              type="number" min={0} step={5} value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              placeholder="بدون تایم اصلاح"
              className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>
          تایم اصلاح بعد از پایان نوبت به‌صورت خودکار خالی نگه داشته می‌شود (مثلاً برای تمیزکاری یا آماده‌سازی) و به مشتری نمایش داده نمی‌شود
        </p>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>قیمت (تومان) — اختیاری</label>
          <input
            type="number" min={0} step={1000} value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="تعیین نشده"
            className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
          />
        </div>
        {!priceSet && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>
            اگر قیمت خالی بماند، به مشتری «قیمت در سالن اعلام می‌شود» نمایش داده می‌شود
          </p>
        )}

        <div style={{ borderTop: "1px dashed var(--color-border)", paddingTop: 12, opacity: priceSet ? 1 : 0.5 }}>
          <label className="muted" style={{ fontSize: 12 }}>تخفیف این خدمت (اختیاری — برای همه مشتریان این خدمت اعمال می‌شود)</label>
          {!priceSet ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>برای تعریف تخفیف، ابتدا قیمت خدمت را وارد کنید</p>
          ) : (
            <>
              <div className="flex gap-2 mt-2">
                {[{ v: "none", l: "بدون تخفیف" }, { v: "percent", l: "درصدی", Icon: Percent }, { v: "fixed", l: "مبلغ ثابت", Icon: Banknote }].map((o) => (
                  <button
                    key={o.v}
                    onClick={() => { setDiscountType(o.v); if (o.v === "none") setDiscountValue(0); }}
                    className="tap flex-1 flex items-center justify-center gap-1"
                    style={{
                      padding: 9, borderRadius: "var(--radius-md)", fontSize: 12, fontWeight: 700,
                      border: `1px solid ${discountType === o.v ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: discountType === o.v ? "var(--color-accent-500)" : "var(--color-surface)",
                      color: discountType === o.v ? "oklch(16% 0.02 70)" : "var(--color-body)",
                    }}
                  >
                    {o.Icon && <o.Icon size={12} />} {o.l}
                  </button>
                ))}
              </div>

              {discountType !== "none" && (
                <div className="fade-in mt-3">
                  <label className="muted" style={{ fontSize: 12 }}>{discountType === "percent" ? "درصد تخفیف" : "مبلغ تخفیف (تومان)"}</label>
                  <input
                    type="number" min={0} max={discountType === "percent" ? 100 : priceNum}
                    value={discountValue} onChange={(e) => setDiscountValue(Math.max(0, Number(e.target.value)))}
                    className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
                  />
                  <label className="muted" style={{ fontSize: 12, marginTop: 10, display: "block" }}>دلیل (یادداشت داخلی — اختیاری)</label>
                  <textarea value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} rows={2} style={{ width: "100%", padding: "10px 14px", fontSize: 13, marginTop: 4, resize: "none" }} />

                  <div className="card mt-3" style={{ padding: 12 }}>
                    <Row label="قیمت اصلی" value={formatToman(priceNum)} strike={previewAmount > 0} />
                    <Row label="تخفیف" value={"- " + formatToman(previewAmount)} />
                    <div style={{ borderTop: "1px dashed var(--color-border)", margin: "8px 0" }} />
                    <Row label="قیمت نهایی مشتری" value={formatToman(previewFinal)} bold />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <button
          disabled={!name.trim()}
          className="tap accent-btn w-full mt-1"
          style={{ padding: 12 }}
          onClick={() => onSave({
            id: service?.id, name: name.trim(), gender, category, duration_minutes: duration,
            buffer_minutes: buffer === "" ? 0 : Math.max(0, Number(buffer)),
            price: priceSet ? priceNum : null,
            is_active: service?.is_active ?? true,
            discount_type: priceSet ? discountType : "none",
            discount_value: priceSet ? discountValue : 0,
            discount_reason: priceSet ? discountReason.trim() : "",
          })}
        >
          {service ? "ذخیره تغییرات" : "افزودن خدمت"}
        </button>
      </div>
    </Modal>
  );
}

/* ============================================================
   Schedule management tab (working hours + time-off)
   ============================================================ */
function ScheduleTab({ workingHours, setWorkingHours, staffWorkingHours, setStaffWorkingHours, currentStylistId, currentStylist, updateStylist, timeOff, setTimeOff, approvedDates, setApprovedDates, notify }) {
  const [newOffDate, setNewOffDate] = useState("");
  const [newOffReason, setNewOffReason] = useState("");
  const [newOffAllDay, setNewOffAllDay] = useState(true);
  const [newOffStart, setNewOffStart] = useState("13:00");
  const [newOffEnd, setNewOffEnd] = useState("14:00");

  const myHours = currentStylistId ? (staffWorkingHours[currentStylistId] || workingHours) : workingHours;
  const myTimeOff = currentStylistId ? timeOff.filter((t) => t.staff_id === currentStylistId) : timeOff.filter((t) => !t.staff_id);

  function updateDay(day, patch) {
    if (currentStylistId) {
      setStaffWorkingHours((prev) => {
        const base = prev[currentStylistId] || workingHours;
        return { ...prev, [currentStylistId]: base.map((w) => (w.day_of_week === day ? { ...w, ...patch } : w)) };
      });
    } else {
      setWorkingHours((prev) => prev.map((w) => (w.day_of_week === day ? { ...w, ...patch } : w)));
    }
  }
  const newOffRangeValid = newOffAllDay || hhmmToMin(newOffEnd) > hhmmToMin(newOffStart);
  function addTimeOff() {
    if (!newOffDate || !newOffRangeValid) return;
    setTimeOff((prev) => [...prev, {
      id: uid(), date: newOffDate, reason: newOffReason.trim(), staff_id: currentStylistId || null,
      start_min: newOffAllDay ? null : hhmmToMin(newOffStart),
      end_min: newOffAllDay ? null : hhmmToMin(newOffEnd),
    }]);
    setNewOffDate(""); setNewOffReason(""); setNewOffAllDay(true);
    notify(newOffAllDay ? "تعطیلی تمام‌روز اضافه شد" : "تعطیلی ساعتی اضافه شد");
  }
  function removeTimeOff(id) {
    setTimeOff((prev) => prev.filter((t) => t.id !== id));
  }

  function isDayLocked(d) {
    const wh = workingHours.find((w) => w.day_of_week === schemaDayOf(d));
    return !wh || wh.is_closed || timeOff.some((t) => t.date === dateKey(d) && !t.staff_id && t.start_min == null);
  }
  function toggleApproved(d) {
    if (isDayLocked(d)) return;
    const k = dateKey(d);
    setApprovedDates((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }
  function approveNext(count, label) {
    const keys = upcomingDates.slice(0, count).filter((d) => !isDayLocked(d)).map((d) => dateKey(d));
    setApprovedDates((prev) => Array.from(new Set([...prev, ...keys])));
    notify(`${label} برای رزرو باز شد`);
  }
  function revokeAllApproved() {
    setApprovedDates([]);
    notify("همهٔ تاییدها لغو شد");
  }

  const upcomingDates = useMemo(() => {
    const arr = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, []);

  return (
    <div>
      <PanelSectionHeader
        Icon={CalendarIcon}
        title={currentStylistId ? "ساعات کاری من" : "ساعات کاری"}
        subtitle="ساعات کاری سالن، مرخصی‌ها، و تایید روزهای باز برای رزرو"
        color="var(--color-tab-dash)"
      />
      {currentStylistId && currentStylist && (
        <div className="card mb-6" style={{ padding: 14 }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>
            <MessageSquareText size={14} /> یادآوری پیامکی خودکار
          </p>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4, marginBottom: 10, lineHeight: 1.7 }}>
            چند ساعت قبل از هر نوبت، پیامک یادآوری برای مشتری ارسال شود؟
          </p>
          <select
            value={currentStylist.reminder_hours_before ?? 3}
            onChange={(e) => updateStylist(currentStylistId, { reminder_hours_before: Number(e.target.value) })}
            style={{ width: "100%", padding: "9px 10px", fontSize: 13, fontWeight: 700 }}
          >
            <option value={1}>۱ ساعت قبل</option>
            <option value={2}>۲ ساعت قبل</option>
            <option value={3}>۳ ساعت قبل</option>
            <option value={6}>۶ ساعت قبل</option>
            <option value={12}>۱۲ ساعت قبل</option>
            <option value={24}>۲۴ ساعت قبل</option>
            <option value={48}>۴۸ ساعت قبل</option>
          </select>
        </div>
      )}

      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        {currentStylistId ? "ساعات کاری شخصی شما — در صورت عدم تغییر، از ساعات پیش‌فرض سالن پیروی می‌کند" : "ساعات کاری هفتگی (مشترک برای هر دو بخش)"}
      </p>
      <div className="flex flex-col gap-2 mb-6">
        {myHours.slice().sort((a, b) => a.day_of_week - b.day_of_week).map((w) => (
          <div key={w.day_of_week} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ width: 68, fontWeight: 700, fontSize: 13, color: "var(--color-heading)" }}>{SCHEMA_DAY_LABELS[w.day_of_week]}</div>
            <Switch checked={!w.is_closed} onChange={(v) => updateDay(w.day_of_week, { is_closed: !v })} />
            {!w.is_closed ? (
              <div className="flex items-center gap-1.5 tabular" style={{ marginRight: "auto" }} dir="ltr">
                <input type="time" value={w.start_time} onChange={(e) => updateDay(w.day_of_week, { start_time: e.target.value })} style={{ padding: "6px 8px", fontSize: 12.5 }} />
                <span className="muted" style={{ fontSize: 12 }}>تا</span>
                <input type="time" value={w.end_time} onChange={(e) => updateDay(w.day_of_week, { end_time: e.target.value })} style={{ padding: "6px 8px", fontSize: 12.5 }} />
              </div>
            ) : (
              <span className="muted" style={{ fontSize: 12.5, marginRight: "auto" }}>تعطیل</span>
            )}
          </div>
        ))}
      </div>

      {!currentStylistId && (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>روزهای باز برای رزرو</p>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.7 }}>
            مشتری فقط می‌تواند روزی را رزرو کند که شما برای آن روز تایید کرده باشید — تک‌روز، یک هفته، یا یک ماه.
          </p>
          <div className="flex gap-2 mb-3 flex-wrap">
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(1, "امروز")}>
              <Check size={13} /> تایید امروز
            </button>
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(7, "این هفته")}>
              <Check size={13} /> تایید این هفته
            </button>
            <button className="tap accent-btn flex items-center gap-1.5" style={{ padding: "8px 14px", fontSize: 12.5 }} onClick={() => approveNext(30, "این ماه")}>
              <Check size={13} /> تایید این ماه
            </button>
            <button
              className="tap ghost-btn flex items-center gap-1.5"
              style={{ padding: "8px 14px", fontSize: 12.5, color: "var(--color-danger)", borderColor: "var(--color-danger)" }}
              onClick={revokeAllApproved}
            >
              <X size={13} /> لغو همه تاییدها
            </button>
          </div>

          <div className="card mb-6" style={{ padding: 12 }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-accent-500)", display: "inline-block" }} /> تاییدشده
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, border: "1px solid var(--color-border)", display: "inline-block" }} /> هنوز تاییدنشده
              </span>
              <span className="flex items-center gap-1 muted" style={{ fontSize: 11 }}>
                <Lock size={9} /> تعطیل
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {upcomingDates.slice(0, 30).map((d) => {
                const k = dateKey(d);
                const locked = isDayLocked(d);
                const approved = approvedDates.includes(k);
                return (
                  <button
                    key={k}
                    disabled={locked}
                    onClick={() => toggleApproved(d)}
                    className="tap tabular"
                    title={locked ? "این روز تعطیل یا غیرفعال است" : approved ? "لغو تایید این روز" : "تایید این روز برای رزرو"}
                    style={{
                      padding: "6px 2px", borderRadius: "var(--radius-md)", textAlign: "center",
                      border: `1px solid ${approved ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: approved ? "var(--color-accent-500)" : "var(--color-surface)",
                      color: approved ? "white" : locked ? "var(--color-muted)" : "var(--color-heading)",
                      opacity: locked ? 0.4 : 1,
                    }}
                  >
                    <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.8 }}>{WEEKDAYS_FA_SHORT[d.getDay()]}</div>
                    <div className="tabular" style={{ fontSize: 12.5, fontWeight: 800, marginTop: 1 }}>{toFa(jalaliDayNum(d))}</div>
                    {locked && <Lock size={9} style={{ margin: "2px auto 0" }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        {currentStylistId ? "مرخصی‌های شخصی شما" : "تعطیلی‌های موقت سالن"}
      </p>
      <div className="card mb-3" style={{ padding: 12 }}>
        <div className="flex gap-2">
          <select value={newOffDate} onChange={(e) => setNewOffDate(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }}>
            <option value="">انتخاب تاریخ...</option>
            {upcomingDates.map((d) => (
              <option key={dateKey(d)} value={dateKey(d)}>{jalaliLabel(d, { short: false })}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-1 mt-2" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          <button
            onClick={() => setNewOffAllDay(true)}
            className="tap flex-1"
            style={{ padding: "7px 4px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700, background: newOffAllDay ? "var(--color-surface)" : "transparent", color: newOffAllDay ? "var(--color-heading)" : "var(--color-muted)", boxShadow: newOffAllDay ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
          >
            تمام روز
          </button>
          <button
            onClick={() => setNewOffAllDay(false)}
            className="tap flex-1"
            style={{ padding: "7px 4px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700, background: !newOffAllDay ? "var(--color-surface)" : "transparent", color: !newOffAllDay ? "var(--color-heading)" : "var(--color-muted)", boxShadow: !newOffAllDay ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
          >
            بازهٔ ساعتی (مثلاً استراحت ناهار)
          </button>
        </div>

        {!newOffAllDay && (
          <div className="flex items-center gap-1.5 tabular mt-2" dir="ltr">
            <input type="time" value={newOffStart} onChange={(e) => setNewOffStart(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} />
            <span className="muted" style={{ fontSize: 12 }}>تا</span>
            <input type="time" value={newOffEnd} onChange={(e) => setNewOffEnd(e.target.value)} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} />
          </div>
        )}
        {!newOffAllDay && !newOffRangeValid && (
          <p style={{ fontSize: 11, color: "var(--color-danger)", marginTop: 4 }}>ساعت پایان باید بعد از ساعت شروع باشد</p>
        )}

        <input
          value={newOffReason} onChange={(e) => setNewOffReason(e.target.value)} placeholder="دلیل (اختیاری)"
          style={{ width: "100%", padding: "9px 10px", fontSize: 12.5, marginTop: 8 }}
        />
        <button disabled={!newOffDate || !newOffRangeValid} className="tap accent-btn w-full mt-2 flex items-center justify-center gap-1.5" style={{ padding: 10, fontSize: 13 }} onClick={addTimeOff}>
          <CalendarX size={14} /> {newOffAllDay ? "ثبت تعطیلی تمام‌روز" : "ثبت تعطیلی ساعتی"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {myTimeOff.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>تعطیلی موقتی ثبت نشده</p>}
        {myTimeOff
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((t) => {
            const [y, m, d] = t.date.split("-").map(Number);
            const isPartial = t.start_min != null;
            return (
              <div key={t.id} className="card" style={{ padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
                {isPartial ? <Clock size={15} color="var(--color-warning)" style={{ flexShrink: 0 }} /> : <CalendarX size={15} color="var(--color-danger)" style={{ flexShrink: 0 }} />}
                <div style={{ flex: 1 }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{jalaliLabel(new Date(y, m - 1, d), { short: true })}</span>
                    {isPartial && (
                      <span className="tabular" dir="ltr" style={{ fontSize: 11, fontWeight: 700, color: "var(--color-warning)", background: "color-mix(in oklch, var(--color-warning) 14%, transparent)", padding: "2px 7px", borderRadius: "var(--radius-full)" }}>
                        {formatClock(t.start_min)} - {formatClock(t.end_min)}
                      </span>
                    )}
                  </div>
                  {t.reason && <div className="muted" style={{ fontSize: 11.5 }}>{t.reason}</div>}
                </div>
                <button className="tap ghost-btn" style={{ width: 30, height: 30, padding: 0 }} onClick={() => removeTimeOff(t.id)}>
                  <X size={13} style={{ margin: "auto" }} />
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* ============================================================
   Accounting tab — real numbers computed from booking + expense data
   (no external service; range toggle over today/7d/30d).
   Tracks revenue, expenses, net profit, growth vs. the previous
   period, cancellation loss, completion rate and new-vs-returning
   customer mix — everything sourced from bookings/expenses props.
   ============================================================ */
function AccountingTab({ bookings, services, stylists = [], expenses, addExpense, removeExpense, canEditExpenses = true, staffId = null }) {
  const [range, setRange] = useState("7"); // "1" | "7" | "30"
  const [showAddExpense, setShowAddExpense] = useState(false);

  const scopedBookings = staffId ? bookings.filter((b) => b.staff_id === staffId) : bookings;

  const { rangeBookings, days, prevRangeBookings } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const spanDays = Number(range);
    const dayList = [];
    for (let i = spanDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dayList.push(d);
    }
    const keys = new Set(dayList.map((d) => dateKey(d)));
    const prevDayList = [];
    for (let i = spanDays * 2 - 1; i >= spanDays; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      prevDayList.push(d);
    }
    const prevKeys = new Set(prevDayList.map((d) => dateKey(d)));
    return {
      rangeBookings: scopedBookings.filter((b) => keys.has(b.date)),
      days: dayList,
      prevRangeBookings: scopedBookings.filter((b) => prevKeys.has(b.date)),
    };
  }, [scopedBookings, range]);

  const completed = rangeBookings.filter((b) => b.status === "completed");
  const upcoming = rangeBookings.filter((b) => ["pending", "confirmed", "rescheduled"].includes(b.status));
  const cancelled = rangeBookings.filter((b) => b.status === "cancelled" || b.status === "no_show");
  const priced = (list) => list.filter((b) => b.final_price != null);

  const realizedRevenue = priced(completed).reduce((s, b) => s + b.final_price, 0);
  const expectedRevenue = priced(upcoming).reduce((s, b) => s + b.final_price, 0);
  const discountGiven = priced(completed).reduce((s, b) => s + Math.max(0, (b.original_price || 0) - b.final_price), 0);
  const avgTicket = priced(completed).length > 0 ? Math.round(realizedRevenue / priced(completed).length) : 0;
  const unpricedCount = rangeBookings.filter((b) => b.final_price == null).length;
  const lostRevenue = priced(cancelled).reduce((s, b) => s + b.final_price, 0);
  const completionRate = completed.length + cancelled.length > 0 ? completed.length / (completed.length + cancelled.length) : null;

  // Growth vs. the previous equally-sized window (e.g. this 7 days vs. the 7 days before that)
  const prevCompleted = prevRangeBookings.filter((b) => b.status === "completed");
  const prevRealizedRevenue = priced(prevCompleted).reduce((s, b) => s + b.final_price, 0);
  const growthPct = prevRealizedRevenue > 0 ? Math.round(((realizedRevenue - prevRealizedRevenue) / prevRealizedRevenue) * 100) : null;

  // Revenue broken down per stylist — owner-only (a logged-in stylist already
  // only ever sees their own numbers via the staffId scoping above).
  const byStylist = useMemo(() => {
    if (staffId) return [];
    const buckets = new Map(); // staff_id (or "unassigned") -> revenue
    for (const b of priced(completed)) {
      const key = b.staff_id || "unassigned";
      buckets.set(key, (buckets.get(key) || 0) + b.final_price);
    }
    const rows = Array.from(buckets.entries()).map(([staffKey, revenue]) => {
      const stylist = stylists.find((s) => s.id === staffKey);
      return { key: staffKey, name: stylist ? stylist.name : "بدون آرایشگر مشخص", gender: stylist?.gender, revenue };
    });
    return rows.sort((a, b) => b.revenue - a.revenue);
  }, [completed, staffId, stylists]);
  const byStylistMax = Math.max(1, ...byStylist.map((s) => s.revenue));

  const dailyRevenue = useMemo(() => {
    return days.map((d) => {
      const key = dateKey(d);
      const amt = priced(completed.filter((b) => b.date === key)).reduce((s, b) => s + b.final_price, 0);
      return { date: d, amount: amt };
    });
  }, [days, completed]);

  // For the "year" range, 365 daily bars would be unreadable — bucket the same
  // dailyRevenue data into Jalali months for the trend chart only. All the actual
  // revenue/expense/profit numbers above still cover the full 365-day range.
  const monthlyRevenue = useMemo(() => {
    if (range !== "365") return [];
    const map = new Map(); // "jy-jm" -> { jy, jm, amount }
    for (const d of dailyRevenue) {
      const { jy, jm } = gregorianToJalali(d.date.getFullYear(), d.date.getMonth() + 1, d.date.getDate());
      const key = `${jy}-${jm}`;
      const cur = map.get(key) || { jy, jm, amount: 0 };
      cur.amount += d.amount;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.jy - b.jy || a.jm - b.jm);
  }, [dailyRevenue, range]);

  const trendData = range === "365" ? monthlyRevenue : dailyRevenue;
  const trendMax = Math.max(1, ...trendData.map((d) => d.amount));

  // Expenses for the same range, categorized for the breakdown bar + list
  const rangeExpenses = useMemo(() => {
    if (!canEditExpenses) return [];
    const keys = new Set(days.map((d) => dateKey(d)));
    return expenses.filter((e) => keys.has(e.date));
  }, [expenses, days, canEditExpenses]);
  const totalExpenses = rangeExpenses.reduce((s, e) => s + e.amount, 0);
  const netProfit = realizedRevenue - totalExpenses;
  const profitMargin = realizedRevenue > 0 ? netProfit / realizedRevenue : null;

  const byExpenseCategory = useMemo(() => {
    const map = new Map();
    for (const e of rangeExpenses) map.set(e.category, (map.get(e.category) || 0) + e.amount);
    return Array.from(map.entries())
      .map(([category, amount]) => ({ category, amount, meta: EXPENSE_CATEGORY_META[category] || EXPENSE_CATEGORY_META.other }))
      .sort((a, b) => b.amount - a.amount);
  }, [rangeExpenses]);

  // Conic-gradient stops for the expense donut — a colorful ring instead of a flat bar
  const expenseDonutGradient = useMemo(() => {
    if (totalExpenses <= 0) return null;
    let acc = 0;
    const stops = byExpenseCategory.map((c) => {
      const start = (acc / totalExpenses) * 360;
      acc += c.amount;
      const end = (acc / totalExpenses) * 360;
      return `${c.meta.color} ${start}deg ${end}deg`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  }, [byExpenseCategory, totalExpenses]);

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-3" style={{ gap: 8 }}>
        <p className="muted" style={{ fontSize: 11.5, flexShrink: 0 }}>بازهٔ گزارش</p>
        <div
          className="flex gap-1 scrollbar-none"
          style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)", overflowX: "auto" }}
        >
          {[{ v: "1", l: "امروز" }, { v: "7", l: "۷ روز اخیر" }, { v: "30", l: "۳۰ روز اخیر" }, { v: "365", l: "یک سال اخیر" }].map((o) => (
            <button
              key={o.v}
              onClick={() => setRange(o.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: range === o.v ? "var(--color-surface)" : "transparent",
                color: range === o.v ? "var(--color-heading)" : "var(--color-muted)",
                whiteSpace: "nowrap", flexShrink: 0,
              }}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

      {/* Headline numbers, with a growth badge vs. the previous equally-sized period */}
      <div className="card card-glass mb-3" style={{ padding: 18, background: "var(--grad-brand)" }}>
        <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
        <div className="flex items-center justify-between" style={{ position: "relative" }}>
          <div className="flex items-center gap-2">
            <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: "oklch(100% 0 0 / 0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Wallet size={16} />
            </div>
            <span style={{ fontSize: 14.5, fontWeight: 800, opacity: 0.95 }}>درآمد تحقق‌یافته</span>
          </div>
          {growthPct != null && (
            <span
              className="tabular flex items-center gap-1"
              style={{ fontSize: 11, fontWeight: 800, padding: "4px 9px", borderRadius: "var(--radius-full)", background: "oklch(100% 0 0 / 0.22)", backdropFilter: "blur(4px)" }}
            >
              {growthPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {growthPct >= 0 ? "+" : ""}{toFa(growthPct)}٪
            </span>
          )}
        </div>
        <div className="tabular" style={{ fontSize: 30, fontWeight: 800, marginTop: 10, position: "relative", letterSpacing: "-0.02em" }}>
          {formatToman(realizedRevenue)}
        </div>
        <div className="flex items-center gap-3 mt-2" style={{ opacity: 0.88, fontSize: 11.5, position: "relative" }}>
          <span>{toFa(priced(completed).length)} نوبت تکمیل‌شده</span>
          {unpricedCount > 0 && <span>· {toFa(unpricedCount)} بدون قیمت</span>}
          {growthPct != null && <span>· نسبت به بازهٔ قبل</span>}
        </div>
      </div>

      {byStylist.length > 0 && (
        <div className="card mb-3" style={{ padding: 14 }}>
          <p className="flex items-center gap-2 mb-3" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)" }}>
            <Users size={16} color="var(--color-accent-700)" /> درآمد هر آرایشگر
          </p>
          <div className="flex flex-col gap-2.5">
            {byStylist.map((s) => (
              <div key={s.key}>
                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                    {s.name} {s.gender && <GenderBadge gender={s.gender} />}
                  </span>
                  <span className="tabular" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(s.revenue)}</span>
                </div>
                <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", overflow: "hidden" }}>
                  <div style={{ width: `${(s.revenue / byStylistMax) * 100}%`, height: "100%", borderRadius: "var(--radius-full)", background: s.gender ? SECTION_META[s.gender].color : "var(--color-muted)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        <StatCard label="میانگین هر نوبت" value={formatToman(avgTicket)} icon={Banknote} color="var(--color-accent-500)" />
        <StatCard label="درآمد در انتظار" value={formatToman(expectedRevenue)} icon={Hourglass} color="var(--color-info)" />
        <StatCard label="تخفیف اعطاشده" value={formatToman(discountGiven)} icon={Percent} color="var(--color-accent-700)" />
      </div>

      <div className="flex gap-2 mb-3">
        <StatCard
          label="سود خالص"
          value={formatToman(netProfit)}
          icon={PiggyBank}
          tone={netProfit >= 0 ? "success" : "danger"}
          trend={profitMargin != null ? `حاشیه ${toFa(Math.round(profitMargin * 100))}٪` : undefined}
        />
        <StatCard label="مجموع هزینه‌ها" value={formatToman(totalExpenses)} icon={Receipt} color="var(--color-warning)" />
        <StatCard label="درآمد ازدست‌رفته" value={formatToman(lostRevenue)} icon={XCircle} tone={lostRevenue > 0 ? "danger" : "default"} color={lostRevenue > 0 ? undefined : "var(--color-danger)"} />
      </div>

      {/* Completion-rate gauge */}
      <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-success) 7%, var(--color-surface)), var(--color-surface))" }}>
        <p className="flex items-center gap-2 mb-3" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-success)" }}>
          <CheckCircle2 size={16} /> نرخ تکمیل نوبت‌ها
        </p>
        <div className="flex items-center gap-3">
          <div
            style={{
              width: 56, height: 56, borderRadius: "50%", flexShrink: 0,
              background: completionRate == null
                ? "color-mix(in oklch, var(--color-success) 14%, var(--color-surface))"
                : `conic-gradient(var(--color-success) ${Math.round(completionRate * 360)}deg, color-mix(in oklch, var(--color-success) 14%, var(--color-surface)) 0deg)`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div style={{ width: 42, height: 42, borderRadius: "50%", background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="tabular" style={{ fontSize: 12, fontWeight: 800, color: "var(--color-success)" }}>
                {completionRate == null ? "—" : `${toFa(Math.round(completionRate * 100))}٪`}
              </span>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
            {completed.length + cancelled.length > 0
              ? `${toFa(completed.length)} تکمیل‌شده از ${toFa(completed.length + cancelled.length)} نوبت قطعی‌شده`
              : "هنوز نوبت قطعی‌شده‌ای در این بازه نیست"}
          </p>
        </div>
      </div>

      {/* Revenue trend — daily for short ranges, monthly for the year view */}
      {range !== "1" && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-accent-700)", marginBottom: 10 }}>
            <TrendingUp size={16} />
            {range === "365" ? "روند درآمد ماهانه" : "روند درآمد روزانه"}
          </p>
          <div className="flex items-end gap-1.5 scrollbar-none" style={{ overflowX: "auto", height: 110, paddingBottom: 2 }}>
            {trendData.map((d, i) => {
              const h = Math.max(4, Math.round((d.amount / trendMax) * 86));
              const isToday = range !== "365" && dateKey(d.date) === dateKey(new Date());
              return (
                <div key={i} className="flex flex-col items-center" style={{ flexShrink: 0, width: range === "30" ? 16 : range === "365" ? 40 : 34 }}>
                  <div
                    title={formatToman(d.amount)}
                    style={{
                      width: "100%", height: h, borderRadius: "var(--radius-full) var(--radius-full) 4px 4px",
                      background: isToday ? "var(--grad-brand)" : "linear-gradient(180deg, var(--color-accent-300), var(--color-accent-700))",
                      opacity: d.amount === 0 ? 0.22 : 1,
                      boxShadow: isToday && d.amount > 0 ? "var(--shadow-glow-accent)" : "none",
                    }}
                  />
                  {(range === "7" || range === "365") && (
                    <span className="muted tabular" style={{ fontSize: 9, marginTop: 4, whiteSpace: "nowrap" }}>
                      {range === "365" ? MONTHS_FA[d.jm - 1] : jalaliLabel(d.date, { short: true })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expenses — salon-wide overhead, owner-only */}
      {canEditExpenses && (
      <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-warning) 7%, var(--color-surface)), var(--color-surface))" }}>
        <div className="flex items-center justify-between mb-3">
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-warning)" }}>
            <ReceiptText size={16} /> هزینه‌های این بازه
          </p>
          <button className="tap accent-btn flex items-center gap-1" style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => setShowAddExpense(true)}>
            <Plus size={13} /> ثبت هزینه
          </button>
        </div>

        {byExpenseCategory.length > 0 && (
          <div className="flex items-center gap-4">
            <div
              style={{
                width: 74, height: 74, borderRadius: "50%", flexShrink: 0,
                background: expenseDonutGradient,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
                <span className="tabular" style={{ fontSize: 10.5, fontWeight: 800, color: "var(--color-heading)" }}>{formatToman(totalExpenses)}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5" style={{ flex: 1 }}>
              {byExpenseCategory.map((c) => (
                <span key={c.category} className="flex items-center gap-1.5" style={{ fontSize: 11 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c.meta.color, display: "inline-block" }} />
                  <span className="muted">{c.meta.label}:</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(c.amount)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {rangeExpenses.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "8px 0" }}>هنوز هزینه‌ای برای این بازه ثبت نشده</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...rangeExpenses].sort((a, b) => b.created_at - a.created_at).map((e) => {
              const meta = EXPENSE_CATEGORY_META[e.category] || EXPENSE_CATEGORY_META.other;
              const Icon = meta.Icon;
              return (
                <div key={e.id} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))` }}>
                  <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: `color-mix(in oklch, ${meta.color} 18%, transparent)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={14} color={meta.color} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                    <div className="muted" style={{ fontSize: 10.5 }}>{meta.label} · {jalaliLabel(parseDateKey(e.date), { short: true })}</div>
                  </div>
                  <span className="tabular" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)", flexShrink: 0 }}>{formatToman(e.amount)}</span>
                  <button className="tap ghost-btn" style={{ width: 26, height: 26, padding: 0, flexShrink: 0 }} onClick={() => removeExpense(e.id)}>
                    <X size={12} style={{ margin: "auto" }} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {cancelled.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, textAlign: "center" }}>
          <Coins size={11} style={{ display: "inline", marginLeft: 4, verticalAlign: -1 }} />
          {toFa(cancelled.length)} نوبت لغو‌شده/عدم‌حضور در این بازه
          {lostRevenue > 0 && <> · معادل {formatToman(lostRevenue)} خارج از محاسبهٔ درآمد</>}
        </p>
      )}

      {showAddExpense && (
        <AddExpenseModal
          onClose={() => setShowAddExpense(false)}
          onSave={(expense) => { addExpense(expense); setShowAddExpense(false); }}
        />
      )}
    </div>
  );
}

function AddExpenseModal({ onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("supplies");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dateKey(new Date()));

  const recentDates = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const arr = [];
    for (let i = 0; i < 45; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      arr.push(d);
    }
    return arr;
  }, []);

  const canSave = title.trim().length > 0 && Number(amount) > 0;

  return (
    <Modal title="ثبت هزینهٔ جدید" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>عنوان هزینه</label>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً خرید مواد رنگ مو"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
          />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>دسته‌بندی</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
            {Object.entries(EXPENSE_CATEGORY_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>مبلغ (تومان)</label>
            <input
              type="number" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
              className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>تاریخ</label>
            <select value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
              {recentDates.map((d) => (
                <option key={dateKey(d)} value={dateKey(d)}>{jalaliLabel(d, { short: true })}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          disabled={!canSave}
          className="tap accent-btn w-full"
          style={{ padding: 12, fontSize: 14, marginTop: 4 }}
          onClick={() => canSave && onSave(makeSeedExpense({ title: title.trim(), category, amount: Number(amount), date }))}
        >
          <Receipt size={14} style={{ display: "inline", verticalAlign: -2, marginLeft: 6 }} />
          ثبت هزینه
        </button>
      </div>
    </Modal>
  );
}

/* ============================================================
   AI Analysis tab — placeholder only. Not implemented yet;
   this UI reserves the spot and previews what will land here.
   ============================================================ */
// Revenue forecast — the one piece of BI_MATURITY_SKILL's 5-step method that's
// actually implemented (see the note rendered above it). Pure client-side
// least-squares trend over completed months already in `bookings`; no new
// data collection, no external model — matches the "high value / low
// difficulty" cell the assessment landed on.
function forecastNextMonthRevenue(bookings) {
  const priced = bookings.filter((b) => b.status === "completed" && b.final_price != null);
  if (priced.length === 0) return { ready: false, reason: "no-data" };

  const byMonth = new Map(); // key: jy*12+jm -> revenue total
  for (const b of priced) {
    const d = parseDateKey(b.date);
    const { jy, jm } = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const key = jy * 12 + jm;
    byMonth.set(key, (byMonth.get(key) || 0) + b.final_price);
  }

  const today = new Date();
  const { jy: curJy, jm: curJm } = gregorianToJalali(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const curKey = curJy * 12 + curJm;

  // Only fully-elapsed months count as history — this month is still in progress.
  const months = Array.from(byMonth.keys()).filter((k) => k < curKey).sort((a, b) => a - b);
  if (months.length < 3) return { ready: false, reason: "not-enough-months", monthsSoFar: months.length };

  const series = months.map((k, i) => ({ x: i, key: k, y: byMonth.get(k) }));
  const n = series.length;
  const sumX = series.reduce((s, p) => s + p.x, 0);
  const sumY = series.reduce((s, p) => s + p.y, 0);
  const sumXY = series.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = series.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  const residuals = series.map((p) => p.y - (slope * p.x + intercept));
  const variance = residuals.reduce((s, r) => s + r * r, 0) / n;
  const stdev = Math.sqrt(variance);

  const nextX = n; // one step past the last historical month
  const point = Math.max(0, slope * nextX + intercept);
  const targetKey = months[months.length - 1] + 1;
  const targetJy = Math.floor((targetKey - 1) / 12);
  const targetJm = ((targetKey - 1) % 12) + 1;

  return {
    ready: true,
    point,
    low: Math.max(0, point - stdev),
    high: point + stdev,
    trend: slope >= 0 ? "up" : "down",
    history: series.map((p) => ({ jy: Math.floor((p.key - 1) / 12), jm: ((p.key - 1) % 12) + 1, revenue: p.y })),
    targetJy, targetJm,
  };
}

function AIAnalysisTab({ bookings }) {
  const forecast = useMemo(() => forecastNextMonthRevenue(bookings), [bookings]);
  const histMax = forecast.ready ? Math.max(...forecast.history.map((h) => h.revenue), forecast.point) : 1;

  const PLANNED = [
    { Icon: TrendingUp, title: "پیش‌بینی ساعات پرترافیک", desc: "پیشنهاد بهترین بازه‌های زمانی برای رزرو بر اساس روند نوبت‌های گذشته." },
    { Icon: Wand2, title: "پیشنهاد قیمت‌گذاری و تخفیف", desc: "پیشنهاد خودکار تخفیف برای خدمات کم‌مشتری در ساعات خلوت." },
    { Icon: Sparkles, title: "شناسایی مشتریان درخطر ریزش", desc: "هشدار برای مشتریانی که مدتی است نوبت جدید ثبت نکرده‌اند." },
  ];

  return (
    <div className="fade-in">
      {/* What this widget is and why it's the one built first */}
      <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-info) 7%, var(--color-surface)), var(--color-surface))" }}>
        <p className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)", marginBottom: 6 }}>
          <Info size={13} /> بر اساس روش پنج‌گامهٔ سند بلوغ BI
        </p>
        <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
          گزارش‌های توصیفی (حسابداری، هوش تجاری) قبلاً پایدار شده‌اند — یعنی این پروژه فراتر از سطح «کودکی/نوجوانیِ» TDWI و روی نردبان تحلیل، در سطح «تشخیصی» (drill-down) قرار داره. طبق ماتریس گارتنر، منطقی‌ترین قدم بعدی (ارزش بالا، دشواری پایین) یک پیش‌بینی روند ساده بود — نه یک مدل پیچیده — چون کاملاً از داده‌های موجود، بدون جمع‌آوری چیز جدیدی، قابل محاسبه‌ست. همین‌جا پیاده شد 👇
        </p>
      </div>

      {/* The actual forecast */}
      <div className="card card-glass mb-4" style={{ padding: 18, background: "var(--grad-info)" }}>
        <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
        <div className="flex items-center gap-2" style={{ position: "relative" }}>
          <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: "oklch(100% 0 0 / 0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Target size={16} />
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.92 }}>پیش‌بینی درآمد</span>
        </div>

        {!forecast.ready ? (
          <div style={{ position: "relative", marginTop: 12 }}>
            <p style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.95 }}>
              {forecast.reason === "no-data"
                ? "هنوز نوبت تکمیل‌شده‌ای ثبت نشده — به محض داشتن چند نوبت واقعی، پیش‌بینی فعال می‌شود."
                : `فعلاً ${toFa(forecast.monthsSoFar || 0)} ماه کامل داده هست؛ برای پیش‌بینی معتبر حداقل به ۳ ماه کامل نیاز است. طبق گام ۱ سند (شمارش داده‌ها) — هنوز اول مسیریم.`}
            </p>
          </div>
        ) : (
          <>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 800, marginTop: 10, position: "relative", letterSpacing: "-0.02em" }}>
              {formatToman(forecast.point)}
            </div>
            <div className="flex items-center gap-1.5 mt-1" style={{ position: "relative", fontSize: 11.5, opacity: 0.9 }}>
              {forecast.trend === "up" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              برآورد {MONTHS_FA[forecast.targetJm - 1]} {toFa(forecast.targetJy)} — بازهٔ محتمل {formatToman(forecast.low)} تا {formatToman(forecast.high)}
            </div>

            <div className="flex items-end gap-2 mt-4" style={{ position: "relative", height: 70 }}>
              {forecast.history.map((h, i) => (
                <div key={i} className="flex flex-col items-center" style={{ flex: 1 }}>
                  <div style={{ width: "100%", maxWidth: 22, height: Math.max(4, (h.revenue / histMax) * 54), borderRadius: 4, background: "oklch(100% 0 0 / 0.55)" }} />
                  <span className="tabular" style={{ fontSize: 8.5, marginTop: 4, opacity: 0.85 }}>{MONTHS_FA[h.jm - 1].slice(0, 3)}</span>
                </div>
              ))}
              <div className="flex flex-col items-center" style={{ flex: 1 }}>
                <div style={{ width: "100%", maxWidth: 22, height: Math.max(4, (forecast.point / histMax) * 54), borderRadius: 4, border: "2px dashed white", background: "transparent" }} />
                <span className="tabular" style={{ fontSize: 8.5, marginTop: 4, fontWeight: 700 }}>برآورد</span>
              </div>
            </div>
            <p style={{ fontSize: 9.5, marginTop: 8, opacity: 0.75, position: "relative", lineHeight: 1.6 }}>
              روش: رگرسیون خطی سادهٔ حداقل مربعات روی {toFa(forecast.history.length)} ماه کاملِ گذشته — قابل بازبینی، بدون جعبهٔ سیاه.
            </p>
          </>
        )}
      </div>

      <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>بقیهٔ قابلیت‌های برنامه‌ریزی‌شده</p>
      <div className="flex flex-col gap-2">
        {PLANNED.map((item, i) => (
          <div key={i} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, opacity: 0.6 }}>
            <div style={{ width: 38, height: 38, borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <item.Icon size={17} color="var(--color-muted)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)" }}>{item.title}</div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.6 }}>{item.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Business Intelligence tab — owner-only (RBAC enforced by PanelView:
   this tab is excluded from a logged-in stylist's subTabs list and the
   render is double-guarded with `!currentStylist`).

   4 KPIs, each comparable against the previous equal-length period, with
   a shared hierarchical drill-down: کل ← شعبه ← جنسیت ← خدمت ← آرایشگر ← روز ← فاکتور.
   Every level renders the same 4 columns (مقدار / دورهٔ قبل / Δ٪ / سهم٪).

   Design notes (this app has no real multi-branch data model):
   - "شعبه" is derived from an optional `booking.branch` field, defaulting
     to a single "شعبه اصلی" — the hierarchy level exists and works, it's
     just a single bucket until real branch data is introduced.
   - "فاکتور" (leaf level) = each individual priced booking. A single
     invoice has no natural "previous period" counterpart, so that column
     shows "—" there; مقدار/سهم٪ are still fully computed.
   - "روز" (day) compares each date against the same relative day in the
     previous period (date shifted back by the period length), not a
     literal calendar match — previous-period dates are a different date
     range entirely, so a literal match would always be empty.
   ============================================================ */
const BI_DRILL_LEVELS = [
  { key: "branch", label: "شعبه" },
  { key: "gender", label: "جنسیت" },
  { key: "service", label: "خدمت" },
  { key: "staff", label: "آرایشگر" },
  { key: "day", label: "روز" },
  { key: "invoice", label: "فاکتور" },
];

function biDeriveKey(levelKey, b, services) {
  switch (levelKey) {
    case "branch":
      return { raw: b.branch || "شعبه اصلی", label: b.branch || "شعبه اصلی" };
    case "gender":
      return { raw: b.customer_gender, label: GENDER_TYPE_LABEL[b.customer_gender] || b.customer_gender };
    case "service": {
      const svc = services.find((s) => s.id === b.service_id);
      return { raw: b.service_id, label: svc ? svc.name : "نامشخص" };
    }
    case "staff":
      return { raw: b.staff_id || "none", label: b.staff_name || "بدون آرایشگر مشخص" };
    case "day":
      return { raw: b.date, label: jalaliLabel(parseDateKey(b.date), { short: true }) };
    default:
      return { raw: b.id, label: b.id };
  }
}
function biEntryMatches(b, entry) {
  switch (entry.levelKey) {
    case "branch": return (b.branch || "شعبه اصلی") === entry.rawValue;
    case "gender": return b.customer_gender === entry.rawValue;
    case "service": return b.service_id === entry.rawValue;
    case "staff": return (b.staff_id || "none") === entry.rawValue;
    case "day": return b.date === entry.rawValue;
    case "invoice": return b.id === entry.rawValue;
    default: return true;
  }
}

function biPriced(list) { return list.filter((b) => b.final_price != null); }

const BI_KPIS = [
  {
    id: "newCustomers", label: "مشتری جدید", Icon: UserPlus, higherIsBetter: true,
    format: (v) => `${toFa(Math.round(v))} نفر`,
    compute: (subset, allBookings, periodStartTs) => {
      const seen = new Set();
      let count = 0;
      for (const b of subset) {
        if (seen.has(b.customer_phone)) continue;
        seen.add(b.customer_phone);
        const hadEarlier = allBookings.some((ob) => ob.customer_phone === b.customer_phone && bookingTimestamp(ob) < periodStartTs);
        if (!hadEarlier) count++;
      }
      return count;
    },
    single: (b, allBookings, periodStartTs) => {
      const hadEarlier = allBookings.some((ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && bookingTimestamp(ob) < periodStartTs);
      return hadEarlier ? 0 : 1;
    },
  },
  {
    id: "returnRate60", label: "نرخ بازگشت ۶۰ روزه", Icon: Repeat2, higherIsBetter: true,
    format: (v) => `${toFa(Math.round(v * 100))}٪`,
    compute: (subset, allBookings) => {
      const anchors = new Map();
      for (const b of subset) {
        if (b.status !== "completed") continue;
        const ts = bookingTimestamp(b);
        if (!anchors.has(b.customer_phone) || ts < anchors.get(b.customer_phone)) anchors.set(b.customer_phone, ts);
      }
      if (anchors.size === 0) return 0;
      let returned = 0;
      for (const [phone, anchorTs] of anchors) {
        const hasReturn = allBookings.some(
          (ob) => ob.customer_phone === phone && ob.status === "completed" && bookingTimestamp(ob) > anchorTs && bookingTimestamp(ob) <= anchorTs + 60 * 86400000
        );
        if (hasReturn) returned++;
      }
      return returned / anchors.size;
    },
    single: (b, allBookings) => {
      if (b.status !== "completed") return 0;
      const ts = bookingTimestamp(b);
      const hasReturn = allBookings.some(
        (ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && ob.status === "completed" && bookingTimestamp(ob) > ts && bookingTimestamp(ob) <= ts + 60 * 86400000
      );
      return hasReturn ? 1 : 0;
    },
  },
  {
    id: "totalRevenue", label: "درآمد کل", Icon: Wallet, higherIsBetter: true,
    format: (v) => formatToman(v),
    compute: (subset) => biPriced(subset.filter((b) => b.status === "completed")).reduce((s, b) => s + b.final_price, 0),
    single: (b) => (b.status === "completed" && b.final_price != null ? b.final_price : 0),
  },
  {
    id: "noShowRate", label: "نرخ عدم حضور", Icon: XCircle, higherIsBetter: false,
    format: (v) => `${toFa(Math.round(v * 100))}٪`,
    compute: (subset) => (subset.length === 0 ? 0 : subset.filter((b) => b.status === "no_show").length / subset.length),
    single: (b) => (b.status === "no_show" ? 1 : 0),
  },
];

// Surfaces the win-back campaign data that SmsTab already writes to the
// database (campaigns / campaign_targets) — this card is the "missing"
// display piece the phase-3 changelog flagged.
function CampaignReturnRateCard() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setCampaigns(await fetchCampaigns());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <RefreshCw size={13} color="var(--color-accent-700)" /> نرخ بازگشت کمپین‌های جذب مجدد
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={load} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED && (
        <p className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>در حالت دمو، کمپین‌ها از سرور خوانده نمی‌شوند.</p>
      )}
      {SUPABASE_ENABLED && campaigns.length === 0 && !loading && (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز کمپینی از تب «پیامک» ارسال نشده</p>
      )}

      <div className="flex flex-col gap-2">
        {campaigns.slice(0, 8).map((c) => {
          const denom = c.sent_count > 0 ? c.sent_count : c.targeted_count;
          const rate = denom > 0 ? (c.returned_count / denom) * 100 : null;
          return (
            <div key={c.id} style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.name || "کمپین بدون نام"}</span>
                <span className="tabular" style={{ fontSize: 13, fontWeight: 800, color: rate == null ? "var(--color-muted)" : rate >= 15 ? "var(--color-success)" : "var(--color-heading)" }}>
                  {rate == null ? "—" : `${toFa(Math.round(rate))}٪`}
                </span>
              </div>
              <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 2 }}>
                {toFa(c.targeted_count)} هدف · {toFa(c.sent_count)} ارسال‌شده · {toFa(c.returned_count)} بازگشته
                {c.created_at && <> · {jalaliLabel(new Date(c.created_at), { withWeekday: false })}</>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RFM_SEGMENT_META = {
  champions: { label: "مشتریان وفادار", emoji: "👑", color: "var(--color-accent-500)" },
  champions_vip: { label: "وفادار ویژه VIP", emoji: "💎", color: "var(--color-tab-panel)" },
  at_risk: { label: "در خطر ریزش", emoji: "🚨", color: "var(--color-danger)" },
  new: { label: "مشتریان جدید", emoji: "🌱", color: "var(--color-success)" },
  inactive: { label: "غیرفعال", emoji: "💤", color: "var(--color-muted)" },
};
// The database's `segment` column only ever returns these 4 values —
// champions_vip above is a display-only entry (VIP is a boolean flag
// WITHIN champions, not a 5th segment value) used by the smart-campaigns
// list and the member-list badge, so it's deliberately excluded here.
const RFM_BASE_SEGMENT_KEYS = ["champions", "at_risk", "new", "inactive"];

// Reads the get_customer_rfm_segments() RPC directly — a separate data source from
// the bookings prop, so it fetches and refreshes on its own.
// Manager-only: configure the thresholds that drive customer segmentation.
// Mirrors the loyalty-settings form pattern (load → edit locally → save),
// plus a live preview against hypothetical values before committing.
function SegmentSettingsCard({ notify }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recency, setRecency] = useState(60);
  const [visits, setVisits] = useState(4);
  const [inactiveAfter, setInactiveAfter] = useState(120);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const s = await fetchSegmentSettings();
      if (s) {
        setRecency(s.loyal_recency_days);
        setVisits(s.loyal_min_visits);
        setInactiveAfter(s.inactive_after_days);
      }
      setLoading(false);
    })();
  }, []);

  const rangeValid = inactiveAfter > recency;

  async function handlePreview() {
    if (!rangeValid) return;
    setPreviewLoading(true);
    setPreview(await previewSegmentDistribution({ recency, visits, inactive: inactiveAfter }));
    setPreviewLoading(false);
  }

  async function handleSave() {
    if (!rangeValid) { notify("روز «غیرفعال» باید بیشتر از روز «وفادار» باشد"); return; }
    setSaving(true);
    await updateSegmentSettings({ loyal_recency_days: recency, loyal_min_visits: visits, inactive_after_days: inactiveAfter });
    setSaving(false);
    notify("تنظیمات دسته‌بندی مشتریان ذخیره شد");
  }

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", marginBottom: 10 }}>
        <SlidersHorizontal size={14} color="var(--color-accent-700)" /> تنظیمات دسته‌بندی هوشمند مشتریان
      </p>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : loading ? (
        <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>حداکثر روز از آخرین ویزیت برای «وفادار»</label>
              <input
                type="number" min="1" max="365" value={recency}
                onChange={(e) => setRecency(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                مشتری‌ای که ظرف {toFa(recency)} روز اخیر نوبت تکمیل‌شده داشته، «به‌روز» حساب می‌شود
              </p>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>حداقل تعداد ویزیت برای «وفادار»</label>
              <input
                type="number" min="1" max="100" value={visits}
                onChange={(e) => setVisits(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                {toFa(visits)} ویزیت تکمیل‌شده یا بیشتر، مشتری را «پرتردد» می‌کند
              </p>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>روز عدم مراجعه برای «غیرفعال»</label>
              <input
                type="number" min="1" max="365" value={inactiveAfter}
                onChange={(e) => setInactiveAfter(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              {rangeValid ? (
                <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>باید بزرگ‌تر از عدد «حداکثر روز وفادار» بالا باشد</p>
              ) : (
                <p style={{ fontSize: 10.5, marginTop: 3, color: "var(--color-danger)" }}>باید بزرگ‌تر از {toFa(recency)} باشد</p>
              )}
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <button disabled={previewLoading || !rangeValid} className="tap ghost-btn flex-1" style={{ padding: 10, fontSize: 12.5 }} onClick={handlePreview}>
              {previewLoading ? "در حال محاسبه..." : "پیش‌نمایش توزیع مشتریان"}
            </button>
            <button disabled={saving || !rangeValid} className="tap accent-btn flex-1" style={{ padding: 10, fontSize: 12.5 }} onClick={handleSave}>
              {saving ? "در حال ذخیره..." : "ذخیره تنظیمات"}
            </button>
          </div>

          {preview && (
            <div className="fade-in" style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {preview.map((p) => {
                const meta = RFM_SEGMENT_META[p.segment] || { color: "var(--color-muted)" };
                return (
                  <div key={p.segment} style={{ padding: 10, borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 10%, var(--color-surface-raised))` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-heading)" }}>{p.segment_fa}</div>
                    <div className="tabular" style={{ fontSize: 15, fontWeight: 800, color: meta.color }}>{toFa(p.customer_count)} نفر</div>
                    <div className="muted tabular" style={{ fontSize: 10 }}>{toFa(p.pct)}٪</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RfmSegmentsCard({ onSendToSegment }) {
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openSegment, setOpenSegment] = useState(null); // segment key currently drilled into

  async function load() {
    setLoading(true);
    setSegments(await fetchRfmSegments());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const bySegment = useMemo(() => {
    const map = new Map();
    for (const s of segments) map.set(s.segment, (map.get(s.segment) || 0) + 1);
    const total = segments.length || 1;
    return RFM_BASE_SEGMENT_KEYS.map((key) => ({
      key, meta: RFM_SEGMENT_META[key], count: map.get(key) || 0, pct: ((map.get(key) || 0) / total) * 100,
    }));
  }, [segments]);

  // Members of the currently open segment, most valuable (highest revenue) first.
  const openMembers = useMemo(() => {
    if (!openSegment) return [];
    return segments.filter((s) => s.segment === openSegment).sort((a, b) => (b.monetary || 0) - (a.monetary || 0));
  }, [segments, openSegment]);

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <Layers size={13} color="var(--color-accent-700)" /> سگمنت‌بندی مشتریان (RFM)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={load} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>سگمنت‌بندی RFM به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : segments.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز مشتری‌ای برای سگمنت‌بندی یافت نشد</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {bySegment.map(({ key, meta, count, pct }) => (
            <button
              key={key}
              onClick={() => count > 0 && setOpenSegment(key)}
              className="tap"
              style={{ padding: "12px 10px 10px", borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))`, position: "relative", overflow: "hidden", textAlign: "right", cursor: count > 0 ? "pointer" : "default" }}
            >
              <div style={{ position: "absolute", top: 0, insetInlineStart: 0, insetInlineEnd: 0, height: 3, background: `color-mix(in oklch, ${meta.color} 80%, transparent)` }} />
              <div
                style={{
                  width: 30, height: 30, borderRadius: "var(--radius-md)", fontSize: 15,
                  background: `color-mix(in oklch, ${meta.color} 16%, transparent)`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {meta.emoji}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-heading)", marginTop: 6, lineHeight: 1.5 }}>{meta.label}</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: meta.color, marginTop: 4 }}>{toFa(count)} نفر</div>
              <div className="muted tabular" style={{ fontSize: 10.5 }}>{toFa(Math.round(pct))}٪ از کل</div>
              {count > 0 && (
                <span className="flex items-center gap-1" style={{ marginTop: 6, fontSize: 10.5, fontWeight: 700, color: meta.color }}>
                  <Users size={10} /> مشاهدهٔ اعضا
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {openSegment && (
        <Modal title={`${RFM_SEGMENT_META[openSegment].emoji} ${RFM_SEGMENT_META[openSegment].label} (${toFa(openMembers.length)} نفر)`} onClose={() => setOpenSegment(null)}>
          <div className="flex flex-col gap-2" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {openMembers.map((m, i) => (
              <div key={m.phone} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                <span className="tabular" style={{ width: 20, height: 20, borderRadius: "50%", background: `color-mix(in oklch, ${RFM_SEGMENT_META[openSegment].color} 16%, transparent)`, color: RFM_SEGMENT_META[openSegment].color, fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {toFa(i + 1)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{m.name || "بدون نام"}</span>
                    {m.is_vip && (
                      <span className="badge" style={{ background: "var(--color-tab-panel)", color: "white", fontSize: 9.5 }}>💎 VIP</span>
                    )}
                  </div>
                  <div className="muted tabular" style={{ fontSize: 10.5 }} dir="ltr">{toFa(m.phone)}</div>
                </div>
                <div style={{ textAlign: "left" }}>
                  <div className="tabular" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(m.monetary || 0)}</div>
                  <div className="muted tabular" style={{ fontSize: 10 }}>{toFa(m.frequency || 0)} ویزیت · {toFa(m.recency_days ?? 0)} روز پیش</div>
                </div>
              </div>
            ))}
          </div>
          {openSegment === "champions" && openMembers.some((m) => m.is_vip) && (
            <button
              className="tap w-full mt-3 flex items-center justify-center gap-1.5"
              style={{ padding: 10, fontSize: 12.5, borderRadius: "var(--radius-md)", background: "var(--color-tab-panel)", color: "white" }}
              onClick={() => { onSendToSegment("champions_vip"); setOpenSegment(null); }}
            >
              💎 ارسال پیامک ویژه VIP ({toFa(openMembers.filter((m) => m.is_vip).length)} نفر)
            </button>
          )}
          <button
            className="tap accent-btn w-full mt-3"
            style={{ padding: 10, fontSize: 12.5 }}
            onClick={() => { onSendToSegment(openSegment); setOpenSegment(null); }}
          >
            <Send size={13} style={{ display: "inline", marginLeft: 6 }} /> ارسال پیامک به این دسته
          </button>
        </Modal>
      )}
    </div>
  );
}

const SERVICE_CATEGORY_ICON = { hair: Scissors, beard: Scissors, color: Palette, makeup: Sparkles, nails: Hand, skin: Droplet, permanent_makeup: Eye };
const LINE_STATUS_META = {
  active: { label: "فعال", color: "var(--color-success)" },
  at_risk: { label: "در خطر ریزش", color: "var(--color-warning)" },
  dormant: { label: "غیرفعال", color: "var(--color-muted)" },
};

// Per-service-category view of customer recency (v2.11) — a hair-color
// regular who's overdue for skincare looks very different line by line vs.
// as one blended average. Uses the useData hook (unlike the other
// self-contained fetch components in this file) since it's a brand-new
// component with no existing pattern to disrupt.
// Default win-back message for the category-matrix "ارسال پیشنهاد" action —
// editable in the preview modal before sending, never sent as-is silently.
const CATEGORY_OFFER_DEFAULT_BODY =
  "سلام {{name}} عزیز، مدتیه توی بخش {{category}} پیشمون نیومدید! دلمون براتون تنگ شده — برای بازگشت، یه پیشنهاد ویژه منتظرتونه 🎁";

function CategoryMatrixCard({ notify }) {
  const { data: rows, loading, refetch } = useData(fetchCategoryMatrix, [], { cacheKey: "category_matrix" });
  const [openCategory, setOpenCategory] = useState(null);
  const [offerPreview, setOfferPreview] = useState(null); // { category, category_fa, recipients, body }
  const [sendingOffer, setSendingOffer] = useState(false);

  const byCategory = useMemo(() => {
    const map = new Map();
    for (const r of rows || []) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category).push(r);
    }
    return [...map.entries()].map(([category, members]) => ({
      category,
      category_fa: members[0]?.category_fa || CATEGORY_LABEL[category] || category,
      members,
      active: members.filter((m) => m.line_status === "active").length,
      at_risk: members.filter((m) => m.line_status === "at_risk").length,
      dormant: members.filter((m) => m.line_status === "dormant").length,
    }));
  }, [rows]);

  const openMembers = useMemo(() => {
    if (!openCategory) return [];
    const cat = byCategory.find((c) => c.category === openCategory);
    return cat ? [...cat.members].sort((a, b) => a.last_visit_days - b.last_visit_days) : [];
  }, [byCategory, openCategory]);

  // at_risk + dormant only — "active" customers in this line don't need a
  // win-back nudge. Deduplicated by phone and validated against the same
  // Iranian mobile format used everywhere else in the app, so a stray
  // malformed or repeated number can't slip into a send.
  const winBackCandidates = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const m of openMembers) {
      if (m.line_status !== "at_risk" && m.line_status !== "dormant") continue;
      if (!/^09\d{9}$/.test(m.phone || "")) continue;
      if (seen.has(m.phone)) continue;
      seen.add(m.phone);
      out.push(m);
    }
    return out;
  }, [openMembers]);

  function openOfferPreview() {
    if (!winBackCandidates.length) return;
    const cat = byCategory.find((c) => c.category === openCategory);
    setOfferPreview({
      category: openCategory,
      category_fa: cat?.category_fa || CATEGORY_LABEL[openCategory] || openCategory,
      recipients: winBackCandidates,
      body: CATEGORY_OFFER_DEFAULT_BODY,
    });
  }

  async function handleSendOffer() {
    if (!offerPreview || !offerPreview.body.trim()) return;
    setSendingOffer(true);
    const messages = offerPreview.recipients.map((r) => ({
      to: r.phone,
      body: renderTemplate(offerPreview.body, { name: r.name || "مشتری", category: offerPreview.category_fa }),
      kind: "custom",
    }));
    const res = await sendBulkSms(messages);
    setSendingOffer(false);
    setOfferPreview(null);
    setOpenCategory(null);

    if (res?.demo) notify("حالت دمو — پیامک واقعی ارسال نشد");
    else if (res?.ok) notify(`${toFa(res.sent)} پیشنهاد ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`);
    else notify(res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
  }

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <LayoutGrid size={13} color="var(--color-accent-700)" /> ماتریس خط خدمات مشتریان
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : byCategory.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز داده‌ای برای این ماتریس یافت نشد</p>
      ) : (
        <div className="flex flex-col gap-2">
          {byCategory.map((c) => {
            const Icon = SERVICE_CATEGORY_ICON[c.category] || Scissors;
            const total = c.active + c.at_risk + c.dormant;
            return (
              <button
                key={c.category}
                onClick={() => setOpenCategory(c.category)}
                className="tap flex items-center gap-3"
                style={{ padding: 10, borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", textAlign: "right" }}
              >
                <div style={{ width: 32, height: 32, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-accent-500) 14%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon size={15} color="var(--color-accent-700)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.category_fa}</div>
                  <div className="flex items-center gap-2 mt-1" style={{ flexWrap: "wrap" }}>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-success)" }}>● {toFa(c.active)} فعال</span>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-warning)" }}>● {toFa(c.at_risk)} در خطر</span>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-muted)" }}>● {toFa(c.dormant)} غیرفعال</span>
                  </div>
                </div>
                <span className="tabular muted" style={{ fontSize: 11, flexShrink: 0 }}>{toFa(total)} نفر</span>
              </button>
            );
          })}
        </div>
      )}

      {openCategory && (
        <Modal title={`${CATEGORY_LABEL[openCategory] || openCategory} — وضعیت مشتریان`} onClose={() => setOpenCategory(null)}>
          <div className="flex flex-col gap-2" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {openMembers.map((m) => {
              const meta = LINE_STATUS_META[m.line_status] || LINE_STATUS_META.dormant;
              return (
                <div key={m.phone} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{m.name || "بدون نام"}</div>
                    <div className="muted tabular" style={{ fontSize: 10.5 }} dir="ltr">{toFa(m.phone)}</div>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <span className="badge" style={{ background: meta.color, color: "white" }}>{m.line_status_fa}</span>
                    <div className="muted tabular" style={{ fontSize: 10, marginTop: 3 }}>{toFa(m.visit_count)} ویزیت · {toFa(m.last_visit_days)} روز پیش</div>
                  </div>
                </div>
              );
            })}
          </div>
          {winBackCandidates.length > 0 && (
            <button
              className="tap accent-btn w-full mt-3 flex items-center justify-center gap-1.5"
              style={{ padding: 10, fontSize: 12.5 }}
              onClick={openOfferPreview}
            >
              <Send size={13} /> ارسال پیشنهاد به {toFa(winBackCandidates.length)} نفر در خطر/غیرفعال
            </button>
          )}
        </Modal>
      )}

      {offerPreview && (
        <Modal title={`پیشنهاد بازگشت — ${offerPreview.category_fa}`} onClose={() => setOfferPreview(null)}>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
            متن زیر برای هرکدوم از {toFa(offerPreview.recipients.length)} نفر با نام خودشون شخصی‌سازی می‌شه. قبل از ارسال، متن رو بررسی و در صورت نیاز ویرایش کنید.
          </p>
          <textarea
            value={offerPreview.body}
            onChange={(e) => setOfferPreview((p) => ({ ...p, body: e.target.value }))}
            style={{ width: "100%", padding: 11, fontSize: 13, minHeight: 100, resize: "vertical", lineHeight: 1.7 }}
          />
          <div className="flex gap-1 mt-2">
            <span className="badge" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>{"{{name}}"} = نام مشتری</span>
            <span className="badge" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>{"{{category}}"} = {offerPreview.category_fa}</span>
          </div>

          <p className="muted" style={{ fontSize: 11, marginTop: 12, marginBottom: 4 }}>پیش‌نمایش برای نفر اول:</p>
          <div className="surface-raised" style={{ borderRadius: "var(--radius-md)", padding: 10, fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
            {renderTemplate(offerPreview.body, { name: offerPreview.recipients[0]?.name || "مشتری", category: offerPreview.category_fa }) || <span className="muted">متنی وارد نشده</span>}
          </div>

          <button
            disabled={sendingOffer || !offerPreview.body.trim()}
            className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
            style={{ padding: 12, fontSize: 13 }}
            onClick={handleSendOffer}
          >
            {sendingOffer ? <Loader2 size={15} className="salon-spin" /> : <Send size={15} />}
            تایید و ارسال به {toFa(offerPreview.recipients.length)} نفر
          </button>
          {!SUPABASE_ENABLED && (
            <p className="muted flex items-center gap-1 mt-3" style={{ fontSize: 11 }}>
              <AlertTriangle size={12} /> دیتابیس متصل نیست — ارسال واقعی انجام نمی‌شود
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---- v2.12 BI charts: pure SVG/CSS, no charting library, RTL-aware ----

// Line + area chart. RTL: oldest point on the right, newest on the left,
// matching how a Persian reader's eye naturally moves through a timeline.
function RevenueTrendChart({ points }) {
  const width = 600, height = 140, padTop = 10, padBottom = 20, padSide = 4;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const xFor = (i) => n <= 1 ? width / 2 : width - padSide - (i / (n - 1)) * (width - padSide * 2);
  const yFor = (v) => padTop + (1 - v / max) * (height - padTop - padBottom);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(" ");
  const areaPath = n > 0
    ? `${linePath} L ${xFor(n - 1).toFixed(1)} ${height - padBottom} L ${xFor(0).toFixed(1)} ${height - padBottom} Z`
    : "";

  // Thin out x-axis labels so they don't collide when there are many points.
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", overflow: "visible" }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="revenueTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-500)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-accent-500)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {n > 0 && <path d={areaPath} fill="url(#revenueTrendFill)" stroke="none" />}
      {n > 1 && <path d={linePath} fill="none" stroke="var(--color-accent-500)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {points.map((p, i) => (
        (i % labelEvery === 0 || i === n - 1) && (
          <text key={i} x={xFor(i)} y={height - 4} fontSize="8" fill="var(--color-muted)" textAnchor="middle">{p.label}</text>
        )
      ))}
      {n > 0 && (
        <circle cx={xFor(n - 1)} cy={yFor(points[n - 1].value)} r="3" fill="var(--color-accent-500)" />
      )}
    </svg>
  );
}

// Donut (ring) chart built from stroke-dasharray arcs on stacked circles —
// no path-arc trigonometry needed. Legend lists exact values beside it so
// nothing shown only as a proportion is lost as a real number.
function ServiceShareDonut({ slices }) {
  const size = 120, stroke = 16, r = (size - stroke) / 2, circumference = 2 * Math.PI * r;
  let offsetSoFar = 0;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  return (
    <div className="flex items-center gap-4" style={{ flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0, transform: "scaleX(-1)" /* RTL: first slice starts from the right */ }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-raised)" strokeWidth={stroke} />
        {slices.map((s, i) => {
          const frac = s.value / total;
          const dash = frac * circumference;
          const el = (
            <circle
              key={i}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}`}
              strokeDashoffset={(-offsetSoFar).toFixed(1)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offsetSoFar += dash;
          return el;
        })}
      </svg>
      <div className="flex flex-col gap-1.5" style={{ flex: 1, minWidth: 140 }}>
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: "var(--color-heading)" }}>{s.name}</span>
            <span className="tabular muted" style={{ fontSize: 10.5 }}>{toFa(Math.round((s.value / total) * 100))}٪</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// weekday × hour density grid — replaces the two separate 1D bar charts
// (peak hours, busy weekdays) that used to sit here: a heatmap shows the
// INTERACTION between the two dimensions (e.g. "Thursday evenings" as its
// own hot spot), which two independent 1D charts can't.
function BookingHeatmap({ grid, hours, dayLabels }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "inline-grid", gridTemplateColumns: `28px repeat(${hours.length}, 16px)`, gap: 2, direction: "rtl" }}>
        <div />
        {hours.map((h) => (
          <div key={h} className="tabular muted" style={{ fontSize: 7, textAlign: "center" }}>{toFa(h)}</div>
        ))}
        {dayLabels.map((label, dayIdx) => (
          <React.Fragment key={label}>
            <div className="muted" style={{ fontSize: 9, display: "flex", alignItems: "center" }}>{label.slice(0, 2)}</div>
            {hours.map((h, hourIdx) => {
              const count = grid[dayIdx][hourIdx];
              const intensity = count / max;
              return (
                <div
                  key={h}
                  title={`${label} ساعت ${toFa(h)} — ${toFa(count)} نوبت`}
                  style={{
                    width: 16, height: 16, borderRadius: 3,
                    background: count === 0 ? "var(--color-surface-raised)" : `color-mix(in oklch, var(--color-accent-500) ${Math.round(18 + intensity * 82)}%, var(--color-surface-raised))`,
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// v2.13: campaign conversion & ROI analytics. Own useData call (like
// CategoryMatrixCard), so it loads independently of BITab's own range-
// filtered bookings data — campaign performance is lifetime-to-date, not
// scoped to BITab's 7/30/90-day range toggle.
function CampaignPerformanceCard() {
  const { data: rows, loading, refetch } = useData(fetchCampaignPerformance, [null], { cacheKey: "campaign_performance:all" });

  const templates = useMemo(() => (rows || []).filter((r) => r.total_sent > 0), [rows]);

  const totals = useMemo(() => {
    const totalSent = templates.reduce((s, r) => s + Number(r.total_sent || 0), 0);
    const successful = templates.reduce((s, r) => s + Number(r.successful_count || 0), 0);
    const conversions = templates.reduce((s, r) => s + Number(r.total_conversions || 0), 0);
    const revenue = templates.reduce((s, r) => s + Number(r.attributed_revenue || 0), 0);
    const conversionRate = successful > 0 ? (conversions / successful) * 100 : 0;
    return { totalSent, successful, conversions, revenue, conversionRate };
  }, [templates]);

  const maxRate = Math.max(1, ...templates.map((t) => Number(t.conversion_rate || 0)));

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <TrendingUp size={13} color="var(--color-accent-700)" /> عملکرد کمپین‌ها (تبدیل و ROI)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : templates.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز کمپینی ارسال نشده</p>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>پیامک ارسال‌شده</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(totals.successful)}</div>
            </div>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-success) 10%, var(--color-surface-raised))" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>نرخ بازگشت</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: "var(--color-success)" }}>{toFa(Math.round(totals.conversionRate * 10) / 10)}٪</div>
            </div>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-accent-500) 10%, var(--color-surface-raised))" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>درآمد کمپین</div>
              <div className="tabular" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-accent-700)" }}>{formatToman(totals.revenue)}</div>
            </div>
          </div>

          {templates.length > 1 && (
            <div className="flex flex-col gap-2 mt-4">
              <p className="muted" style={{ fontSize: 11 }}>مقایسهٔ نرخ تبدیل قالب‌ها</p>
              {templates
                .slice()
                .sort((a, b) => Number(b.conversion_rate || 0) - Number(a.conversion_rate || 0))
                .map((t) => (
                  <div key={t.template_id || t.template_label}>
                    <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                      <span style={{ fontWeight: 700, color: "var(--color-heading)" }}>{t.template_label || t.template_id}</span>
                      <span className="tabular muted">{toFa(t.conversion_rate)}٪ · {toFa(t.total_conversions)} تبدیل</span>
                    </div>
                    <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", marginTop: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(Number(t.conversion_rate || 0) / maxRate) * 100}%`, height: "100%", background: "var(--grad-brand)" }} />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// v2.18 — average rating + distribution from customer feedback (v2.14),
// which was collected but never surfaced anywhere until now.
function FeedbackStatsCard() {
  const { data: stats, loading, refetch } = useData(fetchFeedbackStats, [], { cacheKey: "feedback_stats" });
  const total = stats?.total_count || 0;
  const maxCount = Math.max(1, ...[1, 2, 3, 4, 5].map((n) => Number(stats?.[`rating_${n}`] || 0)));

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <Star size={13} color="var(--color-warning)" /> رضایت مشتریان (نظرسنجی)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : total === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز نظری ثبت نشده</p>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-3">
            <div className="tabular" style={{ fontSize: 28, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(stats.avg_rating)}</div>
            <div>
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} size={14} fill={n <= Math.round(stats.avg_rating) ? "var(--color-warning)" : "none"} color="var(--color-warning)" />
                ))}
              </div>
              <div className="muted tabular" style={{ fontSize: 11 }}>از {toFa(total)} نظر</div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {[5, 4, 3, 2, 1].map((n) => {
              const count = Number(stats[`rating_${n}`] || 0);
              return (
                <div key={n} className="flex items-center gap-2">
                  <span className="tabular muted" style={{ fontSize: 10.5, width: 14 }}>{toFa(n)}</span>
                  <Star size={10} fill="var(--color-warning)" color="var(--color-warning)" />
                  <div style={{ flex: 1, height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", overflow: "hidden" }}>
                    <div style={{ width: `${(count / maxCount) * 100}%`, height: "100%", background: "var(--color-warning)" }} />
                  </div>
                  <span className="tabular muted" style={{ fontSize: 10.5, width: 24, textAlign: "left" }}>{toFa(count)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function BITab({ bookings, services, stylists, workingHours, staffWorkingHours, timeOff, approvedDates }) {
  const [range, setRange] = useState("30"); // default 30 days
  const [branchFilter, setBranchFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState("all");
  const [drill, setDrill] = useState(null); // { kpiId, path: [{ levelKey, rawValue, label }] }

  const branches = useMemo(() => Array.from(new Set(bookings.map((b) => b.branch || "شعبه اصلی"))), [bookings]);
  const spanDays = Number(range);

  const { periodStart, periodEnd, prevPeriodStart, prevPeriodEnd } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setDate(end.getDate() + 1); // exclusive — through end of today
    const start = new Date(today);
    start.setDate(start.getDate() - (spanDays - 1));
    const prevEnd = new Date(start);
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - spanDays);
    return { periodStart: start, periodEnd: end, prevPeriodStart: prevStart, prevPeriodEnd: prevEnd };
  }, [spanDays]);

  // Branch/stylist-filtered, but NOT date-filtered — this is the pool used for
  // "has this customer been seen before" lookback checks (new customer / return rate),
  // so history outside the selected date window still counts correctly.
  const baseFiltered = useMemo(
    () => bookings.filter((b) => (branchFilter === "all" || (b.branch || "شعبه اصلی") === branchFilter) && (staffFilter === "all" || b.staff_id === staffFilter)),
    [bookings, branchFilter, staffFilter]
  );
  const periodBookings = useMemo(
    () => baseFiltered.filter((b) => { const ts = bookingTimestamp(b); return ts >= periodStart.getTime() && ts < periodEnd.getTime(); }),
    [baseFiltered, periodStart, periodEnd]
  );
  const prevPeriodBookings = useMemo(
    () => baseFiltered.filter((b) => { const ts = bookingTimestamp(b); return ts >= prevPeriodStart.getTime() && ts < prevPeriodEnd.getTime(); }),
    [baseFiltered, prevPeriodStart, prevPeriodEnd]
  );

  // ---- Peak hours: bookings per hour of day, 08:00–20:00 ----
  const peakHours = useMemo(() => {
    const buckets = new Map();
    for (let h = 8; h < 20; h++) buckets.set(h, 0);
    for (const b of periodBookings) {
      const h = Math.floor(b.start_min / 60);
      if (buckets.has(h)) buckets.set(h, buckets.get(h) + 1);
    }
    return Array.from(buckets.entries()).map(([hour, count]) => ({ hour, count }));
  }, [periodBookings]);

  // ---- Weekday distribution: بookings per weekday, شنبه..جمعه ----
  const weekdayDist = useMemo(() => {
    const counts = new Array(7).fill(0); // index = schemaDayOf(), 0 = شنبه
    for (const b of periodBookings) counts[schemaDayOf(parseDateKey(b.date))] += 1;
    return counts.map((count, i) => ({ label: SCHEMA_DAY_LABELS[i], count }));
  }, [periodBookings]);

  // ---- v2.12: weekday × hour heatmap — same two dimensions as peakHours/
  // weekdayDist above, combined into one grid so an interaction like
  // "Thursday evenings specifically" is visible, not just each axis alone.
  const heatmapHours = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 8), []); // 08..19
  const heatmapGrid = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => new Array(heatmapHours.length).fill(0));
    for (const b of periodBookings) {
      const day = schemaDayOf(parseDateKey(b.date));
      const hourIdx = Math.floor(b.start_min / 60) - heatmapHours[0];
      if (hourIdx >= 0 && hourIdx < heatmapHours.length) grid[day][hourIdx] += 1;
    }
    return grid;
  }, [periodBookings, heatmapHours]);

  // ---- Stylist performance table: sortable, with a "score" combining volume,
  // average ticket, and return rate. Return rate is computed over baseFiltered
  // (full history, not just the current period) since it measures a lasting
  // customer relationship, not a one-window snapshot. ----
  const [perfSortKey, setPerfSortKey] = useState("count");
  const [perfSortDir, setPerfSortDir] = useState("desc");
  const stylistPerf = useMemo(() => {
    const activeStylists = stylists.filter((s) => s.active);
    const rows = activeStylists.map((st) => {
      const completedTheirs = periodBookings.filter((b) => b.staff_id === st.id && b.status === "completed" && b.final_price != null);
      const count = completedTheirs.length;
      const totalRevenue = completedTheirs.reduce((s, b) => s + b.final_price, 0);
      const avgRevenue = count > 0 ? totalRevenue / count : 0;
      const customerVisits = new Map();
      for (const b of baseFiltered.filter((b) => b.staff_id === st.id && b.status === "completed")) {
        customerVisits.set(b.customer_phone, (customerVisits.get(b.customer_phone) || 0) + 1);
      }
      const totalCustomers = customerVisits.size;
      const returningCustomers = Array.from(customerVisits.values()).filter((v) => v > 1).length;
      const returnRate = totalCustomers > 0 ? (returningCustomers / totalCustomers) * 100 : 0;
      return { id: st.id, name: st.name, gender: st.gender, count, avgRevenue, returnRate };
    });
    const maxCount = Math.max(1, ...rows.map((r) => r.count));
    const maxAvgRevenue = Math.max(1, ...rows.map((r) => r.avgRevenue));
    return rows.map((r) => ({
      ...r,
      score: (0.4 * (r.count / maxCount) + 0.35 * (r.avgRevenue / maxAvgRevenue) + 0.25 * (r.returnRate / 100)) * 100,
    }));
  }, [stylists, periodBookings, baseFiltered]);
  const stylistPerfAvg = useMemo(() => {
    const n = stylistPerf.length || 1;
    return {
      count: stylistPerf.reduce((s, r) => s + r.count, 0) / n,
      avgRevenue: stylistPerf.reduce((s, r) => s + r.avgRevenue, 0) / n,
      returnRate: stylistPerf.reduce((s, r) => s + r.returnRate, 0) / n,
      score: stylistPerf.reduce((s, r) => s + r.score, 0) / n,
    };
  }, [stylistPerf]);
  const sortedStylistPerf = useMemo(() => {
    const arr = [...stylistPerf];
    arr.sort((a, b) => (perfSortDir === "desc" ? b[perfSortKey] - a[perfSortKey] : a[perfSortKey] - b[perfSortKey]));
    return arr;
  }, [stylistPerf, perfSortKey, perfSortDir]);
  function togglePerfSort(key) {
    if (perfSortKey === key) setPerfSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setPerfSortKey(key); setPerfSortDir("desc"); }
  }

  // ---- Pareto: the customers who make up 80% of this period's revenue ----
  const paretoData = useMemo(() => {
    const byCustomer = new Map();
    for (const b of periodBookings.filter((b) => b.status === "completed" && b.final_price != null)) {
      const cur = byCustomer.get(b.customer_phone) || { phone: b.customer_phone, name: b.customer_name, revenue: 0, visits: 0 };
      cur.revenue += b.final_price;
      cur.visits += 1;
      byCustomer.set(b.customer_phone, cur);
    }
    const sorted = Array.from(byCustomer.values()).sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = sorted.reduce((s, c) => s + c.revenue, 0);
    let cumulative = 0, paretoCount = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += sorted[i].revenue;
      if (totalRevenue > 0 && cumulative / totalRevenue >= 0.8) { paretoCount = i + 1; break; }
    }
    const topCustomers = sorted.slice(0, paretoCount);
    const topRevenue = topCustomers.reduce((s, c) => s + c.revenue, 0);
    return {
      topCustomers, totalRevenue,
      pctOfCustomers: sorted.length > 0 ? (paretoCount / sorted.length) * 100 : 0,
      pctOfRevenue: totalRevenue > 0 ? (topRevenue / totalRevenue) * 100 : 0,
    };
  }, [periodBookings]);

  // ---- Demand forecast: 7-day trailing moving average of completed bookings,
  // plus an EXACT (not estimated) capacity model for the next 7 days — each
  // active stylist's real working minutes that day (respecting their own
  // hours, time off, and day-approval), minus minutes already booked.
  // "کم‌پرشدگی" alert = fill rate under 20% (i.e. the day is mostly empty —
  // the missed-opportunity case), shown alongside the raw numbers so the fill
  // vs. empty reading is never ambiguous.
  const demandForecast = useMemo(() => {
    const dailyCounts = new Map();
    for (const b of baseFiltered.filter((b) => b.status === "completed")) {
      dailyCounts.set(b.date, (dailyCounts.get(b.date) || 0) + 1);
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const last7Keys = [];
    for (let i = 1; i <= 7; i++) { const d = new Date(today); d.setDate(d.getDate() - i); last7Keys.push(dateKey(d)); }
    const movingAvg = last7Keys.reduce((s, k) => s + (dailyCounts.get(k) || 0), 0) / 7;

    const activeStylists = stylists.filter((s) => s.active && (staffFilter === "all" || s.id === staffFilter));
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const dKey = dateKey(d);
      const approved = (approvedDates || []).includes(dKey);
      let totalCapacity = 0, totalBooked = 0;
      for (const st of activeStylists) {
        const whList = (staffWorkingHours && staffWorkingHours[st.id]) || workingHours;
        const wh = whList.find((w) => w.day_of_week === schemaDayOf(d));
        const isOff = (timeOff || []).some((t) => (!t.staff_id || t.staff_id === st.id) && t.date === dKey);
        if (!wh || wh.is_closed || isOff || !approved) continue;
        totalCapacity += Math.max(0, hhmmToMin(wh.end_time) - hhmmToMin(wh.start_time));
        const theirBookings = bookings.filter(
          (b) => b.staff_id === st.id && b.date === dKey && ["confirmed", "pending", "rescheduled", "completed"].includes(b.status)
        );
        totalBooked += theirBookings.reduce((s, b) => s + (b.end_min - b.start_min) + (b.buffer_minutes || 0), 0);
      }
      const fillRate = totalCapacity > 0 ? Math.min(1, totalBooked / totalCapacity) : 0;
      days.push({ date: d, dKey, totalCapacity, totalBooked, fillRate, hasCapacity: totalCapacity > 0, lowFill: totalCapacity > 0 && fillRate < 0.2 });
    }
    return { movingAvg, days };
  }, [baseFiltered, bookings, stylists, staffFilter, workingHours, staffWorkingHours, timeOff, approvedDates]);

  function applyPath(list, path) {
    return path.reduce((acc, entry) => acc.filter((b) => biEntryMatches(b, entry)), list);
  }
  const pathFilteredPeriod = drill ? applyPath(periodBookings, drill.path) : periodBookings;
  const pathFilteredPrev = drill ? applyPath(prevPeriodBookings, drill.path) : prevPeriodBookings;

  // Moved here from Accounting: service popularity and new-vs-returning are analytical,
  // not transactional, so they live in BI now. All scoped to the current period/filters,
  // same pool the KPI cards use (periodBookings), not affected by the drill-down path.
  const periodCompleted = periodBookings.filter((b) => b.status === "completed");
  const periodPricedCompleted = periodCompleted.filter((b) => b.final_price != null);

  const topByCount = useMemo(() => {
    const map = new Map();
    for (const b of periodCompleted) map.set(b.service_id, (map.get(b.service_id) || 0) + 1);
    const totalCount = periodCompleted.length || 1;
    return Array.from(map.entries())
      .map(([serviceId, count]) => ({ service: services.find((s) => s.id === serviceId), count, pct: (count / totalCount) * 100 }))
      .filter((x) => x.service)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }, [periodCompleted, services]);

  // ---- v2.12: daily revenue trend for the selected range (max range here
  // is 90 days, so daily buckets stay readable without needing a
  // monthly-rollup mode the way Accounting's longer-range chart does). ----
  const revenueTrend = useMemo(() => {
    const byDay = new Map();
    for (const b of periodPricedCompleted) byDay.set(b.date, (byDay.get(b.date) || 0) + b.final_price);
    const days = [];
    for (let d = new Date(periodStart); d < periodEnd; d.setDate(d.getDate() + 1)) {
      const key = dateKey(d);
      days.push({ label: jalaliLabel(new Date(d), { short: true }).split(" ")[0], value: byDay.get(key) || 0 });
    }
    return days;
  }, [periodPricedCompleted, periodStart, periodEnd]);

  // ---- v2.12: service revenue share for the donut — top 5 + یک سهم "سایر"
  // برای بقیه، تا مجموع سهم‌ها همیشه ۱۰۰٪ بمونه. ----
  const DONUT_COLORS = ["var(--color-accent-500)", "var(--color-info)", "var(--color-success)", "var(--color-warning)", "var(--color-tab-panel)"];
  const serviceShareSlices = useMemo(() => {
    const map = new Map();
    for (const b of periodPricedCompleted) map.set(b.service_id, (map.get(b.service_id) || 0) + b.final_price);
    const ranked = Array.from(map.entries())
      .map(([serviceId, revenue]) => ({ name: services.find((s) => s.id === serviceId)?.name, revenue }))
      .filter((x) => x.name)
      .sort((a, b) => b.revenue - a.revenue);
    const top = ranked.slice(0, 5).map((x, i) => ({ name: x.name, value: x.revenue, color: DONUT_COLORS[i] }));
    const restTotal = ranked.slice(5).reduce((s, x) => s + x.revenue, 0);
    if (restTotal > 0) top.push({ name: "سایر", value: restTotal, color: "var(--color-muted)" });
    return top;
  }, [periodPricedCompleted, services]);

  // A customer counts as "returning" if they had a completed visit before this period
  // started, anywhere in baseFiltered (branch/staff-filtered but not date-filtered).
  const customerMix = useMemo(() => {
    const rangeStartTs = periodStart.getTime();
    let newRevenue = 0, returningRevenue = 0, newCount = 0, returningCount = 0;
    for (const b of periodPricedCompleted) {
      const hadPriorVisit = baseFiltered.some(
        (ob) => ob.customer_phone === b.customer_phone && ob.status === "completed" && bookingTimestamp(ob) < rangeStartTs
      );
      if (hadPriorVisit) { returningRevenue += b.final_price; returningCount += 1; }
      else { newRevenue += b.final_price; newCount += 1; }
    }
    return { newRevenue, returningRevenue, newCount, returningCount, total: newRevenue + returningRevenue || 1 };
  }, [periodPricedCompleted, baseFiltered, periodStart]);

  const activeKpi = drill ? BI_KPIS.find((k) => k.id === drill.kpiId) : null;
  const currentLevel = drill && drill.path.length < BI_DRILL_LEVELS.length ? BI_DRILL_LEVELS[drill.path.length] : null;

  const levelRows = useMemo(() => {
    if (!activeKpi || !currentLevel) return [];
    const parentTotal = activeKpi.compute(pathFilteredPeriod, baseFiltered, periodStart.getTime()) || 1;

    if (currentLevel.key === "invoice") {
      return pathFilteredPeriod
        .map((b) => {
          const svc = services.find((s) => s.id === b.service_id);
          const value = activeKpi.single(b, baseFiltered, periodStart.getTime());
          return {
            rawValue: b.id,
            label: `${b.customer_name || "بدون نام"} · ${svc?.name || ""}`,
            value, prevValue: null,
            share: (value / parentTotal) * 100,
          };
        })
        .sort((a, b) => b.value - a.value);
    }

    const groups = new Map();
    for (const b of pathFilteredPeriod) {
      const { raw, label } = biDeriveKey(currentLevel.key, b, services);
      if (!groups.has(raw)) groups.set(raw, { label, bookings: [] });
      groups.get(raw).bookings.push(b);
    }
    const rows = [];
    for (const [raw, g] of groups) {
      const value = activeKpi.compute(g.bookings, baseFiltered, periodStart.getTime());
      let prevSubset;
      if (currentLevel.key === "day") {
        const shifted = new Date(parseDateKey(raw));
        shifted.setDate(shifted.getDate() - spanDays);
        const shiftedKey = dateKey(shifted);
        prevSubset = pathFilteredPrev.filter((b) => b.date === shiftedKey);
      } else {
        prevSubset = pathFilteredPrev.filter((b) => biDeriveKey(currentLevel.key, b, services).raw === raw);
      }
      const prevValue = activeKpi.compute(prevSubset, baseFiltered, prevPeriodStart.getTime());
      rows.push({ rawValue: raw, label: g.label, value, prevValue, share: (value / parentTotal) * 100 });
    }
    return rows.sort((a, b) => b.value - a.value);
  }, [activeKpi, currentLevel, pathFilteredPeriod, pathFilteredPrev, baseFiltered, services, periodStart, prevPeriodStart, spanDays]);

  function openDrill(kpiId) { setDrill({ kpiId, path: [] }); }
  function drillInto(row) {
    if (!currentLevel || currentLevel.key === "invoice") return;
    setDrill((d) => ({ ...d, path: [...d.path, { levelKey: currentLevel.key, rawValue: row.rawValue, label: row.label }] }));
  }
  function jumpTo(index) {
    if (index < 0) { setDrill(null); return; }
    setDrill((d) => ({ ...d, path: d.path.slice(0, index + 1) }));
  }

  return (
    <div className="fade-in">
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "7", l: "۷ روز اخیر" }, { v: "30", l: "۳۰ روز اخیر" }, { v: "90", l: "۹۰ روز اخیر" }].map((o) => (
            <button
              key={o.v}
              onClick={() => { setRange(o.v); setDrill(null); }}
              className="tap"
              style={{
                flex: 1, padding: "6px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700,
                background: range === o.v ? "var(--color-surface)" : "transparent",
                color: range === o.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {o.l}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <select value={branchFilter} onChange={(e) => { setBranchFilter(e.target.value); setDrill(null); }} style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: "var(--radius-md)" }}>
            <option value="all">همه شعبه‌ها</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={staffFilter} onChange={(e) => { setStaffFilter(e.target.value); setDrill(null); }} style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: "var(--radius-md)" }}>
            <option value="all">همه آرایشگرها</option>
            {stylists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {!drill && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {BI_KPIS.map((kpi) => {
            const value = kpi.compute(periodBookings, baseFiltered, periodStart.getTime());
            const prevValue = kpi.compute(prevPeriodBookings, baseFiltered, prevPeriodStart.getTime());
            const delta = prevValue > 0 ? ((value - prevValue) / prevValue) * 100 : null;
            const good = delta == null ? null : kpi.higherIsBetter ? delta >= 0 : delta <= 0;
            const kpiGrad =
              kpi.id === "totalRevenue" ? "var(--grad-brand)" :
              kpi.id === "returnRate60" ? "var(--grad-success)" :
              kpi.id === "newCustomers" ? "var(--grad-info)" :
              "var(--grad-warning)";
            return (
              <button key={kpi.id} onClick={() => openDrill(kpi.id)} className="tap card" style={{ padding: 14, textAlign: "right", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, color-mix(in oklch, ${kpiGrad === "var(--grad-brand)" ? "var(--color-accent-500)" : kpiGrad === "var(--grad-success)" ? "var(--color-success)" : kpiGrad === "var(--grad-info)" ? "var(--color-info)" : "var(--color-warning)"} 7%, transparent), transparent 60%)`, pointerEvents: "none" }} />
                <div className="flex items-center justify-between mb-2.5" style={{ position: "relative" }}>
                  <div style={{ width: 32, height: 32, borderRadius: "var(--radius-md)", background: kpiGrad, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-sm)" }}>
                    <kpi.Icon size={16} color="white" />
                  </div>
                  {delta != null && (
                    <span
                      className="tabular flex items-center gap-0.5"
                      style={{
                        fontSize: 10.5, fontWeight: 800, padding: "3px 7px", borderRadius: "var(--radius-full)",
                        color: good ? "var(--color-success)" : "var(--color-danger)",
                        background: good ? "color-mix(in oklch, var(--color-success) 14%, transparent)" : "color-mix(in oklch, var(--color-danger) 14%, transparent)",
                      }}
                    >
                      {good ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                      {delta >= 0 ? "+" : ""}{toFa(Math.round(delta))}٪
                    </span>
                  )}
                </div>
                <div className="tabular" style={{ fontSize: 19, fontWeight: 800, color: "var(--color-heading)", position: "relative", letterSpacing: "-0.01em" }}>{kpi.format(value)}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2, position: "relative" }}>{kpi.label}</div>
                <div className="muted tabular" style={{ fontSize: 10, marginTop: 4, position: "relative" }}>دورهٔ قبل: {kpi.format(prevValue)}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* ---- v2.12: Revenue trend (SVG line/area) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 8 }}>
            <TrendingUp size={16} color="var(--color-accent-700)" /> روند درآمد
          </p>
          {revenueTrend.every((d) => d.value === 0) ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <RevenueTrendChart points={revenueTrend} />
          )}
        </div>
      )}

      {!drill && <CampaignPerformanceCard />}
      {!drill && <FeedbackStatsCard />}
      {!drill && <CampaignReturnRateCard />}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>
            <Award size={13} color="var(--color-accent-700)" /> پرفروش‌ترین خدمات (تعداد نوبت)
          </p>
          {topByCount.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <div className="flex flex-col gap-2">
              {topByCount.map((row, idx) => (
                <div key={row.service.id} className="flex items-center gap-2">
                  <span style={{ fontSize: 16 }}>{["🥇", "🥈", "🥉"][idx]}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{row.service.name}</span>
                  <span className="tabular muted" style={{ fontSize: 11.5 }}>{toFa(row.count)} نوبت · {toFa(Math.round(row.pct))}٪</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-accent-700)" }}>
            <Banknote size={13} /> سهم خدمات از درآمد
          </p>
          {serviceShareSlices.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <ServiceShareDonut slices={serviceShareSlices} />
          )}
        </div>
      )}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-info) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)", marginBottom: 10 }}>
            <Users size={13} /> مشتریان جدید در برابر بازگشتی
          </p>
          {customerMix.newCount + customerMix.returningCount === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <>
              <div className="flex" style={{ height: 10, borderRadius: "var(--radius-full)", overflow: "hidden", background: "color-mix(in oklch, var(--color-info) 12%, transparent)" }}>
                <div style={{ width: `${(customerMix.newRevenue / customerMix.total) * 100}%`, background: "var(--color-info)" }} />
                <div style={{ width: `${(customerMix.returningRevenue / customerMix.total) * 100}%`, background: "var(--color-accent-500)" }} />
              </div>
              <div className="flex justify-between mt-2" style={{ flexWrap: "wrap", gap: 6 }}>
                <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
                  <UserPlus size={12} color="var(--color-info)" />
                  <span className="muted">جدید ({toFa(customerMix.newCount)}):</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(customerMix.newRevenue)}</span>
                </span>
                <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
                  <Repeat2 size={12} color="var(--color-accent-700)" />
                  <span className="muted">بازگشتی ({toFa(customerMix.returningCount)}):</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(customerMix.returningRevenue)}</span>
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- v2.12: weekday × hour heatmap (replaces the two separate
           peak-hours / weekday-distribution charts — same two dimensions,
           combined so an interaction like "Thursday evenings" is visible) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 12 }}>
            <Clock size={16} color="var(--color-accent-700)" /> نقشهٔ حرارتی نوبت‌ها (روز و ساعت)
          </p>
          {heatmapGrid.flat().every((v) => v === 0) ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبتی در این بازه ثبت نشده</p>
          ) : (
            <BookingHeatmap grid={heatmapGrid} hours={heatmapHours} dayLabels={SCHEMA_DAY_LABELS} />
          )}
        </div>
      )}

      {/* ---- Stylist performance table (sortable, conditional formatting) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 12 }}>
            <Award size={16} color="var(--color-accent-700)" /> عملکرد آرایشگران
          </p>
          {stylistPerf.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>آرایشگر فعالی یافت نشد</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tabular" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700 }}>آرایشگر</th>
                    {[
                      { key: "count", label: "نوبت" },
                      { key: "avgRevenue", label: "میانگین درآمد" },
                      { key: "returnRate", label: "نرخ بازگشت" },
                      { key: "score", label: "امتیاز" },
                    ].map((col) => (
                      <th
                        key={col.key}
                        onClick={() => togglePerfSort(col.key)}
                        className="tap"
                        style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                      >
                        <span className="flex items-center justify-center gap-0.5">
                          {col.label}
                          {perfSortKey === col.key && (perfSortDir === "desc" ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedStylistPerf.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "7px 8px", fontWeight: 700, color: "var(--color-heading)" }}>
                        <span className="flex items-center gap-1.5">{r.name} <GenderBadge gender={r.gender} /></span>
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.count >= stylistPerfAvg.count ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(r.count)}</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.avgRevenue >= stylistPerfAvg.avgRevenue ? "var(--color-success)" : "var(--color-danger)" }}>{formatToman(Math.round(r.avgRevenue))}</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.returnRate >= stylistPerfAvg.returnRate ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(Math.round(r.returnRate))}٪</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", fontWeight: 800, color: r.score >= stylistPerfAvg.score ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(Math.round(r.score))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 9.5, marginTop: 8, lineHeight: 1.6 }}>
                رنگ نسبت به میانگین همین لیست است. امتیاز = ترکیب وزنی تعداد نوبت (۴۰٪)، میانگین درآمد (۳۵٪)، نرخ بازگشت مشتری (۲۵٪).
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---- Pareto: top customers ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-accent-700)", marginBottom: 4 }}>
            <Percent size={16} /> مشتریان برتر (اصل پارتو)
          </p>
          {paretoData.topCustomers.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
                <b className="tabular" style={{ color: "var(--color-heading)" }}>{toFa(Math.round(paretoData.pctOfCustomers))}٪</b> از مشتریان،
                {" "}<b className="tabular" style={{ color: "var(--color-heading)" }}>{toFa(Math.round(paretoData.pctOfRevenue))}٪</b> از درآمد این بازه را ساخته‌اند
              </p>
              <div className="flex flex-col gap-2">
                {paretoData.topCustomers.slice(0, 8).map((c, i) => (
                  <div key={c.phone} className="flex items-center gap-2">
                    <span className="tabular" style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--color-accent-100)", color: "var(--color-accent-700)", fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {toFa(i + 1)}
                    </span>
                    <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.name || "بدون نام"}</span>
                    <span className="tabular muted" style={{ fontSize: 11.5 }}>{formatToman(c.revenue)} · {toFa(c.visits)} ویزیت</span>
                  </div>
                ))}
                {paretoData.topCustomers.length > 8 && (
                  <p className="muted" style={{ fontSize: 10.5 }}>و {toFa(paretoData.topCustomers.length - 8)} مشتری دیگر از این گروه</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Demand forecast: 7-day moving average + next-7-days capacity ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 4 }}>
            <TrendingUp size={16} color="var(--color-accent-700)" /> پیش‌بینی تقاضا
          </p>
          <p className="muted tabular" style={{ fontSize: 11.5, marginBottom: 10 }}>
            میانگین متحرک ۷ روز گذشته: {toFa(Math.round(demandForecast.movingAvg * 10) / 10)} نوبت در روز
          </p>
          <div className="flex flex-col gap-2">
            {demandForecast.days.map((d) => (
              <div key={d.dKey}>
                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>
                    {WEEKDAYS_FA_FULL[d.date.getDay()]} {toFa(jalaliDayNum(d.date))} {MONTHS_FA[gregorianToJalali(d.date.getFullYear(), d.date.getMonth() + 1, d.date.getDate()).jm - 1]}
                    {d.lowFill && <AlertTriangle size={12} color="var(--color-warning)" />}
                  </span>
                  <span className="tabular muted" style={{ fontSize: 11 }}>
                    {d.hasCapacity ? `${toFa(Math.round(d.fillRate * 100))}٪ پر شده` : "تعطیل / تایید نشده"}
                  </span>
                </div>
                {d.hasCapacity && (
                  <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "color-mix(in oklch, var(--color-warning) 14%, transparent)", overflow: "hidden" }}>
                    <div style={{ width: `${d.fillRate * 100}%`, height: "100%", background: d.lowFill ? "var(--color-warning)" : "var(--color-success)", borderRadius: "var(--radius-full)" }} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {demandForecast.days.some((d) => d.lowFill) && (
            <p className="flex items-center gap-1.5" style={{ fontSize: 11, marginTop: 10, color: "var(--color-warning)" }}>
              <AlertTriangle size={12} /> روزهای با کمتر از ۲۰٪ پرشدگی، فرصت از دست رفته‌اند — برای این روزها کمپین یا تخفیف در نظر بگیرید
            </p>
          )}
        </div>
      )}

      {drill && activeKpi && (
        <div className="fade-in">
          <div className="flex items-center gap-1 mb-3 flex-wrap" style={{ fontSize: 12 }}>
            <button className="tap" style={{ color: "var(--color-muted)" }} onClick={() => jumpTo(-1)}>کل ({activeKpi.label})</button>
            {drill.path.map((p, i) => (
              <React.Fragment key={i}>
                <ChevronLeft size={12} color="var(--color-muted)" />
                <button
                  className="tap"
                  onClick={() => jumpTo(i)}
                  style={{ color: i === drill.path.length - 1 ? "var(--color-heading)" : "var(--color-muted)", fontWeight: i === drill.path.length - 1 ? 700 : 400 }}
                >
                  {p.label}
                </button>
              </React.Fragment>
            ))}
            {currentLevel && (
              <>
                <ChevronLeft size={12} color="var(--color-muted)" />
                <span style={{ fontWeight: 700, color: "var(--color-accent-700)" }}>{currentLevel.label}</span>
              </>
            )}
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 420 }}>
                <thead>
                  <tr style={{ background: "var(--color-surface-raised)" }}>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700 }}>{currentLevel?.label || "—"}</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>مقدار</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>دورهٔ قبل</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>Δ٪</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>سهم٪</th>
                  </tr>
                </thead>
                <tbody>
                  {levelRows.map((row) => {
                    const delta = row.prevValue != null && row.prevValue > 0 ? ((row.value - row.prevValue) / row.prevValue) * 100 : null;
                    const good = delta == null ? null : activeKpi.higherIsBetter ? delta >= 0 : delta <= 0;
                    const clickable = currentLevel?.key !== "invoice";
                    return (
                      <tr
                        key={row.rawValue}
                        onClick={() => clickable && drillInto(row)}
                        style={{ borderTop: "1px solid var(--color-border)", cursor: clickable ? "pointer" : "default" }}
                      >
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: "var(--color-heading)", whiteSpace: "nowrap" }}>{row.label}</td>
                        <td className="tabular" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>{activeKpi.format(row.value)}</td>
                        <td className="tabular muted" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                          {row.prevValue != null ? activeKpi.format(row.prevValue) : "—"}
                        </td>
                        <td
                          className="tabular"
                          style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, whiteSpace: "nowrap", color: delta == null ? "var(--color-muted)" : good ? "var(--color-success)" : "var(--color-danger)" }}
                        >
                          {delta != null ? `${delta >= 0 ? "+" : ""}${toFa(Math.round(delta))}٪` : "—"}
                        </td>
                        <td className="tabular muted" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>{toFa(Math.round(row.share))}٪</td>
                      </tr>
                    );
                  })}
                  {levelRows.length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 16, textAlign: "center" }} className="muted">داده‌ای در این سطح نیست</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   NEW — پنل ارسال پیامک (owner/manager only)
   ------------------------------------------------------------
   One place to send real SMS: pick an audience, pick a template,
   preview it against a real recipient, send in bulk. Also hosts
   the win-back campaign (phase 3), because it's the same machinery:
   an audience + a template + a send, plus return tracking.

   Nothing here talks to the SMS provider directly — every send
   goes through the `send-sms` Edge Function, which is the only
   thing holding the کاوه‌نگار / ملی‌پیامک API key.
   ============================================================ */
const AUDIENCES = [
  { id: "today",    label: "نوبت‌های امروز",   Icon: CalendarCheck },
  { id: "tomorrow", label: "نوبت‌های فردا",    Icon: CalendarClock },
  { id: "week",     label: "۷ روز آینده",      Icon: CalendarIcon },
  { id: "all",      label: "همهٔ مشتری‌ها",     Icon: Users },
  { id: "manual",   label: "شمارهٔ دستی",      Icon: UserPlus },
];

/* ============================================================
   Loyalty club tab — the phase-4 piece the changelog flagged as
   "database complete, no UI". Points are already accruing live
   via a database trigger every time a booking completes; this
   tab is purely a read/write surface over that existing data.
   ============================================================ */
function loyaltyTierOf(points, settings) {
  const per = Math.max(1, settings?.points_per_tier || 100);
  const tier = Math.floor((points || 0) / per);
  const discount = Math.min(tier * (settings?.discount_per_tier || 0), settings?.max_discount || 0);
  const toNext = Math.max(per - ((points || 0) % per), 0);
  return { tier, discount, toNext };
}

function LoyaltyCustomerModal({ customer, settings, onClose, notify, onRedeemed }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState(false);
  useEffect(() => {
    (async () => {
      setLoading(true);
      setDetail(await fetchCustomerLoyalty(customer.phone));
      setLoading(false);
    })();
  }, [customer.phone]);

  const { tier, discount, toNext } = loyaltyTierOf(customer.loyalty_points, settings);

  async function handleRedeem() {
    setRedeeming(true);
    const res = await redeemLoyaltyReward(customer.phone);
    setRedeeming(false);
    if (!res.ok) { notify(res.error || "استفاده از جایزه ناموفق بود"); return; }
    notify(`تخفیف ${toFa(res.redeemed_discount_percent)}٪ استفاده شد — امتیاز مشتری صفر شد`);
    setDetail(await fetchCustomerLoyalty(customer.phone));
    onRedeemed?.();
  }

  return (
    <Modal title={customer.name || "مشتری"} onClose={onClose}>
      <Row label="شماره تماس" value={<span dir="ltr" className="tabular">{toFa(customer.phone)}</span>} />
      <Row label="امتیاز فعلی" value={<span className="tabular">{toFa(customer.loyalty_points || 0)}</span>} bold />
      <Row label="سطح فعلی" value={<span className="flex items-center gap-1"><Crown size={13} color="var(--color-accent-500)" /> {toFa(tier)}</span>} />
      <Row label="تخفیف پلکانی" value={`${toFa(discount)}٪`} />
      <Row label="تا سطح بعد" value={`${toFa(toNext)} امتیاز`} />
      <Row label="تعداد ویزیت" value={toFa(customer.total_visits || 0)} />
      <Row label="کد معرفی" value={<span dir="ltr" className="tabular">{customer.referral_code}</span>} />
      {customer.referred_by && <Row label="معرف" value={<span dir="ltr" className="tabular">{toFa(customer.referred_by)}</span>} />}

      {!loading && detail?.at_cap && (
        <div className="fade-in" style={{ marginTop: 10, padding: 12, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-success) 12%, transparent)" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-success)" }}>
            <Crown size={14} /> این مشتری به سقف تخفیف ({toFa(detail.max_discount)}٪) رسیده
          </p>
          <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8, lineHeight: 1.7 }}>
            وقتی این تخفیف واقعاً به مشتری داده شد، اینجا ثبتش کن — امتیازش صفر می‌شه و از نو شروع می‌کنه.
          </p>
          <button disabled={redeeming} className="tap accent-btn w-full" style={{ padding: 10, fontSize: 12.5 }} onClick={handleRedeem}>
            {redeeming ? "در حال ثبت..." : `ثبت استفاده از تخفیف ${toFa(detail.max_discount)}٪`}
          </button>
        </div>
      )}

      <div style={{ borderTop: "1px dashed var(--color-border)", margin: "12px 0" }} />
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>تاریخچهٔ امتیاز</p>
      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
      ) : !detail?.history?.length ? (
        <p className="muted" style={{ fontSize: 12 }}>هنوز تراکنشی ثبت نشده</p>
      ) : (
        <div className="flex flex-col gap-1.5" style={{ maxHeight: 220, overflowY: "auto" }}>
          {detail.history.map((h, i) => (
            <div key={i} className="flex items-center justify-between" style={{ fontSize: 12, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: "var(--color-surface-raised)" }}>
              <span className="muted">{h.reason || "—"}</span>
              <span className="tabular" style={{ fontWeight: 700, color: h.delta >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                {h.delta >= 0 ? "+" : ""}{toFa(h.delta)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function LoyaltyTab({ notify, currentStylist, onNavigateToSmsSegment }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);

  async function loadCustomers() {
    setLoading(true);
    setCustomers(await fetchCustomers());
    setLoading(false);
  }
  async function loadSettings() {
    const s = await fetchLoyaltySettings();
    setSettings(s);
    setForm(s ? { ...s } : null);
  }
  useEffect(() => { loadCustomers(); loadSettings(); }, []);

  async function saveSettings() {
    if (!form) return;
    setSavingSettings(true);
    await updateLoyaltySettings({
      points_per_visit: Number(form.points_per_visit) || 0,
      points_per_tier: Math.max(1, Number(form.points_per_tier) || 1),
      discount_per_tier: Number(form.discount_per_tier) || 0,
      max_discount: Number(form.max_discount) || 0,
      referral_points: Number(form.referral_points) || 0,
    });
    setSavingSettings(false);
    setSettings(form);
    notify("تنظیمات باشگاه مشتریان ذخیره شد");
  }

  const filtered = useMemo(() => {
    const q = search.trim();
    const list = !q ? customers : customers.filter((c) => (c.name || "").includes(q) || (c.phone || "").includes(q));
    return [...list].sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0));
  }, [customers, search]);

  if (!SUPABASE_ENABLED) {
    return (
      <div>
        <PanelSectionHeader Icon={Gift} title="باشگاه مشتریان" subtitle="امتیاز، تخفیف پلکانی، و برنامهٔ معرفی دوستان" color="var(--color-success)" />
        <div className="fade-in card" style={{ padding: 20, textAlign: "center" }}>
          <Gift size={22} color="var(--color-muted)" style={{ margin: "0 auto 8px" }} />
          <p className="muted" style={{ fontSize: 13 }}>باشگاه مشتریان به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PanelSectionHeader Icon={Gift} title="باشگاه مشتریان" subtitle="امتیاز، تخفیف پلکانی، و برنامهٔ معرفی دوستان" color="var(--color-success)" />
      {/* Program settings */}
      <div className="card mb-4" style={{ padding: 14 }}>
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", marginBottom: 10 }}>
          <Gift size={14} color="var(--color-accent-700)" /> تنظیمات باشگاه
        </p>
        {!form ? (
          <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
        ) : (
          <>
            <div className="flex gap-3">
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>امتیاز هر ویزیت</label>
                <input type="number" min={0} value={form.points_per_visit} onChange={(e) => setForm({ ...form, points_per_visit: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>امتیاز هر سطح</label>
                <input type="number" min={1} value={form.points_per_tier} onChange={(e) => setForm({ ...form, points_per_tier: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
            </div>
            <div className="flex gap-3 mt-2">
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>تخفیف هر سطح (٪)</label>
                <input type="number" min={0} value={form.discount_per_tier} onChange={(e) => setForm({ ...form, discount_per_tier: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>سقف تخفیف (٪)</label>
                <input type="number" min={0} value={form.max_discount} onChange={(e) => setForm({ ...form, max_discount: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
            </div>
            <div className="mt-2">
              <label className="muted" style={{ fontSize: 11 }}>امتیاز پاداش معرفی</label>
              <input type="number" min={0} value={form.referral_points} onChange={(e) => setForm({ ...form, referral_points: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
            </div>
            <button disabled={savingSettings} className="tap accent-btn w-full mt-3" style={{ padding: 10, fontSize: 13 }} onClick={saveSettings}>
              ذخیرهٔ تنظیمات
            </button>
            <p className="muted" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.7 }}>
              تخفیف پلکانی فقط اینجا محاسبه و نمایش داده می‌شود؛ هنوز به‌صورت خودکار روی قیمت نهایی نوبت اعمال نمی‌شود — اعمالش نیاز به یک تصمیم دارد (روی قیمت اصلی باشد یا بعد از تخفیف خدمت).
            </p>
          </>
        )}
      </div>

      {/* Segment threshold configuration — manager-only. Stylists can VIEW
          segmentation below (RfmSegmentsCard, opened to them earlier) but
          must not see or change the thresholds that produce it; the RLS on
          customer_segment_settings enforces this server-side regardless,
          this is just keeping the UI honest about who can act on it. */}
      {!currentStylist && <SegmentSettingsCard notify={notify} />}

      {/* Customer segmentation (RFM) — v2.15: reverted to manager-only.
          get_customer_rfm_segments() now enforces is_manager() again —
          this exposes the full customer bank's names/phones/spend, which
          is exactly what "customer bank access blocked for stylist" means. */}
      {!currentStylist && <RfmSegmentsCard onSendToSegment={onNavigateToSmsSegment} />}

      {/* Category-level segmentation matrix — v2.15: reverted to
          manager-only, same reasoning as RFM above. */}
      {!currentStylist && <CategoryMatrixCard notify={notify} />}

      {/* Customer list */}
      <div className="card" style={{ padding: 14 }}>
        <div className="flex items-center justify-between mb-3">
          <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
            <Star size={14} color="var(--color-accent-500)" /> مشتریان
          </p>
          <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={loadCustomers} disabled={loading}>
            <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
          </button>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی نام یا شماره..." style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }} />

        {filtered.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>{loading ? "در حال بارگذاری..." : "مشتری‌ای یافت نشد"}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((c) => {
              const { tier, discount } = loyaltyTierOf(c.loyalty_points, settings);
              return (
                <button
                  key={c.phone}
                  onClick={() => setSelected(c)}
                  className="tap flex items-center gap-2"
                  style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", textAlign: "right" }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-1.5">
                      <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{c.name || "بدون نام"}</span>
                      <GenderBadge gender={c.gender} />
                    </div>
                    <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 1 }} dir="ltr">{toFa(c.phone)}</div>
                  </div>
                  <span className="badge" style={{ background: "color-mix(in oklch, var(--color-accent-500) 16%, transparent)", color: "var(--color-accent-700)" }}>
                    <Crown size={11} /> {toFa(tier)} · {toFa(c.loyalty_points || 0)}
                  </span>
                  {discount > 0 && (
                    <span className="badge" style={{ background: "color-mix(in oklch, var(--color-success) 16%, transparent)", color: "var(--color-success)" }}>
                      {toFa(discount)}٪
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selected && settings && (
        <LoyaltyCustomerModal
          customer={selected}
          settings={settings}
          onClose={() => setSelected(null)}
          notify={notify}
          onRedeemed={loadCustomers}
        />
      )}
    </div>
  );
}

const SMS_SEGMENTS = [
  { id: "quick", label: "ارسال سریع", Icon: Zap, color: "var(--color-success)" },
  { id: "manual", label: "پیام دستی", Icon: MessageSquareText, color: "var(--color-tab-panel)" },
  { id: "log", label: "تاریخچه", Icon: History, color: "var(--color-info)" },
];

function SmsTab({ bookings, services, stylists, smsTemplates, notify, presetSegment, onConsumePresetSegment }) {
  const [segment, setSegment] = useState("quick");
  const [audience, setAudience] = useState("today");
  const [templateId, setTemplateId] = useState("");
  const [body, setBody] = useState("");
  const [manualNumbers, setManualNumbers] = useState("");
  const [showRecipients, setShowRecipients] = useState(false);
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [discount, setDiscount] = useState(15); // only used if the {{discount}} token is inserted
  const [allCustomers, setAllCustomers] = useState([]);

  // ---- v2.13: "بهترین عملکرد" suggester ----
  const [suggestingBest, setSuggestingBest] = useState(false);
  const [bestSuggestion, setBestSuggestion] = useState(null); // { template_label, conversion_rate } — last suggestion shown

  // ---- smart RFM campaign cards ----
  const [rfmSegments, setRfmSegments] = useState([]);
  const [rfmLoading, setRfmLoading] = useState(false);
  const [sendingSegment, setSendingSegment] = useState(null); // which segment is mid-send
  const [highlightSegment, setHighlightSegment] = useState(presetSegment || null);

  useEffect(() => {
    (async () => {
      setRfmLoading(true);
      setRfmSegments(await fetchRfmSegments());
      setRfmLoading(false);
    })();
  }, []);

  // Arrived here via the Loyalty tab's "ارسال پیامک به این دسته" button — jump
  // straight to Quick Send and highlight that card.
  useEffect(() => {
    if (!presetSegment) return;
    setSegment("quick");
    setHighlightSegment(presetSegment);
    onConsumePresetSegment?.();
  }, [presetSegment]);

  async function sendSmartCampaign(segmentKey) {
    const draft = RFM_SMART_DRAFTS[segmentKey];
    // champions_vip isn't a real `segment` value — it's the VIP-flagged
    // subset of "champions" (see get_customer_rfm_segments()'s is_vip
    // column) — so it needs its own filter instead of matching segmentKey
    // against c.segment directly.
    const members = segmentKey === "champions_vip"
      ? rfmSegments.filter((c) => c.segment === "champions" && c.is_vip && !c.sms_opt_out && /^09\d{9}$/.test(c.phone || ""))
      : rfmSegments.filter((c) => c.segment === segmentKey && !c.sms_opt_out && /^09\d{9}$/.test(c.phone || ""));
    if (!members.length) { notify("مشتری‌ای در این دسته برای ارسال یافت نشد"); return; }

    setSendingSegment(segmentKey);
    const campaignId = "cmp-" + Date.now().toString(36);
    await createCampaign({
      id: campaignId,
      name: `کمپین هوشمند — ${RFM_SEGMENT_META[segmentKey]?.label || segmentKey}`,
      inactive_days: null,
      discount_percent: null,
      template_id: null,
      valid_until: null,
      targeted_count: members.length,
    });
    await addCampaignTargets(campaignId, members.map((c) => c.phone));

    // v2.13: template_id here is a synthetic key (the segment itself), not
    // a real sms_templates row — smart-campaign drafts are hardcoded text,
    // not stored templates. template_label makes the segment name readable
    // in the performance breakdown regardless.
    const campaignLog = await logCampaignSend({
      templateId: segmentKey,
      templateLabel: RFM_SEGMENT_META[segmentKey]?.label || segmentKey,
      segment: segmentKey,
      totalSent: members.length,
    });

    const messages = members.map((c) => ({
      to: c.phone,
      body: renderTemplate(draft, { name: c.name || "مشتری", days: toFa(c.recency_days ?? "") }),
      kind: "campaign",
      campaign_id: campaignId,
      campaign_log_id: campaignLog?.id ?? null,
    }));
    const res = await sendBulkSms(messages);
    setSendingSegment(null);

    if (campaignLog?.id && typeof res?.sent === "number") {
      await updateCampaignLogResult(campaignLog.id, res.sent);
    }

    if (res?.demo) notify("حالت دمو — پیامک واقعی ارسال نشد");
    else if (res?.ok) notify(`${toFa(res.sent)} پیامک ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`);
    else notify(res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
    refreshLog();
  }

  const bodyRef = useRef(null);

  const templates = smsTemplates && smsTemplates.length
    ? smsTemplates
    : Object.entries(FALLBACK_SMS_TEMPLATES).map(([kind, b]) => ({
        id: `fallback-${kind}`, kind, title: SMS_KIND_LABEL[kind], body: b, is_default: true,
      }));

  // Pick a sensible default template the first time.
  useEffect(() => {
    if (templateId || !templates.length) return;
    const preferred = templates.find((t) => t.kind === "custom") || templates[0];
    setTemplateId(preferred.id);
    setBody(preferred.body || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  async function refreshLog() {
    setLogLoading(true);
    setLog(await fetchSmsLog(40));
    setLogLoading(false);
  }
  useEffect(() => { refreshLog(); }, []);

  useEffect(() => {
    if (audience !== "all") return;
    (async () => setAllCustomers(await fetchCustomers()))();
  }, [audience]);

  /* -------------------------------------------------- recipient resolution */
  const recipients = useMemo(() => {
    const svcName = (id) => (services.find((s) => s.id === id) || {}).name || "خدمت";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayOffset = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return dateKey(d); };

    const fromBookings = (predicate) => {
      const seen = new Set();
      return bookings
        .filter((b) => ["pending", "confirmed", "rescheduled"].includes(b.status))
        .filter(predicate)
        .filter((b) => /^09\d{9}$/.test(b.customer_phone || ""))
        .filter((b) => (seen.has(b.customer_phone) ? false : seen.add(b.customer_phone)))
        .map((b) => ({
          phone: b.customer_phone,
          vars: {
            name: b.customer_name || "مشتری",
            service: svcName(b.service_id),
            date: jalaliLabel(parseDateKey(b.date), { withWeekday: false }),
            time: formatClock(b.start_min),
            stylist: b.staff_name || "بدون آرایشگر مشخص",
            code: b.tracking_code || "",
            discount: String(discount),
          },
        }));
    };

    if (audience === "today")    return fromBookings((b) => b.date === dayOffset(0));
    if (audience === "tomorrow") return fromBookings((b) => b.date === dayOffset(1));
    if (audience === "week") {
      const window = new Set(Array.from({ length: 7 }, (_, i) => dayOffset(i)));
      return fromBookings((b) => window.has(b.date));
    }

    if (audience === "all") {
      if (allCustomers.length) {
        return allCustomers
          .filter((c) => !c.sms_opt_out && /^09\d{9}$/.test(c.phone))
          .map((c) => ({
            phone: c.phone,
            vars: { name: c.name || "مشتری", points: String(c.loyalty_points ?? 0), discount: String(discount), service: "", date: "", time: "", stylist: "", code: "" },
          }));
      }
      // Offline fallback: derive the customer list from the bookings we hold.
      const seen = new Map();
      for (const b of bookings) {
        if (/^09\d{9}$/.test(b.customer_phone || "") && !seen.has(b.customer_phone)) {
          seen.set(b.customer_phone, { name: b.customer_name || "مشتری" });
        }
      }
      return [...seen.entries()].map(([phone, v]) => ({
        phone, vars: { ...v, discount: String(discount), points: "0", service: "", date: "", time: "", stylist: "", code: "" },
      }));
    }

    // manual
    return [...new Set(
      manualNumbers.split(/[\s,،;\n]+/).map((x) => x.trim()).filter((x) => /^09\d{9}$/.test(x))
    )].map((phone) => ({
      phone,
      vars: { name: "مشتری", discount: String(discount), points: "0", service: "", date: "", time: "", stylist: "", code: "" },
    }));
  }, [audience, bookings, services, manualNumbers, allCustomers, discount]);

  const preview = recipients.length ? renderTemplate(body, recipients[0].vars) : renderTemplate(body, {});
  const parts = smsParts(preview);
  const totalParts = parts * recipients.length;
  const usesDiscountToken = body.includes("{{discount}}");

  function insertToken(token) {
    const el = bodyRef.current;
    if (!el) { setBody((b) => b + token); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  /* --------------------------------------------------------------- sending */
  // v2.13: suggest the best-performing template by conversion rate, and
  // select it if it's a real (non-smart-campaign) template — smart-campaign
  // drafts use a synthetic template_id (the segment key), so those can be
  // shown as the suggestion but can't be auto-loaded into this dropdown.
  async function suggestBestTemplate() {
    setSuggestingBest(true);
    const rows = await fetchCampaignPerformance();
    setSuggestingBest(false);
    const withSends = (rows || []).filter((r) => r.total_sent > 0);
    if (!withSends.length) { notify("هنوز سابقهٔ ارسالی برای مقایسه وجود ندارد"); return; }
    const best = withSends[0]; // RPC already orders by conversion_rate desc
    setBestSuggestion(best);
    const matchingTemplate = templates.find((t) => t.id === best.template_id);
    if (matchingTemplate) {
      setTemplateId(matchingTemplate.id);
      setBody(matchingTemplate.body || "");
    }
    notify(`بهترین عملکرد: «${best.template_label}» با ${toFa(best.conversion_rate)}٪ نرخ تبدیل`);
  }

  async function handleSend() {
    if (!recipients.length) { notify("مخاطبی برای ارسال پیدا نشد"); return; }
    if (!body.trim()) { notify("متن پیام خالی است"); return; }

    setSending(true);
    const selectedTemplate = templates.find((t) => t.id === templateId);
    const campaignLog = await logCampaignSend({
      templateId: selectedTemplate?.id ?? null,
      templateLabel: selectedTemplate?.title || SMS_KIND_LABEL[selectedTemplate?.kind] || "پیام دستی",
      segment: null, // manual composer isn't segment-scoped
      totalSent: recipients.length,
    });

    const messages = recipients.map((r) => ({
      to: r.phone,
      body: renderTemplate(body, r.vars),
      kind: "custom",
      campaign_id: null,
      campaign_log_id: campaignLog?.id ?? null,
    }));

    const res = await sendBulkSms(messages);
    setSending(false);

    if (campaignLog?.id && typeof res?.sent === "number") {
      await updateCampaignLogResult(campaignLog.id, res.sent);
    }

    if (res?.demo) {
      notify("حالت دمو — پیامک واقعی ارسال نشد");
    } else if (res?.ok) {
      notify(`${toFa(res.sent)} پیامک ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`);
    } else {
      notify(res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
    }
    refreshLog();
  }

  /* ----------------------------------------------------------------- render */
  return (
    <div className="fade-in flex flex-col gap-3">
      <PanelSectionHeader Icon={MessageSquareText} title="پیامک" subtitle="کمپین‌های هوشمند، ارسال دستی، و تاریخچهٔ پیامک‌ها" color="var(--color-tab-panel)" />

      {/* Segment switcher — three clear, organized sections instead of one long scroll */}
      <div className="flex gap-2">
        {SMS_SEGMENTS.map((seg) => {
          const active = segment === seg.id;
          return (
            <button
              key={seg.id}
              onClick={() => setSegment(seg.id)}
              className="tap flex-1 flex flex-col items-center gap-1"
              style={{
                padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: active ? 800 : 700,
                background: active ? seg.color : `color-mix(in oklch, ${seg.color} 11%, var(--color-surface))`,
                color: active ? "white" : seg.color,
                border: active ? "none" : `1px solid color-mix(in oklch, ${seg.color} 22%, transparent)`,
                boxShadow: active ? `0 3px 10px -3px color-mix(in oklch, ${seg.color} 55%, transparent)` : "none",
              }}
            >
              <seg.Icon size={16} />
              {seg.label}
            </button>
          );
        })}
      </div>

      {/* ================= Quick Send: one-click RFM campaigns ================= */}
      {segment === "quick" && (
        <div className="card fade-in" style={{ padding: 14 }}>
          <div className="flex items-center justify-between mb-3">
            <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
              <Zap size={14} color="var(--color-success)" /> کمپین‌های آمادهٔ ارسال
            </p>
            <button className="tap ghost-btn" style={{ width: 26, height: 26, padding: 0 }} onClick={async () => { setRfmLoading(true); setRfmSegments(await fetchRfmSegments()); setRfmLoading(false); }} disabled={rfmLoading}>
              <RefreshCw size={12} style={{ margin: "auto", animation: rfmLoading ? "salonSpin 1s linear infinite" : "none" }} />
            </button>
          </div>
          {!SUPABASE_ENABLED ? (
            <p className="muted" style={{ fontSize: 11.5 }}>کمپین‌های هوشمند به دیتابیس Supabase نیاز دارند.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {Object.keys(RFM_SMART_DRAFTS).map((key) => {
                const meta = RFM_SEGMENT_META[key];
                const count = key === "champions_vip"
                  ? rfmSegments.filter((c) => c.segment === "champions" && c.is_vip).length
                  : rfmSegments.filter((c) => c.segment === key).length;
                const isHighlighted = highlightSegment === key;
                const isSendingThis = sendingSegment === key;
                return (
                  <div
                    key={key}
                    style={{
                      padding: 12, borderRadius: "var(--radius-md)",
                      background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))`,
                      border: isHighlighted ? `2px solid ${meta.color}` : "2px solid transparent",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                        <span style={{ fontSize: 16 }}>{meta.emoji}</span> {meta.label}
                      </span>
                      <span className="muted tabular" style={{ fontSize: 11 }}>{toFa(count)} نفر</span>
                    </div>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.8 }}>
                      {RFM_SMART_DRAFTS[key].replace(/\{\{name\}\}/g, "مریم").replace(/\{\{days\}\}/g, "۴۵")}
                    </p>
                    <button
                      disabled={count === 0 || sendingSegment != null}
                      className="tap accent-btn w-full mt-2 flex items-center justify-center gap-1.5"
                      style={{ padding: 8, fontSize: 12 }}
                      onClick={() => sendSmartCampaign(key)}
                    >
                      {isSendingThis ? <Loader2 size={13} style={{ animation: "salonSpin 1s linear infinite" }} /> : <Send size={13} />}
                      تایید و ارسال سریع
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ================= Manual: audience + template + body + preview + send ================= */}
      {segment === "manual" && (
        <div className="flex flex-col gap-3 fade-in">
          <div className="card" style={{ padding: 14 }}>
            <p className="muted flex items-center gap-1 mb-3" style={{ fontSize: 12 }}>
              <Users size={13} /> مخاطبان
            </p>
            <div className="flex gap-1" style={{ flexWrap: "wrap" }}>
              {AUDIENCES.map((a) => {
                const on = audience === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setAudience(a.id)}
                    className="tap flex items-center gap-1"
                    style={{
                      padding: "7px 10px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: 700,
                      border: `1px solid ${on ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: on ? "var(--color-accent-100)" : "var(--color-surface)",
                      color: on ? "var(--color-accent-700)" : "var(--color-body)",
                    }}
                  >
                    <a.Icon size={12} /> {a.label}
                  </button>
                );
              })}
            </div>

            {audience === "manual" && (
              <textarea
                dir="ltr"
                value={manualNumbers}
                onChange={(e) => setManualNumbers(e.target.value)}
                placeholder="09121234567, 09351112233"
                className="tabular fade-in"
                style={{ width: "100%", padding: 11, fontSize: 13, marginTop: 12, minHeight: 74, resize: "vertical" }}
              />
            )}

            <div className="flex items-center justify-between" style={{ marginTop: 12 }}>
              <p style={{ fontSize: 12.5, fontWeight: 700 }}>
                <span className="tabular" style={{ color: recipients.length ? "var(--color-accent-700)" : "var(--color-muted)" }}>
                  {toFa(recipients.length)}
                </span>{" "}
                گیرنده
              </p>
              {recipients.length > 0 && (
                <button className="muted" style={{ fontSize: 11.5 }} onClick={() => setShowRecipients((v) => !v)}>
                  {showRecipients ? "بستن لیست" : "نمایش لیست"}
                </button>
              )}
            </div>

            {showRecipients && (
              <div className="fade-in surface-raised" style={{ marginTop: 8, borderRadius: "var(--radius-md)", padding: 10, maxHeight: 150, overflowY: "auto" }}>
                {recipients.map((r) => (
                  <div key={r.phone} className="flex items-center justify-between" style={{ padding: "3px 0", fontSize: 11.5 }}>
                    <span>{r.vars.name}</span>
                    <span className="tabular muted" dir="ltr">{toFa(r.phone)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="flex items-center justify-between mb-3">
              <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
                <MessageSquareText size={13} /> قالب پیام
              </p>
              {SUPABASE_ENABLED && (
                <button
                  onClick={suggestBestTemplate}
                  disabled={suggestingBest}
                  className="tap flex items-center gap-1"
                  style={{ padding: "5px 9px", borderRadius: "var(--radius-full)", fontSize: 11, fontWeight: 700, background: "color-mix(in oklch, var(--color-success) 14%, transparent)", color: "var(--color-success)" }}
                >
                  <TrendingUp size={11} /> {suggestingBest ? "در حال بررسی..." : "بهترین عملکرد"}
                </button>
              )}
            </div>
            {bestSuggestion && (
              <p className="muted fade-in" style={{ fontSize: 11, marginBottom: 8 }}>
                «{bestSuggestion.template_label}» با <b className="tabular" style={{ color: "var(--color-success)" }}>{toFa(bestSuggestion.conversion_rate)}٪</b> نرخ تبدیل بهترین سابقه را دارد
              </p>
            )}

            <select
              value={templateId}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value);
                setTemplateId(e.target.value);
                if (t) setBody(t.body || "");
              }}
              style={{ width: "100%", padding: "10px 12px", fontSize: 13 }}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title || SMS_KIND_LABEL[t.kind] || t.kind}
                </option>
              ))}
            </select>

            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="متن پیامک…"
              style={{ width: "100%", padding: 11, fontSize: 13, marginTop: 10, minHeight: 110, resize: "vertical", lineHeight: 1.7 }}
            />

            <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap" }}>
              {SMS_PLACEHOLDERS.map((ph) => (
                <button
                  key={ph.token}
                  onClick={() => insertToken(ph.token)}
                  className="tap"
                  title={ph.label}
                  style={{
                    padding: "4px 8px", borderRadius: "var(--radius-full)", fontSize: 10.5, fontWeight: 700,
                    border: "1px solid var(--color-border)", background: "var(--color-surface-raised)",
                    color: "var(--color-muted)", minHeight: 0,
                  }}
                >
                  {ph.label}
                </button>
              ))}
            </div>

            {usesDiscountToken && (
              <div className="fade-in flex items-center justify-between" style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                <label className="muted" style={{ fontSize: 11.5 }}>درصد تخفیفی که {"{{discount}}"} در پیام نشان می‌دهد</label>
                <div className="flex items-center gap-1">
                  <input
                    type="number" min="0" max="100" value={discount}
                    onChange={(e) => setDiscount(Number(e.target.value))}
                    className="tabular" style={{ width: 52, padding: "5px 6px", fontSize: 12, textAlign: "center" }}
                  />
                  <span className="muted" style={{ fontSize: 11 }}>٪</span>
                </div>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="flex items-center justify-between mb-2">
              <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
                <Eye size={13} /> پیش‌نمایش
              </p>
              <span className="badge tabular" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>
                {toFa(parts)} پیامک × {toFa(recipients.length)} = {toFa(totalParts)}
              </span>
            </div>

            <div
              className="surface-raised"
              style={{
                borderRadius: "var(--radius-md)", padding: 12, fontSize: 12.5, lineHeight: 1.85,
                whiteSpace: "pre-wrap", minHeight: 60, color: "var(--color-body)",
              }}
            >
              {preview || <span className="muted">متنی وارد نشده</span>}
            </div>

            <button
              onClick={handleSend}
              disabled={sending || !recipients.length || !body.trim()}
              className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
              style={{ padding: 13, fontSize: 13.5 }}
            >
              {sending ? <Loader2 size={15} className="salon-spin" /> : <Send size={15} />}
              ارسال دسته‌جمعی به {toFa(recipients.length)} نفر
            </button>

            {!SUPABASE_ENABLED && (
              <p className="muted flex items-center gap-1 mt-3" style={{ fontSize: 11 }}>
                <AlertTriangle size={12} /> دیتابیس متصل نیست — ارسال واقعی انجام نمی‌شود
              </p>
            )}
          </div>
        </div>
      )}

      {/* ================= Log ================= */}
      {segment === "log" && (
        <div className="card fade-in" style={{ padding: 14 }}>
          <div className="flex items-center justify-between mb-3">
            <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
              <History size={13} /> تاریخچهٔ ارسال
            </p>
            <button className="muted" style={{ fontSize: 11.5 }} onClick={refreshLog} disabled={logLoading}>
              {logLoading ? "…" : "به‌روزرسانی"}
            </button>
          </div>

          {!log.length ? (
            <p className="muted" style={{ fontSize: 12, textAlign: "center", padding: "14px 0" }}>
              هنوز پیامکی ارسال نشده
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {log.map((m) => {
                const meta = SMS_STATUS_META[m.status] || SMS_STATUS_META.queued;
                return (
                  <div key={m.id} style={{ borderBottom: "1px dashed var(--color-border)", paddingBottom: 7 }}>
                    <div className="flex items-center justify-between">
                      <span className="tabular" dir="ltr" style={{ fontSize: 12, fontWeight: 700 }}>{toFa(m.to_phone)}</span>
                      <span className="badge" style={{ background: meta.color, color: "white" }}>{meta.label}</span>
                    </div>
                    <p className="muted" style={{ fontSize: 11, marginTop: 3, whiteSpace: "pre-wrap" }}>
                      {String(m.body || "").slice(0, 90)}{String(m.body || "").length > 90 ? "…" : ""}
                    </p>
                    <div className="flex items-center gap-1 muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                      <span>{SMS_KIND_LABEL[m.kind] || m.kind}</span>
                      {m.scheduled_for && m.status === "queued" && (
                        <span>· زمان ارسال: {jalaliLabel(new Date(m.scheduled_for), { short: true })} {formatClock(new Date(m.scheduled_for).getHours() * 60 + new Date(m.scheduled_for).getMinutes())}</span>
                      )}
                      {m.error && <span style={{ color: "var(--color-danger)" }}>· {m.error}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

