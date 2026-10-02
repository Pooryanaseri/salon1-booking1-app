// tests/insights.test.js — v2.40 BI "تحلیل و اقدام پیشنهادی" rules.
import { describe, it, expect } from "vitest";
import { buildBIInsights, fillDayDraft } from "../src/panel/biInsights.js";

const zeroKpi = { revenue: 0, noShowRate: 0, returnRate60: 1, newCustomers: 0 };
const ON = { attendance_confirmation: true, reminder_hours_before: 3, deposit_percent: 10, waitlist_auto_offer: true };
const bk = (status, extra = {}) => ({ status, service_id: "s1", final_price: status === "completed" ? 100000 : null, ...extra });

function base(over = {}) {
  return {
    spanDays: 30, cur: { ...zeroKpi }, prev: { ...zeroKpi },
    periodBookings: [], prevPeriodBookings: [], services: [{ id: "s1", price: 200000 }],
    heatmapGrid: null, heatmapHours: [], pareto: null, nextDays: [], serviceShare: [], stylistPerf: [],
    automation: ON, segmentCounts: {},
    ...over,
  };
}
const ids = (list) => list.map((i) => i.id);

describe("buildBIInsights", () => {
  it("says nothing without enough data", () => {
    expect(buildBIInsights(base())).toEqual([]);
  });

  it("no-shows: offers the first switch that is still off", () => {
    const periodBookings = [...Array(8)].map(() => bk("completed")).concat([bk("no_show"), bk("no_show")]);
    const c = base({ periodBookings, cur: { ...zeroKpi, noShowRate: 0.2 } });

    let ins = buildBIInsights({ ...c, automation: { ...ON, attendance_confirmation: false } }).find((i) => i.id === "no-show");
    expect(ins.tone).toBe("warn");
    expect(ins.text).toContain("۴۰۰,۰۰۰ تومان"); // 2 × service price (no final_price on no-shows)
    expect(ins.action).toMatchObject({ kind: "automation", patch: { attendance_confirmation: true } });

    ins = buildBIInsights({ ...c, automation: { ...ON, reminder_hours_before: 0 } }).find((i) => i.id === "no-show");
    expect(ins.action).toMatchObject({ kind: "reminder", hours: 3 });

    ins = buildBIInsights({ ...c, automation: { ...ON, deposit_percent: 0 } }).find((i) => i.id === "no-show");
    expect(ins.action).toMatchObject({ kind: "goto", tab: "schedule" });

    ins = buildBIInsights(c).find((i) => i.id === "no-show");
    expect(ins.action).toBeUndefined(); // everything already on: report only
  });

  it("revenue drop names the driver; win-back lives on the at-risk finding", () => {
    const prevPeriodBookings = [...Array(10)].map(() => bk("completed"));
    const periodBookings = [...Array(6)].map(() => bk("completed"));
    const list = buildBIInsights(base({
      periodBookings, prevPeriodBookings,
      cur: { ...zeroKpi, revenue: 600000 }, prev: { ...zeroKpi, revenue: 1000000 },
      segmentCounts: { at_risk: 7 },
    }));
    const rev = list.find((i) => i.id === "revenue-down");
    expect(rev.text).toContain("کاهش تعداد نوبت‌ها");
    expect(rev.action).toBeUndefined();
    expect(list.find((i) => i.id === "at-risk").action).toMatchObject({ kind: "campaign", segment: "at_risk", count: 7 });
  });

  it("small revenue changes are not reported", () => {
    const list = buildBIInsights(base({ cur: { ...zeroKpi, revenue: 950000 }, prev: { ...zeroKpi, revenue: 1000000 } }));
    expect(ids(list)).not.toContain("revenue-down");
  });

  it("empty day ahead (not today) gets a fill action; full days suggest the waitlist only when it's off", () => {
    const nextDays = [
      { dKey: "2026-10-03", label: "امروز", fillRate: 0.05, hasCapacity: true },
      { dKey: "2026-10-04", label: "یکشنبه", fillRate: 0.1, hasCapacity: true },
      { dKey: "2026-10-05", label: "دوشنبه", fillRate: 0.95, hasCapacity: true },
    ];
    let list = buildBIInsights(base({ nextDays }));
    const empty = list.find((i) => i.id.startsWith("empty-"));
    expect(empty.action).toMatchObject({ kind: "fill_day", dKey: "2026-10-04" });
    expect(ids(list)).not.toContain("waitlist");

    list = buildBIInsights(base({ nextDays, automation: { ...ON, waitlist_auto_offer: false } }));
    expect(list.find((i) => i.id === "waitlist").action.patch).toEqual({ waitlist_auto_offer: true });
  });

  it("orders warnings first and caps the list", () => {
    const list = buildBIInsights(base({
      cur: { ...zeroKpi, revenue: 2000000, newCustomers: 10 }, prev: { ...zeroKpi, revenue: 1000000, newCustomers: 5 },
      segmentCounts: { at_risk: 5 }, limit: 2,
    }));
    expect(list).toHaveLength(2);
    expect(list[0].tone).toBe("warn");
  });

  it("fill-day SMS carries the booking link when known", () => {
    expect(fillDayDraft("یکشنبه", "https://x.ir/mana")).toContain("https://x.ir/mana");
    expect(fillDayDraft("یکشنبه", "")).not.toContain("رزرو:");
  });
});
