import { describe, it, expect } from "vitest";
import { priceCart, shippingFor, categoryLabel, placeOrder, fetchShop, setOrderStatus, fetchOrders } from "../src/lib/shop";

const products = [
  { id: "a", name: "غذا", price: 500000, stock: 2 },
  { id: "b", name: "شامپو", price: 200000, stock: null },
];

describe("priceCart", () => {
  it("prices lines and drops unknown products", () => {
    const r = priceCart([{ id: "a", qty: 1 }, { id: "b", qty: 3 }, { id: "gone", qty: 1 }], products);
    expect(r.subtotal).toBe(1100000);
    expect(r.count).toBe(4);
    expect(r.lines).toHaveLength(2);
  });
  it("clips to stock and to 50", () => {
    const r = priceCart([{ id: "a", qty: 5 }, { id: "b", qty: 80 }], products);
    expect(r.lines[0]).toMatchObject({ qty: 2, clipped: true });
    expect(r.lines[1]).toMatchObject({ qty: 50, clipped: true });
  });
  it("skips sold-out products", () => {
    expect(priceCart([{ id: "a", qty: 1 }], [{ ...products[0], stock: 0 }]).lines).toHaveLength(0);
  });
});

describe("shippingFor", () => {
  const shop = { shipping_fee: 60000, free_shipping_over: 1000000 };
  it("charges for shipping below the threshold", () => expect(shippingFor(shop, 900000, "shipping")).toBe(60000));
  it("is free above the threshold", () => expect(shippingFor(shop, 1000000, "shipping")).toBe(0));
  it("never charges for pickup", () => expect(shippingFor(shop, 10, "pickup")).toBe(0));
  it("threshold 0 means never free", () => expect(shippingFor({ shipping_fee: 5, free_shipping_over: 0 }, 9e9, "shipping")).toBe(5));
});

describe("categories", () => {
  it("labels known keys and passes custom text through", () => {
    expect(categoryLabel("food")).toBe("غذا");
    expect(categoryLabel("hair")).toBe("مراقبت مو");
    expect(categoryLabel("ویژه")).toBe("ویژه");
  });
});

describe("demo shop", () => {
  it("places an order, reserves stock and releases it on cancel", async () => {
    const shop = await fetchShop();
    expect(shop.enabled).toBe(true);
    const p = shop.products.find((x) => x.stock > 1);
    const res = await placeOrder({ name: "سارا", phone: "09120000000", items: [{ product_id: p.id, qty: 2 }], delivery: "pickup", payment: "cash" });
    expect(res.ok).toBe(true);
    expect(res.total).toBe(p.price * 2);
    expect((await fetchShop()).products.find((x) => x.id === p.id).stock).toBe(p.stock - 2);
    const tooMany = await placeOrder({ name: "سارا", phone: "09120000000", items: [{ product_id: p.id, qty: 999 }], delivery: "pickup", payment: "cash" });
    expect(tooMany.ok).toBe(false);
    expect((await setOrderStatus(res.id, "cancelled", "")).ok).toBe(false);
    expect((await setOrderStatus(res.id, "cancelled", "تمام شد")).ok).toBe(true);
    expect((await fetchShop()).products.find((x) => x.id === p.id).stock).toBe(p.stock);
    expect((await fetchOrders())[0].status).toBe("cancelled");
  });
});
