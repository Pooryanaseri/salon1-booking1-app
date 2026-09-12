// ============================================================================
//  SMS provider adapters — Kavenegar + Melipayamak behind one interface.
//  Switch with the SMS_PROVIDER secret; no code change, no redeploy of the app.
//  You said you'd hand over the exact API later: when you do, the ONLY thing
//  that changes is the relevant function in this file.
// ============================================================================

export type SendResult = {
  ok: boolean;
  providerMsgId?: string;
  cost?: number;
  error?: string;
};

/** Iranian numbers arrive as 09xxxxxxxxx; both providers accept that as-is. */
export function normalizePhone(raw: string): string {
  let p = String(raw).replace(/[^\d+]/g, "");
  if (p.startsWith("+98")) p = "0" + p.slice(3);
  if (p.startsWith("0098")) p = "0" + p.slice(4);
  if (p.startsWith("98") && p.length === 12) p = "0" + p.slice(2);
  if (p.length === 10 && p.startsWith("9")) p = "0" + p;
  return p;
}

export function isValidIranMobile(p: string): boolean {
  return /^09\d{9}$/.test(p);
}

/* --------------------------------------------------------------- Kavenegar */
// Docs: https://kavenegar.com/rest.html
// Simple send:  GET/POST https://api.kavenegar.com/v1/{API-KEY}/sms/send.json
async function sendKavenegar(to: string, message: string): Promise<SendResult> {
  const apiKey = Deno.env.get("KAVENEGAR_API_KEY");
  const sender = Deno.env.get("KAVENEGAR_SENDER") ?? "";
  if (!apiKey) return { ok: false, error: "KAVENEGAR_API_KEY تنظیم نشده" };

  const url = `https://api.kavenegar.com/v1/${apiKey}/sms/send.json`;
  const form = new URLSearchParams({ receptor: to, message });
  if (sender) form.set("sender", sender);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const json = await res.json();
    const status = json?.return?.status;
    if (status !== 200) {
      return { ok: false, error: `کاوه‌نگار ${status}: ${json?.return?.message ?? "خطای نامشخص"}` };
    }
    const entry = Array.isArray(json.entries) ? json.entries[0] : json.entries;
    return { ok: true, providerMsgId: String(entry?.messageid ?? ""), cost: entry?.cost };
  } catch (e) {
    return { ok: false, error: `کاوه‌نگار: ${(e as Error).message}` };
  }
}

/* ------------------------------------------------------------ Melipayamak */
// Docs: https://console.melipayamak.com  (REST v1 "send/simple")
async function sendMelipayamak(to: string, message: string): Promise<SendResult> {
  const apiKey = Deno.env.get("MELIPAYAMAK_API_KEY");   // console REST key
  const from = Deno.env.get("MELIPAYAMAK_SENDER") ?? "";
  if (!apiKey) return { ok: false, error: "MELIPAYAMAK_API_KEY تنظیم نشده" };

  const url = `https://console.melipayamak.com/api/send/simple/${apiKey}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, text: message }),
    });
    const json = await res.json();
    // Success shape: { recId: <number>, status: "ارسال موفق بود" }
    if (!json?.recId) {
      return { ok: false, error: `ملی‌پیامک: ${json?.status ?? "خطای نامشخص"}` };
    }
    return { ok: true, providerMsgId: String(json.recId) };
  } catch (e) {
    return { ok: false, error: `ملی‌پیامک: ${(e as Error).message}` };
  }
}

/* ------------------------------------------------------------------ router */
export function activeProvider(): string {
  return (Deno.env.get("SMS_PROVIDER") ?? "kavenegar").toLowerCase();
}

export async function sendOne(to: string, message: string): Promise<SendResult & { provider: string }> {
  const provider = activeProvider();
  const phone = normalizePhone(to);

  if (!isValidIranMobile(phone)) {
    return { ok: false, provider, error: `شماره نامعتبر: ${to}` };
  }
  // Escape hatch for staging: log instead of spending credit.
  if (Deno.env.get("SMS_DRY_RUN") === "true") {
    console.log(`[DRY RUN] -> ${phone}: ${message}`);
    return { ok: true, provider: `${provider} (dry-run)`, providerMsgId: "dry-run" };
  }

  const result = provider === "melipayamak"
    ? await sendMelipayamak(phone, message)
    : await sendKavenegar(phone, message);

  return { ...result, provider };
}
