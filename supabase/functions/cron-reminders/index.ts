// ============================================================================
//  Edge Function: cron-reminders
//  Run every 5 minutes (pg_cron or any external scheduler). Does two jobs:
//
//   1. DRAIN — sends any queued sms_messages whose scheduled_for is now due.
//   2. SWEEP — belt-and-braces: finds upcoming appointments whose reminder
//      window (the stylist's own reminder_hours_before) has opened but which
//      have no reminder queued or sent, and sends them. This covers bookings
//      created before this feature shipped, or a lost queue row.
//
//  Deploy:  supabase functions deploy cron-reminders --no-verify-jwt
//  Schedule: see DEPLOY.md step 6.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendOne } from "../_shared/providers.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Deployed with --no-verify-jwt since the scheduler has no user session —
// but that also means anyone who finds the URL could invoke it. This can't
// be tricked into sending arbitrary content (every message here is built
// server-side from real appointment data, and sends are already
// de-duplicated), so the practical risk was wasted invocations/cost rather
// than fraud — but require the same shared secret send-sms uses anyway.
const INTERNAL_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET");

// The salon's wall-clock offset. Appointments store a local date + minutes.
// Iran is UTC+03:30 = 210 minutes (Iran dropped DST in 2022, so this is stable).
const TZ_OFFSET_MIN = Number(Deno.env.get("SALON_TZ_OFFSET_MINUTES") ?? 210);
const SALON_NAME = Deno.env.get("SALON_NAME") ?? "آرایشگاه مانا";

/* ------------------------------------------------- Jalali + Persian digits */
function gregorianToJalali(gy: number, gm: number, gd: number) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);
  return { jy, jm, jd };
}
const MONTHS_FA = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
const FA_DIGITS = ["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"];
const toFa = (s: string | number) => String(s).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);

function jalaliLabel(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const j = gregorianToJalali(y, m, d);
  return `${toFa(j.jd)} ${MONTHS_FA[j.jm - 1]}`;
}
const clockLabel = (mins: number) =>
  `${toFa(String(Math.floor(mins / 60)).padStart(2, "0"))}:${toFa(String(mins % 60).padStart(2, "0"))}`;

/** Local salon date + minute-of-day -> real UTC instant. */
function appointmentInstant(dateISO: string, startMin: number): number {
  const [y, m, d] = dateISO.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0) + (startMin - TZ_OFFSET_MIN) * 60_000;
}

function render(body: string, vars: Record<string, string>) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

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

  const now = Date.now();
  const report = { drained: 0, drainFailed: 0, swept: 0, sweepFailed: 0 };

  /* ------------------------------------------------------------ 1. DRAIN --- */
  const { data: due } = await admin
    .from("sms_messages")
    .select("id, to_phone, body, kind, appointment_id")
    .eq("status", "queued")
    .lte("scheduled_for", new Date(now).toISOString())
    .limit(200);

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

    if (r.ok && msg.appointment_id && msg.kind === "reminder") {
      await admin.from("appointments")
        .update({ sms_sent_reminder: true })
        .eq("id", msg.appointment_id);
    }
    r.ok ? report.drained++ : report.drainFailed++;
  }

  /* ------------------------------------------------------------ 2. SWEEP --- */
  // Look 3 days out; the per-stylist window is checked per row below.
  const todayISO = new Date(now + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
  const horizonISO = new Date(now + TZ_OFFSET_MIN * 60_000 + 3 * 86_400_000)
    .toISOString().slice(0, 10);

  const [{ data: appts }, { data: stylists }, { data: services }, { data: tpl }] =
    await Promise.all([
      admin.from("appointments")
        .select("id, customer_name, customer_phone, service_id, staff_id, staff_name, date, start_min, status, tracking_code, sms_sent_reminder")
        .in("status", ["confirmed", "rescheduled"])
        .eq("sms_sent_reminder", false)
        .gte("date", todayISO)
        .lte("date", horizonISO),
      admin.from("stylists").select("id, reminder_hours_before"),
      admin.from("services").select("id, name"),
      admin.from("sms_templates").select("body").eq("kind", "reminder").eq("is_default", true).maybeSingle(),
    ]);

  const reminderHours = new Map((stylists ?? []).map((s) => [s.id, s.reminder_hours_before ?? 3]));
  const serviceName = new Map((services ?? []).map((s) => [s.id, s.name]));
  const defaultHours = Number(Deno.env.get("DEFAULT_REMINDER_HOURS") ?? 3);
  const templateBody = tpl?.body
    ?? "{{name}} عزیز، یادآوری نوبت شما در {{salon}}:\n{{service}} — {{date}} ساعت {{time}}\nمنتظر شما هستیم.";

  for (const a of appts ?? []) {
    if (!/^09\d{9}$/.test(a.customer_phone ?? "")) continue;

    // Per-stylist window — exactly the reminderHours field you already have.
    const hours = a.staff_id ? (reminderHours.get(a.staff_id) ?? defaultHours) : defaultHours;
    const startsAt = appointmentInstant(a.date, a.start_min);
    const windowOpens = startsAt - hours * 3_600_000;

    if (now < windowOpens) continue;   // too early
    if (now > startsAt) continue;      // already started, pointless

    // Skip if a reminder is already queued or sent for this appointment.
    const { count } = await admin
      .from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("appointment_id", a.id)
      .eq("kind", "reminder")
      .in("status", ["queued", "sent", "delivered"]);
    if ((count ?? 0) > 0) continue;

    const body = render(templateBody, {
      name: a.customer_name || "مشتری",
      service: serviceName.get(a.service_id ?? "") ?? "خدمت",
      date: jalaliLabel(a.date),
      time: clockLabel(a.start_min),
      stylist: a.staff_name || "—",
      code: a.tracking_code ?? "",
      salon: SALON_NAME,
    });

    const r = await sendOne(a.customer_phone, body);

    await admin.from("sms_messages").insert({
      to_phone: a.customer_phone,
      body,
      kind: "reminder",
      appointment_id: a.id,
      provider: r.provider,
      provider_msg_id: r.providerMsgId ?? null,
      status: r.ok ? "sent" : "failed",
      error: r.ok ? null : r.error,
      cost: r.cost ?? null,
      sent_at: r.ok ? new Date().toISOString() : null,
    });

    if (r.ok) {
      await admin.from("appointments").update({ sms_sent_reminder: true }).eq("id", a.id);
      report.swept++;
    } else {
      report.sweepFailed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), ...report }), {
    headers: { "Content-Type": "application/json" },
  });
});
