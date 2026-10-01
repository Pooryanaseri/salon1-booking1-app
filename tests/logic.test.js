// tests/logic.test.js
//
// A real, runnable Vitest suite (idea 5 from CHANGES.md v2.17) covering the
// app's core pricing/segmentation/attribution math — the same logic that
// was verified manually throughout development via one-off Node scripts.
// These reimplement the exact algorithms as pure functions (App.jsx doesn't
// export its internal helpers, and extracting them was out of scope for
// this pass), so a change to the real implementation should be mirrored
// here too. Run with `npm test`.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------- pricing --
function discountAmountFor(price, discountType, discountValue) {
  if (discountType === "none" || !discountValue) return 0;
  return discountType === "percent" ? Math.round((price * discountValue) / 100) : discountValue;
}
function computeFinalPrice(servicePrice, serviceDiscountType, serviceDiscountValue, loyaltyPct) {
  const serviceDiscount = discountAmountFor(servicePrice, serviceDiscountType, serviceDiscountValue);
  const afterService = Math.max(0, servicePrice - serviceDiscount);
  const loyaltyAmount = Math.round((afterService * loyaltyPct) / 100);
  return Math.max(0, afterService - loyaltyAmount);
}

describe("discount stacking (service discount, then loyalty tier discount)", () => {
  it("no discounts -> final equals original", () => {
    expect(computeFinalPrice(1000000, "none", 0, 0)).toBe(1000000);
  });
  it("service discount only", () => {
    expect(computeFinalPrice(1000000, "percent", 10, 0)).toBe(900000);
  });
  it("loyalty discount only", () => {
    expect(computeFinalPrice(1000000, "none", 0, 15)).toBe(850000);
  });
  it("both stack sequentially (service first, then loyalty on the result)", () => {
    expect(computeFinalPrice(1000000, "percent", 10, 15)).toBe(765000);
  });
  it("never goes negative", () => {
    expect(computeFinalPrice(100000, "percent", 100, 50)).toBe(0);
  });
});

// ------------------------------------------------------------- RFM segment --
function classifySegment(recencyDays, frequency, personalLimit, loyalMinVisits) {
  if (recencyDays <= personalLimit && frequency >= loyalMinVisits) return "champions";
  if (recencyDays > personalLimit && frequency >= loyalMinVisits) return "at_risk";
  if (recencyDays <= personalLimit && frequency < loyalMinVisits) return "new";
  return "inactive";
}
function personalRecencyLimit(avgGapDays, loyalRecencyDays) {
  if (avgGapDays > 0) return Math.max(loyalRecencyDays, Math.round(avgGapDays * 1.5));
  return loyalRecencyDays;
}

describe("RFM segmentation", () => {
  it("covers the full grid with no gaps or overlaps", () => {
    const seen = new Set();
    for (let r = 1; r <= 400; r += 10) {
      for (let f = 0; f <= 20; f++) {
        seen.add(classifySegment(r, f, 60, 4));
      }
    }
    expect(seen).toEqual(new Set(["champions", "at_risk", "new", "inactive"]));
  });
  it("personalized threshold beats the flat salon default", () => {
    const limit = personalRecencyLimit(90, 60); // customer's own 90-day cadence
    expect(classifySegment(80, 5, limit, 4)).toBe("champions");
    expect(classifySegment(80, 5, 60, 4)).toBe("at_risk"); // what the OLD flat threshold would have said
  });
});

// -------------------------------------------------------- campaign attribution --
function findAttributedSms(smsMessages, phone, bookingCreatedAtMs) {
  const sevenDaysAgo = bookingCreatedAtMs - 7 * 24 * 60 * 60 * 1000;
  return smsMessages
    .filter((s) => s.to_phone === phone && s.campaign_log_id != null && ["sent", "delivered"].includes(s.status)
      && s.sent_at >= sevenDaysAgo && s.sent_at <= bookingCreatedAtMs)
    .sort((a, b) => b.sent_at - a.sent_at)[0] || null;
}

describe("campaign conversion attribution (7-day time-based window)", () => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  it("attributes a booking within the 7-day window", () => {
    const sms = { to_phone: "0912X", campaign_log_id: "cl1", status: "sent", sent_at: now - 3 * DAY };
    expect(findAttributedSms([sms], "0912X", now)?.campaign_log_id).toBe("cl1");
  });
  it("does not attribute outside the window", () => {
    const sms = { to_phone: "0912X", campaign_log_id: "cl1", status: "sent", sent_at: now - 8 * DAY };
    expect(findAttributedSms([sms], "0912X", now)).toBeNull();
  });
  it("ignores failed sends", () => {
    const sms = { to_phone: "0912X", campaign_log_id: "cl1", status: "failed", sent_at: now - 1 * DAY };
    expect(findAttributedSms([sms], "0912X", now)).toBeNull();
  });
  it("picks the most recent campaign SMS when several match", () => {
    const older = { to_phone: "0912X", campaign_log_id: "cl_old", status: "sent", sent_at: now - 5 * DAY };
    const newer = { to_phone: "0912X", campaign_log_id: "cl_new", status: "sent", sent_at: now - 1 * DAY };
    expect(findAttributedSms([older, newer], "0912X", now)?.campaign_log_id).toBe("cl_new");
  });
});

// -------------------------------------------------------- offer dedup/validation --
function winBackCandidates(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    if (m.line_status !== "at_risk" && m.line_status !== "dormant") continue;
    if (!/^09\d{9}$/.test(m.phone || "")) continue;
    if (seen.has(m.phone)) continue;
    seen.add(m.phone);
    out.push(m);
  }
  return out;
}

describe("category-matrix win-back candidate filtering", () => {
  it("dedupes and validates phone numbers, excludes active-status members", () => {
    const members = [
      { phone: "09121234567", line_status: "at_risk" },
      { phone: "09121234567", line_status: "at_risk" }, // duplicate
      { phone: "09121234568", line_status: "dormant" },
      { phone: "09121234569", line_status: "active" }, // excluded
      { phone: "invalid", line_status: "at_risk" }, // excluded
    ];
    const result = winBackCandidates(members);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.phone).sort()).toEqual(["09121234567", "09121234568"]);
  });
});

// ------------------------------------------------------- customer segmentation (v2.23) --
// Mirrors get_customer_rfm_segments()'s classification exactly — both the
// personalization (avg_gap_days-adjusted recency limit) and the
// inactive_after_days boundary that was previously collected/validated in
// the UI but never actually used (confirmed dead against real Postgres —
// see CHANGES.md v2.23).
function personalLimit(recencyDefault, avgGapDays) {
  return avgGapDays > 0 ? Math.max(recencyDefault, Math.round(avgGapDays * 1.5)) : recencyDefault;
}
function classifySegmentV223(recencyDays, frequency, personalLimitVal, loyalMinVisits, inactiveAfterDays) {
  if (recencyDays <= personalLimitVal && frequency >= loyalMinVisits) return "champions";
  if (recencyDays <= personalLimitVal && frequency < loyalMinVisits) return "new";
  if (recencyDays > personalLimitVal && recencyDays <= inactiveAfterDays && frequency >= loyalMinVisits) return "at_risk";
  return "inactive";
}

describe("customer segmentation: inactive_after_days is now a real boundary", () => {
  it("a loyal customer lapsed WITHIN the grace window is at_risk", () => {
    const limit = personalLimit(60, 0);
    expect(classifySegmentV223(90, 5, limit, 4, 120)).toBe("at_risk");
  });
  it("the SAME loyal customer lapsed BEYOND the grace window is inactive, not at_risk", () => {
    const limit = personalLimit(60, 0);
    // This is the exact bug: previously "at_risk" regardless of how far
    // past inactive_after_days the customer was.
    expect(classifySegmentV223(200, 5, limit, 4, 120)).toBe("inactive");
  });
  it("a never-loyal, lapsed customer is inactive regardless of inactive_after_days", () => {
    const limit = personalLimit(60, 0);
    expect(classifySegmentV223(90, 1, limit, 4, 120)).toBe("inactive");
  });
});

describe("customer segmentation: preview now matches live personalization", () => {
  it("a customer whose natural visit cadence exceeds the flat default is still champions, not at_risk", () => {
    // avg_gap_days=90 pushes their personal limit to round(90*1.5)=135,
    // well past their 85-day recency — champions either way. Before the
    // v2.23 fix, preview ignored avg_gap_days entirely and would have
    // classified this same customer as at_risk (85 > flat 60).
    const limit = personalLimit(60, 90);
    expect(limit).toBe(135);
    expect(classifySegmentV223(85, 5, limit, 4, 120)).toBe("champions");
    // the old (buggy) preview logic, for contrast:
    const oldFlatResult = 85 <= 60 && 5 >= 4 ? "champions" : "at_risk";
    expect(oldFlatResult).toBe("at_risk"); // proves preview and live used to disagree
  });
});
