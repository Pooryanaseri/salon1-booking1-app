// ============================================================================
//  Edge Function: payment  (v2.37 — online deposit via Zarinpal)
//
//  POST { action: "request", appointment_id }
//    → { ok, url }   redirect the customer to Zarinpal
//  POST { action: "request", order_id }            (v2.48 — shop orders)
//  POST { action: "request", gift_card_id | package_purchase_id }  (v2.50)
//  POST { action: "request", event_token }   (v2.53 — event deposit, paid to the salon)
//  POST { action: "request", plan_invoice_id } (v2.53 — subscription, paid to the platform)
//    → { ok, url }
//  POST { action: "verify", authority, status }
//    → { ok, paid, appointment: {...} } or { ok, paid, order: {...} } after
//      Zarinpal sends them back to /payment/callback?Authority=…&Status=OK|NOK
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

async function platformMerchant(): Promise<string> {
  const { data } = await admin.from("platform_settings").select("zarinpal_merchant_id").maybeSingle();
  return (data?.zarinpal_merchant_id ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!SITE) return json({ ok: false, error: "پرداخت آنلاین پیکربندی نشده است" }, 500);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: false, error: "درخواست نامعتبر" }, 400); }

  /* ------------------------------------------- request (event / plan) ---- */
  // v2.53: an event deposit (the client holds the quote link's token) and a
  // salon's subscription invoice (paid to the platform's own merchant).
  if (payload.action === "request" && (payload.event_token || payload.plan_invoice_id)) {
    let salonId: string, amountRial: number, merchant: string, col: string, id: string, description: string, mobile: string | undefined;
    if (payload.event_token) {
      const token = String(payload.event_token);
      if (!/^[0-9a-f]{36}$/.test(token)) return json({ ok: false, error: "لینک نامعتبر است" }, 400);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data: ev } = await admin.from("event_requests").select("*").eq("token_hash", hash).maybeSingle();
      if (!ev || !["quoted", "accepted"].includes(ev.status) || !(ev.deposit_amount > 0)) {
        return json({ ok: false, error: "این پیش‌فاکتور منتظر پرداخت نیست" }, 400);
      }
      const { data: paid } = await admin.from("event_payments").select("amount").eq("event_id", ev.id);
      if ((paid ?? []).reduce((t: number, p: { amount: number }) => t + Number(p.amount), 0) >= ev.deposit_amount) {
        return json({ ok: false, error: "بیعانه قبلاً پرداخت شده است" }, 400);
      }
      salonId = ev.salon_id; amountRial = Number(ev.deposit_amount) * 10; merchant = await merchantFor(ev.salon_id);
      col = "event_request_id"; id = ev.id; description = "بیعانهٔ مراسم"; mobile = ev.customer_phone;
    } else {
      id = String(payload.plan_invoice_id);
      const { data: inv } = await admin.from("plan_invoices").select("*").eq("id", id).maybeSingle();
      if (!inv || inv.status !== "awaiting_payment" || Date.now() - new Date(inv.created_at).getTime() > 86_400_000) {
        return json({ ok: false, error: "این صورتحساب منتظر پرداخت نیست" }, 400);
      }
      salonId = inv.salon_id; amountRial = Number(inv.amount) * 10; merchant = await platformMerchant();
      col = "plan_invoice_id"; description = "اشتراک نرم‌افزار نوبت‌دهی";
    }
    const { count } = await admin.from("payments").select("id", { count: "exact", head: true }).eq(col, id);
    if ((count ?? 0) >= 5) return json({ ok: false, error: "تعداد تلاش برای پرداخت زیاد بود" }, 429);
    if (!merchant) return json({ ok: false, error: "درگاه پرداخت تنظیم نشده" }, 500);
    const zp = await zarinpal("request", {
      merchant_id: merchant, amount: amountRial, callback_url: `${SITE}/payment/callback`, description,
      ...(mobile ? { metadata: { mobile } } : {}),
    });
    const authority = zp.data?.authority;
    if (zp.data?.code !== 100 || !authority) {
      console.error("[payment/request-event-plan] zarinpal refused:", JSON.stringify(zp.errors ?? zp));
      return json({ ok: false, error: "اتصال به درگاه پرداخت ناموفق بود — دوباره امتحان کنید" }, 502);
    }
    await admin.from("payments").insert({ salon_id: salonId, [col]: id, amount_rial: amountRial, authority, status: "requested" });
    return json({ ok: true, url: `${ZP}/StartPay/${authority}` });
  }

  /* ---------------------------------------- request (gift card / package) --- */
  // v2.50: gift cards and prepaid packages bought online
  if (payload.action === "request" && (payload.gift_card_id || payload.package_purchase_id)) {
    const isGift = !!payload.gift_card_id;
    const table = isGift ? "gift_cards" : "package_purchases";
    const id = String(isGift ? payload.gift_card_id : payload.package_purchase_id);
    const { data: row } = await admin.from(table).select("*").eq("id", id).maybeSingle();
    if (!row || row.status !== "awaiting_payment" || Date.now() - new Date(row.created_at).getTime() > 86_400_000) {
      return json({ ok: false, error: "این خرید منتظر پرداخت نیست" }, 400);
    }
    const col = isGift ? "gift_card_id" : "package_purchase_id";
    const { count } = await admin.from("payments").select("id", { count: "exact", head: true }).eq(col, id);
    if ((count ?? 0) >= 5) return json({ ok: false, error: "تعداد تلاش برای پرداخت زیاد بود" }, 429);
    const merchant = await merchantFor(row.salon_id);
    if (!merchant) return json({ ok: false, error: "درگاه پرداخت سالن تنظیم نشده" }, 500);
    const amountRial = Number(isGift ? row.amount : row.price_paid) * 10;
    const zp = await zarinpal("request", {
      merchant_id: merchant,
      amount: amountRial,
      callback_url: `${SITE}/payment/callback`,
      description: isGift ? "کارت هدیه" : `بستهٔ ${row.package_name}`,
      metadata: { mobile: isGift ? row.buyer_phone : row.customer_phone },
    });
    const authority = zp.data?.authority;
    if (zp.data?.code !== 100 || !authority) {
      console.error("[payment/request-purchase] zarinpal refused:", JSON.stringify(zp.errors ?? zp));
      return json({ ok: false, error: "اتصال به درگاه پرداخت ناموفق بود — دوباره امتحان کنید" }, 502);
    }
    await admin.from("payments").insert({ salon_id: row.salon_id, [col]: id, amount_rial: amountRial, authority, status: "requested" });
    return json({ ok: true, url: `${ZP}/StartPay/${authority}` });
  }

  /* ------------------------------------------------------ request (order) --- */
  if (payload.action === "request" && payload.order_id) {
    const { data: order } = await admin
      .from("orders")
      .select("id, salon_id, code, status, total, customer_phone, created_at, paid_at")
      .eq("id", String(payload.order_id))
      .maybeSingle();
    if (!order || order.status !== "awaiting_payment" || order.paid_at) {
      return json({ ok: false, error: "این سفارش منتظر پرداخت نیست" }, 400);
    }
    if (Date.now() - new Date(order.created_at).getTime() > HOLD_MINUTES * 60_000) {
      return json({ ok: false, error: "مهلت پرداخت تمام شده — لطفاً دوباره سفارش دهید" }, 400);
    }
    const { count } = await admin.from("payments").select("id", { count: "exact", head: true }).eq("order_id", order.id);
    if ((count ?? 0) >= 5) return json({ ok: false, error: "تعداد تلاش برای پرداخت زیاد بود" }, 429);

    const merchant = await merchantFor(order.salon_id);
    if (!merchant) return json({ ok: false, error: "درگاه پرداخت سالن تنظیم نشده" }, 500);

    const amountRial = Number(order.total) * 10;
    const zp = await zarinpal("request", {
      merchant_id: merchant,
      amount: amountRial,
      callback_url: `${SITE}/payment/callback`,
      description: `سفارش ${order.code}`,
      metadata: { mobile: order.customer_phone },
    });
    const authority = zp.data?.authority;
    if (zp.data?.code !== 100 || !authority) {
      console.error("[payment/request-order] zarinpal refused:", JSON.stringify(zp.errors ?? zp));
      return json({ ok: false, error: "اتصال به درگاه پرداخت ناموفق بود — دوباره امتحان کنید" }, 502);
    }
    await admin.from("payments").insert({
      salon_id: order.salon_id, order_id: order.id, amount_rial: amountRial, authority, status: "requested",
    });
    return json({ ok: true, url: `${ZP}/StartPay/${authority}` });
  }

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

    /* -------- event deposit / subscription (v2.53) -------- */
    if (pay.event_request_id || pay.plan_invoice_id) {
      const isEvent = !!pay.event_request_id;
      const out = async () => {
        if (isEvent) {
          const { data } = await admin.from("event_requests").select("id, kind, event_date, customer_name, status").eq("id", pay.event_request_id).maybeSingle();
          return { event: data };
        }
        const { data } = await admin.from("plan_invoices").select("id, plan_id, months, amount, status").eq("id", pay.plan_invoice_id).maybeSingle();
        return { plan: data };
      };
      if (pay.status === "paid") return json({ ok: true, paid: true, ...(await out()) });
      if (payload.status !== "OK") {
        if (pay.status === "requested") await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, ...(await out()) });
      }
      const merchant = isEvent ? await merchantFor(pay.salon_id) : await platformMerchant();
      const zp = await zarinpal("verify", { merchant_id: merchant, amount: pay.amount_rial, authority });
      const code = zp.data?.code;
      if (code !== 100 && code !== 101) {
        await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, ...(await out()) });
      }
      const refId = String(zp.data?.ref_id ?? "");
      await admin.from("payments").update({ status: "paid", ref_id: refId, card_pan: zp.data?.card_pan ?? null, paid_at: new Date().toISOString() }).eq("id", pay.id);
      const { error: cErr } = isEvent
        ? await admin.rpc("confirm_event_payment", { p_id: pay.event_request_id, p_amount: Math.round(pay.amount_rial / 10), p_ref: refId })
        : await admin.rpc("confirm_plan_payment", { p_id: pay.plan_invoice_id, p_ref: refId });
      if (cErr) console.error("[payment/verify-event-plan] confirm failed:", cErr.message);
      return json({ ok: true, paid: true, ...(await out()) });
    }

    /* -------- gift card / package -------- */
    if (pay.gift_card_id || pay.package_purchase_id) {
      const isGift = !!pay.gift_card_id;
      const out = async () => {
        if (isGift) {
          const { data } = await admin.from("gift_cards").select("id, amount, recipient_name, status").eq("id", pay.gift_card_id).maybeSingle();
          return { gift: data };
        }
        const { data } = await admin.from("package_purchases").select("id, package_name, sessions_total, price_paid, status").eq("id", pay.package_purchase_id).maybeSingle();
        return { package: data };
      };
      if (pay.status === "paid") return json({ ok: true, paid: true, ...(await out()) });
      if (payload.status !== "OK") {
        if (pay.status === "requested") await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, ...(await out()) });
      }
      const merchant = await merchantFor(pay.salon_id);
      const zp = await zarinpal("verify", { merchant_id: merchant, amount: pay.amount_rial, authority });
      const code = zp.data?.code;
      if (code !== 100 && code !== 101) {
        await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, ...(await out()) });
      }
      const refId = String(zp.data?.ref_id ?? "");
      await admin.from("payments").update({ status: "paid", ref_id: refId, card_pan: zp.data?.card_pan ?? null, paid_at: new Date().toISOString() }).eq("id", pay.id);
      const { error: cErr } = isGift
        ? await admin.rpc("confirm_gift_card_payment", { p_id: pay.gift_card_id, p_ref: refId })
        : await admin.rpc("confirm_package_payment", { p_id: pay.package_purchase_id, p_ref: refId });
      if (cErr) console.error("[payment/verify-purchase] confirm failed:", cErr.message);
      return json({ ok: true, paid: true, ...(await out()) });
    }

    /* -------- shop order -------- */
    if (pay.order_id) {
      const orderOut = async () => {
        const { data } = await admin
          .from("orders")
          .select("id, code, status, total, delivery, paid_at, refund_needed, created_at")
          .eq("id", pay.order_id).maybeSingle();
        return data;
      };
      if (pay.status === "paid" || pay.status === "refund_needed") {
        return json({ ok: true, paid: true, refund: pay.status === "refund_needed", order: await orderOut() });
      }
      if (payload.status !== "OK") {
        if (pay.status === "requested") await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, order: await orderOut() });
      }
      const merchant = await merchantFor(pay.salon_id);
      const zp = await zarinpal("verify", { merchant_id: merchant, amount: pay.amount_rial, authority });
      const code = zp.data?.code;
      if (code !== 100 && code !== 101) {
        await admin.from("payments").update({ status: "failed" }).eq("id", pay.id);
        return json({ ok: true, paid: false, order: await orderOut() });
      }
      const refId = String(zp.data?.ref_id ?? "");
      await admin.from("payments").update({
        status: "paid", ref_id: refId, card_pan: zp.data?.card_pan ?? null, paid_at: new Date().toISOString(),
      }).eq("id", pay.id);
      const { data: outcome, error: confirmErr } = await admin.rpc("confirm_order_payment", { p_order: pay.order_id, p_ref: refId });
      if (confirmErr || outcome === "refund") {
        if (confirmErr) console.error("[payment/verify-order] confirm failed:", confirmErr.message);
        await admin.from("payments").update({ status: "refund_needed" }).eq("id", pay.id);
        const { data: mgrs } = await admin.from("users").select("phone").eq("salon_id", pay.salon_id).in("role", ["owner", "manager"]).eq("active", true);
        const order = await orderOut();
        for (const m of mgrs ?? []) {
          await admin.from("sms_messages").insert({
            salon_id: pay.salon_id, to_phone: m.phone, kind: "order_staff", status: "queued", scheduled_for: new Date().toISOString(),
            body: `سفارش ${order?.code ?? ""} پرداخت شد ولی مهلتش گذشته و کالا دیگر موجود نبود — لطفاً از پنل زرین‌پال بازگردانید (کد پیگیری ${refId}).`,
          });
        }
        return json({ ok: true, paid: true, refund: true, order });
      }
      return json({ ok: true, paid: true, order: await orderOut() });
    }

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
