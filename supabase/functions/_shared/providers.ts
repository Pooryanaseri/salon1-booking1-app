// ============================================================================
//  SMS provider adapters — Kavenegar + Melipayamak behind one interface.
//  v2.41: every salon sends through its OWN account (salon_sms_settings,
//  set in Panel → پیامک). The SMS_PROVIDER / *_API_KEY secrets are only a
//  fallback for salons without their own account — set
//  SMS_PLATFORM_FALLBACK=false to turn that off on a multi-salon install.
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
async function sendKavenegar(to: string, message: string, apiKey: string, sender: string): Promise<SendResult> {

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
async function sendMelipayamak(to: string, message: string, apiKey: string, from: string): Promise<SendResult> {

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

/* ---------------------------------------------------------------- accounts */
export type SmsAccount = { provider: string; apiKey: string; sender: string; source: "salon" | "platform" };

/** The project-wide account from secrets, if any and if fallback is allowed. */
export function platformAccount(): SmsAccount | null {
  if (Deno.env.get("SMS_PLATFORM_FALLBACK") === "false") return null;
  const provider = (Deno.env.get("SMS_PROVIDER") ?? "kavenegar").toLowerCase();
  const apiKey = provider === "melipayamak" ? Deno.env.get("MELIPAYAMAK_API_KEY") : Deno.env.get("KAVENEGAR_API_KEY");
  if (!apiKey) return null;
  const sender = (provider === "melipayamak" ? Deno.env.get("MELIPAYAMAK_SENDER") : Deno.env.get("KAVENEGAR_SENDER")) ?? "";
  return { provider, apiKey, sender, source: "platform" };
}

/** Per-run cache of salon accounts (one query per salon per run, not per SMS). */
// deno-lint-ignore no-explicit-any
export function smsAccounts(admin: any) {
  const cache = new Map<string, SmsAccount | null>();
  return {
    async forSalon(salonId: string | null | undefined): Promise<SmsAccount | null> {
      if (!salonId) return platformAccount();
      if (cache.has(salonId)) return cache.get(salonId)!;
      const { data } = await admin.from("salon_sms_settings").select("provider, api_key, sender").eq("salon_id", salonId).maybeSingle();
      const acc: SmsAccount | null = data?.api_key
        ? { provider: data.provider, apiKey: data.api_key, sender: data.sender ?? "", source: "salon" }
        : platformAccount();
      cache.set(salonId, acc);
      return acc;
    },
    /** Warm the cache for many salons in one query. */
    async preload(salonIds: string[]) {
      const ids = [...new Set(salonIds.filter((id) => id && !cache.has(id)))];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await admin.from("salon_sms_settings").select("salon_id, provider, api_key, sender").in("salon_id", ids.slice(i, i + 200));
        const found = new Map((data ?? []).map((r: any) => [r.salon_id, r]));
        for (const id of ids.slice(i, i + 200)) {
          const r: any = found.get(id);
          cache.set(id, r?.api_key ? { provider: r.provider, apiKey: r.api_key, sender: r.sender ?? "", source: "salon" } : platformAccount());
        }
      }
    },
  };
}

export const NO_ACCOUNT_ERROR = "حساب پیامک این سالن تنظیم نشده (پنل ← پیامک ← حساب پیامک سالن)";

/* ------------------------------------------------------------------ router */
export async function sendOne(to: string, message: string, account: SmsAccount | null): Promise<SendResult & { provider: string }> {
  const provider = account?.provider ?? "none";
  const phone = normalizePhone(to);

  if (!isValidIranMobile(phone)) {
    return { ok: false, provider, error: `شماره نامعتبر: ${to}` };
  }
  // Escape hatch for staging: log instead of spending credit.
  if (Deno.env.get("SMS_DRY_RUN") === "true") {
    console.log(`[DRY RUN] -> ${phone}: ${message}`);
    return { ok: true, provider: `${provider} (dry-run)`, providerMsgId: "dry-run" };
  }
  if (!account) return { ok: false, provider, error: NO_ACCOUNT_ERROR };

  const result = account.provider === "melipayamak"
    ? await sendMelipayamak(phone, message, account.apiKey, account.sender)
    : await sendKavenegar(phone, message, account.apiKey, account.sender);

  return { ...result, provider: account.source === "platform" ? `${account.provider} (platform)` : account.provider };
}

/** Run fn over items with at most `limit` in flight (provider calls are slow). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
