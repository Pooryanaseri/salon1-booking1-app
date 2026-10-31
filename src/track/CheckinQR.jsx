import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode } from "lucide-react";
import { toFa } from "../lib/format";

/* v2.51 — the booking's QR for check-in at the salon (encodes the tracking code). */
export function CheckinQR({ code }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!open || !code) return;
    QRCode.toDataURL(code, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(null));
  }, [open, code]);
  if (!code) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="tap ghost-btn w-full flex items-center justify-center gap-1.5" style={{ padding: 9, fontSize: 12.5 }} onClick={() => setOpen((o) => !o)}>
        <QrCode size={14} /> {open ? "بستن QR" : "QR ورود به سالن"}
      </button>
      {open && (
        <div style={{ textAlign: "center", marginTop: 8 }}>
          {src && <img src={src} alt={`QR نوبت ${code}`} style={{ width: 180, height: 180, background: "white", padding: 6, borderRadius: 10 }} />}
          <p className="muted tabular" style={{ fontSize: 12, marginTop: 4 }}>کد پیگیری: <span dir="ltr">{toFa(code)}</span> — هنگام رسیدن به سالن نشان دهید</p>
        </div>
      )}
    </div>
  );
}
