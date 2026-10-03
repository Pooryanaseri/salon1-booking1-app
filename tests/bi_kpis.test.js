// tests/bi_kpis.test.js — the indexed BI KPIs (v2.42 review) must give
// exactly what the original whole-history scans gave, only faster.
import { describe, it, expect } from "vitest";
import { BI_KPIS } from "../src/panel/BITab.jsx";
import { bookingTimestamp } from "../src/lib/format.js";

// The original implementations, verbatim in logic.
const ref = {
  newCustomers(subset, all, start) {
    const seen = new Set(); let count = 0;
    for (const b of subset) {
      if (seen.has(b.customer_phone)) continue;
      seen.add(b.customer_phone);
      if (!all.some((ob) => ob.customer_phone === b.customer_phone && bookingTimestamp(ob) < start)) count++;
    }
    return count;
  },
  returnRate60(subset, all) {
    const anchors = new Map();
    for (const b of subset) {
      if (b.status !== "completed") continue;
      const ts = bookingTimestamp(b);
      if (!anchors.has(b.customer_phone) || ts < anchors.get(b.customer_phone)) anchors.set(b.customer_phone, ts);
    }
    if (anchors.size === 0) return 0;
    let returned = 0;
    for (const [phone, a] of anchors) {
      if (all.some((ob) => ob.customer_phone === phone && ob.status === "completed" && bookingTimestamp(ob) > a && bookingTimestamp(ob) <= a + 60 * 86400000)) returned++;
    }
    return returned / anchors.size;
  },
  newSingle: (b, all, start) => (all.some((ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && bookingTimestamp(ob) < start) ? 0 : 1),
  returnSingle(b, all) {
    if (b.status !== "completed") return 0;
    const ts = bookingTimestamp(b);
    return all.some((ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && ob.status === "completed" && bookingTimestamp(ob) > ts && bookingTimestamp(ob) <= ts + 60 * 86400000) ? 1 : 0;
  },
};

function makeData(n, customers, seed) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const statuses = ["completed", "completed", "completed", "no_show", "cancelled", "confirmed"];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - Math.floor(rnd() * 400) + 20);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { id: "b" + i, date: key, start_min: 540 + Math.floor(rnd() * 20) * 30, customer_phone: "0912" + String(Math.floor(rnd() * customers)).padStart(7, "0"),
      status: statuses[Math.floor(rnd() * statuses.length)], final_price: 100000 };
  });
}
const kpi = (id) => BI_KPIS.find((k) => k.id === id);

describe("indexed BI KPIs match the original scans", () => {
  for (const [n, customers, seed] of [[50, 10, 1], [400, 60, 2], [1500, 300, 3], [3000, 2000, 4]]) {
    it(`${n} bookings / ${customers} customers`, () => {
      const all = makeData(n, customers, seed);
      for (const span of [7, 30, 90]) {
        const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (span - 1));
        const st = start.getTime();
        const period = all.filter((b) => bookingTimestamp(b) >= st);
        expect(kpi("newCustomers").compute(period, all, st)).toBe(ref.newCustomers(period, all, st));
        expect(kpi("returnRate60").compute(period, all, st)).toBe(ref.returnRate60(period, all));
        for (const b of period.slice(0, 200)) {
          expect(kpi("newCustomers").single(b, all, st)).toBe(ref.newSingle(b, all, st));
          expect(kpi("returnRate60").single(b, all, st)).toBe(ref.returnSingle(b, all));
        }
      }
    });
  }

  it("stays fast on a large salon (20k bookings)", () => {
    const all = makeData(20000, 3000, 9);
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 89);
    const period = all.filter((b) => bookingTimestamp(b) >= start.getTime());
    const t = performance.now();
    for (let i = 0; i < 4; i++) {
      kpi("newCustomers").compute(period, all, start.getTime());
      kpi("returnRate60").compute(period, all, start.getTime());
    }
    expect(performance.now() - t).toBeLessThan(150);
  });
});
