// ============================================================================
//  Edge Function: cron-reminders
//  Run every minute (pg_cron — see supabase/cron.sql). Two steps:
//
//   1. SWEEP — belt-and-braces: queue_due_reminders() (SQL, v2.42) queues a
//      reminder for any upcoming booking whose window has opened but which
//      has none queued or sent (bookings created before v2.31, a lost row).
//      Runs in the database: the old version loaded every booking, stylist
//      and service through the REST API, which caps results at 1000 rows —
//      with hundreds of salons reminders went missing silently.
//   2. DRAIN — sends due sms_messages, claimed atomically (v2.34), each
//      through its own salon's SMS account (v2.41), a few at a time.
//
//  Deploy:  supabase functions deploy cron-reminders --no-verify-jwt
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendOne, smsAccounts, mapLimit } from "../_shared/providers.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Deployed with --no-verify-jwt since the scheduler has no user session —
// require the same shared secret send-sms uses.
const INTERNAL_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET");

// Per run: how many due messages to take, and how many provider calls may be
// in flight at once. 300 per minute ≈ 430k a day — far above what hundreds
// of salons send — while each run stays well inside the function time limit.
const BATCH = Number(Deno.env.get("SMS_DRAIN_BATCH") ?? 300);
const CONCURRENCY = Number(Deno.env.get("SMS_DRAIN_CONCURRENCY") ?? 8);

Deno.serve(async (req) => {
  if (INTERNAL_SECRET) {
    const provided = req.headers.get("x-internal-secret");
    if (provided !== INTERNAL_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    console.warn("[cron-reminders] INTERNAL_FUNCTION_SECRET is not set — this endpoint is unauthenticated. Set it with `supabase secrets set INTERNAL_FUNCTION_SECRET=...` and pass it as the x-internal-secret header from your scheduler.");
  }

  const report = { swept: 0, drained: 0, drainFailed: 0, skipped: 0 };

  /* ------------------------------------------------------------ 1. SWEEP --- */
  const { data: swept, error: sweepError } = await admin.rpc("queue_due_reminders", { p_limit: 500 });
  if (sweepError) console.error("[cron-reminders] queue_due_reminders failed:", sweepError.message);
  report.swept = Number(swept ?? 0);

  /* ------------------------------------------------------------ 2. DRAIN --- */
  const { data: due, error: claimError } = await admin.rpc("claim_due_sms", { p_limit: BATCH });
  if (claimError) console.error("[cron-reminders] claim_due_sms failed:", claimError.message);
  // deno-lint-ignore no-explicit-any
  const messages: any[] = due ?? [];
  if (!messages.length) return done(report);

  const accounts = smsAccounts(admin);
  await accounts.preload(messages.map((m) => m.salon_id));

  // An appointment can change state (cancelled, no_show) between queueing
  // its reminder and the reminder being due — recheck right before sending.
  const reminderAppts = [...new Set(messages.filter((m) => m.appointment_id && m.kind === "reminder").map((m) => m.appointment_id))];
  const apptStatus = new Map<string, string>();
  for (let i = 0; i < reminderAppts.length; i += 200) {
    const { data } = await admin.from("appointments").select("id, status").in("id", reminderAppts.slice(i, i + 200));
    for (const a of data ?? []) apptStatus.set(a.id, a.status);
  }

  // v2.43: campaign SMS can sit in the queue (quiet hours) — a customer who
  // opted out meanwhile must not get it.
  const campaignPhones = [...new Set(messages.filter((m) => m.kind === "campaign").map((m) => m.to_phone))];
  const optedOut = new Set<string>();
  for (let i = 0; i < campaignPhones.length; i += 200) {
    const { data } = await admin.from("customers").select("salon_id, phone")
      .in("phone", campaignPhones.slice(i, i + 200)).eq("sms_opt_out", true);
    for (const c of data ?? []) optedOut.add(`${c.salon_id}|${c.phone}`);
  }

  await mapLimit(messages, CONCURRENCY, async (msg) => {
    if (msg.kind === "campaign" && optedOut.has(`${msg.salon_id}|${msg.to_phone}`)) {
      await admin.from("sms_messages").update({ status: "cancelled", error: "customer opted out" }).eq("id", msg.id);
      report.skipped++;
      return;
    }
    if (msg.appointment_id && msg.kind === "reminder") {
      const status = apptStatus.get(msg.appointment_id);
      if (status && !["confirmed", "rescheduled"].includes(status)) {
        await admin.from("sms_messages").update({ status: "cancelled", error: `appointment status became '${status}'` }).eq("id", msg.id);
        report.skipped++;
        return;
      }
    }

    const r = await sendOne(msg.to_phone, msg.body, await accounts.forSalon(msg.salon_id));
    await admin.from("sms_messages").update({
      status: r.ok ? "sent" : "failed",
      provider: r.provider,
      provider_msg_id: r.providerMsgId ?? null,
      error: r.ok ? null : r.error,
      cost: r.cost ?? null,
      sent_at: r.ok ? new Date().toISOString() : null,
    }).eq("id", msg.id);

    if (r.ok && msg.appointment_id && msg.kind === "reminder") {
      await admin.from("appointments").update({ sms_sent_reminder: true }).eq("id", msg.appointment_id);
    }
    r.ok ? report.drained++ : report.drainFailed++;
  });

  return done(report);
});

function done(report: Record<string, number>) {
  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), ...report }), {
    headers: { "Content-Type": "application/json" },
  });
}
