import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardList, Loader2, Ticket } from "lucide-react";
import { Modal } from "../components/ui";
import { toFa, jalaliLabel, parseDateKey } from "../lib/format";
import { fetchClientRecords, saveClientRecord, CLIENT_RECORD_FIELDS } from "../lib/business";

/* ============================================================
   v2.52 — men's / women's salons: the client record (the twin of
   the pet health record) and package use at "انجام شد".
   ============================================================ */
const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-body)" };

/** Records of the clients on a list of bookings, refreshed by `tick`. */
export function useClientRecords(bookings, enabled, tick = 0) {
  const [map, setMap] = useState(new Map());
  const key = enabled ? [...new Set(bookings.map((b) => b.customer_phone))].sort().join(",") : "";
  useEffect(() => {
    if (!key) { setMap(new Map()); return undefined; }
    let alive = true;
    fetchClientRecords(key.split(",")).then((m) => { if (alive) setMap(m); });
    return () => { alive = false; };
  }, [key, tick]);
  return map;
}

/** Small warning on a booking card. */
export function ClientRecordBadges({ record, booking }) {
  if (!record && !booking?.package_purchase_id) return null;
  return (
    <>
      {booking?.package_purchase_id && (
        <span className="badge" style={{ background: "color-mix(in oklch, var(--color-tab-panel) 14%, transparent)", color: "var(--color-tab-panel)" }}>
          <Ticket size={12} /> از بسته
        </span>
      )}
      {record?.allergies && (
        <span className="badge" title={record.allergies} style={{ background: "color-mix(in oklch, var(--color-danger) 14%, transparent)", color: "var(--color-danger)" }}>
          <AlertTriangle size={12} /> حساسیت: {record.allergies.length > 24 ? `${record.allergies.slice(0, 24)}…` : record.allergies}
        </span>
      )}
      {record?.color_formula && (
        <span className="badge" title={record.color_formula} style={{ background: "color-mix(in oklch, var(--color-info) 12%, transparent)", color: "var(--color-info)" }}>
          <ClipboardList size={12} /> فرمول رنگ دارد
        </span>
      )}
    </>
  );
}

export function ClientRecordModal({ phone, name, record, onClose, onSaved, notify }) {
  const [r, setR] = useState(() => ({ phone, ...Object.fromEntries(CLIENT_RECORD_FIELDS.map(([k]) => [k, record?.[k] || ""])), patch_test_at: record?.patch_test_at || "" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    const res = await saveClientRecord(r);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    notify("پروندهٔ مشتری ذخیره شد");
    onSaved?.();
    onClose();
  }
  const patchOld = r.patch_test_at && (Date.now() - new Date(r.patch_test_at).getTime()) / 86400000 > 180;
  return (
    <Modal title={`پروندهٔ ${name || "مشتری"}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="muted tabular" style={{ fontSize: 12 }} dir="ltr">{phone}</p>
        {CLIENT_RECORD_FIELDS.map(([k, label, max]) => (
          <label key={k} className="muted" style={{ fontSize: 12 }}>{label}
            {max > 100
              ? <textarea rows={2} maxLength={max} value={r[k]} onChange={(e) => setR((x) => ({ ...x, [k]: e.target.value }))} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
              : <input maxLength={max} value={r[k]} onChange={(e) => setR((x) => ({ ...x, [k]: e.target.value }))} style={input} />}
          </label>
        ))}
        <label className="muted" style={{ fontSize: 12 }}>تاریخ آخرین تست حساسیت (پچ تست) رنگ
          <input type="date" dir="ltr" value={r.patch_test_at || ""} onChange={(e) => setR((x) => ({ ...x, patch_test_at: e.target.value }))} style={input} />
        </label>
        {patchOld && <p style={{ fontSize: 12, color: "var(--color-warning)" }}>بیش از ۶ ماه از آخرین تست حساسیت گذشته — پیش از رنگ دوباره تست کنید.</p>}
        {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{error}</p>}
        <button disabled={busy} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={save}>
          {busy && <Loader2 size={14} className="salon-spin" />} ذخیره
        </button>
      </div>
    </Modal>
  );
}

/** "انجام شد" when the client has a prepaid package for this service. */
export function PackageChoiceModal({ booking, packages, onClose, onConfirm }) {
  const [pick, setPick] = useState(packages[0]?.id || "");
  return (
    <Modal title="ثبت انجام نوبت" onClose={onClose}>
      <p style={{ fontSize: 13, lineHeight: 1.9 }}>{booking.customer_name} برای این خدمت بستهٔ پیش‌پرداخت دارد. از بسته کم شود؟</p>
      <div className="flex flex-col gap-2" style={{ marginTop: 8 }} role="radiogroup" aria-label="بسته">
        {packages.map((p) => (
          <label key={p.id} className="flex items-center gap-2" style={{ fontSize: 13 }}>
            <input type="radio" name="pkg" checked={pick === p.id} onChange={() => setPick(p.id)} />
            <Ticket size={14} color="var(--color-tab-panel)" /> {p.package_name} — {toFa(p.sessions_left)} جلسه مانده
            <span className="muted" style={{ fontSize: 11.5 }}>(تا {jalaliLabel(parseDateKey(p.expires_at), { short: true })})</span>
          </label>
        ))}
        <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
          <input type="radio" name="pkg" checked={pick === ""} onChange={() => setPick("")} /> پرداخت عادی (بدون بسته)
        </label>
      </div>
      <button className="tap accent-btn w-full" style={{ padding: 12, marginTop: 12 }}
        onClick={() => onConfirm(packages.find((p) => p.id === pick) || null)}>
        ثبت «انجام شد»
      </button>
    </Modal>
  );
}
