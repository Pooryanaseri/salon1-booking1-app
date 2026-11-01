import { describe, it, expect } from "vitest";
import { subscriptionNotice } from "../src/lib/growth";

const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

describe("subscriptionNotice (v2.58)", () => {
  it("says nothing when not enforced, unlimited or far away", () => {
    expect(subscriptionNotice({ enforced: false, state: "active", days_left: 3 })).toBeNull();
    expect(subscriptionNotice({ enforced: true, state: "active", days_left: null })).toBeNull();
    expect(subscriptionNotice({ enforced: true, state: "active", days_left: 40, warn_days: 14 })).toBeNull();
  });
  it("warns inside the reminder window and on the last day", () => {
    expect(subscriptionNotice({ enforced: true, state: "active", days_left: 7, warn_days: 14 })).toEqual({ tone: "warning", text: "۷ روز تا پایان اشتراک" });
    expect(subscriptionNotice({ enforced: true, state: "active", days_left: 0, warn_days: 14 }).text).toBe("امروز آخرین روز اشتراک است");
  });
  it("counts down the renewal window", () => {
    const n = subscriptionNotice({ enforced: true, state: "grace", days_left: -2, grace_until: iso(3) });
    expect(n.tone).toBe("danger");
    expect(n.text).toContain("۳ روز");
    expect(subscriptionNotice({ enforced: true, state: "grace", days_left: -5, grace_until: iso(0) }).text).toBe("امروز آخرین روز مهلت تمدید است");
  });
  it("locked", () => {
    expect(subscriptionNotice({ enforced: true, state: "locked", days_left: -9 }).tone).toBe("danger");
  });
});
