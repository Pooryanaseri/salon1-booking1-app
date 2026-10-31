import { describe, it, expect } from "vitest";
import { consentRequired, largeDogsAt, saveVisitReport, fetchPetReports, sellPackage, fetchPurchases, redeemPackageSession } from "../src/lib/petcare";

describe("consentRequired", () => {
  const old = new Date(Date.now() - 11 * 365.25 * 86400000).toISOString().slice(0, 10);
  it("off never asks", () => expect(consentRequired("off", { temperament: "aggressive" })).toBe(false));
  it("always asks", () => expect(consentRequired("always", { temperament: "calm" })).toBe(true));
  it("risky asks for aggressive pets", () => expect(consentRequired("risky", { temperament: "aggressive" })).toBe(true));
  it("risky asks for seniors", () => expect(consentRequired("risky", { temperament: "calm", birth_date: old })).toBe(true));
  it("risky skips young calm pets", () => expect(consentRequired("risky", { temperament: "nervous", birth_date: "2023-01-01" })).toBe(false));
});

describe("largeDogsAt", () => {
  const b = (o) => ({ id: Math.random().toString(), date: "2026-11-01", status: "confirmed", start_min: 600, end_min: 660, pet_size: "large", ...o });
  const list = [b({}), b({ pet_size: "small" }), b({ status: "cancelled" }), b({ start_min: 660, end_min: 720 }), b({ date: "2026-11-02" }), b({ pet_size: "giant", start_min: 630, end_min: 700 })];
  it("counts overlapping large and giant dogs only", () => expect(largeDogsAt(list, "2026-11-01", 600, 660)).toBe(2));
  it("touching end is not overlap", () => expect(largeDogsAt(list, "2026-11-01", 720, 780)).toBe(0));
});

describe("demo reports and packages", () => {
  it("stores a report and finds it by pet", async () => {
    const booking = { id: "a1", pet_id: "p1", pet_name: "پشمک", date: "2026-11-01" };
    expect((await saveVisitReport(booking, { checks: { fleas: true }, note: "x", photos: [], before: [], after: [], productIds: [], send: true })).ok).toBe(true);
    const r = await fetchPetReports("p1");
    expect(r).toHaveLength(1);
    expect(r[0].checks.fleas).toBe(true);
  });
  it("sells a package and redeems a session", async () => {
    expect((await sellPackage({ id: "k1", name: "۴ حمام", service_id: "s1", sessions: 4, price: 1000000, valid_days: 90 }, "0912", "")).ok).toBe(false);
    expect((await sellPackage({ id: "k1", name: "۴ حمام", service_id: "s1", sessions: 4, price: 1000000, valid_days: 90 }, "09120000000", "سارا")).ok).toBe(true);
    const [p] = await fetchPurchases("09120000000");
    const res = await redeemPackageSession(p, { id: "a1", extra_charges: [{ label: "گره‌زدایی", amount: 350000 }] });
    expect(res).toMatchObject({ ok: true, left: 3, final_price: 350000 });
  });
});
