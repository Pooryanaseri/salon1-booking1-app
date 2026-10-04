// tests/pagination.test.js — v2.42 fetchAllPages (Supabase caps each request at 1000 rows).
import { describe, it, expect } from "vitest";
import { fetchAllPages } from "../src/lib/api.js";

function fakeTable(total, { failAt = null } = {}) {
  const calls = [];
  const make = () => ({
    range: async (from, to) => {
      calls.push(from);
      if (failAt !== null && from >= failAt) return { data: null, error: { message: "boom" } };
      const n = Math.max(0, Math.min(to, total - 1) - from + 1);
      return { data: Array.from({ length: n }, (_, i) => from + i), error: null };
    },
  });
  return { make, calls };
}

describe("fetchAllPages", () => {
  for (const total of [0, 1, 999, 1000, 1001, 2500, 4000, 4001, 9999]) {
    it(`returns all ${total} rows exactly once, in order`, async () => {
      const t = fakeTable(total);
      const { data, error } = await fetchAllPages(t.make);
      expect(error).toBeNull();
      expect(data).toEqual(Array.from({ length: total }, (_, i) => i));
    });
  }
  it("stops on the first short page (no runaway requests)", async () => {
    const t = fakeTable(1500);
    await fetchAllPages(t.make);
    expect(Math.max(...t.calls)).toBeLessThanOrEqual(4000);
  });
  it("reports an error from any page", async () => {
    const t = fakeTable(5000, { failAt: 2000 });
    const { data, error } = await fetchAllPages(t.make);
    expect(data).toBeNull();
    expect(error.message).toBe("boom");
  });
});
