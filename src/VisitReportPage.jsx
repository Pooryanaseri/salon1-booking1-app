import { useEffect, useState } from "react";
import { Loader2, PawPrint, CheckCircle2, AlertTriangle, ShoppingBag, Package } from "lucide-react";
import { getVisitReport, petPhotoUrl, HEALTH_CHECKS, BEHAVIOR_LABEL } from "./lib/petcare";
import { productPhotoUrl } from "./lib/shop";
import { formatToman, isoToJalaliLabel } from "./lib/format";

/**
 * v2.49 — the owner's grooming report, opened from the SMS link
 * (/visit?token=…): before/after photos, the health checklist, the
 * groomer's note and recommended products from the salon's shop.
 */
export default function VisitReportPage({ token }) {
  const [r, setR] = useState(null);
  const [state, setState] = useState("loading");
  const [zoom, setZoom] = useState(null);
  useEffect(() => {
    if (!token) { setState("invalid"); return; }
    getVisitReport(token).then((res) => {
      if (!res?.ok) { setState("invalid"); return; }
      setR(res); setState("ok");
    });
  }, [token]);

  const brand = "#c2703a";
  const pet = "#2f8f6b";
  const wrap = { minHeight: "100vh", padding: "24px 16px 40px", background: "#f6f2ec", fontFamily: "'Vazirmatn Variable', Vazirmatn, system-ui, sans-serif", color: "#2b2420" };
  const card = { maxWidth: 460, margin: "0 auto 14px", background: "white", borderRadius: 18, padding: 18, boxShadow: "0 6px 24px -14px rgba(60,40,20,.35)" };
  const display = { fontFamily: "'Noto Kufi Arabic Variable', 'Vazirmatn Variable', system-ui, sans-serif" };

  if (state === "loading") {
    return <div dir="rtl" style={{ ...wrap, display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 size={26} color={brand} style={{ animation: "spin .9s linear infinite" }} /><style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style></div>;
  }
  if (state === "invalid") {
    return (
      <div dir="rtl" style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <PawPrint size={30} color="#999" style={{ margin: "0 auto 8px" }} />
          <p style={{ fontWeight: 700 }}>این گزارش پیدا نشد یا منقضی شده است</p>
        </div>
      </div>
    );
  }

  const checks = r.checks || {};
  const found = HEALTH_CHECKS.filter((h) => checks[h.id]);
  const photos = r.photos || [];
  const before = photos.filter((p) => p.includes("/before-"));
  const after = photos.filter((p) => p.includes("/after-"));
  const shopLink = r.salon_slug ? `/${r.salon_slug}?tab=shop` : "/";

  const Photos = ({ list, label }) => list.length > 0 && (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ fontSize: 12.5, fontWeight: 700, color: "#7a6a5e", marginBottom: 6 }}>{label}</p>
      <div style={{ display: "grid", gridTemplateColumns: list.length > 1 ? "1fr 1fr" : "1fr", gap: 6 }}>
        {list.map((p) => (
          <button key={p} onClick={() => setZoom(p)} style={{ border: 0, padding: 0, background: "none", cursor: "zoom-in" }} aria-label={`بزرگ‌نمایی ${label}`}>
            <img src={petPhotoUrl(p)} alt={label} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 12 }} />
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div dir="rtl" style={wrap}>
      <div style={{ ...card, background: `linear-gradient(135deg, #e9a24b, ${brand} 55%, #b8462f)`, color: "white" }}>
        <p style={{ fontSize: 12.5, opacity: 0.9 }}>{r.salon_name}</p>
        <p style={{ ...display, fontSize: 22, fontWeight: 800, marginTop: 4 }}>گزارش آرایش {r.pet_name}</p>
        <p style={{ fontSize: 13, opacity: 0.92, marginTop: 4 }}>{isoToJalaliLabel(String(r.date).slice(0, 10))}{r.services_label ? ` · ${r.services_label}` : ""}</p>
      </div>

      {(before.length > 0 || after.length > 0) && (
        <div style={card}>
          <div style={{ display: "flex", gap: 12 }}>
            <Photos list={before} label="قبل" />
            <Photos list={after} label="بعد" />
          </div>
        </div>
      )}

      <div style={card}>
        <p style={{ ...display, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>کارت سلامت</p>
        {found.length === 0 ? (
          <p style={{ display: "flex", alignItems: "center", gap: 6, color: pet, fontWeight: 700, fontSize: 14 }}><CheckCircle2 size={18} /> مشکلی دیده نشد</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {found.map((h) => (
              <p key={h.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                <AlertTriangle size={16} color="#c98a12" /> {h.hint}
              </p>
            ))}
          </div>
        )}
        {checks.behavior && <p style={{ fontSize: 13, color: "#7a6a5e", marginTop: 10 }}>رفتار: {BEHAVIOR_LABEL[checks.behavior]}</p>}
        {r.note && <p style={{ fontSize: 14, marginTop: 10, lineHeight: 1.9, background: "#faf6f1", borderRadius: 12, padding: "10px 12px" }}>«{r.note}»</p>}
      </div>

      {(r.products || []).length > 0 && (
        <div style={card}>
          <p style={{ ...display, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>پیشنهاد آرایشگر برای {r.pet_name}</p>
          {r.products.map((p) => {
            const url = productPhotoUrl(p);
            return (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px dashed #eadfd4" }}>
                {url ? <img src={url} alt="" style={{ width: 46, height: 46, borderRadius: 10, objectFit: "cover" }} />
                  : <span style={{ width: 46, height: 46, borderRadius: 10, background: "#fbeee0", display: "flex", alignItems: "center", justifyContent: "center" }}><Package size={20} color={brand} /></span>}
                <span style={{ flex: 1, fontSize: 14 }}>{p.name}</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{formatToman(p.price)}</span>
              </div>
            );
          })}
          <a href={shopLink} style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: 12, borderRadius: 12, background: brand, color: "white", fontWeight: 700, textDecoration: "none" }}>
            <ShoppingBag size={16} /> خرید از فروشگاه سالن
          </a>
        </div>
      )}

      <div style={{ maxWidth: 460, margin: "0 auto", textAlign: "center" }}>
        <a href={r.salon_slug ? `/${r.salon_slug}` : "/"} style={{ color: brand, fontWeight: 700, fontSize: 14 }}>رزرو نوبت بعدی</a>
      </div>

      {zoom && (
        <div role="dialog" aria-label="عکس" onClick={() => setZoom(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <img src={petPhotoUrl(zoom)} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}
