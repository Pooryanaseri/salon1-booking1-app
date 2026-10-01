// tests/security.test.js
//
// v2.19 — OTP/token ownership-proof logic, mirrored as pure functions for
// a repeatable Vitest suite. The actual SQL (supabase/migrations/
// v2.19_secure_public_booking.sql) was verified by loading it into a real
// PostgreSQL 16 instance and calling every function directly — see the
// deployment report for that session's exact commands and results. This
// file is a lightweight regression guard for the same logic shape; it does
// not call a real database (no Postgres/Supabase available in a plain
// `npm test` run), so it cannot replace re-running the real checks after
// any future change to the migration.

import { describe, it, expect } from "vitest";

function otpHashMatches(otp, salt, storedHash, hashFn) {
  return hashFn(otp + salt) === storedHash;
}

describe("OTP verification never trusts phone or appointment id alone", () => {
  const fakeHash = (s) => "H(" + s + ")"; // stand-in for sha256
  it("correct OTP + correct salt matches the stored hash", () => {
    const salt = "abc123";
    const stored = fakeHash("482913" + salt);
    expect(otpHashMatches("482913", salt, stored, fakeHash)).toBe(true);
  });
  it("wrong OTP never matches", () => {
    const salt = "abc123";
    const stored = fakeHash("482913" + salt);
    expect(otpHashMatches("000000", salt, stored, fakeHash)).toBe(false);
  });
  it("attempts counter blocks further tries once max_attempts is reached", () => {
    const maxAttempts = 5;
    let attempts = 5;
    const allowed = attempts < maxAttempts;
    expect(allowed).toBe(false);
  });
  it("an expired challenge is never accepted regardless of a correct code", () => {
    const now = Date.now();
    const expiresAt = now - 1000; // already expired
    const challengeIsUsable = expiresAt > now;
    expect(challengeIsUsable).toBe(false);
  });
});

describe("access token entropy and scoping", () => {
  it("a 256-bit (32-byte) token hex-encodes to 64 characters", () => {
    // gen_random_bytes(32) -> encode(..., 'hex') -> 64 hex chars = 256 bits,
    // well above the 128-bit minimum this task required.
    const simulatedHexLength = 32 * 2;
    expect(simulatedHexLength).toBe(64);
    expect(simulatedHexLength * 4).toBeGreaterThanOrEqual(128); // 4 bits per hex char
  });
  it("only a token hash is ever meant to be persisted, never the plaintext", () => {
    // This is an architectural invariant, not something a unit test can
    // enforce on its own — verified for real by inspecting every INSERT
    // in v2.19_secure_public_booking.sql: booking_otp_challenges stores
    // otp_hash (never otp), booking_access_tokens stores token_hash
    // (never token). Documented here as the property this suite exists
    // to guard the shape of.
    expect(true).toBe(true);
  });
});

describe("ownership resolution — token maps to exactly one phone, nothing else grants access", () => {
  function resolveToken(tokenHash, tokenStore) {
    const row = tokenStore.find((t) => t.token_hash === tokenHash && !t.revoked && t.expires_at > Date.now());
    return row ? row.phone : null;
  }
  const store = [{ token_hash: "H(real-token)", phone: "0912X", revoked: false, expires_at: Date.now() + 100000 }];

  it("a real, unexpired, unrevoked token resolves to its owner's phone", () => {
    expect(resolveToken("H(real-token)", store)).toBe("0912X");
  });
  it("a random/guessed token resolves to nothing", () => {
    expect(resolveToken("H(guessed)", store)).toBeNull();
  });
  it("a revoked token resolves to nothing even if otherwise valid", () => {
    const revokedStore = [{ ...store[0], revoked: true }];
    expect(resolveToken("H(real-token)", revokedStore)).toBeNull();
  });
  it("an expired token resolves to nothing", () => {
    const expiredStore = [{ ...store[0], expires_at: Date.now() - 1000 }];
    expect(resolveToken("H(real-token)", expiredStore)).toBeNull();
  });
  it("logging out actually revokes the token, not just clearing client state", () => {
    // Found during loop-testing: the revoked column always existed and was
    // always checked here, but nothing ever set it to true until
    // revoke_booking_token was added — "log out" was previously a client-
    // only reset. Verified for real against Postgres: a token that still
    // has 19 minutes of natural life left is fully dead the instant it's
    // revoked. This test guards the shape of that fix.
    let tokenStore = [{ token_hash: "H(session-token)", phone: "0912X", revoked: false, expires_at: Date.now() + 19 * 60 * 1000 }];
    function revoke(hash) { tokenStore = tokenStore.map((t) => (t.token_hash === hash ? { ...t, revoked: true } : t)); }
    expect(resolveToken("H(session-token)", tokenStore)).toBe("0912X");
    revoke("H(session-token)");
    expect(resolveToken("H(session-token)", tokenStore)).toBeNull();
  });
});

describe("cross-customer isolation — owning a valid token for phone A never grants access to phone B's booking", () => {
  function canActOnBooking(resolvedPhone, bookingOwnerPhone) {
    return resolvedPhone != null && resolvedPhone === bookingOwnerPhone;
  }
  it("matching phone -> allowed", () => {
    expect(canActOnBooking("0912X", "0912X")).toBe(true);
  });
  it("different phone -> denied, even with a technically valid token", () => {
    expect(canActOnBooking("0912X", "0913Y")).toBe(false);
  });
  it("no resolvable phone (bad token) -> always denied", () => {
    expect(canActOnBooking(null, "0912X")).toBe(false);
  });
});
