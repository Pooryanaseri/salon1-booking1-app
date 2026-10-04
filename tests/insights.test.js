// tests/insights.test.js — v2.43 BI action center rules.
import { describe, it, expect } from "vitest";
import { buildBIInsights, fillDayDraft, isSuppressed, responseRate, rankFillDayAudience, smsPartCount, DEFAULT_RESPONSE } from "../src/panel/biInsights.js";

const zeroKpi = { revenue: 0, noShowRate: 0, returnRate60: 1, newCustomers: 0 };
const ON = { attendance_confirmation: true, reminder_hours_before: 3, deposit_percent: 10, waitlist_auto_offer: true };
const bk = (status, extra = {}) => ({ status, service_id: "s1", final_price: status === "completed" ? 100000 : null, ...extra });

function base(over = {}) {
  return {
    spanDays: 30, cur: { ...zeroKpi }, prev: { ...zeroKpi },
    periodBookings: [], prevPeriodBookings: [], services: [{ id: "s1", price: 200000, duration_minutes: 60 }],
    heatmapGrid: null, heatmapHours: [], pareto: null, nextDays: [], serviceShare: [], stylistPerf: [],
    automation: ON, segmentCounts: {}, campaignStats: {}, recentActions: {},
    ...over,
  };
}
const all = (r) => [...r.actions, ...r.notes];
const find = (r, id) => all(r).find((f) => f.id === id);

describe("buildBIInsights v2", () => {
  it("says nothing without enough data", () => {
    const r = buildBIInsights(base());
    expect(r.actions).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.totalImpact).toBe(0);
  });

  it("no-shows: first missing measure, monthly impact with its basis, urgent", () => {
    const periodBookings = [...Array(8)].map(() => bk("completed")).concat([bk("no_show"), bk("no_show")]);
    const c = base({ periodBookings, cur: { ...zeroKpi, noShowRate: 0.2, revenue: 800000 } });

    let f = find(buildBIInsights({ ...c, automation: { ...ON, attendance_confirmation: false } }), "no-show");
    expect(f.action).toMatchObject({ kind: "automation", patch: { attendance_confirmation: true } });
    expect(f.priority).toBe("urgent");
    // 2 × 200,000 lost in 30 days × 35% expected reduction
    expect(f.impact.amount).toBeCloseTo(400000 * 0.35);
    expect(f.impact.basis).toContain("تایید حضور");
    expect(f.evidence.find((e) => e.label === "درآمد از دست‌رفته").value).toContain("۴۰۰,۰۰۰");

    f = find(buildBIInsights({ ...c, automation: { ...ON, reminder_hours_before: 0 } }), "no-show");
    expect(f.action).toMatchObject({ kind: "reminder", hours: 3 });

    f = find(buildBIInsights({ ...c, automation: { ...ON, deposit_percent: 0 } }), "no-show");
    expect(f.action).toMatchObject({ kind: "goto", tab: "schedule" });

    f = find(buildBIInsights(c), "no-show");
    expect(f.action).toBeUndefined();
    expect(f.impact).toBeUndefined();
  });

  it("at-risk impact uses the salon's own response rate once it has history", () => {
    const periodBookings = [...Array(10)].map(() => bk("completed"));
    const withDefault = find(buildBIInsights(base({ periodBookings, segmentCounts: { at_risk: 10 } })), "at-risk");
    expect(withDefault.impact.amount).toBeCloseTo(10 * DEFAULT_RESPONSE.at_risk * 100000);
    expect(withDefault.action).toMatchObject({ kind: "campaign", audience: "segment", segment: "at_risk" });

    const withHistory = find(buildBIInsights(base({ periodBookings, segmentCounts: { at_risk: 10 }, campaignStats: { at_risk: { sent: 40, conversions: 10 } } })), "at-risk");
    expect(withHistory.impact.amount).toBeCloseTo(10 * 0.25 * 100000);
    expect(withHistory.evidence.some((e) => e.label.includes("کمپین‌های قبلی"))).toBe(true);
  });

  it("revenue change is a note that names its driver", () => {
    const prevPeriodBookings = [...Array(10)].map(() => bk("completed"));
    const periodBookings = [...Array(6)].map(() => bk("completed"));
    const r = buildBIInsights(base({ periodBookings, prevPeriodBookings, cur: { ...zeroKpi, revenue: 600000 }, prev: { ...zeroKpi, revenue: 1000000 } }));
    const f = r.notes.find((n) => n.id === "revenue-down");
    expect(f.diagnosis).toContain("کاهش تعداد نوبت‌ها");
    expect(f.action).toBeUndefined();
  });

  it("empty day ahead (not today): fill campaign capped by the empty slots", () => {
    const nextDays = [
      { dKey: "2026-10-3", label: "امروز", fillRate: 0.05, hasCapacity: true, totalCapacity: 600, totalBooked: 30, date: new Date(2026, 9, 3) },
      { dKey: "2026-10-4", label: "یکشنبه", fillRate: 0.1, hasCapacity: true, totalCapacity: 240, totalBooked: 24, date: new Date(2026, 9, 4) },
      { dKey: "2026-10-5", label: "دوشنبه", fillRate: 0.95, hasCapacity: true, totalCapacity: 600, totalBooked: 570, date: new Date(2026, 9, 5) },
    ];
    const r = buildBIInsights(base({ nextDays }));
    const f = find(r, "empty-2026-10-4");
    expect(f.action).toMatchObject({ kind: "campaign", audience: "lapsed", dKey: "2026-10-4", weekday: 1 });
    // 216 free minutes / 60 = 3 slots; 100 × 6% = 6 → capped at 3
    expect(f.impact.amount).toBe(3 * 200000);
    expect(find(r, "waitlist")).toBeUndefined();
    expect(find(buildBIInsights(base({ nextDays, automation: { ...ON, waitlist_auto_offer: false } })), "waitlist").action.patch).toEqual({ waitlist_auto_offer: true });
  });

  it("orders by priority then impact, caps the list and sums the impact", () => {
    const periodBookings = [...Array(10)].map(() => bk("completed"));
    const r = buildBIInsights(base({ periodBookings, cur: { ...zeroKpi, revenue: 1000000, returnRate60: 0.1 }, segmentCounts: { at_risk: 20, new: 5 }, limit: 2 }));
    expect(r.actions).toHaveLength(2);
    expect(r.actions[0].id).toBe("at-risk"); // 20 × 12% beats 5 × 15%
    expect(r.totalImpact).toBeCloseTo(r.actions.reduce((s, a) => s + a.impact.amount, 0));
  });

  it("hides findings that were snoozed, dismissed or acted on recently", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    const day = 86400000;
    const ago = (d) => new Date(now - d * day).toISOString();
    expect(isSuppressed("x", { x: { status: "snoozed", until: new Date(now + day).toISOString(), created_at: ago(1) } }, now)).toBe(true);
    expect(isSuppressed("x", { x: { status: "snoozed", until: new Date(now - day).toISOString(), created_at: ago(8) } }, now)).toBe(false);
    expect(isSuppressed("x", { x: { status: "dismissed", created_at: ago(29) } }, now)).toBe(true);
    expect(isSuppressed("x", { x: { status: "dismissed", created_at: ago(31) } }, now)).toBe(false);
    expect(isSuppressed("x", { x: { status: "done", created_at: ago(10) } }, now)).toBe(true);
    expect(isSuppressed("x", { x: { status: "done", created_at: ago(15) } }, now)).toBe(false);

    const periodBookings = [...Array(10)].map(() => bk("completed"));
    const r = buildBIInsights(base({ periodBookings, segmentCounts: { at_risk: 9 }, recentActions: { "at-risk": { status: "dismissed", created_at: new Date().toISOString() } } }));
    expect(find(r, "at-risk")).toBeUndefined();
  });

  it("response rate: default until 20 sends", () => {
    expect(responseRate("at_risk", { at_risk: { sent: 10, conversions: 9 } }).measured).toBe(false);
    expect(responseRate("at_risk", { at_risk: { sent: 20, conversions: 4 } })).toMatchObject({ rate: 0.2, measured: true });
  });

  it("fill-day audience: same-weekday regulars first, already-booked left out", () => {
    const bookings = [
      { customer_phone: "A", status: "completed", date: "2026-9-27" },  // Sunday → schema day 1
      { customer_phone: "A", status: "completed", date: "2026-9-20" },
      { customer_phone: "B", status: "completed", date: "2026-9-23" },  // Wednesday
      { customer_phone: "C", status: "confirmed", date: "2026-10-4" },  // already booked that day
    ];
    const lapsed = [{ phone: "B", days_since: 90 }, { phone: "A", days_since: 40 }, { phone: "C", days_since: 60 }, { phone: "D", days_since: 120 }];
    const ranked = rankFillDayAudience(lapsed, bookings, { dKey: "2026-10-4", weekday: 1 });
    expect(ranked.map((x) => x.phone)).toEqual(["A", "D", "B"]);
  });

  it("SMS helpers", () => {
    expect(fillDayDraft("یکشنبه", "https://x.ir/mana")).toContain("https://x.ir/mana");
    expect(fillDayDraft("یکشنبه", "")).not.toContain("رزرو:");
    expect(smsPartCount("س".repeat(70))).toBe(1);
    expect(smsPartCount("س".repeat(71))).toBe(2);
    expect(smsPartCount("س".repeat(135))).toBe(3);
  });
});
