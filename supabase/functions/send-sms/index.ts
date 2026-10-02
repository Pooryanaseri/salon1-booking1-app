// ============================================================================
//  Edge Function: send-sms
//  The only thing in the system that touches the SMS provider. Holds the API
//  key as a Supabase secret, verifies the caller, writes an audit row for every
//  message into public.sms_messages.
//
//  Actions:
//    { action: "send",     messages: [{ to, body, kind, appointment_id?, campaign_id?, campaign_log_id? }] }
//    { action: "schedule", messages: [{ to, body, appointment_id, scheduled_for }] }
//    { action: "cancel",   appointment_id: "..." }
//    { action: "request_otp", phone: "09..." }  -- v2.19: sends a booking-management OTP; see supabase/migrations/v2.19_secure_public_booking.sql
//
//  Deploy:  supabase functions deploy send-sms
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendOne, normalizePhone, activeProvider } from "../_shared/providers.ts";

// SECURITY: fail closed. An unset ALLOWED_ORIGIN used to default to "*" —
// any website could call this function from a visitor's browser using
// their session. Now, if it's unset, no Access-Control-Allow-Origin header
// is sent at all, so browsers block cross-origin access by default (this
// only affects browser-enforced CORS; server-to-server calls, e.g. the
// app's own backend or curl, are unaffected either way).
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN");
const CORS: Record<string, string> = {
  ...(ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN } : {}),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// service_role bypasses RLS — required to write the audit log.
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const MAX_BATCH = Number(Deno.env.get("SMS_MAX_BATCH") ?? 200);

/** Only owner/manager may fire SMS. Booking-triggered messages use the shared secret. */
async function authorize(req: Request): Promise<{ ok: boolean; role?: string; error?: string }> {
  const internal = req.headers.get("x-internal-secret");
  if (internal && internal === Deno.env.get("INTERNAL_FUNCTION_SECRET")) {
    return { ok: true, role: "system" };
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "احراز هویت لازم است" };

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    // Anonymous visitors (the public booking pages) get a restricted role:
    // OTP requests and withdrawing feedback follow-ups only — see
    // ANON_CANCELLABLE_KINDS and the anon check before "schedule"/"send".
    return { ok: true, role: "anon" };
  }

  const { data: profile } = await admin
    .from("users").select("role, active").eq("id", data.user.id).maybeSingle();

  if (!profile?.active) return { ok: false, error: "حساب غیرفعال است" };
  return { ok: true, role: profile.role };
}

// v2.31: anonymous callers can no longer send or schedule anything — the
// booking confirmation, stylist notice and reminder are queued by the
// database itself (supabase/migrations/v2.31_server_owned_booking_sms.sql).
// Accepting a caller-chosen recipient and text here made this endpoint an
// open SMS relay on the salon's sender and credit. What an anonymous page
// may still do: request a login OTP for its own number, and withdraw the
// feedback follow-up after the customer has answered (FeedbackPage).
const ANON_CANCELLABLE_KINDS = ["feedback_request", "feedback_followup"];


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const auth = await authorize(req);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "بدنه‌ی درخواست نامعتبر است" }, 400);
  }

  const action = payload.action ?? "send";

  /* ------------------------------------------------------------- cancel ---- */
  if (action === "cancel") {
    if (!payload.appointment_id) return json({ ok: false, error: "appointment_id لازم است" }, 400);
    let query = admin
      .from("sms_messages")
      .delete({ count: "exact" })
      .eq("appointment_id", payload.appointment_id)
      .eq("status", "queued");
    if (auth.role === "anon") query = query.in("kind", ANON_CANCELLABLE_KINDS);
    const { error, count } = await query;
    if (error) { console.error("[send-sms/cancel] db error:", error.message); return json({ ok: false, error: "لغو ناموفق بود" }, 500); }
    return json({ ok: true, cancelled: count ?? 0 });
  }

  /* --------------------------------------------------------- request_otp ---- */
  // v2.19 — the only place the plaintext OTP ever exists outside the
  // customer's own phone. request_booking_otp_internal is granted to
  // service_role only (not anon/authenticated), so this admin-client call
  // is the sole way to reach it. The OTP is sent by SMS and never appears
  // in this function's response, logs, or any stored row beyond its own
  // salted hash (written by the RPC itself).
  if (action === "request_otp") {
    const phone = normalizePhone(payload.phone ?? "");
    const salonId = payload.salon_id ?? null;
    if (!/^09\d{9}$/.test(phone)) return json({ ok: false, error: "شماره نامعتبر است" }, 400);
    if (!salonId) return json({ ok: false, error: "سالن نامعتبر است" }, 400);

    const { data, error } = await admin.rpc("request_booking_otp_internal", { p_phone: phone, p_salon_id: salonId });
    if (error) { console.error("[send-sms/request_otp] rpc error:", error.message); return json({ ok: false, error: "درخواست کد ناموفق بود" }, 500); }
    if (!data?.ok) return json({ ok: false, error: data?.error ?? "درخواست کد ناموفق بود" });

    const body = `کد تایید شما: ${data.otp}\nاین کد ظرف ۵ دقیقه منقضی می‌شود.`;
    const r = await sendOne(phone, body);
    await admin.from("sms_messages").insert({
      salon_id: salonId, to_phone: phone, body, kind: "otp", status: r.ok ? "sent" : "failed",
      provider: r.provider, provider_msg_id: r.providerMsgId ?? null,
      error: r.ok ? null : r.error, cost: r.cost ?? null,
      sent_at: r.ok ? new Date().toISOString() : null,
    });
    if (!r.ok) return json({ ok: false, error: "ارسال پیامک ناموفق بود" }, 502);

    // Testing without a real SMS provider: only when the project owner has
    // explicitly set SMS_DRY_RUN=true (sendOne already skips the real send
    // and just logs in that mode — see providers.ts). Off by default, so
    // this never activates in a normal/production configuration; the OTP
    // is returned only to the same caller who just requested it for their
    // own phone, never to anyone else.
    const devOtp = Deno.env.get("SMS_DRY_RUN") === "true" ? data.otp : undefined;
    return json({ ok: true, expires_in_seconds: data.expires_in_seconds, ...(devOtp ? { dev_otp: devOtp } : {}) });
  }

  if (auth.role === "anon") {
    return json({ ok: false, error: "برای ارسال پیامک باید وارد شوید" }, 403);
  }

  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) return json({ ok: false, error: "پیامی برای ارسال وجود ندارد" }, 400);
  if (messages.length > MAX_BATCH) {
    return json({ ok: false, error: `حداکثر ${MAX_BATCH} پیام در هر درخواست` }, 400);
  }

  /* ----------------------------------------------------------- schedule ---- */
  if (action === "schedule") {
    const rows = messages.map((m) => ({
      to_phone: normalizePhone(m.to),
      body: m.body,
      kind: m.kind ?? "reminder",
      appointment_id: m.appointment_id ?? null,
      campaign_id: m.campaign_id ?? null,
      scheduled_for: m.scheduled_for,
      status: "queued",
    })).filter((r) => r.scheduled_for && new Date(r.scheduled_for).getTime() > Date.now());

    if (!rows.length) return json({ ok: true, queued: 0, note: "زمان یادآوری گذشته بود" });

    // salon_id is derived from each row's own appointment — never trusted
    // from the caller — so a message can't be filed under a different
    // salon than the appointment it's actually about.
    const apptIds = [...new Set(rows.map((r) => r.appointment_id).filter(Boolean))];
    let salonByAppt = {};
    if (apptIds.length) {
      const { data: appts } = await admin.from("appointments").select("id, salon_id").in("id", apptIds);
      salonByAppt = Object.fromEntries((appts ?? []).map((a) => [a.id, a.salon_id]));
    }
    const rowsWithSalon = rows
      .map((r) => ({ ...r, salon_id: r.appointment_id ? salonByAppt[r.appointment_id] : null }))
      .filter((r) => r.salon_id); // an appointment_id that didn't resolve is dropped, not silently filed under no salon

    if (!rowsWithSalon.length) return json({ ok: true, queued: 0, note: "زمان یادآوری گذشته بود" });

    const { error } = await admin.from("sms_messages").insert(rowsWithSalon);
    if (error) { console.error("[send-sms/schedule] db error:", error.message); return json({ ok: false, error: "ثبت یادآوری ناموفق بود" }, 500); }
    return json({ ok: true, queued: rowsWithSalon.length });
  }

  /* --------------------------------------------------------------- send ---- */
  const results = [];
  const auditRows = [];

  for (const m of messages) {
    const to = normalizePhone(m.to);
    const body = String(m.body ?? "").trim();
    const idempotencyKey = m.idempotency_key ? String(m.idempotency_key).slice(0, 128) : null;

    if (!body) {
      results.push({ to, ok: false, error: "متن پیام خالی است" });
      continue;
    }

    // Resolve which salon this message belongs to — from the appointment
    // or campaign it references (never trusted from the caller for those
    // cases, since it must match an existing row), or an explicit
    // salon_id on the message itself for a truly ad-hoc send with neither.
    let salonId = m.salon_id ?? null;
    if (m.appointment_id) {
      const { data: appt } = await admin.from("appointments").select("salon_id").eq("id", m.appointment_id).maybeSingle();
      salonId = appt?.salon_id ?? null;
    } else if (m.campaign_id) {
      const { data: camp } = await admin.from("campaigns").select("salon_id").eq("id", m.campaign_id).maybeSingle();
      salonId = camp?.salon_id ?? null;
    }
    if (!salonId) {
      results.push({ to, ok: false, error: "سالن این پیام مشخص نیست" });
      continue;
    }

    // Idempotency: if this exact key was already processed (e.g. the client
    // retried a request whose response got lost on the way back), reuse
    // that outcome instead of sending the SMS again. Scoped to this salon
    // — the same key could legitimately recur at a different salon.
    if (idempotencyKey) {
      const { data: existing } = await admin
        .from("sms_messages").select("status").eq("salon_id", salonId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existing) {
        results.push({ to, ok: existing.status === "sent", idempotent: true });
        continue;
      }
    }

    // Respect opt-out for anything marketing-flavoured — scoped to this
    // salon's own customer row for this phone, not any salon's.
    if (m.kind === "campaign" || m.kind === "loyalty") {
      const { data: cust } = await admin
        .from("customers").select("sms_opt_out").eq("phone", to).eq("salon_id", salonId).maybeSingle();
      if (cust?.sms_opt_out) {
        results.push({ to, ok: false, error: "مشتری از دریافت پیام‌های تبلیغاتی انصراف داده" });
        continue;
      }
    }

    const r = await sendOne(to, body);

    auditRows.push({
      salon_id: salonId,
      to_phone: to,
      idempotency_key: idempotencyKey,
      body,
      kind: m.kind ?? "custom",
      appointment_id: m.appointment_id ?? null,
      campaign_id: m.campaign_id ?? null,
      campaign_log_id: m.campaign_log_id ?? null,
      provider: r.provider,
      provider_msg_id: r.providerMsgId ?? null,
      status: r.ok ? "sent" : "failed",
      error: r.ok ? null : r.error,
      cost: r.cost ?? null,
      sent_at: r.ok ? new Date().toISOString() : null,
    });

    results.push({ to, ok: r.ok, error: r.error });

    if (r.ok && m.appointment_id && m.kind === "confirmation") {
      await admin.from("appointments")
        .update({ sms_sent_confirmation: true })
        .eq("id", m.appointment_id);
    }
  }

  if (auditRows.length) {
    const { error } = await admin.from("sms_messages").insert(auditRows);
    if (error) console.error("[send-sms] audit insert failed:", error.message);
  }

  // Keep campaign counters honest.
  const campaignId = messages[0]?.campaign_id;
  if (campaignId) {
    const sent = results.filter((r) => r.ok).length;
    const { data: c } = await admin
      .from("campaigns").select("sent_count").eq("id", campaignId).maybeSingle();
    await admin.from("campaigns")
      .update({ sent_count: (c?.sent_count ?? 0) + sent, status: "sent" })
      .eq("id", campaignId);
  }

  const sent = results.filter((r) => r.ok).length;
  return json({
    ok: sent > 0,
    provider: activeProvider(),
    sent,
    failed: results.length - sent,
    results,
  });
});
