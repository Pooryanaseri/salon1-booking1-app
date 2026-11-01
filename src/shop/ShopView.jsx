import { useEffect, useMemo, useState } from "react";
import { ShoppingBag, ShoppingCart, Plus, Minus, Trash2, ArrowRight, Loader2, Package, Store, Truck, CreditCard, Wallet, CheckCircle2, Search } from "lucide-react";
import { formatToman, toFa, normalizeMobile, digitsOnly } from "../lib/format";
import { startOrderPayment } from "../lib/api";
import { checkCoupon } from "../lib/business";
import { groupVariants, fetchShop, placeOrder, priceCart, shippingFor, productPhotoUrl, categoryLabel, loadCart, saveCart, PRODUCT_AUDIENCE } from "../lib/shop";
import { isPetSalon } from "../lib/tenant";

/* ============================================================
   v2.48 — the salon's shop: catalog → cart → checkout → done.
   The cart lives in localStorage; prices, shipping and stock are
   re-checked by place_order on the server.
   ============================================================ */
const input = { width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 };

export function ShopView({ notify, onTrack }) {
  const [shop, setShop] = useState(null);
  const [cart, setCart] = useState(loadCart);
  const [view, setView] = useState("catalog"); // catalog | cart | checkout | done
  const [done, setDone] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchShop().then((s) => { if (!cancelled) setShop(s); });
    return () => { cancelled = true; };
  }, [tick]);
  useEffect(() => { saveCart(cart); }, [cart]);

  const products = useMemo(() => shop?.products || [], [shop]);
  const priced = useMemo(() => priceCart(cart, products), [cart, products]);

  function setQty(id, qty) {
    setCart((c) => {
      if (qty <= 0) return c.filter((x) => x.id !== id);
      return c.some((x) => x.id === id) ? c.map((x) => (x.id === id ? { id, qty } : x)) : [...c, { id, qty }];
    });
  }
  const qtyOf = (id) => cart.find((x) => x.id === id)?.qty || 0;

  if (!shop) {
    return (
      <div className="card fade-in flex items-center justify-center gap-2" style={{ padding: 28 }}>
        <Loader2 size={16} className="salon-spin" color="var(--color-accent-500)" />
        <p className="muted" style={{ fontSize: 12.5 }}>در حال بارگذاری فروشگاه…</p>
      </div>
    );
  }
  if (!shop.enabled) {
    return (
      <div className="card fade-in" style={{ padding: 24, textAlign: "center" }}>
        <ShoppingBag size={28} color="var(--color-muted)" style={{ margin: "0 auto 8px" }} />
        <p className="muted" style={{ fontSize: 13 }}>فروشگاه این سالن فعلاً فعال نیست</p>
      </div>
    );
  }

  if (view === "done" && done) {
    return <OrderDone order={done} onTrack={() => onTrack(done.phone)} onBack={() => { setDone(null); setView("catalog"); }} />;
  }
  if (view === "checkout") {
    return (
      <Checkout
        shop={shop} priced={priced} notify={notify}
        onBack={() => setView("cart")}
        onRefresh={() => { setTick((t) => t + 1); setView("cart"); }}
        onPlaced={(res) => { setCart([]); setDone(res); setView("done"); setTick((t) => t + 1); }}
      />
    );
  }
  if (view === "cart") {
    return <CartView shop={shop} priced={priced} setQty={setQty} onBack={() => setView("catalog")} onCheckout={() => setView("checkout")} />;
  }
  return <Catalog shop={shop} products={products} qtyOf={qtyOf} setQty={setQty} priced={priced} onCart={() => setView("cart")} />;
}

/* ------------------------------------------------------------ catalog --- */
function Catalog({ shop, products, qtyOf, setQty, priced, onCart }) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  // v2.52: a men's + women's salon can split its shelf
  const [aud, setAud] = useState("all");
  const audiences = useMemo(() => new Set(products.map((p) => p.audience || "all")), [products]);
  const splitAudience = audiences.has("men") && audiences.has("women");
  const forAud = (p) => aud === "all" || !p.audience || p.audience === "all" || p.audience === aud;
  const cats = useMemo(() => [...new Set(products.filter(forAud).map((p) => p.category || ""))], [products, aud]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = products.filter((p) => forAud(p) && (cat === "all" || (p.category || "") === cat) && (!q.trim() || p.name.includes(q.trim())));
  const chip = (on) => ({
    padding: "7px 12px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap",
    border: `1px solid ${on ? "var(--color-accent-500)" : "var(--color-border)"}`,
    background: on ? "var(--color-accent-50)" : "var(--color-surface)", color: on ? "var(--color-accent-600, var(--color-accent-500))" : "var(--color-body)",
  });
  return (
    <div className="fade-in" style={{ paddingBottom: priced.count ? 76 : 0 }}>
      <div className="flex items-center justify-between mb-2">
        <h2 style={{ fontSize: 18 }}>فروشگاه</h2>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {[shop.pickup && "تحویل در سالن", shop.shipping && "ارسال"].filter(Boolean).join(" · ")}
        </span>
      </div>
      {!isPetSalon() && !shop.note && <p className="muted" style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.8 }}>همان محصولاتی که آرایشگرهای ما در سالن استفاده می‌کنند — تحویل در سالن یا ارسال به خانه.</p>}
      {shop.note && <p className="muted" style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.8 }}>{shop.note}</p>}
      {splitAudience && (
        <div className="seg flex gap-1 mb-2" role="radiogroup" aria-label="محصولات برای" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {PRODUCT_AUDIENCE.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={aud === k} className="tap" onClick={() => { setAud(k); setCat("all"); }}
              style={{ flex: 1, padding: "7px 8px", borderRadius: "var(--radius-sm)", fontSize: 12.5, fontWeight: 700,
                background: aud === k ? "var(--color-surface)" : "transparent", color: aud === k ? "var(--color-heading)" : "var(--color-muted)",
                boxShadow: aud === k ? "var(--shadow-sm)" : "none" }}>
              {label}
            </button>
          ))}
        </div>
      )}
      {shop.shipping && shop.free_shipping_over > 0 && (
        <p style={{ fontSize: 12, marginBottom: 8, color: "var(--color-success)" }}>
          <Truck size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> ارسال رایگان برای خرید بالای {formatToman(shop.free_shipping_over)}
        </p>
      )}
      {products.length > 6 && (
        <div style={{ position: "relative", marginBottom: 8 }}>
          <Search size={15} className="muted" style={{ position: "absolute", top: 13, right: 12 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی کالا" aria-label="جستجوی کالا"
            style={{ ...input, marginTop: 0, paddingRight: 34 }} />
        </div>
      )}
      {cats.length > 1 && (
        <div className="flex gap-2" style={{ overflowX: "auto", paddingBottom: 6, marginBottom: 6 }}>
          <button className="tap" style={chip(cat === "all")} aria-pressed={cat === "all"} onClick={() => setCat("all")}>همه</button>
          {cats.map((c) => (
            <button key={c || "none"} className="tap" style={chip(cat === c)} aria-pressed={cat === c} onClick={() => setCat(c)}>{categoryLabel(c)}</button>
          ))}
        </div>
      )}
      {shown.length === 0 && (
        <div className="card" style={{ padding: 20, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>{products.length ? "کالایی پیدا نشد" : "هنوز کالایی اضافه نشده"}</p>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        {groupVariants(shown).map((g) => (g.items.length > 1
          ? <VariantCard key={g.key} group={g} qtyOf={qtyOf} setQty={setQty} />
          : <ProductCard key={g.key} p={g.items[0]} qty={qtyOf(g.items[0].id)} setQty={setQty} />))}
      </div>
      {priced.count > 0 && (
        <div style={{ position: "fixed", bottom: 0, insetInline: 0, padding: "10px 16px calc(10px + env(safe-area-inset-bottom))", zIndex: 40, background: "linear-gradient(transparent, var(--color-bg, #f5f2ee) 30%)" }}>
          <button className="tap accent-btn flex items-center justify-between" onClick={onCart} style={{ width: "100%", maxWidth: 448, margin: "0 auto", padding: "13px 16px" }}>
            <span className="flex items-center gap-1.5"><ShoppingCart size={16} /> سبد خرید ({toFa(priced.count)})</span>
            <span className="tabular" style={{ fontWeight: 800 }}>{formatToman(priced.subtotal)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ProductPhoto({ p, size }) {
  const url = productPhotoUrl(p);
  const [broken, setBroken] = useState(false);
  const box = { width: "100%", height: size, borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--color-accent-50)", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={box}>
      {url && !broken
        ? <img src={url} alt={p.name} loading="lazy" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : <Package size={Math.min(36, size / 3)} color="var(--color-accent-500)" style={{ opacity: 0.55 }} />}
    </div>
  );
}

function QtyStepper({ qty, max, onChange, name }) {
  return (
    <div className="flex items-center justify-between" style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: 2 }}>
      <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} aria-label={`یکی بیشتر ${name}`} disabled={qty >= max} onClick={() => onChange(qty + 1)}>
        <Plus size={14} style={{ margin: "auto" }} />
      </button>
      <span className="tabular" style={{ fontWeight: 800, fontSize: 14 }} aria-live="polite">{toFa(qty)}</span>
      <button className="tap ghost-btn" style={{ width: 32, height: 32, padding: 0 }} aria-label={`یکی کمتر ${name}`} onClick={() => onChange(qty - 1)}>
        {qty === 1 ? <Trash2 size={14} style={{ margin: "auto" }} /> : <Minus size={14} style={{ margin: "auto" }} />}
      </button>
    </div>
  );
}

function ProductCard({ p, qty, setQty }) {
  const [open, setOpen] = useState(false);
  const soldOut = p.stock != null && p.stock <= 0;
  const max = p.stock == null ? 50 : Math.min(50, p.stock);
  return (
    <div className="card" data-product={p.name} style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, opacity: soldOut ? 0.6 : 1 }}>
      <ProductPhoto p={p} size={120} />
      <p style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.6, minHeight: 42 }}>{p.name}</p>
      {p.description && (
        <button className="muted" style={{ fontSize: 11.5, textAlign: "right", lineHeight: 1.7 }} onClick={() => setOpen((o) => !o)}>
          {open ? p.description : p.description.length > 40 ? p.description.slice(0, 40) + "…" : p.description}
        </button>
      )}
      <div className="flex items-center justify-between" style={{ marginTop: "auto" }}>
        <span className="tabular" style={{ fontWeight: 800, fontSize: 13.5 }}>{formatToman(p.price)}</span>
        {p.stock != null && p.stock > 0 && p.stock <= 3 && <span style={{ fontSize: 10.5, color: "var(--color-warning)" }}>{toFa(p.stock)} عدد مانده</span>}
      </div>
      {soldOut ? (
        <p className="muted" style={{ fontSize: 12, textAlign: "center", padding: 8 }}>ناموجود</p>
      ) : qty > 0 ? (
        <QtyStepper qty={qty} max={max} name={p.name} onChange={(n) => setQty(p.id, n)} />
      ) : (
        <button className="tap accent-btn flex items-center justify-center gap-1" style={{ padding: "8px 6px", fontSize: 12.5 }} onClick={() => setQty(p.id, 1)}>
          <Plus size={13} /> افزودن به سبد
        </button>
      )}
    </div>
  );
}

// v2.51: one card for a product sold in several sizes/weights
function VariantCard({ group, qtyOf, setQty }) {
  const [sel, setSel] = useState(group.items.find((p) => p.stock == null || p.stock > 0)?.id || group.items[0].id);
  const p = group.items.find((x) => x.id === sel) || group.items[0];
  return (
    <div style={{ display: "flex", flexDirection: "column" }} data-variant-group={group.name}>
      <div className="flex gap-1 flex-wrap" style={{ marginBottom: 4 }} role="radiogroup" aria-label={`اندازهٔ ${group.name}`}>
        {group.items.map((v) => (
          <button key={v.id} type="button" role="radio" aria-checked={v.id === sel} className="tap" onClick={() => setSel(v.id)}
            style={{ padding: "3px 9px", minHeight: 28, borderRadius: "var(--radius-full)", fontSize: 11.5, fontWeight: 700,
              border: `1px solid ${v.id === sel ? "var(--color-accent-500)" : "var(--color-border)"}`,
              background: v.id === sel ? "var(--color-accent-50)" : "var(--color-surface)", opacity: v.stock != null && v.stock <= 0 ? 0.5 : 1 }}>
            {v.variant_label || v.name}
          </button>
        ))}
      </div>
      <ProductCard p={{ ...p, name: group.name + (p.variant_label ? ` — ${p.variant_label}` : "") }} qty={qtyOf(p.id)} setQty={setQty} />
    </div>
  );
}

/* --------------------------------------------------------------- cart --- */
function CartView({ shop, priced, setQty, onBack, onCheckout }) {
  return (
    <div className="fade-in">
      <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={onBack}>
        <ArrowRight size={14} /> ادامهٔ خرید
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 10 }}>سبد خرید</h2>
      {priced.lines.length === 0 ? (
        <div className="card" style={{ padding: 20, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>سبد خرید خالی است</p>
        </div>
      ) : (
        <>
          <div className="card flex flex-col" style={{ padding: "4px 12px" }}>
            {priced.lines.map(({ product: p, qty, total, clipped }) => (
              <div key={p.id} className="flex items-center gap-3" style={{ padding: "10px 0", borderBottom: "1px dashed var(--color-border)" }}>
                <div style={{ width: 54, flexShrink: 0 }}><ProductPhoto p={p} size={54} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</p>
                  <p className="muted tabular" style={{ fontSize: 12 }}>{formatToman(total)}</p>
                  {clipped && <p style={{ fontSize: 11, color: "var(--color-warning)" }}>به اندازهٔ موجودی کم شد</p>}
                </div>
                <div style={{ width: 104 }}>
                  <QtyStepper qty={qty} max={p.stock == null ? 50 : Math.min(50, p.stock)} name={p.name} onChange={(n) => setQty(p.id, n)} />
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between" style={{ padding: "12px 0", fontWeight: 800 }}>
              <span>جمع کالاها</span>
              <span className="tabular">{formatToman(priced.subtotal)}</span>
            </div>
          </div>
          {shop.shipping && shop.free_shipping_over > priced.subtotal && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              با {formatToman(shop.free_shipping_over - priced.subtotal)} خرید بیشتر، ارسال رایگان می‌شود.
            </p>
          )}
          <div className="sticky-cta" style={{ marginTop: 14 }}>
            <button className="tap accent-btn w-full" style={{ padding: 13 }} onClick={onCheckout}>ادامه و ثبت سفارش</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- checkout --- */
function Checkout({ shop, priced, onBack, onPlaced, onRefresh }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [delivery, setDelivery] = useState(shop.pickup ? "pickup" : "shipping");
  const [payment, setPayment] = useState(shop.online ? "online" : "cash");
  const [address, setAddress] = useState("");
  const [postal, setPostal] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [couponInput, setCouponInput] = useState(""); // v2.50
  const [coupon, setCoupon] = useState(null);

  const fee = shippingFor(shop, priced.subtotal, delivery);
  const disc = coupon?.discount ? Math.min(coupon.discount, priced.subtotal) : 0;
  const total = priced.subtotal - disc + fee;
  async function tryCoupon() {
    const r = await checkCoupon(couponInput, "shop", priced.subtotal, /^09\d{9}$/.test(phone) ? phone : null);
    setCoupon(r?.ok ? { code: r.code || couponInput.trim().toUpperCase(), discount: Number(r.discount) || 0 } : { error: r?.error || "کد معتبر نیست" });
  }
  const phoneValid = /^09\d{9}$/.test(phone);
  const ready = phoneValid && name.trim() && priced.lines.length && (delivery !== "shipping" || address.trim().length >= 10)
    && (!postal || postal.length === 10);

  async function submit(e) {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true); setError("");
    const res = await placeOrder({
      name: name.trim(), phone, delivery, payment, address: address.trim(), postalCode: postal, note: note.trim(),
      items: priced.lines.map((l) => ({ product_id: l.product.id, qty: l.qty })),
      coupon: coupon?.code || null,
    });
    if (!res?.ok) {
      setSending(false);
      setError(res?.error || "ثبت سفارش ناموفق بود");
      if (res?.refresh) setTimeout(onRefresh, 1800);
      return;
    }
    if (payment === "online" && !res.demo) {
      const pay = await startOrderPayment(res.id);
      if (pay?.ok && pay.url) { window.location.assign(pay.url); return; }
      setSending(false);
      setError((pay?.error || "اتصال به درگاه پرداخت ناموفق بود") + " — سفارش ثبت شد؛ از «پیگیری» می‌توانید دوباره پرداخت کنید یا لغوش کنید.");
      onPlaced({ ...res, phone, delivery, payment, unpaid: true });
      return;
    }
    setSending(false);
    onPlaced({ ...res, phone, delivery, payment });
  }

  const option = (on) => ({
    flex: 1, padding: "12px 10px", borderRadius: "var(--radius-md)", textAlign: "right",
    border: `1.5px solid ${on ? "var(--color-accent-500)" : "var(--color-border)"}`,
    background: on ? "var(--color-accent-50)" : "var(--color-surface)",
  });
  return (
    <div className="fade-in">
      <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={onBack}>
        <ArrowRight size={14} /> بازگشت به سبد
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>ثبت سفارش</h2>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div>
          <span className="muted" style={{ fontSize: 12 }}>روش تحویل</span>
          <div className="flex gap-2" style={{ marginTop: 4 }} role="radiogroup" aria-label="روش تحویل">
            {shop.pickup && (
              <button type="button" role="radio" aria-checked={delivery === "pickup"} className="tap" style={option(delivery === "pickup")} onClick={() => setDelivery("pickup")}>
                <span className="flex items-center gap-1.5" style={{ fontWeight: 800, fontSize: 13 }}><Store size={15} /> تحویل در سالن</span>
                <span className="muted" style={{ fontSize: 11.5 }}>رایگان</span>
              </button>
            )}
            {shop.shipping && (
              <button type="button" role="radio" aria-checked={delivery === "shipping"} className="tap" style={option(delivery === "shipping")} onClick={() => setDelivery("shipping")}>
                <span className="flex items-center gap-1.5" style={{ fontWeight: 800, fontSize: 13 }}><Truck size={15} /> ارسال</span>
                <span className="muted tabular" style={{ fontSize: 11.5 }}>{shippingFor(shop, priced.subtotal, "shipping") ? formatToman(shop.shipping_fee) : "رایگان"}</span>
              </button>
            )}
          </div>
          {delivery === "pickup" && shop.pickup_address && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>آدرس سالن: {shop.pickup_address}</p>}
          {delivery === "shipping" && shop.shipping_area && <p style={{ fontSize: 12, marginTop: 6, color: "var(--color-warning)" }}>محدودهٔ ارسال: {shop.shipping_area}</p>}
        </div>

        <div>
          <label htmlFor="order-phone" className="muted" style={{ fontSize: 12 }}>شماره موبایل</label>
          <input id="order-phone" dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone} placeholder="09xxxxxxxxx" className="tabular"
            onChange={(e) => setPhone(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
        </div>
        <div>
          <label htmlFor="order-name" className="muted" style={{ fontSize: 12 }}>نام و نام‌خانوادگی</label>
          <input id="order-name" autoComplete="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={input} />
        </div>
        {delivery === "shipping" && (
          <>
            <div>
              <label htmlFor="order-address" className="muted" style={{ fontSize: 12 }}>آدرس کامل</label>
              <textarea id="order-address" rows={3} maxLength={400} value={address} autoComplete="street-address" onChange={(e) => setAddress(e.target.value)}
                placeholder="شهر، خیابان، کوچه، پلاک، واحد" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
            </div>
            <div>
              <label htmlFor="order-postal" className="muted" style={{ fontSize: 12 }}>کد پستی (اختیاری، ۱۰ رقم)</label>
              <input id="order-postal" dir="ltr" inputMode="numeric" value={postal} onChange={(e) => setPostal(digitsOnly(e.target.value, 10))} className="tabular" style={{ ...input, textAlign: "left" }} />
            </div>
          </>
        )}
        <div>
          <label htmlFor="order-note" className="muted" style={{ fontSize: 12 }}>توضیحات (اختیاری)</label>
          <input id="order-note" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} style={input} />
        </div>

        {shop.online && shop.cash && (
          <div>
            <span className="muted" style={{ fontSize: 12 }}>روش پرداخت</span>
            <div className="flex gap-2" style={{ marginTop: 4 }} role="radiogroup" aria-label="روش پرداخت">
              <button type="button" role="radio" aria-checked={payment === "online"} className="tap" style={option(payment === "online")} onClick={() => setPayment("online")}>
                <span className="flex items-center gap-1.5" style={{ fontWeight: 800, fontSize: 13 }}><CreditCard size={15} /> پرداخت آنلاین</span>
              </button>
              <button type="button" role="radio" aria-checked={payment === "cash"} className="tap" style={option(payment === "cash")} onClick={() => setPayment("cash")}>
                <span className="flex items-center gap-1.5" style={{ fontWeight: 800, fontSize: 13 }}><Wallet size={15} /> هنگام تحویل</span>
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <input dir="ltr" value={couponInput} onChange={(e) => { setCouponInput(e.target.value.toUpperCase()); setCoupon(null); }} placeholder="کد تخفیف" aria-label="کد تخفیف"
            style={{ flex: 1, minWidth: 0, padding: "10px 12px", fontSize: 14, textAlign: "left" }} />
          <button type="button" className="tap ghost-btn" style={{ padding: "0 14px", fontSize: 13 }} disabled={!couponInput.trim()} onClick={tryCoupon}>اعمال</button>
        </div>
        {coupon?.error && <p style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: -8 }}>{coupon.error}</p>}

        <div className="card" style={{ padding: "10px 14px", lineHeight: 2.1, fontSize: 13 }}>
          <div className="flex justify-between"><span>جمع کالاها ({toFa(priced.count)} عدد)</span><span className="tabular">{formatToman(priced.subtotal)}</span></div>
          {disc > 0 && <div className="flex justify-between" style={{ color: "var(--color-success)" }}><span>کد تخفیف {coupon.code}</span><span className="tabular">- {formatToman(disc)}</span></div>}
          {delivery === "shipping" && <div className="flex justify-between"><span>هزینهٔ ارسال</span><span className="tabular">{fee ? formatToman(fee) : "رایگان"}</span></div>}
          <div className="flex justify-between" style={{ fontWeight: 800, fontSize: 14 }}><span>مبلغ نهایی</span><span className="tabular">{formatToman(total)}</span></div>
          <p className="muted" style={{ fontSize: 11.5 }}>
            {payment === "online" ? "پس از ثبت، به درگاه زرین‌پال منتقل می‌شوید." : delivery === "shipping" ? "پرداخت هنگام تحویل مرسوله." : "پرداخت هنگام تحویل در سالن."}
          </p>
        </div>

        {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5, lineHeight: 1.8 }}>{error}</p>}
        <div className="sticky-cta">
          <button type="submit" disabled={!ready || sending} className="tap accent-btn w-full flex items-center justify-center gap-1.5" style={{ padding: 13 }}>
            {sending && <Loader2 size={15} className="salon-spin" />}
            {sending ? "در حال ثبت..." : payment === "online" ? `پرداخت ${formatToman(total)}` : "ثبت سفارش"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------- done --- */
function OrderDone({ order, onTrack, onBack }) {
  return (
    <div className="card fade-in" style={{ padding: 22, textAlign: "center" }}>
      <CheckCircle2 size={42} color="var(--color-success)" style={{ margin: "0 auto 10px" }} />
      <p style={{ fontWeight: 800, fontSize: 17 }}>{order.unpaid ? "سفارش ثبت شد — منتظر پرداخت" : "سفارش شما ثبت شد"}</p>
      <p className="tabular" style={{ fontSize: 14, marginTop: 8 }}>شمارهٔ سفارش: <b>{toFa(order.code)}</b></p>
      <p className="tabular muted" style={{ fontSize: 13, marginTop: 4 }}>مبلغ: {formatToman(order.total)}</p>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.9 }}>
        {order.delivery === "shipping" ? "خبر ارسال سفارش را پیامک می‌کنیم." : "وقتی سفارش آمادهٔ تحویل در سالن شد، پیامک می‌گیرید."}
        {order.demo && " (حالت دمو — پیامکی ارسال نمی‌شود)"}
      </p>
      <div className="flex gap-2 mt-4">
        <button className="tap accent-btn flex-1" style={{ padding: 12 }} onClick={onTrack}>پیگیری سفارش</button>
        <button className="tap ghost-btn flex-1" style={{ padding: 12 }} onClick={onBack}>بازگشت به فروشگاه</button>
      </div>
    </div>
  );
}
