import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "../components/ui";
import { formatToman, toFa, normalizeMobile } from "../lib/format";
import { buyPackageOnline, startPurchasePayment } from "../lib/business";

/* v2.50 — buy a prepaid package online (the salon's own Zarinpal). */
export function BuyPackageModal({ pkg, onClose }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go() {
    setBusy(true); setErr("");
    const r = await buyPackageOnline(pkg.id, phone, name.trim());
    if (!r?.ok) { setBusy(false); setErr(r?.error || "ثبت ناموفق بود"); return; }
    const pay = await startPurchasePayment("package", r.id);
    if (pay?.ok && pay.url) { window.location.assign(pay.url); return; }
    setBusy(false); setErr(pay?.error || "اتصال به درگاه پرداخت ناموفق بود");
  }
  const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4 };
  return (
    <Modal title={`خرید «${pkg.name}»`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="tabular" style={{ fontSize: 13 }}>{toFa(pkg.sessions)} جلسه {pkg.service_name} — <b>{formatToman(pkg.price)}</b></p>
        <label className="muted" style={{ fontSize: 12 }}>موبایل (بسته به این شماره ثبت می‌شود)
          <input dir="ltr" type="tel" inputMode="tel" className="tabular" value={phone} placeholder="09xxxxxxxxx" onChange={(e) => setPhone(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>نام<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={input} /></label>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={busy || !/^09\d{9}$/.test(phone)} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={go}>
          {busy && <Loader2 size={14} className="salon-spin" />} پرداخت {formatToman(pkg.price)}
        </button>
      </div>
    </Modal>
  );
}
