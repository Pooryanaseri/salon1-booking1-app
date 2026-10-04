import { useEffect, useState } from "react";
import { KeyRound, CheckCircle2, AlertTriangle, Loader2, Send, Pencil } from "lucide-react";
import { fetchSmsAccount, saveSmsAccount } from "../lib/api";
import { sendTestSms } from "../lib/sms";
import { toFa } from "../lib/format";

const PROVIDERS = [
  { id: "kavenegar", label: "کاوه‌نگار" },
  { id: "melipayamak", label: "ملی‌پیامک" },
];

/**
 * v2.41 — each salon sends its SMS (booking confirmations, reminders, login
 * codes, campaigns) through its own provider account and pays for it there.
 * The API key is write-only: after saving, only its last 4 characters come
 * back from the server.
 */
export function SmsAccountCard({ notify }) {
  const [account, setAccount] = useState(null); // null = loading
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState("kavenegar");
  const [apiKey, setApiKey] = useState("");
  const [sender, setSender] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetchSmsAccount().then((a) => {
      setAccount(a);
      if (a?.configured) { setProvider(a.provider); setSender(a.sender || ""); }
      else if (a?.ok && !a.demo) setEditing(true);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await saveSmsAccount({ provider, apiKey: apiKey.trim(), sender: sender.trim() });
    setSaving(false);
    if (!res?.ok) { notify(res?.error || "ذخیره ناموفق بود"); return; }
    setApiKey("");
    setEditing(false);
    setAccount(await fetchSmsAccount());
    notify("حساب پیامک ذخیره شد — یک پیامک آزمایشی بفرستید");
  }

  async function test() {
    setTesting(true);
    const res = await sendTestSms();
    setTesting(false);
    if (res?.demo) notify("حالت دمو — پیامک واقعی ارسال نشد");
    else if (res?.ok) notify(`پیامک آزمایشی به ${toFa(res.to || "")} ارسال شد`);
    else notify(res?.error || "ارسال پیامک آزمایشی ناموفق بود");
  }

  if (!account) return null;
  const configured = !!account.configured;
  const providerLabel = PROVIDERS.find((p) => p.id === account.provider)?.label || account.provider;

  return (
    <div className="card" style={{ padding: 14, borderInlineStart: `3px solid ${configured ? "var(--color-success)" : "var(--color-warning)"}` }}>
      <p className="flex items-center gap-2" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>
        <KeyRound size={15} color="var(--color-accent-700)" /> حساب پیامک سالن
      </p>

      {configured ? (
        <p className="flex items-center gap-1.5 tabular" style={{ fontSize: 12.5, marginTop: 6 }}>
          <CheckCircle2 size={14} color="var(--color-success)" />
          {providerLabel}{account.sender ? ` · خط ${toFa(account.sender)}` : ""} · کلید ••••{account.key_hint}
        </p>
      ) : (
        <p className="flex items-start gap-1.5" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.9, color: "var(--color-warning)" }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 4 }} />
          {account.demo
            ? "در حالت دمو پیامکی ارسال نمی‌شود."
            : "هنوز تنظیم نشده. پیامک‌های سالن (تایید نوبت، یادآوری، کد ورود مشتری) از حساب خود سالن ارسال می‌شوند. کلید API را از پنل کاوه‌نگار یا ملی‌پیامک بردارید."}
        </p>
      )}

      {editing ? (
        <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
          <div className="flex gap-2" role="radiogroup" aria-label="سرویس پیامک">
            {PROVIDERS.map((p) => (
              <button
                key={p.id} role="radio" aria-checked={provider === p.id}
                className="tap flex-1"
                onClick={() => setProvider(p.id)}
                style={{
                  padding: "8px 10px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
                  border: `1px solid ${provider === p.id ? "var(--color-accent-500)" : "var(--color-border)"}`,
                  background: provider === p.id ? "color-mix(in oklch, var(--color-accent-500) 12%, var(--color-surface))" : "var(--color-surface)",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            dir="ltr" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={configured ? "کلید API جدید (خالی = همان کلید قبلی)" : "کلید API"}
            aria-label="کلید API"
            style={{ width: "100%", padding: "10px 12px", fontSize: 13 }}
          />
          <input
            dir="ltr" inputMode="numeric" value={sender} onChange={(e) => setSender(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="شمارهٔ خط ارسال (اختیاری)" aria-label="شمارهٔ خط ارسال"
            className="tabular" style={{ width: "100%", padding: "10px 12px", fontSize: 13 }}
          />
          <div className="flex gap-2">
            <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: 10 }} disabled={saving || (!configured && apiKey.trim().length < 8)} onClick={save}>
              {saving ? <Loader2 size={14} className="salon-spin" /> : <CheckCircle2 size={14} />} ذخیره
            </button>
            {configured && (
              <button className="tap ghost-btn flex-1" style={{ padding: 10 }} disabled={saving} onClick={() => { setEditing(false); setApiKey(""); }}>انصراف</button>
            )}
          </div>
        </div>
      ) : (
        !account.demo && (
          <div className="flex gap-2" style={{ marginTop: 10 }}>
            {configured && (
              <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "8px 10px", fontSize: 12.5 }} disabled={testing} onClick={test}>
                {testing ? <Loader2 size={13} className="salon-spin" /> : <Send size={13} />} پیامک آزمایشی به خودم
              </button>
            )}
            <button className="tap ghost-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "8px 10px", fontSize: 12.5 }} onClick={() => setEditing(true)}>
              <Pencil size={13} /> {configured ? "تغییر" : "تنظیم"}
            </button>
          </div>
        )
      )}
    </div>
  );
}
