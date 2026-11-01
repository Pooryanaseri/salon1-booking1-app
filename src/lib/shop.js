/* ============================================================
   v2.48 — online shop data layer.
   Real salons go through Supabase (prices, stock and shipping are
   always computed by place_order on the server). Demo mode keeps a
   small in-memory shop so the whole flow can be tried out.
   ============================================================ */
import { supabase, SUPABASE_ENABLED, getCurrentSalonId } from "./supabase";
import { isPetSalon } from "./tenant";
import { shrinkImage } from "./api";
import { checkCoupon } from "./business";

const PHOTO_BUCKET = "shop-photos";

export const SHOP_CATEGORIES = {
  pet: [
    ["food", "غذا"], ["treats", "تشویقی"], ["toys", "اسباب‌بازی"],
    ["grooming", "بهداشتی و آرایشی"], ["accessories", "قلاده و لوازم"], ["health", "مکمل و مراقبت"],
  ],
  beauty: [
    ["hair", "مراقبت مو"], ["styling", "حالت‌دهنده مو"], ["beard", "ریش و اصلاح آقایان"],
    ["skin", "مراقبت پوست"], ["makeup", "آرایشی"], ["nails", "ناخن"],
    ["fragrance", "عطر و بادی‌اسپلش"], ["tools", "ابزار و لوازم"], ["other", "سایر"],
  ],
};
/* v2.52: who a beauty product is for — the storefront filters by it */
export const PRODUCT_AUDIENCE = [["all", "همه"], ["women", "بانوان"], ["men", "آقایان"]];
export function audienceLabel(a) {
  return (PRODUCT_AUDIENCE.find(([k]) => k === a) || PRODUCT_AUDIENCE[0])[1];
}
export function shopCategories() {
  return SHOP_CATEGORIES[isPetSalon() ? "pet" : "beauty"];
}
export function categoryLabel(key) {
  for (const list of Object.values(SHOP_CATEGORIES)) {
    const hit = list.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return key || "سایر";
}

export const ORDER_STATUS = {
  awaiting_payment: { label: "در انتظار پرداخت", color: "var(--color-warning)" },
  pending: { label: "سفارش جدید", color: "var(--color-accent-500)" },
  confirmed: { label: "در حال آماده‌سازی", color: "var(--color-info)" },
  ready: { label: "آمادهٔ تحویل در سالن", color: "var(--color-success)" },
  shipped: { label: "ارسال شد", color: "var(--color-success)" },
  delivered: { label: "تحویل شد", color: "var(--color-muted)" },
  cancelled: { label: "لغو شد", color: "var(--color-danger)" },
};

/** Shipping fee for a subtotal under the shop's rules (mirrors place_order). */
export function shippingFor(shop, subtotal, delivery) {
  if (delivery !== "shipping" || !shop) return 0;
  if (shop.free_shipping_over > 0 && subtotal >= shop.free_shipping_over) return 0;
  return shop.shipping_fee || 0;
}

/** Cart lines [{id, qty}] priced against the current catalog. */
export function priceCart(cart, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  let subtotal = 0, count = 0;
  for (const c of cart) {
    const p = byId.get(c.id);
    if (!p) continue;
    const max = p.stock == null ? 50 : Math.min(50, p.stock);
    const qty = Math.max(0, Math.min(c.qty, max));
    if (!qty) continue;
    lines.push({ product: p, qty, total: p.price * qty, clipped: qty < c.qty });
    subtotal += p.price * qty;
    count += qty;
  }
  return { lines, subtotal, count };
}

export function productPhotoUrl(product) {
  if (product?.demoPhoto) return product.demoPhoto;
  if (!product?.photo_path || !SUPABASE_ENABLED) return null;
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(product.photo_path).data?.publicUrl || null;
}

function logFail(where, error) {
  console.error(`[shop] ${where}:`, error?.message || error);
}

/* --------------------------------------------------------------- demo ---- */
const demoId = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const demo = {
  settings: {
    enabled: true, pickup_enabled: true, pickup_address: "خیابان نمونه، پلاک ۱۰", shipping_enabled: true,
    shipping_fee: 60000, free_shipping_over: 1500000, shipping_area: "فقط داخل تهران — ۱ تا ۲ روز کاری",
    cash_enabled: true, note: "",
  },
  products: null,
  orders: [],
};
function demoProducts() {
  if (demo.products) return demo.products;
  const rows = isPetSalon()
    ? [
        ["غذای خشک سگ بالغ ۳ کیلویی", "food", 690000, 8, "مناسب نژادهای کوچک و متوسط"],
        ["غذای گربه ۲ کیلویی", "food", 520000, 5, ""],
        ["تشویقی دندانی سگ", "treats", 180000, 20, ""],
        ["شامپو ضد گره", "grooming", 260000, 12, "مخصوص موهای بلند"],
        ["قلاده و قلاده‌بند چرمی", "accessories", 340000, 3, ""],
        ["توپ جویدنی", "toys", 95000, 0, ""],
      ]
    : [
        // [name, category, price, stock, description, audience, cost, variant_group, variant_label]
        ["شامپو بدون سولفات ۲۵۰ میل", "hair", 420000, 10, "مناسب موهای رنگ‌شده — همان شامپوی سالن", "women", 260000, "شامپو بدون سولفات", "۲۵۰ میل"],
        ["شامپو بدون سولفات ۵۰۰ میل", "hair", 690000, 6, "مناسب موهای رنگ‌شده — همان شامپوی سالن", "women", 430000, "شامپو بدون سولفات", "۵۰۰ میل"],
        ["ماسک موی کراتینه", "hair", 560000, 6, "بعد از کراتین و رنگ", "women", 340000, "", ""],
        ["سرم ضد وز", "hair", 480000, 2, "", "women", 290000, "", ""],
        ["واکس حالت‌دهنده مات", "styling", 350000, 12, "حالت ماندگار بدون براقی", "men", 190000, "", ""],
        ["روغن ریش آرگان", "beard", 390000, 8, "نرم‌کننده و خوشبوکننده ریش", "men", 210000, "", ""],
        ["افترشیو آرام‌بخش", "beard", 310000, 0, "", "men", 170000, "", ""],
        ["کرم آبرسان صورت", "skin", 380000, 8, "", "all", 230000, "", ""],
        ["لاک ناخن ماندگار", "nails", 120000, 25, "", "women", 60000, "", ""],
        ["برس گرد حرفه‌ای", "tools", 290000, 4, "", "all", 150000, "", ""],
      ];
  demo.products = rows.map(([name, category, price, stock, description, audience = "all", cost = null, variant_group = "", variant_label = ""], i) => ({
    id: `demo-p-${i + 1}`, name, category, price, stock, description, active: true, photo_path: null, sort_order: i,
    audience, cost_price: cost, variant_group, variant_label,
  }));
  seedDemoOrders();
  return demo.products;
}
/* a few past orders so BI and accounting have shop numbers in the demo */
function seedDemoOrders() {
  if (demo.orders.length) return;
  const list = demo.products;
  const spec = [[1, [[0, 1], [2, 1]], "09121234567"], [3, [[4, 2]], "09351112233"], [6, [[5, 1], [6, 1]], "09129998877"],
    [9, [[1, 1]], "09123334455"], [13, [[7, 2], [8, 1]], "09125556677"], [18, [[3, 1]], "09121234567"]];
  for (const [ago, lines, phone] of spec) {
    const items = lines.filter(([i]) => list[i]).map(([i, qty]) => ({ id: demoId("demo-i"), name: list[i].name, unit_price: list[i].price, qty, product_id: list[i].id }));
    if (!items.length) continue;
    const subtotal = items.reduce((t, i) => t + i.unit_price * i.qty, 0);
    demo.orders.push({
      id: demoId("demo-o"), code: String(100000 + Math.floor(Math.random() * 900000)), customer_name: "مشتری", customer_phone: phone,
      delivery: "pickup", address: "", postal_code: "", customer_note: "", subtotal, shipping_fee: 0, total: subtotal, coupon_discount: 0,
      payment_method: "cash", status: "delivered", paid_at: null, refund_needed: false, staff_note: "", cancel_reason: "",
      created_at: new Date(Date.now() - ago * 86400000).toISOString(), order_items: items,
    });
  }
}
function demoShopView() {
  const s = demo.settings;
  return {
    enabled: s.enabled, pickup: s.pickup_enabled || !s.shipping_enabled, pickup_address: s.pickup_address,
    shipping: s.shipping_enabled, shipping_fee: s.shipping_fee, free_shipping_over: s.free_shipping_over,
    shipping_area: s.shipping_area, note: s.note, online: false, cash: true,
    products: s.enabled ? demoProducts().filter((p) => p.active).map(({ cost_price, ...p }) => ({ ...p })) : [], // eslint-disable-line no-unused-vars
    demo: true,
  };
}

/* ---------------------------------------------------------- storefront --- */
export async function fetchShop() {
  if (!SUPABASE_ENABLED) return demoShopView();
  const { data, error } = await supabase.rpc("get_shop");
  if (error) {
    // migration not applied yet → the shop simply stays hidden
    if (!/get_shop|function/i.test(error.message || "")) logFail("get_shop", error);
    return { enabled: false, products: [] };
  }
  return data || { enabled: false, products: [] };
}

/** → {ok, id, code, total, status} | {ok:false, error, refresh?} */
export async function placeOrder({ name, phone, items, delivery, payment, address, postalCode, note, coupon }) {
  if (!SUPABASE_ENABLED) {
    const shop = demoShopView();
    const products = demoProducts();
    const priced = [];
    for (const it of items) {
      const p = products.find((x) => x.id === it.product_id && x.active);
      if (!p) return { ok: false, error: "یکی از کالاها دیگر موجود نیست — سبد را به‌روز کنید", refresh: true };
      if (p.stock != null && p.stock < it.qty) return { ok: false, error: `از «${p.name}» فقط ${p.stock} عدد موجود است`, refresh: true };
      priced.push({ p, qty: it.qty });
    }
    const subtotal = priced.reduce((s, x) => s + x.p.price * x.qty, 0);
    const fee = shippingFor(shop, subtotal, delivery);
    let disc = 0;
    if (coupon) {
      const c = await checkCoupon(coupon, "shop", subtotal);
      if (!c.ok) return c;
      disc = Math.min(c.discount, subtotal);
    }
    priced.forEach(({ p, qty }) => { if (p.stock != null) p.stock -= qty; });
    const order = {
      id: demoId("demo-o"), code: String(100000 + Math.floor(Math.random() * 900000)), customer_name: name, customer_phone: phone,
      delivery, address: delivery === "shipping" ? address : "", postal_code: postalCode || "", customer_note: note || "",
      subtotal, shipping_fee: fee, total: subtotal - disc + fee, coupon_discount: disc, coupon_code: disc ? String(coupon).trim().toUpperCase() : null, payment_method: payment, status: "pending",
      paid_at: null, refund_needed: false, staff_note: "", cancel_reason: "", created_at: new Date().toISOString(),
      order_items: priced.map(({ p, qty }) => ({ id: demoId("demo-i"), name: p.name, unit_price: p.price, qty, product_id: p.id })),
    };
    demo.orders.unshift(order);
    return { ok: true, demo: true, id: order.id, code: order.code, subtotal, discount: disc, shipping_fee: fee, total: order.total, status: "pending" };
  }
  const { data, error } = await supabase.rpc("place_order", {
    p_customer_name: name, p_customer_phone: phone, p_items: items, p_delivery: delivery, p_payment: payment,
    p_address: address || "", p_postal_code: postalCode || "", p_note: note || "",
    ...(coupon ? { p_coupon: coupon } : {}),
  });
  if (error) { logFail("place_order", error); return { ok: false, error: "ثبت سفارش ناموفق بود — دوباره امتحان کنید" }; }
  return data;
}

/* ---------------------------------------------------------- customer ----- */
function myOrderShape(o) {
  return {
    id: o.id, code: o.code, status: o.status, delivery: o.delivery, address: o.address, subtotal: o.subtotal,
    shipping_fee: o.shipping_fee, total: o.total, payment_method: o.payment_method, paid: !!o.paid_at,
    refund_needed: o.refund_needed, cancel_reason: o.cancel_reason || null, staff_note: o.staff_note || null, created_at: o.created_at,
    tracking_code: o.tracking_code || null, carrier: o.carrier || null, discount: o.coupon_discount || 0,
    items: (o.order_items || []).map((i) => ({ name: i.name, qty: i.qty, unit_price: i.unit_price })),
  };
}
/** Customer dashboard: orders of the verified phone (demo: by phone). */
export async function fetchMyOrders(token, phone) {
  if (!SUPABASE_ENABLED) return demo.orders.filter((o) => o.customer_phone === phone).map(myOrderShape);
  if (!token) return [];
  const { data, error } = await supabase.rpc("my_orders_with_token", { p_token: token });
  if (error) { if (!/my_orders_with_token|function/i.test(error.message || "")) logFail("my_orders_with_token", error); return []; }
  return Array.isArray(data) ? data : [];
}
export async function cancelMyOrder(token, orderId) {
  if (!SUPABASE_ENABLED) {
    const o = demo.orders.find((x) => x.id === orderId);
    if (!o || o.status !== "pending") return { ok: false, error: "این سفارش دیگر قابل لغو نیست" };
    o.status = "cancelled"; o.cancel_reason = "لغو توسط مشتری";
    releaseDemoStock(o);
    return { ok: true };
  }
  const { data, error } = await supabase.rpc("cancel_my_order", { p_token: token, p_order: orderId });
  if (error) { logFail("cancel_my_order", error); return { ok: false, error: "لغو ناموفق بود" }; }
  return data;
}
function releaseDemoStock(o) {
  for (const i of o.order_items || []) {
    const p = demoProducts().find((x) => x.id === i.product_id);
    if (p && p.stock != null) p.stock += i.qty;
  }
}

/* ------------------------------------------------------------- staff ----- */
export async function fetchShopSettings() {
  if (!SUPABASE_ENABLED) return { ...demo.settings, online_ready: false };
  const [{ data, error }, pay] = await Promise.all([
    supabase.from("shop_settings").select("*").maybeSingle(),
    supabase.from("salon_payment_settings").select("zarinpal_merchant_id").maybeSingle(),
  ]);
  if (error) { logFail("shop_settings", error); return null; }
  return {
    enabled: false, pickup_enabled: true, pickup_address: "", shipping_enabled: false, shipping_fee: 0,
    free_shipping_over: 0, shipping_area: "", cash_enabled: false, note: "",
    ...(data || {}),
    online_ready: !!(pay?.data?.zarinpal_merchant_id || "").trim(),
  };
}
export async function saveShopSettings(s) {
  const row = {
    enabled: !!s.enabled, pickup_enabled: !!s.pickup_enabled, pickup_address: (s.pickup_address || "").trim(),
    shipping_enabled: !!s.shipping_enabled, shipping_fee: Math.max(0, Number(s.shipping_fee) || 0),
    free_shipping_over: Math.max(0, Number(s.free_shipping_over) || 0), shipping_area: (s.shipping_area || "").trim(),
    cash_enabled: !!s.cash_enabled, note: (s.note || "").trim(),
  };
  if (!SUPABASE_ENABLED) { Object.assign(demo.settings, row); return { ok: true }; }
  const { error } = await supabase.from("shop_settings")
    .upsert({ salon_id: getCurrentSalonId(), ...row, updated_at: new Date().toISOString() }, { onConflict: "salon_id" });
  if (error) { logFail("shop_settings.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}

export async function fetchProducts() {
  if (!SUPABASE_ENABLED) return demoProducts().map((p) => ({ ...p }));
  const { data, error } = await supabase.from("products").select("*").order("sort_order").order("created_at");
  if (error) { logFail("products", error); return []; }
  // v2.52: purchase costs (managers only — RLS returns nothing to others)
  const { data: costs } = await supabase.from("product_costs").select("product_id, cost_price");
  const byId = new Map((costs || []).map((c) => [c.product_id, Number(c.cost_price)]));
  return (data || []).map((p) => ({ ...p, cost_price: byId.has(p.id) ? byId.get(p.id) : null }));
}
/** Insert (no id) or update a product → {ok, product} */
export async function saveProduct(p) {
  const row = {
    name: (p.name || "").trim(), description: (p.description || "").trim(), category: p.category || "",
    price: Math.round(Number(p.price) || 0), stock: p.stock === "" || p.stock == null ? null : Math.max(0, Math.round(Number(p.stock))),
    active: p.active !== false, photo_path: p.photo_path || null, sort_order: Number(p.sort_order) || 0,
    // v2.51 sizes — sent only when used, so an older database still saves products
    ...(p.variant_group || p.variant_label ? { variant_group: (p.variant_group || "").trim().slice(0, 80), variant_label: (p.variant_label || "").trim().slice(0, 40) } : {}),
    // v2.52 men / women — sent only when set (or being reset), like the sizes above
    ...((p.audience && p.audience !== "all") || (p.prevAudience && p.prevAudience !== "all") ? { audience: ["men", "women"].includes(p.audience) ? p.audience : "all" } : {}),
  };
  const cost = p.cost_price === "" || p.cost_price == null ? null : Math.max(0, Math.round(Number(p.cost_price) || 0));
  if (!row.name) return { ok: false, error: "نام کالا لازم است" };
  if (row.price < 1000) return { ok: false, error: "قیمت را درست وارد کنید" };
  if (!SUPABASE_ENABLED) {
    const list = demoProducts();
    if (p.id) {
      const cur = list.find((x) => x.id === p.id);
      Object.assign(cur, row, { cost_price: cost }, p.demoPhoto ? { demoPhoto: p.demoPhoto } : {});
      return { ok: true, product: { ...cur } };
    }
    const created = { id: demoId("demo-p"), ...row, cost_price: cost, demoPhoto: p.demoPhoto };
    list.push(created);
    return { ok: true, product: { ...created } };
  }
  const q = p.id
    ? supabase.from("products").update({ ...row, updated_at: new Date().toISOString() }).eq("id", p.id).select().single()
    : supabase.from("products").insert({ ...row, salon_id: getCurrentSalonId() }).select().single();
  const { data, error } = await q;
  if (error) { logFail("products.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  if (cost != null) {
    const { error: e2 } = await supabase.from("product_costs").upsert({ product_id: data.id, salon_id: getCurrentSalonId(), cost_price: cost, updated_at: new Date().toISOString() });
    if (e2) logFail("product_costs.save", e2);
  } else if (p.prevCost != null) {
    await supabase.from("product_costs").delete().eq("product_id", data.id);
  }
  return { ok: true, product: { ...data, cost_price: cost } };
}

/* ------------------------------------------------------- analytics ---- */
const ACTIVE_ORDER = ["pending", "confirmed", "ready", "shipped", "delivered"];
/** Pure: shop numbers from orders (demo, and the unit tests). from/to are Date. */
export function computeShopAnalytics(orders, products, bookings, from, to) {
  const inRange = (d) => d >= from && d <= to;
  const o = orders.filter((x) => ACTIVE_ORDER.includes(x.status) && inRange(new Date(x.created_at)));
  const costOf = new Map(products.map((p) => [p.id, p.cost_price]));
  const catOf = new Map(products.map((p) => [p.id, p.category]));
  const lines = o.flatMap((x) => x.order_items || []);
  const top = new Map(); const cats = new Map(); const daily = new Map();
  let cogs = 0, withCost = 0, items = 0, itemsRevenue = 0;
  for (const l of lines) {
    const c = costOf.get(l.product_id);
    const rev = l.unit_price * l.qty;
    items += l.qty; itemsRevenue += rev;
    if (c != null) { cogs += c * l.qty; withCost += rev; }
    const t = top.get(l.name) || { name: l.name, qty: 0, revenue: 0, profit: 0, costKnown: true };
    t.qty += l.qty; t.revenue += rev; if (c != null) t.profit += rev - c * l.qty; else t.costKnown = false;
    top.set(l.name, t);
    const cat = catOf.get(l.product_id) || "other";
    cats.set(cat, (cats.get(cat) || 0) + rev);
  }
  for (const x of o) {
    const d = new Date(x.created_at); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    daily.set(k, (daily.get(k) || 0) + x.subtotal - (x.coupon_discount || 0));
  }
  const buyers = new Set(o.map((x) => x.customer_phone));
  const visits = new Set(bookings.filter((b) => b.status === "completed" && b.date && (() => {
    const [y, m, d] = String(b.date).split("-").map(Number); return inRange(new Date(y, m - 1, d, 12));
  })()).map((b) => b.customer_phone));
  return {
    ok: true, orders: o.length, revenue: o.reduce((t, x) => t + x.subtotal - (x.coupon_discount || 0), 0),
    shipping: o.reduce((t, x) => t + (x.shipping_fee || 0), 0), discount: o.reduce((t, x) => t + (x.coupon_discount || 0), 0),
    items, items_revenue: itemsRevenue, buyers: buyers.size, cogs, revenue_with_cost: withCost,
    visit_customers: visits.size, buyers_with_visit: [...buyers].filter((ph) => visits.has(ph)).length,
    top_products: [...top.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8).map(({ costKnown, ...t }) => ({ ...t, profit: costKnown ? t.profit : null })),
    by_category: [...cats.entries()].map(([category, revenue]) => ({ category, revenue })).sort((a, b) => b.revenue - a.revenue),
    daily: [...daily.entries()].sort().map(([date, revenue]) => ({ date, revenue })),
  };
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Shop numbers for BI / accounting over the last `days` days (managers). */
export async function fetchShopAnalytics(days, bookings = []) {
  const to = new Date(); to.setHours(23, 59, 59, 999);
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
  if (!SUPABASE_ENABLED) return { ...computeShopAnalytics(demo.orders, demoProducts(), bookings, from, to), demo: true };
  const { data, error } = await supabase.rpc("shop_analytics", { p_from: isoDay(from), p_to: isoDay(to) });
  if (error) { if (!/shop_analytics|function/i.test(error.message || "")) logFail("shop_analytics", error); return null; }
  return data;
}
export async function deleteProduct(id) {
  if (!SUPABASE_ENABLED) { demo.products = demoProducts().filter((x) => x.id !== id); return { ok: true }; }
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) { logFail("products.delete", error); return { ok: false, error: "حذف ناموفق بود" }; }
  return { ok: true };
}
/** → {ok, path} (demo: {ok, demoPhoto}) */
export async function uploadProductPhoto(file) {
  if (!SUPABASE_ENABLED) return { ok: true, demoPhoto: URL.createObjectURL(file) };
  const blob = await shrinkImage(file, 1000, 0.82);
  if (!blob) return { ok: false, error: "این عکس قابل استفاده نیست" };
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  const name = `${(crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9-]/g, "")}.${ext}`;
  const path = `${getCurrentSalonId()}/${name}`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
  if (error) { logFail("product photo upload", error); return { ok: false, error: "آپلود عکس ناموفق بود" }; }
  return { ok: true, path };
}

export async function fetchOrders() {
  if (!SUPABASE_ENABLED) return demo.orders.map((o) => ({ ...o, order_items: [...o.order_items] }));
  const { data, error } = await supabase.from("orders").select("*, order_items(*)")
    .gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString())
    .order("created_at", { ascending: false }).limit(300);
  if (error) { if (!/orders|relation/i.test(error.message || "")) logFail("orders", error); return []; }
  return data || [];
}
export async function setOrderStatus(id, status, note, tracking = {}) {
  if (!SUPABASE_ENABLED) {
    const o = demo.orders.find((x) => x.id === id);
    if (!o) return { ok: false, error: "سفارش پیدا نشد" };
    if (status === "cancelled" && !(note || "").trim()) return { ok: false, error: "دلیل لغو را بنویسید" };
    o.status = status;
    if (status === "cancelled") { o.cancel_reason = note; releaseDemoStock(o); } else if (note) o.staff_note = note;
    if (status === "shipped" && tracking.code) { o.tracking_code = tracking.code; o.carrier = tracking.carrier || ""; }
    return { ok: true, status };
  }
  const args = { p_order: id, p_status: status, p_note: note || "" };
  if (tracking.code) Object.assign(args, { p_tracking_code: tracking.code, p_carrier: tracking.carrier || "" });
  const { data, error } = await supabase.rpc("set_order_status", args);
  if (error) { logFail("set_order_status", error); return { ok: false, error: "ثبت ناموفق بود" }; }
  return data;
}
export async function markOrderRefunded(id) {
  if (!SUPABASE_ENABLED) { const o = demo.orders.find((x) => x.id === id); if (o) o.refund_needed = false; return { ok: true }; }
  const { data, error } = await supabase.rpc("mark_order_refunded", { p_order: id });
  if (error) { logFail("mark_order_refunded", error); return { ok: false, error: "ثبت ناموفق بود" }; }
  return data;
}

/* ---------------------------------------------------------------- cart --- */
const cartKey = () => `salon:cart:${getCurrentSalonId() || "demo"}`;
export function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(cartKey()) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string" && Number.isInteger(x.qty) && x.qty > 0) : [];
  } catch { return []; }
}
export function saveCart(cart) {
  try { localStorage.setItem(cartKey(), JSON.stringify(cart)); } catch { /* storage blocked */ }
}

/** Groups variants (same variant_group) into one card: [{key, items:[...]}] */
export function groupVariants(products) {
  const out = []; const byKey = new Map();
  for (const p of products) {
    const key = p.variant_group ? `g:${p.variant_group}` : `p:${p.id}`;
    if (!byKey.has(key)) { const g = { key, name: p.variant_group || p.name, items: [] }; byKey.set(key, g); out.push(g); }
    byKey.get(key).items.push(p);
  }
  return out;
}

/** v2.55 demo: the panel's "seller" select on an order. */
export function demoSetOrderSeller(id, stylistId) {
  const o = demo.orders.find((x) => x.id === id);
  if (o) o.sold_by = stylistId;
}
