import { describe, it, expect } from "vitest";
import { checkCoupon, saveCoupon, issueGiftCard, giftCardBalance, redeemGiftCard, fetchCommissionReport, fetchSupplies, saveSupply, supplyMove, checkIn } from "../src/lib/business";
import { groupVariants } from "../src/lib/shop";

/* v2.50/v2.51 — demo-mode (no Supabase) behaviour of the business helpers. */
describe("coupons (demo)", () => {
  it("applies a percent coupon and respects scope + minimum", async () => {
    expect((await checkCoupon("yalda20", "shop", 1000000)).discount).toBe(200000);
    expect((await checkCoupon("", "shop", 1000)).ok).toBe(false);
    expect((await checkCoupon("NOPE", "shop", 1000)).ok).toBe(false);
    expect((await saveCoupon({ code: "BOOK50", kind: "amount", value: 50000, scope: "booking", min_total: 200000 })).ok).toBe(true);
    expect((await checkCoupon("BOOK50", "shop", 500000)).ok).toBe(false);
    expect((await checkCoupon("BOOK50", "booking", 100000)).ok).toBe(false);
    expect((await checkCoupon("BOOK50", "booking", 300000)).discount).toBe(50000);
  });
  it("validates the coupon form", async () => {
    expect((await saveCoupon({ code: "a b", kind: "percent", value: 10 })).ok).toBe(false);
    expect((await saveCoupon({ code: "OK10", kind: "percent", value: 150 })).ok).toBe(false);
    expect((await saveCoupon({ code: "OK10", kind: "amount", value: 10 })).ok).toBe(false);
  });
});

describe("gift cards (demo)", () => {
  it("issues, checks and redeems a card down to zero", async () => {
    const { ok, code } = await issueGiftCard({ amount: 300000, recipientPhone: "09120000001" });
    expect(ok).toBe(true);
    expect((await giftCardBalance(code.toLowerCase())).balance).toBe(300000);
    const r1 = await redeemGiftCard(code, { id: "x", final_price: 200000 });
    expect(r1).toMatchObject({ ok: true, used: 200000, balance: 100000, final_price: 0 });
    const r2 = await redeemGiftCard(code, { id: "y", final_price: 250000 });
    expect(r2).toMatchObject({ used: 100000, balance: 0, final_price: 150000 });
    expect((await redeemGiftCard(code, { id: "z", final_price: 1000 })).ok).toBe(false);
  });
});

describe("commission report (demo)", () => {
  it("counts completed visits in range, excluding transport fees", async () => {
    const stylists = [{ id: "s1", name: "سارا", commission_pct: 40 }];
    const bookings = [
      { staff_id: "s1", status: "completed", date: "2026-3-5", final_price: 500000, transport_fee: 100000 },
      { staff_id: "s1", status: "completed", date: "2026-3-25", final_price: 300000 },
      { staff_id: "s1", status: "booked", date: "2026-3-6", final_price: 900000 },
      { staff_id: "s1", status: "completed", date: "2026-4-1", final_price: 900000 },
    ];
    const { rows } = await fetchCommissionReport("2026-3-1", "2026-3-31", bookings, stylists);
    expect(rows[0]).toMatchObject({ services_count: 2, services_revenue: 700000, total_commission: 280000 });
  });
});

describe("supplies (demo)", () => {
  it("tracks purchase, use and low stock", async () => {
    expect((await saveSupply({ name: "شامپو تست", unit: "لیتر", low_at: 2 })).ok).toBe(true);
    const s = (await fetchSupplies()).find((x) => x.name === "شامپو تست");
    expect((await supplyMove(s, "purchase", 5)).qty).toBe(5);
    expect(await supplyMove(s, "use", 3.5)).toMatchObject({ qty: 1.5, low: true });
    expect((await supplyMove(s, "use", 10)).ok).toBe(false);
    expect((await supplyMove(s, "adjust", 4)).qty).toBe(4);
  });
});

describe("check-in (demo)", () => {
  it("accepts a bare code or a link", async () => {
    const bookings = [{ id: "b1", tracking_code: "MN-12345", customer_name: "مینا" }];
    expect((await checkIn("mn-12345", bookings)).id).toBe("b1");
    expect((await checkIn("https://x.ir/track?code=MN-12345", bookings)).id).toBe("b1");
    expect((await checkIn("MN-99999", bookings)).ok).toBe(false);
  });
});

describe("groupVariants", () => {
  it("groups products sharing a variant_group, keeping order", () => {
    const g = groupVariants([
      { id: 1, name: "غذا ۱ کیلو", variant_group: "غذای خشک", variant_label: "۱ کیلو" },
      { id: 2, name: "قلاده" },
      { id: 3, name: "غذا ۳ کیلو", variant_group: "غذای خشک", variant_label: "۳ کیلو" },
    ]);
    expect(g.map((x) => x.name)).toEqual(["غذای خشک", "قلاده"]);
    expect(g[0].items.map((p) => p.id)).toEqual([1, 3]);
  });
});
