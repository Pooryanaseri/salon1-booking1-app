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

  // v2.34: the queued messages are sent by cron-reminders' drain (claimed
  // atomically there). Sending them here too could send them twice.
  return json({ ok: true, candidates: candidateCount, queued: candidateCount });
});
