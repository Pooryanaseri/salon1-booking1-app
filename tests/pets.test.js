// tests/pets.test.js — v2.44/45 pet salon pricing helpers (mirror the SQL).
import { describe, it, expect } from "vitest";
import { normBreed, petService, petSurcharge, sizeFromWeight, petSizes, pricedBreeds, extraChargesTotal, SEED_PET_SERVICES } from "../src/app/shared.js";

const svc = (id) => SEED_PET_SERVICES.find((s) => s.id === id);

describe("pet pricing", () => {
  it("normalizes breed names like norm_breed()", () => {
    expect(normBreed("چاو چاو")).toBe(normBreed("چاو‌چاو"));
    expect(normBreed(" چاوچاو ")).toBe(normBreed("چاو چاو"));
    expect(normBreed("پامرانيك")).toBe(normBreed("پامرانیک"));
    expect(normBreed("")).toBe("");
  });
  it("size price, then breed price on top", () => {
    const bath = svc("pd3");
    expect(petService(bath, "small").price).toBe(500000);
    expect(petService(bath, "small").duration_minutes).toBe(45);
    expect(petService(bath, "giant").price).toBe(1800000); // no tier: base
    const full = svc("pd6");
    expect(petService(full, "large", "مخلوط").price).toBeNull(); // price in salon
    expect(petService(full, "large", "چاوچاو")).toMatchObject({ price: 3500000, duration_minutes: 180, breed_priced: true });
    expect(petService(full, "small", "پامر").price).toBe(1900000);
  });
  it("aggression surcharge", () => {
    expect(petSurcharge(700000, "aggressive", 30)).toBe(210000);
    expect(petSurcharge(700000, "calm", 30)).toBe(0);
    expect(petSurcharge(null, "aggressive", 30)).toBe(0);
    expect(petSurcharge(700000, "aggressive", 0)).toBe(0);
  });
  it("salon size thresholds", () => {
    expect(sizeFromWeight(4)).toBe("small");
    expect(sizeFromWeight(6)).toBe("medium");
    expect(sizeFromWeight(31)).toBe("giant");
    expect(sizeFromWeight(8, [10, 25, 40])).toBe("small");
    expect(sizeFromWeight("")).toBeNull();
    expect(petSizes([10, 25, 40])[1].hint).toBe("۱۰ تا ۲۵ کیلو");
  });
  it("priced breeds and extra charges", () => {
    expect(pricedBreeds(SEED_PET_SERVICES, "dog")).toEqual(expect.arrayContaining(["پامرانین", "چاو چاو"]));
    expect(pricedBreeds(SEED_PET_SERVICES, "cat")).toEqual([]);
    expect(extraChargesTotal({ extra_charges: [{ amount: 350000 }, { amount: 210000 }] })).toBe(560000);
    expect(extraChargesTotal({})).toBe(0);
  });
});
