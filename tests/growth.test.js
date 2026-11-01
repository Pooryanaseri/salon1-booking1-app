import { describe, it, expect } from "vitest";
import { schemaDowOfKey, offpeakFor, quietHours, sourceStats, targetStatus, sourceLabel } from "../src/lib/growth";

describe("off-peak", () => {
  it("numbers weekdays from Saturday", () => {
    expect(schemaDowOfKey("2026-10-31")).toBe(0); // Saturday
    expect(schemaDowOfKey("2026-11-6")).toBe(6);  // Friday, unpadded key
  });
  it("picks the best matching rule", () => {
    const rules = [{ day: null, start: 600, end: 780, percent: 10 }, { day: 0, start: 600, end: 720, percent: 25, label: "شنبه خلوت" }];
    expect(offpeakFor(rules, "2026-10-31", 630)).toEqual({ percent: 25, label: "شنبه خلوت" });
    expect(offpeakFor(rules, "2026-11-1", 630).percent).toBe(10);
    expect(offpeakFor(rules, "2026-11-1", 780)).toBeNull(); // end is exclusive
    expect(offpeakFor([], "2026-11-1", 600)).toBeNull();
    expect(offpeakFor([{ day_of_week: null, start_min: 0, end_min: 900, percent: 5, active: false }], "2026-11-1", 600)).toBeNull();
  });
  it("finds the quietest hours", () => {
    const d = new Date(); const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const q = quietHours([{ date: key, start_min: 600, status: "completed" }], 10, 12);
    expect(q.length).toBe(14);
    expect(q[q.length - 1]).toMatchObject({ dow: schemaDowOfKey(key), hour: 10, count: 1 });
  });
});

describe("sources", () => {
  it("counts bookings, revenue and first visits per source", () => {
    const d = new Date(); const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const rows = sourceStats([
      { id: "a", date: key, customer_phone: "1", source: "instagram", status: "completed", final_price: 100 },
      { id: "b", date: key, customer_phone: "1", source: "instagram", status: "confirmed", final_price: 50 },
      { id: "c", date: key, customer_phone: "2", source: null, status: "completed", final_price: 300 },
      { id: "d", date: key, customer_phone: "3", source: "card", status: "cancelled", final_price: 900 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["مستقیم / نامشخص", "اینستاگرام"]);
    expect(rows[1]).toMatchObject({ bookings: 2, revenue: 100, newClients: 1 });
    expect(sourceLabel("tiktok")).toBe("tiktok");
  });
});

describe("targets", () => {
  it("needs every target met for the bonus", () => {
    expect(targetStatus({ revenue_target: 0, visits_target: 0, bonus: 100, revenue: 9, visits: 9 })).toMatchObject({ hasTarget: false, earned: 0 });
    expect(targetStatus({ revenue_target: 1000, visits_target: 10, bonus: 100, revenue: 1500, visits: 5 })).toMatchObject({ progress: 0.5, earned: 0 });
    expect(targetStatus({ revenue_target: 1000, visits_target: 10, bonus: 100, revenue: 1000, visits: 12 })).toMatchObject({ progress: 1, earned: 100 });
  });
});
