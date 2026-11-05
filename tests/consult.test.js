import { describe, it, expect } from "vitest";
import { EMPTY_CONSULT, consultMissing, consultPayload, consultDetailsLine } from "../src/lib/consult";

describe("v2.68 consultation", () => {
  it("asks the required questions per section", () => {
    expect(consultMissing("female", EMPTY_CONSULT)).toBe("طول مو");
    expect(consultMissing("female", { ...EMPTY_CONSULT, hair_length: "long", hair_condition: "dry" })).toBe("آخرین رنگ یا دکلره");
    expect(consultMissing("female", { ...EMPTY_CONSULT, hair_length: "long", hair_condition: "dry", last_color: "none" })).toBe("");
    expect(consultMissing("male", { ...EMPTY_CONSULT, hair_length: "short" })).toBe("");
  });
  it("sends only the section's questions, trimmed", () => {
    const d = { ...EMPTY_CONSULT, hair_length: "short", hair_condition: "dry", skin: "oily", goal: "  فید  ", allergy: " " };
    expect(consultPayload("male", d)).toEqual({ hair_length: "short", skin: "oily", goal: "فید" });
    expect(consultPayload("female", d)).toEqual({ hair_length: "short", hair_condition: "dry", goal: "فید" });
  });
  it("reads like the SMS line", () => {
    expect(consultDetailsLine({ hair_length: "long", hair_texture: "curly", hair_condition: "damaged", last_color: "lt3", allergy: "آمونیاک", goal: "بالیاژ" }))
      .toBe("موی بلند، فر، آسیب‌دیده · رنگ/دکلره کمتر از ۳ ماه پیش · حساسیت: آمونیاک · نتیجهٔ دلخواه: بالیاژ");
    expect(consultDetailsLine({ last_color: "none", skin: "sensitive" })).toBe("بدون رنگ قبلی · پوست حساس");
    expect(consultDetailsLine({})).toBe("");
  });
});
