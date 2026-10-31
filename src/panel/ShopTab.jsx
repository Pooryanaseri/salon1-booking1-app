import { useEffect, useRef, useState } from "react";
import { Boxes, ShoppingBag, Package, Settings, Plus, Pencil, Loader2, Phone, MapPin, Camera, Trash2, Truck, Store, AlertTriangle } from "lucide-react";
import { formatToman, toFa, digitsOnly } from "../lib/format";
import { Modal, Switch } from "../components/ui";
import { SuppliesSection } from "./BusinessTools";
import {
  fetchOrders, setOrderStatus, markOrderRefunded, fetchProducts, saveProduct, deleteProduct, uploadProductPhoto,
  fetchShopSettings, saveShopSettings, ORDER_STATUS, shopCategories, categoryLabel, productPhotoUrl,
} from "../lib/shop";

/* ============================================================
   v2.48 — panel: shop orders, products and settings.
   Orders: every staff member (they hand them over at the desk).
   Products and settings: managers only.
   ============================================================ */
const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4 };
const FILTERS = [
  ["open", "باز"], ["pending", "جدید"], ["done", "بسته‌شده"], ["all", "همه"],
];

export function ShopTab({ isManager, notify, onPendingChange, onShopEnabledChange }) {
  const [segment, setSegment] = useState("orders");
  const segs = [
    { id: "orders", label: "سفارش‌ها", Icon: ShoppingBag },
    ...(isManager ? [{ id: "products", label: "کالاها", Icon: Package }] : []),
    { id: "supplies", label: "انبار مواد", Icon: Boxes },
    ...(isManager ? [{ id: "settings", label: "تنظیمات", Icon: Settings }] : []),
  ];
  return (
    <div className="fade-in">
      {segs.length > 1 && (
        <div className="flex gap-2 mb-3" role="tablist" aria-label="بخش‌های فروشگاه">
          {segs.map((s) => (
            <button key={s.id} role="tab" aria-selected={segment === s.id} onClick={() => setSegment(s.id)} className="tap flex-1 flex items-center justify-center gap-1"
              style={{ padding: "9px 6px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
                background: segment === s.id ? "var(--color-tab-shop)" : "var(--color-surface)", color: segment === s.id ? "white" : "var(--color-body)",
                border: segment === s.id ? "none" : "1px solid var(--color-border)" }}>
              <s.Icon size={14} /> {s.label}
            </button>
          ))}
        </div>
      )}
      {segment === "orders" && <OrdersSection isManager={isManager} notify={notify} onPendingChange={onPendingChange} />}
      {segment === "products" && isManager && <ProductsSection notify={notify} />}
      {segment === "settings" && isManager && <SettingsSection notify={notify} onShopEnabledChange={onShopEnabledChange} />}
      {segment === "supplies" && <SuppliesSection isManager={isManager} notify={notify} />}
    </div>
  );
}

/* ------------------------------------------------------------ orders --- */
function OrdersSection({ isManager, notify, onPendingChange }) {
  const [orders, setOrders] = useState(null);
  const [filter, setFilter] = useState("open");
  const [tick, setTick] = useState(0);
  const [cancelFor, setCancelFor] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchOrders().then((list) => {
      if (!alive) return;
      setOrders(list);
      onPendingChange?.(list.filter((o) => o.status === "pending").length);
    });
    return () => { alive = false; };
  }, [tick, onPendingChange]);

  async function move(o, status, note = "", tracking = {}) {
    setBusy(o.id);
    const res = await setOrderStatus(o.id, status, note, tracking);
    setBusy(null);
    if (!res?.ok) { notify(res?.error || "ثبت ناموفق بود"); return false; }
    notify(`سفارش ${toFa(o.code)}: ${ORDER_STATUS[status].label}`);
    setTick((t) => t + 1);
    return true;
  }
  async function refunded(o) {
    if (!window.confirm("مبلغ این سفارش را از پنل زرین‌پال بازگردانده‌اید؟")) return;
    const res = await markOrderRefunded(o.id);
    if (!res?.ok) { notify(res?.error || "ثبت ناموفق بود"); return; }
    setTick((t) => t + 1);
  }

  if (!orders) {
    return <div className="card flex items-center justify-center gap-2" style={{ padding: 24 }}><Loader2 size={15} className="salon-spin" /><span className="muted" style={{ fontSize: 12.5 }}>در حال بارگذاری…</span></div>;
  }
  const refunds = orders.filter((o) => o.refund_needed);
  const shown = orders.filter((o) => {
    if (filter === "open") return ["pending", "confirmed", "ready", "shipped"].includes(o.status);
    if (filter === "pending") return o.status === "pending";
    if (filter === "done") return ["delivered", "cancelled"].includes(o.status);
    return true;
  });
  return (
    <div>
      {refunds.length > 0 && isManager && (
        <div className="card mb-3" style={{ padding: 12, borderColor: "var(--color-warning)" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 800, color: "var(--color-warning)" }}>
            <AlertTriangle size={14} /> {toFa(refunds.length)} سفارش پرداخت‌شده باید بازگردانده شود
          </p>
          <p className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.8 }}>از پنل زرین‌پال مبلغ را برگردانید، سپس اینجا ثبت کنید.</p>
          {refunds.map((o) => (
            <div key={o.id} className="flex items-center justify-between" style={{ marginTop: 6, fontSize: 12.5 }}>
              <span className="tabular">سفارش {toFa(o.code)} · {formatToman(o.total)}{o.payment_ref ? ` · کد پیگیری ${o.payment_ref}` : ""}</span>
              <button className="tap ghost-btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => refunded(o)}>بازگردانده شد</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 mb-3" style={{ overflowX: "auto" }}>
        {FILTERS.map(([id, label]) => (
          <button key={id} className="tap" aria-pressed={filter === id} onClick={() => setFilter(id)}
            style={{ padding: "6px 12px", borderRadius: "var(--radius-full)", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
              border: `1px solid ${filter === id ? "var(--color-tab-shop)" : "var(--color-border)"}`,
              background: filter === id ? "color-mix(in oklch, var(--color-tab-shop) 12%, var(--color-surface))" : "var(--color-surface)",
              color: filter === id ? "var(--color-tab-shop)" : "var(--color-body)" }}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="card" style={{ padding: 20, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>سفارشی نیست</p></div>}
      <div className="flex flex-col gap-2">
        {shown.map((o) => {
          const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
          const items = o.order_items || [];
          return (
            <div key={o.id} className="card" data-order={o.code} style={{ padding: 12 }}>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular" style={{ fontWeight: 800, fontSize: 14 }}>سفارش {toFa(o.code)}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color }}>{st.label}</span>
              </div>
              <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 2 }}>{new Date(o.created_at).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" })}</p>
              <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.9 }}>
                {items.map((i) => (
                  <div key={i.id} className="flex justify-between gap-2">
                    <span>{i.name}{i.qty > 1 ? ` ×${toFa(i.qty)}` : ""}</span>
                    <span className="tabular muted">{formatToman(i.unit_price * i.qty)}</span>
                  </div>
                ))}
                {o.shipping_fee > 0 && <div className="flex justify-between"><span>ارسال</span><span className="tabular muted">{formatToman(o.shipping_fee)}</span></div>}
                <div className="flex justify-between" style={{ fontWeight: 800 }}>
                  <span>جمع</span><span className="tabular">{formatToman(o.total)}</span>
                </div>
              </div>
              <p style={{ fontSize: 12, marginTop: 6 }}>
                <b>{o.paid_at ? "پرداخت‌شده (آنلاین)" : o.payment_method === "online" ? "منتظر پرداخت آنلاین" : "پرداخت هنگام تحویل"}</b>
              </p>
              <div className="flex flex-col gap-1" style={{ marginTop: 6, fontSize: 12.5 }}>
                <span className="flex items-center gap-1.5"><Phone size={13} /> {o.customer_name} · <a href={`tel:${o.customer_phone}`} className="tabular" dir="ltr">{o.customer_phone}</a></span>
                <span className="flex items-center gap-1.5">
                  {o.delivery === "shipping" ? <Truck size={13} /> : <Store size={13} />}
                  {o.delivery === "shipping" ? "ارسال به آدرس" : "تحویل در سالن"}
                </span>
                {o.delivery === "shipping" && (
                  <span className="flex items-start gap-1.5" style={{ lineHeight: 1.8 }}><MapPin size={13} style={{ marginTop: 4, flexShrink: 0 }} />{o.address}{o.postal_code ? ` — کد پستی ${o.postal_code}` : ""}</span>
                )}
                {o.customer_note && <span className="muted">توضیح مشتری: {o.customer_note}</span>}
                {o.staff_note && <span className="muted">یادداشت: {o.staff_note}</span>}
                {o.tracking_code && <span>کد رهگیری{o.carrier ? ` ${o.carrier}` : ""}: <b className="tabular" dir="ltr">{o.tracking_code}</b></span>}
                {o.coupon_code && <span className="muted">کد تخفیف {o.coupon_code}{o.coupon_discount ? ` (−${formatToman(o.coupon_discount)})` : ""}</span>}
                {o.status === "cancelled" && o.cancel_reason && <span style={{ color: "var(--color-danger)" }}>دلیل لغو: {o.cancel_reason === "expired" ? "پرداخت نشد" : o.cancel_reason}</span>}
              </div>
              <OrderActions o={o} busy={busy === o.id} onMove={move} onCancel={() => setCancelFor(o)} />
            </div>
          );
        })}
      </div>
      {cancelFor && (
        <CancelOrderModal order={cancelFor} onClose={() => setCancelFor(null)}
          onConfirm={async (reason) => { if (await move(cancelFor, "cancelled", reason)) setCancelFor(null); }} />
      )}
    </div>
  );
}

function OrderActions({ o, busy, onMove, onCancel }) {
  const [track, setTrack] = useState(""); // v2.51
  const [carrier, setCarrier] = useState("پست");
  const next = {
    pending: [["confirmed", "تایید و آماده‌سازی"]],
    confirmed: [o.delivery === "shipping" ? ["shipped", "ارسال شد"] : ["ready", "آمادهٔ تحویل"]],
    ready: [["delivered", "تحویل داده شد"]],
    shipped: [["delivered", "تحویل شد"]],
  }[o.status];
  if (!next) return null;
  const needsNote = next[0][0] === "shipped";
  return (
    <div style={{ marginTop: 10 }}>
      {needsNote && (
        <div className="flex gap-2" style={{ marginBottom: 6 }}>
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="شرکت ارسال" style={{ ...input, marginTop: 0, width: 110, fontSize: 13 }}>
            {["پست", "تیپاکس", "پیک", "چاپار", "ماهکس"].map((c) => <option key={c}>{c}</option>)}
          </select>
          <input dir="ltr" value={track} onChange={(e) => setTrack(e.target.value)} maxLength={40} placeholder="کد رهگیری (اختیاری)"
            aria-label="کد رهگیری مرسوله" style={{ ...input, marginTop: 0, fontSize: 13, textAlign: "left" }} />
        </div>
      )}
      <div className="flex gap-2">
        {next.map(([status, label]) => (
          <button key={status} disabled={busy} className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: "9px 8px", fontSize: 12.5 }}
            onClick={() => onMove(o, status, "", needsNote ? { code: track.trim(), carrier } : {})}>
            {busy && <Loader2 size={13} className="salon-spin" />} {label}
          </button>
        ))}
        <button disabled={busy} className="tap ghost-btn" style={{ padding: "9px 12px", fontSize: 12.5, color: "var(--color-danger)" }} onClick={onCancel}>لغو</button>
      </div>
    </div>
  );
}

function CancelOrderModal({ order, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`لغو سفارش ${toFa(order.code)}`} onClose={onClose} danger>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
        دلیل لغو برای مشتری پیامک می‌شود و موجودی کالاها برمی‌گردد.
        {order.paid_at && " این سفارش آنلاین پرداخت شده — بعد از لغو، مبلغ را از پنل زرین‌پال بازگردانید."}
      </p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="مثلاً کالا تمام شده است" aria-label="دلیل لغو" style={input} />
      <button disabled={!reason.trim() || busy} className="tap w-full" style={{ marginTop: 12, padding: 12, borderRadius: "var(--radius-md)", background: "var(--color-danger)", color: "white", fontWeight: 800 }}
        onClick={async () => { setBusy(true); await onConfirm(reason.trim()); setBusy(false); }}>
        لغو سفارش
      </button>
    </Modal>
  );
}

/* ----------------------------------------------------------- products --- */
function ProductsSection({ notify }) {
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchProducts().then((list) => { if (alive) setProducts(list); });
    return () => { alive = false; };
  }, [tick]);

  if (!products) {
    return <div className="card flex items-center justify-center gap-2" style={{ padding: 24 }}><Loader2 size={15} className="salon-spin" /></div>;
  }
  return (
    <div>
      <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }}
        onClick={() => setEditing({ name: "", description: "", category: shopCategories()[0][0], price: "", stock: "", active: true, sort_order: products.length })}>
        <Plus size={15} /> افزودن کالا
      </button>
      {products.length === 0 && <div className="card" style={{ padding: 20, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز کالایی ندارید</p></div>}
      <div className="flex flex-col gap-2">
        {products.map((p) => {
          const url = productPhotoUrl(p);
          return (
            <div key={p.id} className="card flex items-center gap-3" data-product={p.name} style={{ padding: 10, opacity: p.active ? 1 : 0.55 }}>
              <div style={{ width: 52, height: 52, borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--color-accent-50)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Package size={20} color="var(--color-accent-500)" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name}</p>
                <p className="muted tabular" style={{ fontSize: 12 }}>
                  {formatToman(p.price)} · {categoryLabel(p.category)} · {p.stock == null ? "موجودی نامحدود" : p.stock === 0 ? "ناموجود" : `${toFa(p.stock)} عدد`}
                  {!p.active && " · مخفی"}
                </p>
              </div>
              <button className="tap ghost-btn" style={{ width: 36, height: 36, padding: 0 }} aria-label={`ویرایش ${p.name}`} onClick={() => setEditing({ ...p, stock: p.stock ?? "" })}>
                <Pencil size={15} style={{ margin: "auto" }} />
              </button>
            </div>
          );
        })}
      </div>
      {editing && (
        <ProductModal product={editing} notify={notify} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); }} />
      )}
    </div>
  );
}

function ProductModal({ product, onClose, onSaved, notify }) {
  const [p, setP] = useState(product);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  const photo = productPhotoUrl(p);

  async function pickPhoto(file) {
    if (!file) return;
    setUploading(true); setError("");
    const res = await uploadProductPhoto(file);
    setUploading(false);
    if (!res.ok) { setError(res.error); return; }
    setP((x) => ({ ...x, photo_path: res.path || x.photo_path, demoPhoto: res.demoPhoto }));
  }
  async function save() {
    setBusy(true); setError("");
    const res = await saveProduct(p);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    notify(p.id ? "کالا ذخیره شد" : "کالا اضافه شد");
    onSaved();
  }
  async function remove() {
    if (!window.confirm(`«${p.name}» حذف شود؟ (سفارش‌های قبلی باقی می‌مانند)`)) return;
    const res = await deleteProduct(p.id);
    if (!res.ok) { setError(res.error); return; }
    notify("کالا حذف شد");
    onSaved();
  }
  return (
    <Modal title={p.id ? "ویرایش کالا" : "کالای جدید"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div style={{ width: 84, height: 84, borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--color-accent-50)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {uploading ? <Loader2 size={20} className="salon-spin" /> : photo ? <img src={photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Package size={26} color="var(--color-accent-500)" />}
          </div>
          <div className="flex flex-col gap-2">
            <button type="button" className="tap ghost-btn flex items-center gap-1" style={{ padding: "8px 12px", fontSize: 12.5 }} onClick={() => fileRef.current?.click()}>
              <Camera size={14} /> {photo ? "تغییر عکس" : "افزودن عکس"}
            </button>
            {photo && <button type="button" className="muted" style={{ fontSize: 12 }} onClick={() => setP((x) => ({ ...x, photo_path: null, demoPhoto: null }))}>حذف عکس</button>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden aria-label="انتخاب عکس کالا" onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <label className="muted" style={{ fontSize: 12 }}>نام کالا
          <input value={p.name} maxLength={80} onChange={(e) => set("name")(e.target.value)} style={input} />
        </label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>قیمت (تومان)
            <input dir="ltr" inputMode="numeric" className="tabular" value={p.price === "" ? "" : toFa(Number(p.price).toLocaleString("en-US"))}
              onChange={(e) => set("price")(digitsOnly(e.target.value, 11))} style={{ ...input, textAlign: "left" }} />
          </label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>موجودی (خالی = نامحدود)
            <input dir="ltr" inputMode="numeric" className="tabular" value={p.stock === "" || p.stock == null ? "" : String(p.stock)}
              onChange={(e) => set("stock")(digitsOnly(e.target.value, 6))} style={{ ...input, textAlign: "left" }} />
          </label>
        </div>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 2 }}>گروه اندازه (اختیاری)
            <input value={p.variant_group || ""} maxLength={80} placeholder="مثلاً غذای سگ بالغ" onChange={(e) => set("variant_group")(e.target.value)} style={input} />
          </label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>اندازه
            <input value={p.variant_label || ""} maxLength={40} placeholder="۲ کیلو" onChange={(e) => set("variant_label")(e.target.value)} style={input} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: -6 }}>کالاهایی با «گروه اندازه»ی یکسان در فروشگاه یک کارت با انتخاب اندازه می‌شوند.</p>
        <label className="muted" style={{ fontSize: 12 }}>دسته
          <select value={p.category} onChange={(e) => set("category")(e.target.value)} style={input}>
            {shopCategories().map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            {p.category && !shopCategories().some(([k]) => k === p.category) && <option value={p.category}>{p.category}</option>}
          </select>
        </label>
        <label className="muted" style={{ fontSize: 12 }}>توضیحات (اختیاری)
          <textarea rows={2} maxLength={600} value={p.description} onChange={(e) => set("description")(e.target.value)} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </label>
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 13 }}>نمایش در فروشگاه</span>
          <Switch checked={p.active !== false} onChange={set("active")} label="نمایش در فروشگاه" />
        </div>
        {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy || uploading} className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={save}>
            {busy && <Loader2 size={14} className="salon-spin" />} ذخیره
          </button>
          {p.id && (
            <button className="tap ghost-btn" style={{ padding: "12px 14px", color: "var(--color-danger)" }} aria-label="حذف کالا" onClick={remove}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- settings --- */
function SettingsSection({ notify, onShopEnabledChange }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchShopSettings().then(setS); }, []);
  if (!s) return <div className="card flex items-center justify-center gap-2" style={{ padding: 24 }}><Loader2 size={15} className="salon-spin" /></div>;
  const set = (k) => (v) => setS((x) => ({ ...x, [k]: v }));
  const money = (k) => ({
    dir: "ltr", inputMode: "numeric", className: "tabular",
    value: s[k] ? toFa(Number(s[k]).toLocaleString("en-US")) : "",
    onChange: (e) => set(k)(Number(digitsOnly(e.target.value, 10)) || 0),
    style: { ...input, textAlign: "left" },
  });
  async function save() {
    if (!s.pickup_enabled && !s.shipping_enabled) { notify("دست‌کم یکی از «تحویل در سالن» یا «ارسال» را روشن کنید"); return; }
    setBusy(true);
    const res = await saveShopSettings(s);
    setBusy(false);
    if (!res.ok) { notify(res.error); return; }
    onShopEnabledChange?.(!!s.enabled);
    notify("تنظیمات فروشگاه ذخیره شد");
  }
  const row = (label, k, hint) => (
    <div className="flex items-center justify-between gap-3" style={{ padding: "8px 0" }}>
      <div><p style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</p>{hint && <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>{hint}</p>}</div>
      <Switch checked={!!s[k]} onChange={set(k)} label={label} />
    </div>
  );
  return (
    <div className="card" style={{ padding: 14 }}>
      {row("فروشگاه فعال باشد", "enabled", "تب «فروشگاه» برای مشتری‌ها نمایش داده می‌شود")}
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "6px 0" }} />
      {row("تحویل در سالن", "pickup_enabled")}
      {s.pickup_enabled && (
        <label className="muted" style={{ fontSize: 12 }}>آدرس سالن برای تحویل
          <input value={s.pickup_address} maxLength={300} onChange={(e) => set("pickup_address")(e.target.value)} style={input} />
        </label>
      )}
      {row("ارسال به آدرس مشتری", "shipping_enabled")}
      {s.shipping_enabled && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <label className="muted" style={{ fontSize: 12, flex: 1 }}>هزینهٔ ارسال (تومان)<input aria-label="هزینهٔ ارسال" {...money("shipping_fee")} /></label>
            <label className="muted" style={{ fontSize: 12, flex: 1 }}>ارسال رایگان بالای (۰ = هرگز)<input aria-label="حد ارسال رایگان" {...money("free_shipping_over")} /></label>
          </div>
          <label className="muted" style={{ fontSize: 12 }}>محدوده و زمان ارسال
            <input value={s.shipping_area} maxLength={200} placeholder="مثلاً فقط داخل شهر — ۱ تا ۲ روز کاری" onChange={(e) => set("shipping_area")(e.target.value)} style={input} />
          </label>
        </div>
      )}
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "10px 0 6px" }} />
      <p style={{ fontSize: 13.5, fontWeight: 700 }}>پرداخت</p>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 2 }}>
        {s.online_ready
          ? "پرداخت آنلاین با درگاه زرین‌پال سالن فعال است."
          : "درگاه زرین‌پال سالن تنظیم نشده — مشتری‌ها هنگام تحویل پرداخت می‌کنند. برای پرداخت آنلاین، مرچنت‌کد را در «ساعات کاری ← پیش‌پرداخت آنلاین» ذخیره کنید (درصد بیعانه می‌تواند خاموش بماند)."}
      </p>
      {s.online_ready && row("پرداخت هنگام تحویل هم مجاز باشد", "cash_enabled")}
      <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 6 }}>پیام کوتاه بالای فروشگاه (اختیاری)
        <input value={s.note} maxLength={300} onChange={(e) => set("note")(e.target.value)} style={input} />
      </label>
      <button disabled={busy} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12, marginTop: 14 }} onClick={save}>
        {busy && <Loader2 size={14} className="salon-spin" />} ذخیرهٔ تنظیمات
      </button>
    </div>
  );
}
