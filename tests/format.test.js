// tests/format.test.js
//
// Unlike logic.test.js (which mirrors algorithms by hand), these import the
// app's real helpers from src/lib/format.js.

import { describe, it, expect } from "vitest";
import {
  toFa, digitsOnly, normalizeMobile, gregorianToJalali, jalaliLabel,
  formatClock, hhmmToMin, formatToman, dateKey, parseDateKey, isRevenueEligible,
} from "../src/lib/format.js";

describe("phone input normalization", () => {
  it("accepts Persian digits typed on a Persian keyboard", () => {
    expect(normalizeMobile("۰۹۱۲۱۲۳۴۵۶۷")).toBe("09121234567");
  });
  it("accepts Arabic-Indic digits", () => {
    expect(normalizeMobile("٠٩١٢١٢٣٤٥٦٧")).toBe("09121234567");
  });
  it("strips spaces, dashes and other non-digits", () => {
    expect(normalizeMobile("0912 123-4567")).toBe("09121234567");
  });
  it("converts +98 and 0098 prefixes (pasted numbers)", () => {
    expect(normalizeMobile("+98 912 123 4567")).toBe("09121234567");
    expect(normalizeMobile("00989121234567")).toBe("09121234567");
  });
  it("adds the leading 0 to a 10-digit 9xxxxxxxxx number", () => {
    expect(normalizeMobile("9121234567")).toBe("09121234567");
  });
  it("doesn't mangle a number while it is still being typed", () => {
    expect(normalizeMobile("0")).toBe("0");
    expect(normalizeMobile("009")).toBe("009");
    expect(normalizeMobile("98")).toBe("98");
    expect(normalizeMobile("0912")).toBe("0912");
  });
  it("caps at 11 digits", () => {
    expect(normalizeMobile("091212345678999")).toBe("09121234567");
  });
  it("digitsOnly keeps max length (OTP codes)", () => {
    expect(digitsOnly("۱۲۳۴۵۶۷", 6)).toBe("123456");
    expect(digitsOnly("a1b2")).toBe("12");
  });
});

describe("Persian formatting", () => {
  it("toFa converts ASCII digits", () => {
    expect(toFa("09:30")).toBe("۰۹:۳۰");
  });
  it("formatClock pads hours and minutes", () => {
    expect(formatClock(9 * 60 + 5)).toBe("۰۹:۰۵");
  });
  it("hhmmToMin parses HH:MM", () => {
    expect(hhmmToMin("14:45")).toBe(885);
  });
  it("formatToman groups thousands", () => {
    expect(formatToman(1250000)).toBe("۱,۲۵۰,۰۰۰ تومان");
  });
});

describe("Jalali calendar", () => {
  it("Nowruz 1405 is 21 March 2026", () => {
    expect(gregorianToJalali(2026, 3, 21)).toEqual({ jy: 1405, jm: 1, jd: 1 });
  });
  it("2 October 2026 is Friday 10 Mehr 1405", () => {
    expect(jalaliLabel(new Date(2026, 9, 2))).toBe("جمعه ۱۰ مهر ۱۴۰۵");
    expect(jalaliLabel(new Date(2026, 9, 2), { short: true })).toBe("۱۰ مهر");
  });
});

describe("date keys", () => {
  it("round-trips through parseDateKey", () => {
    const d = new Date(2026, 0, 5);
    expect(dateKey(d)).toBe("2026-1-5");
    expect(parseDateKey(dateKey(d)).getTime()).toBe(d.getTime());
  });
});

describe("revenue eligibility", () => {
  it("only completed bookings count", () => {
    expect(isRevenueEligible("completed")).toBe(true);
    expect(isRevenueEligible("confirmed")).toBe(false);
    expect(isRevenueEligible("pending_verification")).toBe(false);
  });
});
