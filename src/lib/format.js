// ============================================================================
//  Pure formatting / date / phone helpers shared across the app (and tested
//  directly in tests/format.test.js). No React, no Supabase.
// ============================================================================

/* ============================================================
   Jalali (Persian) calendar conversion — pure math, no deps
   ============================================================ */
export function gregorianToJalali(gy, gm, gd) {
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
export function jalaliDayNum(date) {
  return gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate()).jd;
}

export const MONTHS_FA = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
export const WEEKDAYS_FA_SHORT = ["ی", "د", "س", "چ", "پ", "ج", "ش"]; // JS getDay index 0..6 (Sun..Sat)
export const WEEKDAYS_FA_FULL = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
export const SCHEMA_DAY_LABELS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"]; // day_of_week 0..6, 0=Saturday

export const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
export function toFa(input) {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
}
// Persian (۰-۹) and Arabic-Indic (٠-٩) keyboards type digits that /\D/ treats
// as non-digits — without this, a customer typing their number on a Persian
// keyboard sees nothing appear in the field. Converts them to ASCII first,
// then keeps digits only.
export function digitsOnly(input, maxLen) {
  const ascii = String(input)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "");
  return maxLen ? ascii.slice(0, maxLen) : ascii;
}
// Normalizes the common ways people write a mobile number (+98…, 0098…,
// 9xxxxxxxxx) to the 09xxxxxxxxx form the rest of the app validates against.
export function normalizeMobile(input) {
  let d = digitsOnly(input);
  if (d.startsWith("0098") && d.length >= 13) d = "0" + d.slice(4);
  else if (d.startsWith("98") && d.length >= 12) d = "0" + d.slice(2);
  else if (d.startsWith("9") && d.length === 10) d = "0" + d;
  return d.slice(0, 11);
}
export function formatToman(n) {
  return toFa(Math.round(n).toLocaleString("en-US")) + " تومان";
}
export function jalaliLabel(date, { withWeekday = true, short = false } = {}) {
  const { jy, jm, jd } = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const day = toFa(jd);
  const month = MONTHS_FA[jm - 1];
  if (short) return `${day} ${month}`;
  const wd = WEEKDAYS_FA_FULL[date.getDay()];
  return withWeekday ? `${wd} ${day} ${month} ${toFa(jy)}` : `${day} ${month} ${toFa(jy)}`;
}
export function formatClock(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return toFa(String(h).padStart(2, "0")) + ":" + toFa(String(m).padStart(2, "0"));
}
export function hhmmToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
// v2.25 — the ONE rule for whether a booking counts toward revenue/income/
// commission anywhere in this app. completed is the only eligible status:
// pending_verification and archived_unconfirmed are unverified income and
// must never be counted, no matter how "not cancelled" they look.
export function isRevenueEligible(status) {
  return status === "completed";
}

export function dateKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
export function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function bookingTimestamp(b) {
  return parseDateKey(b.date).getTime() + b.start_min * 60000;
}
