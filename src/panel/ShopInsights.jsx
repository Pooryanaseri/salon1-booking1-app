import { useEffect, useState } from "react";
import { ShoppingBag, Lightbulb, Loader2 } from "lucide-react";
import { formatToman, toFa } from "../lib/format";
import { fetchShopAnalytics, categoryLabel } from "../lib/shop";
import { fetchRevenueExtras } from "../lib/business";

/* ============================================================
   v2.52 — the shop inside BI and accounting.
   ============================================================ */

/** Derived numbers shared by the BI card and the tests. */
export function shopKpis(a, serviceRevenue = 0) {
  if (!a?.ok) return null;
  const revenue = a.revenue || 0;
  const grossProfit = a.revenue_with_cost > 0 ? a.revenue_with_cost - a.cogs : null;
  return {
    revenue,
    orders: a.orders || 0,
    aov: a.orders ? Math.round(revenue / a.orders) : 0,
    grossProfit,
    margin: grossProfit != null && a.revenue_with_cost > 0 ? grossProfit / a.revenue_with_cost : null,
    costCoverage: a.items_revenue > 0 ? (a.revenue_with_cost || 0) / a.items_revenue : 0,
    attachRate: a.visit_customers > 0 ? a.buyers_with_visit / a.visit_customers : null,
    share: revenue + serviceRevenue > 0 ? revenue / (revenue + serviceRevenue) : 0,
  };
}

/** One actionable line for the manager, or null. */
export function shopInsight(k, a) {
  if (!k) return null;
  if (k.orders === 0) return "در این بازه سفارشی ثبت نشده — فروشگاه را در «داشبورد من» و گزارش بعد از نوبت به مشتری‌ها معرفی کنید.";
  if (k.attachRate != null && a.visit_customers >= 10 && k.attachRate < 0.15) {
    return `فقط ${toFa(Math.round(k.attachRate * 100))}٪ از مشتری‌های این بازه از فروشگاه خرید کرده‌اند. بعد از هر نوبت، در «گزارش نوبت» یک یا دو محصول پیشنهاد دهید.`;
  }
  if (k.margin != null && k.margin < 0.2) return `حاشیهٔ سود فروشگاه ${toFa(Math.round(k.margin * 100))}٪ است — قیمت کالاهای پرفروش را بازبینی کنید.`;
  if (k.costCoverage < 0.5) return "برای دیدن سود واقعی فروشگاه، «قیمت خرید» کالاها را در پنل فروشگاه وارد کنید.";
  return null;
}

export function ShopBICard({ days, bookings, serviceRevenue, onNavigate }) {
  const [a, setA] = useState(null);
  useEffect(() => {
    let alive = true;
    setA(null);
    fetchShopAnalytics(days, bookings).then((r) => { if (alive) setA(r || { ok: false }); });
    return () => { alive = false; };
  }, [days, bookings]);
  if (!a) return <div className="card mb-4 flex justify-center" style={{ padding: 18 }}><Loader2 size={15} className="salon-spin" /></div>;
  if (!a.ok) return null;
  const k = shopKpis(a, serviceRevenue);
  const tip = shopInsight(k, a);
  const max = Math.max(1, ...(a.daily || []).map((d) => d.revenue));
  const cell = (label, value, sub) => (
    <div style={{ flex: "1 1 45%", minWidth: 0, background: "var(--color-surface-raised)", borderRadius: "var(--radius-md)", padding: "8px 10px" }}>
      <p className="muted" style={{ fontSize: 11 }}>{label}</p>
      <p className="tabular" style={{ fontSize: 14.5, fontWeight: 800, color: "var(--color-heading)" }}>{value}</p>
      {sub && <p className="muted tabular" style={{ fontSize: 10.5 }}>{sub}</p>}
    </div>
  );
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="shop-bi">
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-accent-600, var(--color-accent-500))" }}>
          <ShoppingBag size={13} /> فروشگاه
        </p>
        {onNavigate && <button className="tap muted" style={{ fontSize: 11.5 }} onClick={() => onNavigate("shop")}>مدیریت فروشگاه</button>}
      </div>
      <div className="flex flex-wrap gap-2">
        {cell("فروش", formatToman(k.revenue), `${toFa(Math.round(k.share * 100))}٪ از کل درآمد`)}
        {cell("سفارش", toFa(k.orders), `میانگین ${formatToman(k.aov)}`)}
        {cell("سود ناخالص", k.grossProfit != null ? formatToman(k.grossProfit) : "—", k.margin != null ? `حاشیه ${toFa(Math.round(k.margin * 100))}٪` : "قیمت خرید وارد نشده")}
        {cell("مشتری نوبت که خرید کرد", k.attachRate != null ? `${toFa(Math.round(k.attachRate * 100))}٪` : "—", `${toFa(a.buyers_with_visit || 0)} از ${toFa(a.visit_customers || 0)} نفر`)}
      </div>
      {(a.daily || []).length > 1 && (
        <div className="flex items-end gap-1" style={{ height: 44, marginTop: 12 }} aria-label="فروش روزانهٔ فروشگاه">
          {a.daily.map((d) => (
            <div key={d.date} title={`${d.date}: ${formatToman(d.revenue)}`} style={{ flex: 1, height: `${Math.max(6, (d.revenue / max) * 100)}%`, background: "var(--color-accent-400, var(--color-accent-500))", borderRadius: 3, opacity: 0.85 }} />
          ))}
        </div>
      )}
      {(a.top_products || []).length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 4 }}>پرفروش‌ها</p>
          {a.top_products.slice(0, 5).map((p) => (
            <div key={p.name} className="tabular" style={{ fontSize: 12.5, padding: "4px 0", borderTop: "1px dashed var(--color-border)" }}>
              <span style={{ fontWeight: 700 }}>{p.name}</span> <span className="muted">× {toFa(p.qty)}</span>
              <div className="muted" style={{ fontSize: 11.5 }}>{formatToman(p.revenue)}{p.profit != null ? ` · سود ${formatToman(p.profit)}` : ""}</div>
            </div>
          ))}
        </>
      )}
      {(a.by_category || []).length > 1 && (
        <div className="flex flex-wrap gap-1.5" style={{ marginTop: 10 }}>
          {a.by_category.map((c) => (
            <span key={c.category} className="tabular" style={{ fontSize: 11, padding: "3px 8px", borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)" }}>
              {categoryLabel(c.category)}: {formatToman(c.revenue)}
            </span>
          ))}
        </div>
      )}
      {tip && (
        <p className="flex items-start gap-1.5" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.8, background: "color-mix(in oklch, var(--color-warning) 10%, var(--color-surface))", borderRadius: "var(--radius-md)", padding: "8px 10px" }}>
          <Lightbulb size={14} color="var(--color-warning)" style={{ flexShrink: 0, marginTop: 4 }} /> {tip}
        </p>
      )}
    </div>
  );
}

/** Accounting: everything the salon earned besides services, for net profit. */
export function useOtherIncome(days, bookings, enabled) {
  const [r, setR] = useState(null);
  useEffect(() => {
    if (!enabled) { setR(null); return undefined; }
    let alive = true;
    const to = new Date(); const from = new Date(); from.setDate(from.getDate() - (days - 1));
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    Promise.all([fetchShopAnalytics(days, bookings), fetchRevenueExtras(iso(from), iso(to))]).then(([shop, extras]) => {
      if (!alive) return;
      const shopOk = shop?.ok ? shop : null;
      const ex = extras?.ok ? extras : null;
      const shopGross = shopOk ? (shopOk.revenue || 0) - (shopOk.cogs || 0) : 0;
      setR({
        shopRevenue: shopOk?.revenue || 0,
        shopCogs: shopOk?.cogs || 0,
        shopGross,
        packages: ex?.packages_revenue || 0,
        gifts: ex?.gift_cards_revenue || 0,
        events: ex?.events_revenue || 0, // v2.53 event deposits and instalments
        total: shopGross + (ex?.packages_revenue || 0) + (ex?.gift_cards_revenue || 0) + (ex?.events_revenue || 0),
      });
    });
    return () => { alive = false; };
  }, [days, bookings, enabled]);
  return r;
}
