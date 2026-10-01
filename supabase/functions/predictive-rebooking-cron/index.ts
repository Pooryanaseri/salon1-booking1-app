// ============================================================================
//  Edge Function: predictive-rebooking-cron
//  Run once a day via pg_cron or any external scheduler.
//
//  Thin wrapper: calls the SQL engine (run_predictive_rebooking(), v2.26)
//  which does all the candidate-finding and queues sms_messages rows —
//  then drains anything due right now, the same way cron-reminders does,
//  so a daily predictive-engine run and a 5-minute reminder sweep don't
//  need two separate SMS-sending code paths.
//
//  Deploy:  supabase functions deploy predictive-rebooking-cron --no-verify-jwt
//  Schedule: once a day (any time — the SQL function itself has no time-
//  of-day logic, only date-based windows) — see DEPLOY.md.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendOne } from "../_shared/providers.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const INTERNAL_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (INTERNAL_SECRET) {
    const internal = req.headers.get("x-internal-secret");
    if (internal !== INTERNAL_SECRET) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  } else {
    console.warn("[predictive-rebooking-cron] INTERNAL_FUNCTION_SECRET is not set — this endpoint is unauthenticated.");
  }

  const { data: candidateCount, error: engineError } = await admin.rpc("run_predictive_rebooking");
  if (engineError) {
    console.error("[predictive-rebooking-cron] engine failed:", engineError.message);
    return json({ ok: false, error: "engine failed" }, 500);
  }

  // Drain whatever the engine just queued (scheduled_for = now(), so it's
  // immediately due) — same send/update pattern as cron-reminders' DRAIN.
  const { data: due } = await admin
    .from("sms_messages")
    .select("id, to_phone, body")
    .eq("status", "queued")
    .eq("kind", "predictive_rebooking")
    .lte("scheduled_for", new Date().toISOString())
    .limit(500);

  let sent = 0, failed = 0;
  for (const msg of due ?? []) {
    const r = await sendOne(msg.to_phone, msg.body);
    await admin.from("sms_messages").update({
      status: r.ok ? "sent" : "failed",
      provider: r.provider,
      provider_msg_id: r.providerMsgId ?? null,
      error: r.ok ? null : r.error,
      cost: r.cost ?? null,
      sent_at: r.ok ? new Date().toISOString() : null,
    }).eq("id", msg.id);
    r.ok ? sent++ : failed++;
  }

  return json({ ok: true, candidates: candidateCount, sent, failed });
});
