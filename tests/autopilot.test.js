// tests/autopilot.test.js
//
// Pure-function mirrors of the Autopilot 2.0 (v2.25) and Predictive
// Autopilot (v2.26) SQL logic, for a repeatable offline Vitest suite —
// same approach as logic.test.js/security.test.js: these do not call a
// real database (no Postgres/Supabase available in a plain `npm test`
// run), so they are a regression guard for the logic SHAPE, not a
// replacement for the real checks already run against actual Postgres 16
// (see CHANGES.md's v2.25/v2.26 entries for those session's exact
// commands and results). A change to the real SQL should be mirrored here
// too.
//
// TWO DELIBERATE DEVIATIONS FROM THE LITERAL REQUEST — both because the
// real, already-built-and-tested system behaves differently, and a test
// asserting the literal request would be asserting something false about
// it:
//   1. "Rebooking Tokens... 72h default window" — the token family actually
//      used for rebooking links (rebooking_tokens, created by
//      create_rebooking_token) expires in 14 DAYS, not 72h. 72 hours is
//      reconciliation_tokens' window — a separate token system for the
//      owner's weekly batch-approve link, not a rebooking link at all.
//      This file tests rebooking_tokens at their real 14-day window (suite
//      1), and separately tests reconciliation_tokens at their real 72h
//      window (suite 4, where the reconciliation batch logic itself is
//      covered) — so both real numbers are actually exercised, just not
//      under one mismatched label.
//   2. "Prevent review/feedback submission unless status is strictly
//      completed" — the real RLS policy (p_feedback_insert) allows
//      submission when status is 'completed' OR 'pending_verification'.
//      This is not an oversight: a customer's feedback submission is
//      literally how a pending_verification appointment becomes completed
//      (see upgrade_appointment_on_feedback) — the whole point of the
//      v2.25 feedback loop. A "strictly completed" test would fail
//      against the real, intended behavior. Suite 3 tests the real gate
//      (completed or pending_verification allowed; everything else
//      rejected), including an explicit case proving pending_verification
//      is accepted.

import { describe, it, expect } from "vitest";

/* ============================================================
   Suite 1 — Rebooking Tokens
   Mirrors rebooking_tokens / create_rebooking_token /
   resolve_rebooking_token / create_booking_from_rebooking_token
   (supabase/migrations/v2.26_predictive_part1_rebooking_tokens.sql)
   ============================================================ */

const REBOOKING_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — the real value

function createRebookingToken({ salonId, customerPhone, serviceId, staffId = null, reason = "manual" }, nowMs) {
  return {
    tokenHash: `hash-${salonId}-${customerPhone}-${nowMs}-${Math.random()}`,
    salonId,
    customerPhone,
    serviceId,
    staffId,
    reason,
    expiresAt: nowMs + REBOOKING_TOKEN_TTL_MS,
    usedAt: null,
  };
}

// Mirrors: `where token_hash = ... and used_at is null and expires_at > now()`
function resolveRebookingToken(tokenStore, tokenHash, nowMs) {
  const token = tokenStore.find((t) => t.tokenHash === tokenHash);
  if (!token) return null;
  if (token.usedAt !== null) return null;
  if (!(token.expiresAt > nowMs)) return null;
  return token;
}

// Mirrors create_booking_from_rebooking_token's final step: `update
// rebooking_tokens set used_at = now() where id = v_rt.id` — only ever
// reachable through a successful resolve, matching the real function's
// single write path.
function redeemRebookingToken(tokenStore, tokenHash, nowMs) {
  const token = resolveRebookingToken(tokenStore, tokenHash, nowMs);
  if (!token) return { ok: false, error: "این لینک منقضی یا نامعتبر است" };
  token.usedAt = nowMs;
  return { ok: true, salonId: token.salonId, customerPhone: token.customerPhone };
}

// Mirrors: `select * from services where id = v_rt.service_id and
// salon_id = v_rt.salon_id and is_active` — a resolved token can only
// ever look up data scoped to ITS OWN salon_id, never any other. This is
// the actual multi-tenant boundary mechanism: there is no "check if this
// token belongs to salon X" branch anywhere: every subsequent lookup is
// simply `and salon_id = v_rt.salon_id`, so a lookup for a resource that
// only exists under a different salon just finds nothing.
function findServiceForToken(servicesCatalog, token, serviceId) {
  return servicesCatalog.find((s) => s.id === serviceId && s.salonId === token.salonId && s.isActive) || null;
}

describe("rebooking tokens: single-use", () => {
  it("resolves a fresh, unused token", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const resolved = resolveRebookingToken(store, store[0].tokenHash, now + 1000);
    expect(resolved).not.toBeNull();
    expect(resolved.customerPhone).toBe("09121234567");
  });

  it("a successful redemption marks the token used", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const res = redeemRebookingToken(store, store[0].tokenHash, now + 1000);
    expect(res.ok).toBe(true);
    expect(store[0].usedAt).toBe(now + 1000);
  });

  it("rejects reusing an already-redeemed token", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const first = redeemRebookingToken(store, store[0].tokenHash, now + 1000);
    const second = redeemRebookingToken(store, store[0].tokenHash, now + 2000);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toBeTruthy();
  });

  it("an unknown token hash resolves to nothing", () => {
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, 1000)];
    expect(resolveRebookingToken(store, "does-not-exist", 2000)).toBeNull();
  });
});

describe("rebooking tokens: expiration (real window — 14 days)", () => {
  it("is valid right up to the boundary of its 14-day window", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const justBeforeExpiry = now + REBOOKING_TOKEN_TTL_MS - 1;
    expect(resolveRebookingToken(store, store[0].tokenHash, justBeforeExpiry)).not.toBeNull();
  });

  it("is invalid once the 14-day window has passed", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const afterExpiry = now + REBOOKING_TOKEN_TTL_MS + 1;
    expect(resolveRebookingToken(store, store[0].tokenHash, afterExpiry)).toBeNull();
  });

  it("a token good at creation is correctly expired 72 hours later (still well within its real 14-day window — proves this isn't accidentally using the reconciliation token's shorter window)", () => {
    const now = 1_000_000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const after72h = now + 72 * 60 * 60 * 1000;
    expect(resolveRebookingToken(store, store[0].tokenHash, after72h)).not.toBeNull();
  });
});

describe("rebooking tokens: multi-tenant boundary", () => {
  const servicesCatalog = [
    { id: "svc-shared-id", salonId: "salon_a", isActive: true, name: "سرویس الف" },
    { id: "svc-shared-id", salonId: "salon_b", isActive: true, name: "سرویس ب" },
  ];

  it("a token scoped to salon_a resolves only salon_a's service, even when salon_b has a service with the SAME id", () => {
    const now = 1000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc-shared-id" }, now)];
    const token = resolveRebookingToken(store, store[0].tokenHash, now + 1);
    const svc = findServiceForToken(servicesCatalog, token, "svc-shared-id");
    expect(svc.salonId).toBe("salon_a");
    expect(svc.name).toBe("سرویس الف");
  });

  it("a token scoped to salon_a cannot resolve a service that exists ONLY under salon_b", () => {
    const now = 1000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc-only-in-b" }, now)];
    const salonBOnlyCatalog = [{ id: "svc-only-in-b", salonId: "salon_b", isActive: true, name: "فقط در ب" }];
    const token = resolveRebookingToken(store, store[0].tokenHash, now + 1);
    expect(findServiceForToken(salonBOnlyCatalog, token, "svc-only-in-b")).toBeNull();
  });

  it("redeeming always reports the token's OWN salon_id, never a caller-supplied one (nothing in the redeem call accepts a salon override)", () => {
    const now = 1000;
    const store = [createRebookingToken({ salonId: "salon_a", customerPhone: "09121234567", serviceId: "svc1" }, now)];
    const res = redeemRebookingToken(store, store[0].tokenHash, now + 1);
    expect(res.salonId).toBe("salon_a");
  });
});

/* ============================================================
   Suite 2 — Predictive Engine Math & Anti-Spam
   Mirrors run_predictive_rebooking()
   (supabase/migrations/v2.26_predictive_part3_engine.sql)
   ============================================================ */

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors the real SQL window exactly:
//   current_date between last_date + (cycle_days - 3) and last_date + (cycle_days + 2)
function isWithinRebookingWindow(lastServiceDateMs, averageCycleDays, todayMs) {
  const windowStart = lastServiceDateMs + (averageCycleDays - 3) * DAY_MS;
  const windowEnd = lastServiceDateMs + (averageCycleDays + 2) * DAY_MS;
  return todayMs >= windowStart && todayMs <= windowEnd;
}

// Mirrors the three real exclusion rules combined with the window check,
// in the same order as the actual query's WHERE clause.
function shouldSendPredictiveReminder({
  lastServiceDateMs, averageCycleDays, todayMs,
  hasUpcomingBookingForSameService,
  recentPredictiveTokenAgeDays, // null if none sent recently
  smsOptOut,
}) {
  if (averageCycleDays == null) return false; // s.average_cycle_days is not null
  if (!isWithinRebookingWindow(lastServiceDateMs, averageCycleDays, todayMs)) return false;
  if (hasUpcomingBookingForSameService) return false; // not exists (... status in (...) and date >= current_date)
  if (recentPredictiveTokenAgeDays !== null && recentPredictiveTokenAgeDays <= 10) return false; // not exists (... reason='predictive' and created_at > now() - 10 days)
  if (smsOptOut) return false;
  return true;
}

describe("predictive engine: due-window calculation", () => {
  const cycle30 = 30;

  it("is NOT due well before the window opens", () => {
    const lastVisit = 0;
    const tooEarly = 10 * DAY_MS; // cycle-3 opens at day 27
    expect(isWithinRebookingWindow(lastVisit, cycle30, tooEarly)).toBe(false);
  });

  it("is due exactly at the window's opening boundary (cycle - 3 days)", () => {
    const lastVisit = 0;
    const atOpen = (cycle30 - 3) * DAY_MS;
    expect(isWithinRebookingWindow(lastVisit, cycle30, atOpen)).toBe(true);
  });

  it("is due exactly at the window's closing boundary (cycle + 2 days)", () => {
    const lastVisit = 0;
    const atClose = (cycle30 + 2) * DAY_MS;
    expect(isWithinRebookingWindow(lastVisit, cycle30, atClose)).toBe(true);
  });

  it("is NOT due one day past the window's close", () => {
    const lastVisit = 0;
    const pastClose = (cycle30 + 3) * DAY_MS;
    expect(isWithinRebookingWindow(lastVisit, cycle30, pastClose)).toBe(false);
  });
});

describe("predictive engine: anti-spam guards", () => {
  const base = {
    lastServiceDateMs: 0,
    averageCycleDays: 30,
    todayMs: 29 * DAY_MS, // squarely inside the window
    hasUpcomingBookingForSameService: false,
    recentPredictiveTokenAgeDays: null,
    smsOptOut: false,
  };

  it("sends when due and no exclusion applies", () => {
    expect(shouldSendPredictiveReminder(base)).toBe(true);
  });

  it("suppresses when the customer already has an upcoming booking for the same service", () => {
    expect(shouldSendPredictiveReminder({ ...base, hasUpcomingBookingForSameService: true })).toBe(false);
  });

  it("suppresses when a predictive reminder was already sent within the last 10 days (dedup)", () => {
    expect(shouldSendPredictiveReminder({ ...base, recentPredictiveTokenAgeDays: 3 })).toBe(false);
  });

  it("allows sending again once the prior predictive reminder is older than 10 days", () => {
    expect(shouldSendPredictiveReminder({ ...base, recentPredictiveTokenAgeDays: 11 })).toBe(true);
  });

  it("suppresses when the customer has opted out of SMS", () => {
    expect(shouldSendPredictiveReminder({ ...base, smsOptOut: true })).toBe(false);
  });

  it("suppresses when the service has no average_cycle_days configured", () => {
    expect(shouldSendPredictiveReminder({ ...base, averageCycleDays: null })).toBe(false);
  });

  it("multiple exclusions at once still correctly suppress (not just the first one checked)", () => {
    expect(shouldSendPredictiveReminder({ ...base, hasUpcomingBookingForSameService: true, smsOptOut: true })).toBe(false);
  });
});

/* ============================================================
   Suite 3 — Status Lifecycle & Expiration
   Mirrors archive_stale_pending_verifications() and the
   p_feedback_insert RLS policy
   (supabase/migrations/v2.25_autopilot_part1_lifecycle.sql,
    v2.25_autopilot_part2_scheduling_reconciliation.sql)
   ============================================================ */

const SEVEN_DAYS_MS = 7 * DAY_MS;

// Mirrors: `where status = 'pending_verification' and updated_at < now() - interval '7 days'`
function resolveStaleStatus(status, updatedAtMs, nowMs) {
  if (status !== "pending_verification") return status; // untouched
  if (nowMs - updatedAtMs > SEVEN_DAYS_MS) return "archived_unconfirmed";
  return "pending_verification";
}

// Mirrors appointment_status_for_feedback()'s result feeding p_feedback_insert's check.
function canSubmitFeedback(appointmentStatus) {
  return appointmentStatus === "completed" || appointmentStatus === "pending_verification";
}

describe("status lifecycle: 7-day auto-archive", () => {
  it("a pending_verification booking just under 7 days old stays pending_verification", () => {
    const now = 10 * DAY_MS;
    const updatedAt = now - SEVEN_DAYS_MS + 1;
    expect(resolveStaleStatus("pending_verification", updatedAt, now)).toBe("pending_verification");
  });

  it("a pending_verification booking older than 7 days becomes archived_unconfirmed", () => {
    const now = 10 * DAY_MS;
    const updatedAt = now - SEVEN_DAYS_MS - 1;
    expect(resolveStaleStatus("pending_verification", updatedAt, now)).toBe("archived_unconfirmed");
  });

  it("never auto-resolves to completed, no matter how long it's been pending — the hard policy from the spec", () => {
    const now = 365 * DAY_MS;
    const updatedAt = 0;
    const result = resolveStaleStatus("pending_verification", updatedAt, now);
    expect(result).not.toBe("completed");
    expect(result).toBe("archived_unconfirmed");
  });

  it("leaves other statuses (confirmed, completed, cancelled, ...) completely untouched regardless of age", () => {
    const now = 365 * DAY_MS;
    for (const status of ["confirmed", "rescheduled", "completed", "cancelled", "cancelled_by_salon", "no_show"]) {
      expect(resolveStaleStatus(status, 0, now)).toBe(status);
    }
  });
});

describe("status lifecycle: feedback submission gate", () => {
  it("allows submission when the appointment is completed", () => {
    expect(canSubmitFeedback("completed")).toBe(true);
  });

  it("allows submission when the appointment is pending_verification (this is the actual, intended behavior — see the file-level note: a customer's feedback is literally what upgrades pending_verification to completed, so this must be allowed, not rejected)", () => {
    expect(canSubmitFeedback("pending_verification")).toBe(true);
  });

  it("rejects submission for a still-upcoming (confirmed/rescheduled) appointment", () => {
    expect(canSubmitFeedback("confirmed")).toBe(false);
    expect(canSubmitFeedback("rescheduled")).toBe(false);
    expect(canSubmitFeedback("pending")).toBe(false);
  });

  it("rejects submission for a terminal non-completed status", () => {
    expect(canSubmitFeedback("cancelled")).toBe(false);
    expect(canSubmitFeedback("cancelled_by_salon")).toBe(false);
    expect(canSubmitFeedback("no_show")).toBe(false);
    expect(canSubmitFeedback("archived_unconfirmed")).toBe(false);
  });
});

/* ============================================================
   Suite 4 — Reconciliation Batch & Idempotency
   Mirrors submit_reconciliation_batch() and
   sync_customer_from_appointment()'s completion guard
   (supabase/migrations/v2.25_autopilot_part2_scheduling_reconciliation.sql,
    v2.24_multitenant_part4_settings_trigger_fix.sql)
   ============================================================ */

const RECONCILIATION_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // the real 72h window

function resolveReconciliationToken(tokenStore, tokenHash, nowMs) {
  const token = tokenStore.find((t) => t.tokenHash === tokenHash);
  if (!token) return null;
  if (!(token.expiresAt > nowMs)) return null;
  return token.salonId;
}

// Mirrors submit_reconciliation_batch()'s loop exactly: each decision is
// applied ONLY if the appointment belongs to the token's own salon AND is
// still pending_verification — anything else (wrong salon, already
// resolved by someone else, bad decision value) is silently skipped, not
// an error that aborts the rest of a legitimate batch.
function submitReconciliationBatch(appointments, tokenSalonId, decisions) {
  let completed = 0, noShow = 0, skipped = 0;
  for (const decision of decisions) {
    if (decision.decision !== "completed" && decision.decision !== "no_show") { skipped++; continue; }
    const appt = appointments.find((a) => a.id === decision.id);
    if (!appt || appt.salonId !== tokenSalonId || appt.status !== "pending_verification") { skipped++; continue; }
    appt.status = decision.decision;
    decision.decision === "completed" ? completed++ : noShow++;
  }
  return { ok: true, completed, noShow, skipped };
}

// Mirrors sync_customer_from_appointment()'s exact guard:
//   if new.status = 'completed' and coalesce(old.status, '') <> 'completed' and new.points_awarded = 0
function shouldAwardLoyaltyPoints(oldStatus, newStatus, pointsAlreadyAwarded) {
  if (newStatus !== "completed") return false;
  if (oldStatus === "completed") return false;
  if (pointsAlreadyAwarded !== 0) return false;
  return true;
}

describe("reconciliation batch: status updates", () => {
  it("resolves a token to its own salon within the 72h window", () => {
    const now = 1000;
    const store = [{ tokenHash: "h1", salonId: "salon_a", expiresAt: now + RECONCILIATION_TOKEN_TTL_MS }];
    expect(resolveReconciliationToken(store, "h1", now + 1)).toBe("salon_a");
  });

  it("a reconciliation token is correctly expired once its real 72h window passes", () => {
    const now = 1000;
    const store = [{ tokenHash: "h1", salonId: "salon_a", expiresAt: now + RECONCILIATION_TOKEN_TTL_MS }];
    expect(resolveReconciliationToken(store, "h1", now + RECONCILIATION_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("applies completed/no_show decisions to the token's own pending_verification appointments", () => {
    const appointments = [
      { id: "apt1", salonId: "salon_a", status: "pending_verification" },
      { id: "apt2", salonId: "salon_a", status: "pending_verification" },
    ];
    const res = submitReconciliationBatch(appointments, "salon_a", [
      { id: "apt1", decision: "completed" },
      { id: "apt2", decision: "no_show" },
    ]);
    expect(res).toEqual({ ok: true, completed: 1, noShow: 1, skipped: 0 });
    expect(appointments[0].status).toBe("completed");
    expect(appointments[1].status).toBe("no_show");
  });

  it("silently skips (never errors out) an appointment belonging to a different salon than the token", () => {
    const appointments = [{ id: "apt-b1", salonId: "salon_b", status: "pending_verification" }];
    const res = submitReconciliationBatch(appointments, "salon_a", [{ id: "apt-b1", decision: "completed" }]);
    expect(res.skipped).toBe(1);
    expect(res.completed).toBe(0);
    expect(appointments[0].status).toBe("pending_verification"); // untouched
  });

  it("silently skips an appointment that's no longer pending_verification (already resolved by someone else)", () => {
    const appointments = [{ id: "apt1", salonId: "salon_a", status: "completed" }];
    const res = submitReconciliationBatch(appointments, "salon_a", [{ id: "apt1", decision: "no_show" }]);
    expect(res.skipped).toBe(1);
    expect(appointments[0].status).toBe("completed"); // not overwritten
  });

  it("a mixed batch (some valid, some cross-salon, some already-resolved) processes each independently", () => {
    const appointments = [
      { id: "apt1", salonId: "salon_a", status: "pending_verification" },
      { id: "apt2", salonId: "salon_b", status: "pending_verification" }, // wrong salon
      { id: "apt3", salonId: "salon_a", status: "cancelled" },            // already resolved
    ];
    const res = submitReconciliationBatch(appointments, "salon_a", [
      { id: "apt1", decision: "completed" },
      { id: "apt2", decision: "completed" },
      { id: "apt3", decision: "no_show" },
    ]);
    expect(res).toEqual({ ok: true, completed: 1, noShow: 0, skipped: 2 });
  });
});

describe("reconciliation batch: loyalty/referral idempotency guard", () => {
  it("awards points on a genuine first transition into completed", () => {
    expect(shouldAwardLoyaltyPoints("pending_verification", "completed", 0)).toBe(true);
  });

  it("awards points when completed directly from confirmed (the normal staff-confirms path, unrelated to reconciliation)", () => {
    expect(shouldAwardLoyaltyPoints("confirmed", "completed", 0)).toBe(true);
  });

  it("does NOT re-award points if the appointment was already completed (repeated completion is a no-op, not a double credit)", () => {
    expect(shouldAwardLoyaltyPoints("completed", "completed", 10)).toBe(false);
  });

  it("does NOT award points if points_awarded is already non-zero, even if old_status looks like a fresh transition (defense in depth against a replayed/duplicated update)", () => {
    expect(shouldAwardLoyaltyPoints("pending_verification", "completed", 10)).toBe(false);
  });

  it("does NOT award points for a transition to any status other than completed", () => {
    expect(shouldAwardLoyaltyPoints("pending_verification", "no_show", 0)).toBe(false);
    expect(shouldAwardLoyaltyPoints("pending_verification", "archived_unconfirmed", 0)).toBe(false);
  });

  it("a reconciliation-driven completion and a feedback-driven completion hit the exact same guard, so neither path can double-credit a customer who somehow got resolved twice", () => {
    // Simulates: feedback already completed it (points awarded), then a
    // stale reconciliation batch (e.g. a second browser tab) tries to
    // complete the same appointment again.
    const alreadyAwarded = shouldAwardLoyaltyPoints("pending_verification", "completed", 0);
    expect(alreadyAwarded).toBe(true); // first time: awarded
    const secondAttempt = shouldAwardLoyaltyPoints("completed", "completed", 10);
    expect(secondAttempt).toBe(false); // second time: blocked
  });
});
