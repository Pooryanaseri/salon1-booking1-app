import { useState } from "react";
import { Sparkles, Percent, Banknote, Plus, Trash2, Pencil, Settings } from "lucide-react";
import { toFa, formatToman } from "../lib/format";
import { CATEGORY_LABEL, SECTION_META, SERVICE_ICONS, discountAmountFor, finalPriceFor, hasPrice, priceLabel, uid } from "../app/shared";
import { GenderBadge, Modal, PanelSectionHeader, Row, Switch } from "../components/ui";

/* ============================================================
   Services management tab — discounts are configured HERE, per
   service, and apply to every booking of that service.
   ============================================================ */
export function ServicesTab({ services, setServices, notify }) {
  const [editing, setEditing] = useState(null); // service object or 'new'
  const [genderFilter, setGenderFilter] = useState("all");

  function toggleActive(id) {
    setServices((prev) => prev.map((s) => (s.id === id ? { ...s, is_active: !s.is_active } : s)));
  }
  function removeService(id) {
    setServices((prev) => prev.filter((s) => s.id !== id));
    notify("خدمت حذف شد");
  }
  function saveService(data) {
    if (data.id) {
      setServices((prev) => prev.map((s) => (s.id === data.id ? { ...s, ...data } : s)));
      notify("خدمت ویرایش شد");
    } else {
      setServices((prev) => [...prev, { ...data, id: uid() }]);
      notify("خدمت جدید اضافه شد");
    }
    setEditing(null);
  }

  const filtered = genderFilter === "all" ? services : services.filter((s) => s.gender === genderFilter);

  return (
    <div>
      <PanelSectionHeader Icon={Settings} title="خدمات" subtitle="افزودن، قیمت‌گذاری، و مدیریت خدمات هر بخش" color="var(--color-tab-services)" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "all", l: "همه" }, { v: "female", l: "زنانه" }, { v: "male", l: "مردانه" }].map((f) => (
            <button
              key={f.v}
              onClick={() => setGenderFilter(f.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: genderFilter === f.v ? "var(--color-surface)" : "transparent",
                color: genderFilter === f.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
        <button className="tap accent-btn flex items-center gap-1" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => setEditing("new")}>
          <Plus size={15} /> افزودن خدمت
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((s) => {
          const Icon = SERVICE_ICONS[s.category] || Sparkles;
          const dAmt = discountAmountFor(s);
          const fPrice = finalPriceFor(s);
          return (
            <div key={s.id} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, opacity: s.is_active ? 1 : 0.55 }}>
              <div style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: SECTION_META[s.gender].tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={16} color={SECTION_META[s.gender].color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--color-heading)" }}>{s.name}</span>
                  <GenderBadge gender={s.gender} />
                </div>
                <div className="muted tabular" style={{ fontSize: 11.5, marginTop: 1 }}>
                  {CATEGORY_LABEL[s.category]} · {toFa(s.duration_minutes)} د
                  {s.buffer_minutes > 0 && <> (+{toFa(s.buffer_minutes)} د تایم اصلاح)</>}
                  {" · "}
                  {!hasPrice(s) ? (
                    priceLabel(s)
                  ) : dAmt > 0 ? (
                    <>
                      <span style={{ textDecoration: "line-through" }}>{formatToman(s.price)}</span>{" "}
                      <span style={{ color: "var(--color-danger)", fontWeight: 700 }}>{formatToman(fPrice)}</span>
                    </>
                  ) : (
                    formatToman(s.price)
                  )}
                </div>
              </div>
              <Switch checked={s.is_active} onChange={() => toggleActive(s.id)} />
              <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} onClick={() => setEditing(s)}>
                <Pencil size={14} style={{ margin: "auto" }} />
              </button>
              <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0, color: "var(--color-danger)" }} onClick={() => removeService(s.id)}>
                <Trash2 size={14} style={{ margin: "auto" }} />
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>خدمتی در این بخش ثبت نشده</p>
          </div>
        )}
      </div>

      {editing && <ServiceEditModal service={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveService} />}
    </div>
  );
}

export function ServiceEditModal({ service, onClose, onSave }) {
  const [name, setName] = useState(service?.name || "");
  const [gender, setGender] = useState(service?.gender || "female");
  const [category, setCategory] = useState(service?.category || "hair");
  const [duration, setDuration] = useState(service?.duration_minutes || 30);
  // Buffer ("touch-up"/cleanup time) is optional and stylist-defined per service — added after the
  // appointment before the next one can start; not shown to the customer as part of the duration.
  const [buffer, setBuffer] = useState(service?.buffer_minutes ? String(service.buffer_minutes) : "");
  // Price is optional — an empty field means "price announced in salon", not zero.
  const [price, setPrice] = useState(service?.price != null ? String(service.price) : "");
  const [discountType, setDiscountType] = useState(service?.discount_type || "none");
  const [discountValue, setDiscountValue] = useState(service?.discount_value || 0);
  const [discountReason, setDiscountReason] = useState(service?.discount_reason || "");
  const [cycleDays, setCycleDays] = useState(service?.average_cycle_days ? String(service.average_cycle_days) : "");

  const priceNum = price === "" ? null : Number(price);
  const priceSet = priceNum != null && priceNum > 0;
  const previewAmount = !priceSet || discountType === "none" || !discountValue ? 0
    : discountType === "percent" ? Math.round((priceNum * discountValue) / 100) : discountValue;
  const previewFinal = priceSet ? Math.max(0, priceNum - previewAmount) : 0;

  return (
    <Modal title={service ? "ویرایش خدمت" : "افزودن خدمت جدید"} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>بخش</label>
          <div className="flex gap-2 mt-1">
            {["female", "male"].map((g) => {
              const meta = SECTION_META[g];
              const Icon = meta.Icon;
              return (
                <button
                  key={g}
                  onClick={() => setGender(g)}
                  className="tap flex-1 flex items-center justify-center gap-1.5"
                  style={{
                    padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                    border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                    background: gender === g ? meta.tint : "var(--color-surface)",
                    color: gender === g ? meta.color : "var(--color-body)",
                  }}
                >
                  <Icon size={14} /> {meta.short}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="muted" style={{ fontSize: 12 }}>نام خدمت</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>دسته‌بندی</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
            {Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>مدت (دقیقه)</label>
            <input type="number" min={5} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>تایم اصلاح (دقیقه) — اختیاری</label>
            <input
              type="number" min={0} step={5} value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              placeholder="بدون تایم اصلاح"
              className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>
          تایم اصلاح بعد از پایان نوبت به‌صورت خودکار خالی نگه داشته می‌شود (مثلاً برای تمیزکاری یا آماده‌سازی) و به مشتری نمایش داده نمی‌شود
        </p>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>قیمت (تومان) — اختیاری</label>
          <input
            type="number" min={0} step={1000} value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="تعیین نشده"
            className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
          />
        </div>
        {!priceSet && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>
            اگر قیمت خالی بماند، به مشتری «قیمت در سالن اعلام می‌شود» نمایش داده می‌شود
          </p>
        )}

        <div style={{ borderTop: "1px dashed var(--color-border)", paddingTop: 12, opacity: priceSet ? 1 : 0.5 }}>
          <label className="muted" style={{ fontSize: 12 }}>تخفیف این خدمت (اختیاری — برای همه مشتریان این خدمت اعمال می‌شود)</label>
          {!priceSet ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>برای تعریف تخفیف، ابتدا قیمت خدمت را وارد کنید</p>
          ) : (
            <>
              <div className="flex gap-2 mt-2">
                {[{ v: "none", l: "بدون تخفیف" }, { v: "percent", l: "درصدی", Icon: Percent }, { v: "fixed", l: "مبلغ ثابت", Icon: Banknote }].map((o) => (
                  <button
                    key={o.v}
                    onClick={() => { setDiscountType(o.v); if (o.v === "none") setDiscountValue(0); }}
                    className="tap flex-1 flex items-center justify-center gap-1"
                    style={{
                      padding: 9, borderRadius: "var(--radius-md)", fontSize: 12, fontWeight: 700,
                      border: `1px solid ${discountType === o.v ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: discountType === o.v ? "var(--color-accent-500)" : "var(--color-surface)",
                      color: discountType === o.v ? "oklch(16% 0.02 70)" : "var(--color-body)",
                    }}
                  >
                    {o.Icon && <o.Icon size={12} />} {o.l}
                  </button>
                ))}
              </div>

              {discountType !== "none" && (
                <div className="fade-in mt-3">
                  <label className="muted" style={{ fontSize: 12 }}>{discountType === "percent" ? "درصد تخفیف" : "مبلغ تخفیف (تومان)"}</label>
                  <input
                    type="number" min={0} max={discountType === "percent" ? 100 : priceNum}
                    value={discountValue} onChange={(e) => setDiscountValue(Math.max(0, Number(e.target.value)))}
                    className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
                  />
                  <label className="muted" style={{ fontSize: 12, marginTop: 10, display: "block" }}>دلیل (یادداشت داخلی — اختیاری)</label>
                  <textarea value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} rows={2} style={{ width: "100%", padding: "10px 14px", fontSize: 13, marginTop: 4, resize: "none" }} />

                  <div className="card mt-3" style={{ padding: 12 }}>
                    <Row label="قیمت اصلی" value={formatToman(priceNum)} strike={previewAmount > 0} />
                    <Row label="تخفیف" value={"- " + formatToman(previewAmount)} />
                    <div style={{ borderTop: "1px dashed var(--color-border)", margin: "8px 0" }} />
                    <Row label="قیمت نهایی مشتری" value={formatToman(previewFinal)} bold />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <label className="muted" style={{ fontSize: 12 }}>فاصلهٔ معمول بین نوبت‌ها (روز) — اختیاری</label>
          <input
            type="number" min={1} step={1} value={cycleDays}
            onChange={(e) => setCycleDays(e.target.value)}
            placeholder="مثلاً ۳۰ روز برای کوتاهی مو"
            className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
          />
          <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            وقتی پر بشه، نزدیک این موعد برای مشتری‌هایی که نوبت آینده‌ای برای این خدمت ندارن، خودکار پیامک یادآوریِ رزرو مجدد ارسال می‌شه
          </p>
        </div>

        <button
          disabled={!name.trim()}
          className="tap accent-btn w-full mt-1"
          style={{ padding: 12 }}
          onClick={() => onSave({
            id: service?.id, name: name.trim(), gender, category, duration_minutes: duration,
            buffer_minutes: buffer === "" ? 0 : Math.max(0, Number(buffer)),
            price: priceSet ? priceNum : null,
            is_active: service?.is_active ?? true,
            discount_type: priceSet ? discountType : "none",
            discount_value: priceSet ? discountValue : 0,
            discount_reason: priceSet ? discountReason.trim() : "",
            average_cycle_days: cycleDays === "" ? null : Math.max(1, Number(cycleDays)),
          })}
        >
          {service ? "ذخیره تغییرات" : "افزودن خدمت"}
        </button>
      </div>
    </Modal>
  );
}
