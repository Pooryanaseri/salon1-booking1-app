import { describe, it, expect } from "vitest";
import { tierPrice, tierSaving } from "../src/lib/growth";

const paye = { max_stylists: 2, price_3: 6000000, price_6: 11400000, price_12: 21600000, extra_stylist_price_3: 0 };
const bozorg = { max_stylists: 20, price_3: 21000000, price_6: 40000000, price_12: 75500000, extra_stylist_price_3: 900000 };

describe("v2.64 tier prices (mirror plan_price)", () => {
  it("uses the tier's own 3/6/12-month prices", () => {
    expect(tierPrice(paye, 3, 2)).toBe(6000000);
    expect(tierPrice(paye, 6, 2)).toBe(11400000);
    expect(tierPrice(paye, 12, 2)).toBe(21600000);
    expect(tierPrice(paye, 1, 2)).toBeNull();
  });
  it("adds extra stylists only on tiers that sell them", () => {
    expect(tierPrice(bozorg, 3, 25)).toBe(21000000 + 5 * 900000);
    expect(tierPrice(bozorg, 12, 25)).toBe(75500000 + Math.round(5 * 900000 * (75500000 / 21000000)));
    expect(tierPrice(bozorg, 3, 18)).toBe(21000000);
    expect(tierPrice(paye, 3, 5)).toBe(6000000);
  });
  it("shows the saving of longer periods", () => {
    expect(tierSaving(paye, 3)).toBe(0);
    expect(tierSaving(paye, 6)).toBe(5);
    expect(tierSaving(paye, 12)).toBe(10);
  });
});

import { formatCardNumber } from "../src/lib/growth";
describe("v2.66 card-to-card", () => {
  it("groups the card number in fours", () => {
    expect(formatCardNumber("6037991234567890")).toBe("6037 9912 3456 7890");
    expect(formatCardNumber("")).toBe("");
  });
});
