import { describe, it, expect } from "vitest";
import { computeStatement, contractOn, shiftMonth, monthKey, priceFor } from "../src/lib/contracts";

const bk = (id, staff, price, extra = {}) => ({ id, staff_id: staff, status: "completed", date: "2026-11-3", final_price: price, ...extra });

describe("contractOn", () => {
  it("takes the latest contract that has started", () => {
    const cs = [{ stylist_id: "a", kind: "rent", effective_from: "2026-09-01" }, { stylist_id: "a", kind: "share", effective_from: "2026-11-01" }];
    expect(contractOn(cs, "a", "2026-10-31").kind).toBe("rent");
    expect(contractOn(cs, "a", "2026-11-30").kind).toBe("share");
    expect(contractOn(cs, "a", "2026-08-30")).toBeNull();
  });
  it("months", () => {
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(monthKey(new Date(2026, 10, 15))).toBe("2026-11-01");
  });
});

describe("computeStatement", () => {
  it("hybrid, salon collects (same numbers as the DB test)", () => {
    const s = computeStatement({
      contract: { kind: "hybrid", rent_amount: 2000000, service_share_pct: 10, collector: "salon" },
      bookings: [bk("1", "a", 1000000), bk("2", "a", 1000000), bk("3", "a", 700000, { gift_card_amount: 300000 }), bk("x", "b", 999)],
      ledger: [{ stylist_id: "a", month: "2026-11-01", kind: "charge", amount: 150000 }, { stylist_id: "a", month: "2026-11-01", kind: "paid_to_stylist", amount: 500000 }],
      month: "2026-11-01", stylistId: "a",
    });
    expect(s).toMatchObject({ gross: 3000000, held_by_salon: 3000000, salon_share: 300000, rent: 2000000, stylist_net: 550000, balance: 50000 });
  });
  it("share, stylist collects: owes the share minus what the salon holds", () => {
    const s = computeStatement({
      contract: { kind: "share", service_share_pct: 30, collector: "stylist" },
      bookings: [bk("4", "b", 1000000, { deposit_paid_at: "x", deposit_amount: 200000 }), bk("5", "b", 1000000)],
      month: "2026-11-01", stylistId: "b",
    });
    expect(s).toMatchObject({ held_by_stylist: 1800000, online: 200000, balance: -400000 });
  });
  it("employees and other months", () => {
    expect(computeStatement({ contract: null, bookings: [], month: "2026-11-01", stylistId: "a" }).kind).toBe("employee");
    const s = computeStatement({ contract: { kind: "rent", rent_amount: 100, collector: "stylist" }, bookings: [bk("1", "a", 500)], month: "2026-10-01", stylistId: "a" });
    expect(s).toMatchObject({ visits: 0, gross: 0, balance: -100 });
  });
});

describe("v2.55 independent stylists", () => {
  it("adds product commission to what the salon owes", () => {
    const contract = { kind: "share", service_share_pct: 20, collector: "salon", product_commission_pct: 10 };
    const orders = [
      { sold_by: "a", status: "pending", subtotal: 2000000, created_at: new Date(2026, 10, 5).toISOString() },
      { sold_by: "a", status: "cancelled", subtotal: 500000, created_at: new Date(2026, 10, 5).toISOString() },
      { sold_by: "b", status: "delivered", subtotal: 900000, created_at: new Date(2026, 10, 5).toISOString() },
      { sold_by: "a", status: "delivered", subtotal: 700000, created_at: new Date(2026, 9, 5).toISOString() },
    ];
    const s = computeStatement({ contract, bookings: [bk(1, "a", 1000000, { date: "2026-11-02" }), bk(2, "a", 1000000, { date: "2026-11-03" })], month: "2026-11-01", stylistId: "a", orders });
    expect(s.product_sales).toBe(2000000);
    expect(s.product_commission).toBe(200000);
    expect(s.balance).toBe(2000000 - 400000 + 200000);
  });
  it("priceFor finds the stylist's own price", () => {
    const prices = [{ stylist_id: "a", service_id: "cut", price: 1500000 }];
    expect(priceFor(prices, "a", "cut")).toBe(1500000);
    expect(priceFor(prices, "b", "cut")).toBeNull();
  });
});
