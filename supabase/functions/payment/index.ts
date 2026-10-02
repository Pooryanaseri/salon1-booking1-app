// ============================================================================
//  Edge Function: payment  (v2.37 — online deposit via Zarinpal)
//
//  POST { action: "request", appointment_id }
//    → { ok, url }   redirect the customer to Zarinpal
//  POST { action: "verify", authority, status }
//    → { ok, paid, appointment: {...} }   after Zarinpal sends them back to
//      /payment/callback?Authority=…&Status=OK|NOK
//
//  Called by anonymous customers, so nothing from the caller is trusted
//  except identifiers: the amount comes from appointments.deposit_amount,
//  the merchant ID from salon_payment_settings, and a booking is confirmed
//  only after Zarinpal's own verify call succeeds.
//
//  Env: ALLOWED_ORIGIN (public site address, used for CORS and the callback
//  URL), ZARINPAL_SANDBOX=true to use Zarinpal's sandbox while testing.
//  Deploy: supabase functions deploy payment --no-verify-jwt
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const SITE = ALLOWED_ORIGIN.replace(/\/$/, "");
const SANDBOX = Deno.env.get("ZARINPAL_SANDBOX") === "true";
const ZP = SANDBOX ? "https://sandbox.zarinpal.com/pg" : "https://payment.zarinpal.com/pg";
const HOLD_MINUTES = 20; // must match expire_unpaid_bookings()

const CORS: Record<string, string> = {
  ...(ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN } : {}),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function zarinpal(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${ZP}/v4/payment/${path}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return data as { data?: { code?: number; authority?: string; ref_id?: number; card_pan?: string }; errors?: unknown };
}

async function merchantFor(salonId: string): Promise<string> {
  const { data } = await admin.from("salon_payment_settings").select("zarinpal_merchant_id").eq("salon_id", salonId).maybeSingle();
  return (data?.zarinpal_merchant_id ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!SITE) return json({ ok: false, error: "پرداخت آنلاین پیکربندی نشده است" }, 500);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: false, error: "درخواست نامعتبر" }, 400); }

  /* ------------------------------------------------------------ request --- */
  if (payload.action === "request") {
    const { data: appt } = await admin
      .from("appointments")
      .select("id, salon_id, status, deposit_amount, customer_phone, created_at")
      .eq("id", String(payload.appointment_id ?? ""))
      .maybeSingle();
    if (!appt || appt.status !== "awaiting_payment" || !appt.deposit_amount) {
      return json({ ok: false, error: "این نوبت منتظر پرداخت نیست" }, 400);
    }
    if (Date.now() - new Date(appt.created_at).getTime() > HOLD_MINUTES * 60_000) {
      return json({ ok: false, error: "مهلت پرداخت تمام شده — لطفاً دوباره نوبت بگیرید" }, 400);
    }
    const { count } = await admin.from("payments").select("id", { count: "exact", head: true }).eq("appointment_id", appt.id);
    if ((count ?? 0) >= 5) return json({ ok: false, error: "تعداد تلاش برای پرداخت زیاد بود" }, 429);

    const merchant = await merchantFor(appt.salon_id);
    if (!merchant) return json({ ok: false, error: "درگاه پرداخت سالن تنظیم نشده" }, 500);

    const amountRial = Number(appt.deposit_amount) * 10; // app prices are in toman
    const zp = await zarinpal("request", {
      merchant_id: merchant,
      amount: amountRial,
      callback_url: `${SITE}/payment/callback`,
      description: `بیعانهٔ نوبت ${appt.id}`,
      metadata: { mobile: appt.customer_phone },
    });
    const authority = zp.data?.authority;
    if (zp.data?.code !== 100 || !authority) {
      console.error("[payment/request] zarinpal refused:", JSON.stringify(zp.errors ?? zp));
      return json({ ok: false, error: "اتصال به درگاه پرداخت ناموفق بود — دوباره امتحان کنید" }, 502);
    }
    await admin.from("payments").insert({
      salon_id: appt.salon_id, appointment_id: appt.id, amount_rial: amountRial, authority, status: "requested",
    });
    return json({ ok: true, url: `${ZP}/StartPay/${authority}` });
  }

  /* ------------------------------------------------------------- verify --- */
  if (payload.action === "verify") {
    const authority = String(payload.authority ?? "");
    const { data: pay } = await admin.from("payments").select("*").eq("authority", authority).maybeSingle();
    if (!pay) return json({ ok: false, error: "پرداخت پیدا نشد" }, 404);

    const apptOut = async () => {
      const { data } = await admin
        .from("appointments")
        .select("id, status, date, start_min, tracking_code, deposit_amount, final_price, salon_id")
        .eq("id", pay.appointment_id).maybeSingle();
      return data;
    };

    if (pay.status === "paid") return json({ ok: true, paid: true, appointment: await apptOut() });
    if (payload.status !== "OK") {
      if (pay.status === "requested") await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
      return json({ ok: true, paid: false, appointment: await apptOut() });
    }

    const merchant = await merchantFor(pay.salon_id);
    const zp = await zarinpal("verify", { merchant_id: merchant, amount: pay.amount_rial, authority });
    const code = zp.data?.code;
    if (code !== 100 && code !== 101) {
      await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
      return json({ ok: true, paid: false, appointment: await apptOut() });
    }

    const refId = String(zp.data?.ref_id ?? "");
    const now = new Date().toISOString();
    // Money is in: record it first, then try to (re)confirm the booking.
    await admin.from("payments").update({ status: "paid", ref_id: refId, card_pan: zp.data?.card_pan ?? null, paid_at: now }).eq("id", pay.id);
    const { error: confirmErr } = await admin
      .from("appointments")
      .update({ status: "confirmed", deposit_paid_at: now, deposit_ref: refId })
      .eq("id", pay.appointment_id)
      .in("status", ["awaiting_payment", "cancelled"]); // cancelled = the hold expired while paying
    if (confirmErr) {
      // The slot was taken after the hold expired — the salon refunds.
      console.error("[payment/verify] could not confirm after payment:", confirmErr.message);
      await admin.from("payments").update({ status: "refund_needed" }).eq("id", pay.id);
      const { data: mgrs } = await admin.from("users").select("phone").eq("salon_id", pay.salon_id).in("role", ["owner", "manager"]).eq("active", true);
      for (const m of mgrs ?? []) {
        await admin.from("sms_messages").insert({
          salon_id: pay.salon_id, to_phone: m.phone, kind: "custom", status: "queued", scheduled_for: now,
          body: `بیعانهٔ نوبت ${pay.appointment_id} پرداخت شد ولی زمانش دیگر خالی نبود — لطفاً از پنل زرین‌پال بازگردانید (کد پیگیری ${refId}).`,
        });
      }
      return json({ ok: true, paid: true, refund: true, appointment: await apptOut() });
    }
    return json({ ok: true, paid: true, appointment: await apptOut() });
  }

  return json({ ok: false, error: "action نامعتبر" }, 400);
});
