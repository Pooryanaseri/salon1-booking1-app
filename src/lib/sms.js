// ============================================================================
//  SMS client
//  The browser NEVER holds the SMS provider API key. Everything goes through
//  the `send-sms` Supabase Edge Function, which holds the secret server-side
//  and writes an audit row into public.sms_messages.
// ============================================================================
import { supabase, SUPABASE_ENABLED } from "./supabase";

export const SALON_NAME_SMS = import.meta.env.VITE_SALON_NAME || "آرایشگاه مانا";

/* ------------------------------------------------------- template rendering */
export const SMS_PLACEHOLDERS = [
  { token: "{{name}}",     label: "نام مشتری" },
  { token: "{{service}}",  label: "نام خدمت" },
  { token: "{{date}}",     label: "تاریخ (شمسی)" },
  { token: "{{time}}",     label: "ساعت" },
  { token: "{{stylist}}",  label: "نام آرایشگر" },
  { token: "{{code}}",     label: "کد پیگیری" },
  { token: "{{salon}}",    label: "نام سالن" },
  { token: "{{points}}",   label: "امتیاز باشگاه" },
  { token: "{{discount}}", label: "درصد تخفیف" },
  { token: "{{days}}",     label: "تعداد روز عدم مراجعه" },
];

export function renderTemplate(body, vars = {}) {
  const all = { salon: SALON_NAME_SMS, ...vars };
  return String(body || "").replace(/\{\{(\w+)\}\}/g, (_, k) =>
    all[k] === undefined || all[k] === null ? "" : String(all[k])
  );
}

/** Rough Iranian-SMS part count — 70 chars per part for Persian (UCS-2). */
export function smsParts(text) {
  return Math.max(1, Math.ceil((text || "").length / 70));
}

/* ---------------------------------------------------------------- dispatch */
async function invoke(payload) {
  if (!SUPABASE_ENABLED) {
    console.info("[salon/sms] حالت دمو — پیامک واقعی ارسال نشد:", payload);
    return { ok: false, demo: true };
  }
  const { data, error } = await supabase.functions.invoke("send-sms", { body: payload });
  if (error) {
    console.error("[salon/sms] send-sms failed:", error.message);
    return { ok: false, error: error.message };
  }
  return data;
}

/**
 * Send one message now.
 * @param {{to:string, body:string, kind?:string, appointmentId?:string, campaignId?:string}} opts
 */
export function sendSms({ to, body, kind = "custom", appointmentId = null, campaignId = null }) {
  // Deterministic (not random) so a genuine network retry of the same logical
  // action — "send the confirmation for booking X" — reuses the same key and
  // gets recognized server-side, instead of generating a fresh key each time
  // (which would defeat the point of idempotency).
  const idempotencyKey = appointmentId ? `${kind}-${appointmentId}` : null;
  return invoke({ action: "send", messages: [{ to, body, kind, appointment_id: appointmentId, campaign_id: campaignId, idempotency_key: idempotencyKey }] });
}

/** Bulk send (پنل ارسال / کمپین). Chunked server-side. */
export function sendBulkSms(messages, { kind = "custom", campaignId = null } = {}) {
  return invoke({
    action: "send",
    messages: messages.map((m) => ({ ...m, kind: m.kind || kind, campaign_id: m.campaign_id ?? campaignId })),
  });
}

/**
 * Queue a reminder for later. The cron function picks it up when due.
 * `scheduledFor` is an ISO string, computed from the stylist's reminder_hours_before.
 */
export function scheduleReminder({ to, body, appointmentId, scheduledFor, kind = "reminder" }) {
  return invoke({
    action: "schedule",
    messages: [{ to, body, kind, appointment_id: appointmentId, scheduled_for: scheduledFor }],
  });
}

/** Cancel a queued reminder — used when a booking is cancelled or moved. */
export function cancelScheduledReminders(appointmentId) {
  return invoke({ action: "cancel", appointment_id: appointmentId });
}

/**
 * v2.19 — request a 6-digit booking-management OTP by SMS. The plaintext
 * code never reaches this function's return value in real mode — it's
 * generated and sent entirely inside the send-sms Edge Function, which is
 * the only caller granted execute on request_booking_otp_internal.
 */
export function requestBookingOtp(phone) {
  return invoke({ action: "request_otp", phone });
}
