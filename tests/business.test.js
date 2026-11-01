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

/* v2.52 — shop analytics for BI and accounting */
import { computeShopAnalytics } from "../src/lib/shop";
import { shopKpis, shopInsight } from "../src/panel/ShopInsights";
import { fetchClientRecords, saveClientRecord } from "../src/lib/business";

describe("computeShopAnalytics", () => {
  const products = [{ id: "p1", category: "beard", cost_price: 100 }, { id: "p2", category: "hair", cost_price: null }];
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const orders = [
    { status: "delivered", created_at: day(1), customer_phone: "09120000001", subtotal: 500, coupon_discount: 50, shipping_fee: 20,
      order_items: [{ product_id: "p1", name: "روغن", unit_price: 300, qty: 1 }, { product_id: "p2", name: "سرم", unit_price: 200, qty: 1 }] },
    { status: "cancelled", created_at: day(1), customer_phone: "09120000002", subtotal: 900, order_items: [] },
    { status: "pending", created_at: day(40), customer_phone: "09120000003", subtotal: 900, order_items: [] },
  ];
  const now = new Date(); const pad = (n) => n;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const bookings = [{ status: "completed", date: today, customer_phone: "09120000001" }, { status: "completed", date: today, customer_phone: "09120000009" }];
  const from = new Date(Date.now() - 30 * 86400000); const to = new Date(Date.now() + 86400000);
  const a = computeShopAnalytics(orders, products, bookings, from, to);
  it("counts only live orders in range", () => {
    expect(a).toMatchObject({ orders: 1, revenue: 450, shipping: 20, discount: 50, items: 2, cogs: 100, revenue_with_cost: 300 });
  });
  it("attach rate and categories", () => {
    expect(a.visit_customers).toBe(2);
    expect(a.buyers_with_visit).toBe(1);
    expect(a.by_category.map((c) => c.category)).toEqual(["beard", "hair"]);
    expect(a.top_products.find((p) => p.name === "سرم").profit).toBeNull();
  });
  it("kpis and the manager hint", () => {
    const k = shopKpis(a, 1550);
    expect(k.share).toBeCloseTo(450 / 2000);
    expect(k.grossProfit).toBe(200);
    expect(k.attachRate).toBe(0.5);
    expect(shopInsight(k, a)).toBeNull(); // 60% of sales have a cost, margin 67%
    expect(shopInsight({ ...k, costCoverage: 0.3 }, a)).toMatch(/قیمت خرید/);
    expect(shopInsight({ ...k, attachRate: 0.05 }, { ...a, visit_customers: 20 })).toMatch(/گزارش نوبت/);
    expect(shopInsight(shopKpis({ ok: true, orders: 0 }), {})).toMatch(/سفارشی ثبت نشده/);
    expect(shopKpis(null)).toBeNull();
  });
});

describe("client records (demo)", () => {
  it("saves and reads back, trimming fields", async () => {
    expect((await saveClientRecord({ phone: "123" })).ok).toBe(false);
    expect((await saveClientRecord({ phone: "09125550000", allergies: "  هنا  ", color_formula: "6.0" })).ok).toBe(true);
    const m = await fetchClientRecords(["09125550000", "bad"]);
    expect(m.get("09125550000")).toMatchObject({ allergies: "هنا", color_formula: "6.0" });
  });
});
