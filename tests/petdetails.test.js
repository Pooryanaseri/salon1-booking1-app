import { describe, it, expect } from "vitest";
import { EMPTY_PET, petAgeMonths, petExtras, petReady, petMissing, BREEDS, OTHER_BREED } from "../src/booking/PetForm";
import { petAgeLabel } from "../src/panel/PetCare";

const base = { ...EMPTY_PET, name: "پاپی", size: "medium" };

describe("pet form (v2.61)", () => {
  it("breed, age and first-grooming are required", () => {
    expect(petReady(base, false)).toBe(false);
    expect(petMissing(base, false, "سگ")).toBe("نژاد را انتخاب کنید");
    const b = { ...base, breed: OTHER_BREED };
    expect(petMissing(b, false, "سگ")).toBe("سن را وارد کنید");
    const c = { ...b, age_years: "0", age_months_part: "4" };
    expect(petMissing(c, false, "سگ")).toBe("بگویید اولین آرایش است یا نه");
    expect(petReady({ ...c, first_grooming: false }, false)).toBe(true);
    expect(petReady({ ...c, first_grooming: false }, true)).toBe(false); // vaccine still required when asked
  });
  it("age in months and the server payload", () => {
    expect(petAgeMonths(base)).toBeNull();
    expect(petAgeMonths({ ...base, age_years: "2", age_months_part: "" })).toBe(24);
    expect(petExtras({ ...base, age_years: "1", age_months_part: "3", first_grooming: true, supplies: ["حوله"], supplies_note: "  شامپوی خودمان " }))
      .toEqual({ age_months: "15", first_grooming: "true", supplies: ["حوله"], supplies_note: "شامپوی خودمان" });
  });
  it("lists only well-known breeds", () => {
    expect(BREEDS.dog).toContain("پامرانین");
    expect(BREEDS.cat).toContain("پرشین");
  });
});

describe("pet age label grows with time", () => {
  it("months, years, and years + months", () => {
    expect(petAgeLabel({ age_months: 5 })).toBe("۵ ماهه");
    expect(petAgeLabel({ age_months: 24 })).toBe("۲ ساله");
    expect(petAgeLabel({ age_months: 10, age_set_on: "2026-01-15" }, new Date(2026, 4, 20))).toBe("۱ سال و ۲ ماه");
    expect(petAgeLabel({})).toBe("");
  });
});
