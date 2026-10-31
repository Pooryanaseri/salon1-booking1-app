import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, X, Send, Package as PackageIcon, Plus, Pencil, Truck, ShieldCheck, Ticket } from "lucide-react";
import { Modal, Switch } from "../components/ui";
import { formatToman, toFa, digitsOnly, normalizeMobile, isoToJalaliLabel } from "../lib/format";
import { watermark, recordPetWeight } from "../lib/business";
import { getSalonName } from "../lib/tenant";
import { fetchProducts, productPhotoUrl } from "../lib/shop";
import {
  GROOM_STAGES, HEALTH_CHECKS, BEHAVIOR_LABEL, setGroomStage, uploadPetPhoto, petPhotoUrl, saveVisitReport, fetchVisitReport,
  fetchPetCareSettings, savePetCareSettings, fetchPackages, savePackage, sellPackage, fetchPurchases,
} from "../lib/petcare";

/* ============================================================
   v2.49 — pet care in the panel: grooming status, visit report
   (photos + health checklist + product picks), settings, packages.
   ============================================================ */
const input = { width: "100%", padding: "9px 12px", fontSize: 14, marginTop: 4 };

/* ------------------------------------------------- grooming status bar --- */
export function GroomStageBar({ booking, onChanged, notify }) {
  const [busy, setBusy] = useState(null);
  const current = GROOM_STAGES.findIndex((s) => s.id === booking.groom_stage);
  async function pick(stage) {
    if (busy || stage === booking.groom_stage) return;
    setBusy(stage);
    const res = await setGroomStage(booking.id, stage);
    setBusy(null);
    if (!res?.ok) { notify(res?.error || "ثبت ناموفق بود"); return; }
    onChanged(stage);
    if (stage === "ready") notify(`پیامک «${booking.pet_name} آمادهٔ تحویل است» ارسال شد`);
  }
  return (
    <div className="flex gap-1" role="group" aria-label={`وضعیت ${booking.pet_name}`} style={{ marginTop: 8 }}>
      {GROOM_STAGES.map((s, i) => {
        const done = i <= current;
        const isReady = s.id === "ready";
        const color = isReady ? "var(--color-success)" : "var(--color-pet-500)";
        return (
          <button key={s.id} type="button" className="tap" aria-pressed={booking.groom_stage === s.id} onClick={() => pick(s.id)}
            style={{
              flex: 1, minHeight: 34, padding: "4px 2px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
              background: done ? color : `color-mix(in oklch, ${color} 10%, var(--color-surface))`,
              color: done ? "white" : color, border: done ? "none" : `1px solid color-mix(in oklch, ${color} 25%, transparent)`,
            }}>
            {busy === s.id ? <Loader2 size={12} className="salon-spin" style={{ margin: "auto" }} /> : s.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- photo picker --- */
function PhotoSlot({ label, paths, onAdd, onRemove, busy }) {
  const ref = useRef(null);
  return (
    <div>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
        {paths.map((p, i) => (
          <div key={p} style={{ position: "relative", width: 68, height: 68 }}>
            <img src={petPhotoUrl(p)} alt={`${label} ${toFa(i + 1)}`} style={{ width: 68, height: 68, objectFit: "cover", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }} />
            <button type="button" className="tap" aria-label={`حذف ${label} ${toFa(i + 1)}`} onClick={() => onRemove(p)}
              style={{ position: "absolute", top: -6, left: -6, width: 22, height: 22, minHeight: 0, borderRadius: "50%", background: "var(--color-danger)", color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <X size={12} />
            </button>
          </div>
        ))}
        {paths.length < 4 && (
          <button type="button" className="tap" disabled={busy} onClick={() => ref.current?.click()}
            style={{ width: 68, height: 68, borderRadius: "var(--radius-md)", border: "1px dashed var(--color-pet-500)", color: "var(--color-pet-500)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, fontSize: 11, fontWeight: 700 }}>
            {busy ? <Loader2 size={18} className="salon-spin" /> : <Camera size={18} />} عکس
          </button>
        )}
      </div>
      <input ref={ref} type="file" accept="image/*" capture="environment" multiple hidden aria-label={`انتخاب ${label}`}
        onChange={(e) => { onAdd([...(e.target.files || [])]); e.target.value = ""; }} />
    </div>
  );
}

/* ------------------------------------------------------ visit report --- */
export function VisitReportModal({ booking, notify, onClose, afterComplete }) {
  const [loaded, setLoaded] = useState(false);
  const [checks, setChecks] = useState({});
  const [behavior, setBehavior] = useState("");
  const [weight, setWeight] = useState(""); // v2.51 weight history
  const [note, setNote] = useState("");
  const [before, setBefore] = useState([]);
  const [after, setAfter] = useState([]);
  const [products, setProducts] = useState([]);
  const [picked, setPicked] = useState([]);
  const [uploading, setUploading] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sentAt, setSentAt] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchVisitReport(booking.id), fetchProducts()]).then(([r, prods]) => {
      if (!alive) return;
      if (r) {
        const c = r.checks || {};
        setChecks(Object.fromEntries(HEALTH_CHECKS.map((h) => [h.id, !!c[h.id]])));
        setBehavior(c.behavior || "");
        setNote(r.note || "");
        setBefore(r.demoBefore || (r.photos || []).filter((p) => p.includes("/before-")));
        setAfter(r.demoAfter || (r.photos || []).filter((p) => p.includes("/after-")));
        setPicked(r.product_ids || []);
        setSentAt(r.sent_at || null);
      }
      setProducts((prods || []).filter((p) => p.active));
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [booking.id]);

  async function add(kind, files) {
    setUploading(kind);
    const out = [];
    for (const f of files.slice(0, 4)) {
      // v2.50: the salon's name on every photo, so shared photos advertise the salon
      const res = await uploadPetPhoto(booking.id, kind, await watermark(f, getSalonName()));
      if (res.ok) out.push(res.path); else notify(res.error);
    }
    setUploading(null);
    (kind === "before" ? setBefore : setAfter)((x) => [...x, ...out].slice(0, 4));
  }
  async function save(send) {
    setSaving(true);
    const kg = Number(weight);
    if (weight && booking.pet_id && kg > 0 && kg <= 150) await recordPetWeight(booking.pet_id, kg);
    const res = await saveVisitReport(booking, {
      checks: { ...Object.fromEntries(Object.entries(checks).filter(([, v]) => v)), ...(behavior ? { behavior } : {}) },
      note: note.trim(), photos: [...before, ...after], before, after, productIds: picked, send,
    });
    setSaving(false);
    if (!res?.ok) { notify(res?.error || "ذخیره ناموفق بود"); return; }
    if (send && !res.sent && !res.demo) notify("گزارش ذخیره شد ولی لینک ساخته نشد (آدرس سایت تنظیم نشده)");
    else notify(send ? "گزارش برای صاحب حیوان پیامک شد" : "گزارش ذخیره شد");
    onClose(true);
  }
  const toggle = (id) => setChecks((c) => ({ ...c, [id]: !c[id] }));

  return (
    <Modal title={`گزارش ${booking.pet_name || ""}`} onClose={() => onClose(false)}>
      {!loaded ? (
        <div className="flex justify-center" style={{ padding: 20 }}><Loader2 size={18} className="salon-spin" /></div>
      ) : (
        <div className="flex flex-col gap-3">
          {afterComplete && <p style={{ fontSize: 12.5, color: "var(--color-success)", fontWeight: 700 }}>نوبت ثبت شد. عکس و گزارش برای صاحب {booking.pet_name} بفرستید؟</p>}
          <div className="flex gap-4 flex-wrap">
            <PhotoSlot label="عکس قبل" paths={before} busy={uploading === "before"} onAdd={(f) => add("before", f)} onRemove={(p) => setBefore((x) => x.filter((y) => y !== p))} />
            <PhotoSlot label="عکس بعد" paths={after} busy={uploading === "after"} onAdd={(f) => add("after", f)} onRemove={(p) => setAfter((x) => x.filter((y) => y !== p))} />
          </div>
          <div>
            <span className="muted" style={{ fontSize: 12 }}>کارت سلامت — موارد دیده‌شده را بزنید</span>
            <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
              {HEALTH_CHECKS.map((h) => (
                <button key={h.id} type="button" className="tap" aria-pressed={!!checks[h.id]} title={h.hint} onClick={() => toggle(h.id)}
                  style={{ padding: "6px 11px", minHeight: 34, borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
                    border: `1px solid ${checks[h.id] ? "var(--color-warning)" : "var(--color-border)"}`,
                    background: checks[h.id] ? "color-mix(in oklch, var(--color-warning) 16%, var(--color-surface))" : "var(--color-surface)",
                    color: checks[h.id] ? "var(--color-heading)" : "var(--color-body)" }}>
                  {h.label}
                </button>
              ))}
            </div>
            {!Object.values(checks).some(Boolean) && <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>اگر چیزی نزنید، «مشکلی دیده نشد» نمایش داده می‌شود.</p>}
          </div>
          {booking.pet_id && (
            <label className="muted" style={{ fontSize: 12 }}>وزن امروز (کیلو، اختیاری — در نمودار وزن ثبت می‌شود)
              <input dir="ltr" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)))}
                className="tabular" style={{ ...input, textAlign: "left" }} />
            </label>
          )}
          <label className="muted" style={{ fontSize: 12 }}>رفتار در این نوبت
            <select value={behavior} onChange={(e) => setBehavior(e.target.value)} style={input}>
              <option value="">—</option>
              {Object.entries(BEHAVIOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="muted" style={{ fontSize: 12 }}>توضیح برای صاحب حیوان
            <textarea rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً گوش‌ها را تمیز کردیم؛ پیشنهاد می‌کنیم به دامپزشک نشان دهید"
              style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
          </label>
          {products.length > 0 && (
            <div>
              <span className="muted" style={{ fontSize: 12 }}>محصول پیشنهادی از فروشگاه (حداکثر ۴)</span>
              <div className="flex flex-col gap-1.5" style={{ marginTop: 6, maxHeight: 180, overflowY: "auto" }}>
                {products.map((p) => {
                  const on = picked.includes(p.id);
                  const url = productPhotoUrl(p);
                  return (
                    <label key={p.id} className="flex items-center gap-2" style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={on} disabled={!on && picked.length >= 4}
                        onChange={() => setPicked((x) => (on ? x.filter((y) => y !== p.id) : [...x, p.id]))} />
                      {url ? <img src={url} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover" }} /> : <PackageIcon size={16} className="muted" />}
                      <span style={{ flex: 1 }}>{p.name}</span>
                      <span className="muted tabular" style={{ fontSize: 11.5 }}>{formatToman(p.price)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {sentAt && <p className="muted" style={{ fontSize: 11.5 }}>قبلاً ارسال شده — ارسال دوباره لینک تازه می‌فرستد.</p>}
          <div className="flex gap-2">
            <button disabled={saving || !!uploading} className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={() => save(true)}>
              {saving ? <Loader2 size={14} className="salon-spin" /> : <Send size={14} />} ذخیره و پیامک به صاحب
            </button>
            <button disabled={saving || !!uploading} className="tap ghost-btn" style={{ padding: "12px 14px" }} onClick={() => save(false)}>فقط ذخیره</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------- badges on a booking card --- */
export function PetCareBadges({ booking, pet }) {
  const items = [];
  if (booking.transport_address) items.push({ Icon: Truck, text: "رفت‌وبرگشت", title: booking.transport_address, color: "var(--color-info)" });
  if (pet?.consent_at) items.push({ Icon: ShieldCheck, text: "رضایت‌نامه", title: `پذیرفته در ${isoToJalaliLabel(String(pet.consent_at).slice(0, 10))}`, color: "var(--color-success)" });
  if (booking.package_purchase_id) items.push({ Icon: Ticket, text: "از بسته", color: "var(--color-tab-panel)" });
  if (!items.length) return null;
  return (
    <>
      {items.map(({ Icon, text, title, color }) => (
        <span key={text} className="badge" title={title} style={{ background: `color-mix(in oklch, ${color} 14%, transparent)`, color }}>
          <Icon size={12} /> {text}
        </span>
      ))}
      {booking.transport_address && (
        <div className="muted" style={{ fontSize: 11, width: "100%", lineHeight: 1.7 }}>آدرس: {booking.transport_address}</div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- settings --- */
export function PetCareSettingsCard({ notify }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchPetCareSettings().then(setS); }, []);
  if (!s) return null;
  const set = (k) => (v) => setS((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true);
    const res = await savePetCareSettings({
      ...s,
      pet_cycle_days: Math.min(365, Math.max(7, Number(s.pet_cycle_days) || 42)),
      pet_transport_fee: Math.max(0, Number(s.pet_transport_fee) || 0),
      pet_large_capacity: s.pet_large_capacity === "" || s.pet_large_capacity == null ? null : Math.min(20, Math.max(1, Number(s.pet_large_capacity))),
    });
    setBusy(false);
    notify(res.ok ? "تنظیمات مراقبت حیوانات ذخیره شد" : res.error);
  }
  const row = (label, k, hint) => (
    <div className="flex items-center justify-between gap-3" style={{ padding: "7px 0" }}>
      <div><p style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</p>{hint && <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>{hint}</p>}</div>
      <Switch checked={!!s[k]} onChange={set(k)} label={label} />
    </div>
  );
  return (
    <div className="card mb-6" style={{ padding: 14 }}>
      <p style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)", marginBottom: 4 }}>مراقبت و یادآوری حیوانات</p>
      {row("پیامک «آمادهٔ تحویل»", "pet_ready_sms", "وقتی وضعیت را «آماده» می‌زنید")}
      {row("یادآوری‌های خودکار", "pet_reminders_enabled", "واکسن رو به اتمام، وقت آرایش بعدی، تولد حیوان")}
      {s.pet_reminders_enabled && (
        <div className="flex flex-col gap-2">
          <label className="muted" style={{ fontSize: 12 }}>فاصلهٔ معمول بین دو آرایش (روز)
            <input dir="ltr" inputMode="numeric" className="tabular" value={s.pet_cycle_days} onChange={(e) => set("pet_cycle_days")(digitsOnly(e.target.value, 3))} style={{ ...input, textAlign: "left" }} />
          </label>
          <label className="muted" style={{ fontSize: 12 }}>پیشنهاد تولد (اختیاری، در پیامک تبریک)
            <input value={s.pet_birthday_message} maxLength={200} placeholder="مثلاً این هفته ۱۰٪ تخفیف حمام" onChange={(e) => set("pet_birthday_message")(e.target.value)} style={input} />
          </label>
        </div>
      )}
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
      <label className="muted" style={{ fontSize: 12 }}>رضایت‌نامهٔ آنلاین
        <select value={s.pet_consent_mode} onChange={(e) => set("pet_consent_mode")(e.target.value)} style={input}>
          <option value="off">خاموش</option>
          <option value="risky">فقط حیوان پرخاشگر یا مسن (۱۰ سال به بالا)</option>
          <option value="always">برای همه</option>
        </select>
      </label>
      {s.pet_consent_mode !== "off" && (
        <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>متن رضایت‌نامه
          <textarea rows={3} maxLength={1000} value={s.pet_consent_text} onChange={(e) => set("pet_consent_text")(e.target.value)} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </label>
      )}
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
      {row("سرویس رفت‌وبرگشت", "pet_transport_enabled", "مشتری هنگام رزرو آدرس می‌دهد؛ هزینه به نوبت اضافه می‌شود")}
      {s.pet_transport_enabled && (
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>هزینه (تومان)
            <input dir="ltr" inputMode="numeric" className="tabular" value={s.pet_transport_fee ? toFa(Number(s.pet_transport_fee).toLocaleString("en-US")) : ""} onChange={(e) => set("pet_transport_fee")(Number(digitsOnly(e.target.value, 9)) || 0)} style={{ ...input, textAlign: "left" }} />
          </label>
          <label className="muted" style={{ fontSize: 12, flex: 2 }}>محدوده
            <input value={s.pet_transport_area} maxLength={200} placeholder="مثلاً تا ۵ کیلومتری سالن" onChange={(e) => set("pet_transport_area")(e.target.value)} style={input} />
          </label>
        </div>
      )}
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "10px 0" }} />
      <label className="muted" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>دامپزشک همکار (وقتی در کارت سلامت موردی دیده شود به صاحب حیوان پیشنهاد می‌شود)
        <input value={s.pet_vet_partner || ""} maxLength={200} placeholder="مثلاً کلینیک دامپزشکی مهر — ۰۲۱۱۲۳۴۵۶۷۸" onChange={(e) => set("pet_vet_partner")(e.target.value)} style={input} />
      </label>
      <label className="muted" style={{ fontSize: 12 }}>حداکثر سگ بزرگ و غول‌پیکر همزمان (خالی = بدون محدودیت)
        <input dir="ltr" inputMode="numeric" className="tabular" value={s.pet_large_capacity ?? ""} onChange={(e) => set("pet_large_capacity")(digitsOnly(e.target.value, 2) === "" ? null : Number(digitsOnly(e.target.value, 2)))} style={{ ...input, textAlign: "left" }} />
      </label>
      <button disabled={busy} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 11, marginTop: 12 }} onClick={save}>
        {busy && <Loader2 size={14} className="salon-spin" />} ذخیره
      </button>
    </div>
  );
}

/* ---------------------------------------------------------- packages --- */
export function PackagesSection({ services, notify, isManager }) {
  const [list, setList] = useState(null);
  const [purchases, setPurchases] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selling, setSelling] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([fetchPackages(), fetchPurchases()]).then(([k, p]) => { if (alive) { setList(k); setPurchases(p); } });
    return () => { alive = false; };
  }, [tick]);
  const priced = services.filter((s) => s.is_active && !s.is_addon && s.price > 0);
  if (!list) return <div className="card flex justify-center" style={{ padding: 20 }}><Loader2 size={16} className="salon-spin" /></div>;
  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, marginBottom: 10 }}>
        بستهٔ پیش‌پرداخت (مثلاً ۴ حمام با تخفیف) را در سالن بفروشید؛ هنگام «انجام شد» یک جلسه از بستهٔ مشتری کم می‌شود.
      </p>
      {isManager && (
        <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }}
          onClick={() => setEditing({ name: "", service_id: priced[0]?.id || "", sessions: 4, price: "", valid_days: 180, active: true })}>
          <Plus size={15} /> بستهٔ جدید
        </button>
      )}
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز بسته‌ای تعریف نشده</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((k) => {
          const svc = services.find((s) => s.id === k.service_id);
          const single = svc?.price ? svc.price * k.sessions : 0;
          return (
            <div key={k.id} className="card" style={{ padding: 12, opacity: k.active ? 1 : 0.55 }} data-package={k.name}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p style={{ fontWeight: 800, fontSize: 14 }}>{k.name}</p>
                  <p className="muted tabular" style={{ fontSize: 12 }}>{toFa(k.sessions)} × {svc?.name || "؟"} · اعتبار {toFa(k.valid_days)} روز</p>
                  <p className="tabular" style={{ fontSize: 13, marginTop: 2 }}>
                    <b>{formatToman(k.price)}</b>
                    {single > k.price && <span style={{ color: "var(--color-success)", fontSize: 11.5 }}> · {toFa(Math.round(100 - (k.price * 100) / single))}٪ صرفه‌جویی</span>}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {k.active && <button className="tap accent-btn" style={{ padding: "8px 12px", fontSize: 12.5 }} onClick={() => setSelling(k)}>فروش</button>}
                  {isManager && <button className="tap ghost-btn" style={{ width: 36, height: 36, padding: 0 }} aria-label={`ویرایش ${k.name}`} onClick={() => setEditing({ ...k })}><Pencil size={14} style={{ margin: "auto" }} /></button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {purchases.length > 0 && (
        <div className="card mt-4" style={{ padding: 12 }}>
          <p style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 6 }}>بسته‌های فروخته‌شده</p>
          {purchases.slice(0, 50).map((p) => {
            const expired = p.expires_at < new Date().toISOString().slice(0, 10);
            return (
              <div key={p.id} className="flex justify-between gap-2" style={{ fontSize: 12.5, padding: "6px 0", borderTop: "1px dashed var(--color-border)" }}>
                <span>{p.customer_name || "مشتری"} <span className="muted tabular" dir="ltr">{p.customer_phone}</span> · {p.package_name}</span>
                <span className="tabular" style={{ color: expired || p.sessions_left === 0 ? "var(--color-muted)" : "var(--color-success)", fontWeight: 700, whiteSpace: "nowrap" }}>
                  {expired ? "منقضی" : `${toFa(p.sessions_left)} از ${toFa(p.sessions_total)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {editing && <PackageModal pkg={editing} services={priced} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); }} />}
      {selling && <SellModal pkg={selling} notify={notify} onClose={() => setSelling(null)} onSold={() => { setSelling(null); setTick((t) => t + 1); }} />}
    </div>
  );
}

function PackageModal({ pkg, services, onClose, onSaved }) {
  const [k, setK] = useState(pkg);
  const [err, setErr] = useState("");
  const set = (f) => (v) => setK((x) => ({ ...x, [f]: v }));
  async function save() {
    const res = await savePackage(k, services);
    if (!res.ok) { setErr(res.error); return; }
    onSaved();
  }
  return (
    <Modal title={k.id ? "ویرایش بسته" : "بستهٔ جدید"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>نام بسته
          <input value={k.name} maxLength={60} placeholder="مثلاً ۴ حمام کامل" onChange={(e) => set("name")(e.target.value)} style={input} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>خدمت
          <select value={k.service_id} onChange={(e) => set("service_id")(e.target.value)} style={input}>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({formatToman(s.price)})</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>تعداد جلسات
            <input dir="ltr" inputMode="numeric" className="tabular" value={k.sessions} onChange={(e) => set("sessions")(digitsOnly(e.target.value, 2))} style={{ ...input, textAlign: "left" }} />
          </label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>اعتبار (روز)
            <input dir="ltr" inputMode="numeric" className="tabular" value={k.valid_days} onChange={(e) => set("valid_days")(digitsOnly(e.target.value, 3))} style={{ ...input, textAlign: "left" }} />
          </label>
        </div>
        <label className="muted" style={{ fontSize: 12 }}>قیمت کل بسته (تومان)
          <input dir="ltr" inputMode="numeric" className="tabular" value={k.price === "" ? "" : toFa(Number(k.price).toLocaleString("en-US"))} onChange={(e) => set("price")(digitsOnly(e.target.value, 11))} style={{ ...input, textAlign: "left" }} />
        </label>
        <div className="flex items-center justify-between"><span style={{ fontSize: 13 }}>قابل فروش</span><Switch checked={k.active !== false} onChange={set("active")} label="قابل فروش" /></div>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
      </div>
    </Modal>
  );
}

function SellModal({ pkg, onClose, onSold, notify }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function sell() {
    setBusy(true); setErr("");
    const res = await sellPackage(pkg, phone, name.trim());
    setBusy(false);
    if (!res?.ok) { setErr(res?.error || "ثبت ناموفق بود"); return; }
    notify(`بستهٔ «${pkg.name}» فعال شد و به مشتری پیامک شد`);
    onSold();
  }
  return (
    <Modal title={`فروش «${pkg.name}»`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="muted tabular" style={{ fontSize: 12.5 }}>مبلغ را در سالن دریافت کنید: <b>{formatToman(pkg.price)}</b></p>
        <label className="muted" style={{ fontSize: 12 }}>موبایل مشتری
          <input dir="ltr" type="tel" inputMode="tel" className="tabular" value={phone} placeholder="09xxxxxxxxx" onChange={(e) => setPhone(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>نام (اختیاری)
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={input} />
        </label>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={busy || !/^09\d{9}$/.test(phone)} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={sell}>
          {busy && <Loader2 size={14} className="salon-spin" />} ثبت فروش
        </button>
      </div>
    </Modal>
  );
}
