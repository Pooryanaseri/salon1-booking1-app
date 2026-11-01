import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Pencil, Gift, Ticket, AlertTriangle, ShieldCheck, Download, Database, Camera, ScanLine, Building2, Image as ImageIcon, X, TrendingUp, Users, Layers } from "lucide-react";
import { PackagesSection } from "./PetCare";
import { Modal, Switch } from "../components/ui";
import { formatToman, toFa, digitsOnly, normalizeMobile, isoToJalaliLabel, formatClock } from "../lib/format";
import {
  fetchRevenueExtras, fetchCommissionReport, fetchCoupons, saveCoupon, fetchGiftCards, issueGiftCard, giftCardBalance,
  fetchSupplies, saveSupply, supplyMove, fetchProfileSettings, saveProfileSettings, uploadGalleryPhoto, galleryUrl,
  mfaStatus, mfaEnroll, mfaVerify, mfaDisable, fetchBackups, backupNow, downloadBackup, fetchBranches, fetchBranchesSummary,
  switchBranch, checkIn,
} from "../lib/business";

/* ============================================================
   v2.50 / v2.51 — panel pieces for the business tools.
   ============================================================ */
const input = { width: "100%", padding: "9px 12px", fontSize: 14, marginTop: 4 };
const money = (v, set) => ({
  dir: "ltr", inputMode: "numeric", className: "tabular",
  value: v === "" || v == null ? "" : toFa(Number(v).toLocaleString("en-US")),
  onChange: (e) => set(digitsOnly(e.target.value, 11)), style: { ...input, textAlign: "left" },
});
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const rangeDates = (days) => {
  const to = new Date(); const from = new Date(); from.setDate(to.getDate() - (days - 1));
  return [iso(from), iso(to)];
};
const Spinner = () => <div className="card flex items-center justify-center" style={{ padding: 20 }}><Loader2 size={16} className="salon-spin" /></div>;
const cardTitle = (Icon, text, color = "var(--color-accent-500)") => (
  <p className="flex items-center gap-1.5" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)", marginBottom: 8 }}>
    <Icon size={15} color={color} /> {text}
  </p>
);

/* ------------------------------------------ 1. revenue beyond bookings --- */
export function RevenueExtrasCard({ days = 30 }) {
  const [r, setR] = useState(null);
  useEffect(() => {
    const [from, to] = rangeDates(days);
    fetchRevenueExtras(from, to).then(setR);
  }, [days]);
  if (!r) return <Spinner />;
  if (!r.ok) return null;
  const rows = [
    ["فروشگاه", r.shop_revenue, `${toFa(r.shop_orders)} سفارش`],
    ["بسته‌های پیش‌پرداخت", r.packages_revenue, `${toFa(r.packages_count)} بسته`],
    ["کارت هدیه", r.gift_cards_revenue, `مانده قابل استفاده: ${formatToman(r.gift_cards_outstanding)}`],
  ];
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="revenue-extras">
      {cardTitle(TrendingUp, `درآمدهای دیگر (${toFa(days)} روز اخیر)`, "var(--color-success)")}
      {rows.map(([label, v, sub]) => (
        <div key={label} className="flex justify-between gap-2" style={{ padding: "6px 0", borderTop: "1px dashed var(--color-border)", fontSize: 13 }}>
          <span>{label} <span className="muted" style={{ fontSize: 11.5 }}>({sub})</span></span>
          <b className="tabular">{formatToman(v || 0)}</b>
        </div>
      ))}
      {r.top_products?.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>پرفروش‌ترین کالاها</p>
          {r.top_products.map((p) => (
            <div key={p.name} className="flex justify-between" style={{ fontSize: 12.5, padding: "3px 0" }}>
              <span>{p.name} × {toFa(p.qty)}</span><span className="tabular muted">{formatToman(p.revenue)}</span>
            </div>
          ))}
        </>
      )}
      {r.low_stock?.length > 0 && (
        <p className="flex items-start gap-1.5" style={{ fontSize: 12.5, marginTop: 10, color: "var(--color-warning)", lineHeight: 1.8 }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 4 }} />
          موجودی رو به اتمام: {r.low_stock.map((p) => `${p.name} (${toFa(p.stock)})`).join("، ")}
        </p>
      )}
      {r.demo && <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>در حالت دمو این گزارش خالی است.</p>}
    </div>
  );
}

/* --------------------------------------------------------- 4. commission --- */
export function CommissionCard({ bookings, stylists }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState(null);
  useEffect(() => {
    const [from, to] = rangeDates(days);
    fetchCommissionReport(from, to, bookings, stylists).then(setR);
  }, [days, bookings, stylists]);
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="commission">
      <div className="flex items-center justify-between">
        {cardTitle(Users, "پورسانت کارکنان", "var(--color-info)")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="بازهٔ پورسانت" style={{ padding: "4px 8px", fontSize: 12 }}>
          {[7, 30, 90].map((d) => <option key={d} value={d}>{toFa(d)} روز</option>)}
        </select>
      </div>
      {!r ? <Loader2 size={15} className="salon-spin" /> : !r.ok ? <p className="muted" style={{ fontSize: 12 }}>{r.error}</p> : (
        <>
          {r.rows.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>آرایشگری ثبت نشده</p>}
          {r.rows.map((x) => (
            <div key={x.id} style={{ padding: "8px 0", borderTop: "1px dashed var(--color-border)", fontSize: 12.5 }}>
              <div className="flex justify-between"><b>{x.name}</b><b className="tabular" style={{ color: "var(--color-success)" }}>{formatToman(x.total_commission)}</b></div>
              <div className="muted tabular" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
                {toFa(x.services_count)} خدمت · {formatToman(x.services_revenue)} × {toFa(x.commission_pct)}٪
                {x.packages_count > 0 && <> · {toFa(x.packages_count)} بسته × {toFa(x.package_commission_pct)}٪</>}
              </div>
            </div>
          ))}
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>درصدها را در «آرایشگرها ← ویرایش» تعیین کنید. هزینهٔ رفت‌وبرگشت در پورسانت حساب نمی‌شود.</p>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------- 3. coupons + gift cards --- */
export function MarketingTab({ isManager, notify, services = [], showPackages = false }) {
  const [seg, setSeg] = useState(isManager ? "coupons" : "gifts");
  return (
    <div className="fade-in">
      <div className="flex gap-2 mb-3" role="tablist" aria-label="تخفیف و هدیه">
        {[...(isManager ? [["coupons", "کد تخفیف", Ticket]] : []), ["gifts", "کارت هدیه", Gift],
          ...(showPackages ? [["packages", "بسته‌ها", Layers]] : [])].map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={seg === id} className="tap flex-1 flex items-center justify-center gap-1" onClick={() => setSeg(id)}
            style={{ padding: "9px 6px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
              background: seg === id ? "var(--color-accent-500)" : "var(--color-surface)", color: seg === id ? "white" : "var(--color-body)",
              border: seg === id ? "none" : "1px solid var(--color-border)" }}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {seg === "coupons" && isManager && <CouponsSection notify={notify} />}
      {seg === "gifts" && <GiftCardsSection notify={notify} />}
      {/* v2.52: prepaid packages for men's / women's salons (pet salons keep them under «حیوانات») */}
      {seg === "packages" && showPackages && <PackagesSection services={services} notify={notify} isManager={isManager} />}
    </div>
  );
}

function CouponsSection({ notify }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchCoupons().then(setList); }, [tick]);
  if (!list) return <Spinner />;
  return (
    <div>
      <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }}
        onClick={() => setEditing({ code: "", kind: "percent", value: "10", scope: "both", min_total: "", max_uses: "", valid_until: "", active: true })}>
        <Plus size={15} /> کد تخفیف جدید
      </button>
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز کدی نساخته‌اید</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((c) => {
          const expired = c.valid_until && c.valid_until < iso(new Date());
          const full = c.max_uses != null && c.used_count >= c.max_uses;
          return (
            <div key={c.id} className="card flex items-center justify-between gap-2" data-coupon={c.code} style={{ padding: 12, opacity: c.active && !expired && !full ? 1 : 0.55 }}>
              <div>
                <p className="tabular" dir="ltr" style={{ fontWeight: 800, fontSize: 15, textAlign: "right" }}>{c.code}</p>
                <p className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
                  {c.percent ? `${toFa(c.percent)}٪` : formatToman(c.amount)} · {{ booking: "نوبت", shop: "فروشگاه", both: "نوبت و فروشگاه" }[c.scope]}
                  {c.min_total > 0 && <> · خرید بالای {formatToman(c.min_total)}</>}
                  {" · "}{toFa(c.used_count)}{c.max_uses != null ? ` از ${toFa(c.max_uses)}` : ""} استفاده
                  {c.valid_until && <> · تا {isoToJalaliLabel(c.valid_until)}</>}
                  {expired && " · منقضی"}{full && " · تمام شده"}
                </p>
              </div>
              <button className="tap ghost-btn" style={{ width: 36, height: 36, padding: 0 }} aria-label={`ویرایش ${c.code}`}
                onClick={() => setEditing({ ...c, kind: c.percent ? "percent" : "amount", value: String(c.percent || c.amount), min_total: c.min_total || "", max_uses: c.max_uses ?? "", valid_until: c.valid_until || "" })}>
                <Pencil size={14} style={{ margin: "auto" }} />
              </button>
            </div>
          );
        })}
      </div>
      {editing && <CouponModal c={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); notify("کد تخفیف ذخیره شد"); }} />}
    </div>
  );
}

function CouponModal({ c: initial, onClose, onSaved }) {
  const [c, setC] = useState(initial);
  const [err, setErr] = useState("");
  const set = (k) => (v) => setC((x) => ({ ...x, [k]: v }));
  async function save() {
    const res = await saveCoupon(c);
    if (!res.ok) { setErr(res.error); return; }
    onSaved();
  }
  return (
    <Modal title={c.id ? "ویرایش کد تخفیف" : "کد تخفیف جدید"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>کد (مثلاً YALDA20)
          <input dir="ltr" value={c.code} maxLength={20} onChange={(e) => set("code")(e.target.value.toUpperCase().replace(/\s/g, ""))} style={{ ...input, textAlign: "left" }} disabled={!!c.id} />
        </label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>نوع
            <select value={c.kind} onChange={(e) => set("kind")(e.target.value)} style={input}>
              <option value="percent">درصد</option><option value="amount">مبلغ ثابت</option>
            </select>
          </label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>{c.kind === "percent" ? "درصد" : "مبلغ (تومان)"}
            {c.kind === "percent"
              ? <input dir="ltr" inputMode="numeric" className="tabular" value={c.value} onChange={(e) => set("value")(digitsOnly(e.target.value, 3))} style={{ ...input, textAlign: "left" }} />
              : <input {...money(c.value, set("value"))} />}
          </label>
        </div>
        <label className="muted" style={{ fontSize: 12 }}>برای
          <select value={c.scope} onChange={(e) => set("scope")(e.target.value)} style={input}>
            <option value="both">نوبت و فروشگاه</option><option value="booking">فقط نوبت</option><option value="shop">فقط فروشگاه</option>
          </select>
        </label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>حداقل خرید (اختیاری)<input {...money(c.min_total, set("min_total"))} /></label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>سقف استفاده (اختیاری)
            <input dir="ltr" inputMode="numeric" className="tabular" value={c.max_uses} onChange={(e) => set("max_uses")(digitsOnly(e.target.value, 6))} style={{ ...input, textAlign: "left" }} />
          </label>
        </div>
        <label className="muted" style={{ fontSize: 12 }}>تا تاریخ (اختیاری)
          <input type="date" value={c.valid_until || ""} onChange={(e) => set("valid_until")(e.target.value)} style={input} />
        </label>
        <div className="flex items-center justify-between"><span style={{ fontSize: 13 }}>فعال</span><Switch checked={c.active !== false} onChange={set("active")} label="فعال" /></div>
        <p className="muted" style={{ fontSize: 11.5 }}>هر مشتری هر کد را یک بار می‌تواند استفاده کند.</p>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
      </div>
    </Modal>
  );
}

function GiftCardsSection({ notify }) {
  const [list, setList] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [code, setCode] = useState("");
  const [bal, setBal] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchGiftCards().then(setList); }, [tick]);
  async function check() {
    setBal(await giftCardBalance(code));
  }
  if (!list) return <Spinner />;
  return (
    <div>
      <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }} onClick={() => setIssuing(true)}>
        <Gift size={15} /> فروش کارت هدیه در سالن
      </button>
      <div className="card mb-3" style={{ padding: 12 }}>
        <p className="muted" style={{ fontSize: 12 }}>استعلام مانده</p>
        <div className="flex gap-2" style={{ marginTop: 4 }}>
          <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="GXXXXXXXX" aria-label="کد کارت هدیه" style={{ ...input, marginTop: 0, textAlign: "left" }} />
          <button className="tap ghost-btn" style={{ padding: "0 14px" }} onClick={check}>استعلام</button>
        </div>
        {bal && <p style={{ fontSize: 12.5, marginTop: 6, color: bal.ok ? "var(--color-success)" : "var(--color-danger)" }}>{bal.ok ? `مانده: ${formatToman(bal.balance)}` : bal.error}</p>}
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>برای پرداخت با کارت هدیه، هنگام «انجام شد» کد را وارد کنید.</p>
      </div>
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>کارت هدیه‌ای فروخته نشده</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((g) => (
          <div key={g.id} className="card" style={{ padding: 12, fontSize: 12.5 }}>
            <div className="flex justify-between"><b className="tabular" dir="ltr">{g.code}</b>
              <b className="tabular" style={{ color: g.balance > 0 ? "var(--color-success)" : "var(--color-muted)" }}>{formatToman(g.balance)} از {formatToman(g.amount)}</b></div>
            <p className="muted" style={{ lineHeight: 1.8 }}>
              برای {g.recipient_name || "—"} <span dir="ltr" className="tabular">{g.recipient_phone}</span>
              {g.status === "awaiting_payment" ? " · منتظر پرداخت آنلاین" : g.sold_at_desk ? " · فروش در سالن" : " · خرید آنلاین"}
              {" · تا "}{isoToJalaliLabel(g.expires_at)}
            </p>
          </div>
        ))}
      </div>
      {issuing && <IssueGiftModal notify={notify} onClose={() => setIssuing(false)} onDone={() => { setIssuing(false); setTick((t) => t + 1); }} />}
    </div>
  );
}

function IssueGiftModal({ onClose, onDone, notify }) {
  const [f, setF] = useState({ amount: "500000", recipientPhone: "", recipientName: "", buyerName: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  async function go() {
    setBusy(true); setErr("");
    const res = await issueGiftCard({ ...f, amount: Number(f.amount) });
    setBusy(false);
    if (!res?.ok) { setErr(res?.error || "ثبت ناموفق بود"); return; }
    notify(`کارت هدیه ${res.code} ساخته و برای گیرنده پیامک شد`);
    onDone();
  }
  return (
    <Modal title="فروش کارت هدیه" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>مبلغ (تومان) — در سالن دریافت کنید<input {...money(f.amount, set("amount"))} /></label>
        <label className="muted" style={{ fontSize: 12 }}>موبایل گیرنده
          <input dir="ltr" type="tel" inputMode="tel" className="tabular" value={f.recipientPhone} onChange={(e) => set("recipientPhone")(normalizeMobile(e.target.value))} placeholder="09xxxxxxxxx" style={{ ...input, textAlign: "left" }} />
        </label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>نام گیرنده<input value={f.recipientName} maxLength={80} onChange={(e) => set("recipientName")(e.target.value)} style={input} /></label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>از طرف<input value={f.buyerName} maxLength={80} onChange={(e) => set("buyerName")(e.target.value)} style={input} /></label>
        </div>
        <label className="muted" style={{ fontSize: 12 }}>پیام (اختیاری)<input value={f.message} maxLength={200} onChange={(e) => set("message")(e.target.value)} style={input} /></label>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={busy || !/^09\d{9}$/.test(f.recipientPhone) || !Number(f.amount)} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={go}>
          {busy && <Loader2 size={14} className="salon-spin" />} ساخت و ارسال پیامک
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- 10. supplies --- */
export function SuppliesSection({ isManager, notify }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [moving, setMoving] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchSupplies().then(setList); }, [tick]);
  if (!list) return <Spinner />;
  const low = list.filter((s) => s.active && s.qty <= s.low_at);
  return (
    <div>
      {low.length > 0 && (
        <div className="card mb-3" style={{ padding: 12, borderColor: "var(--color-warning)" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 800, color: "var(--color-warning)" }}>
            <AlertTriangle size={14} /> رو به اتمام: {low.map((s) => s.name).join("، ")}
          </p>
        </div>
      )}
      {isManager && (
        <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }} onClick={() => setEditing({ name: "", unit: "عدد", low_at: 1, active: true })}>
          <Plus size={15} /> قلم جدید
        </button>
      )}
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز موادی ثبت نشده (شامپو، رنگ، تیغ…)</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((s) => (
          <div key={s.id} className="card flex items-center justify-between gap-2" data-supply={s.name} style={{ padding: 12 }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</p>
              <p className="tabular" style={{ fontSize: 12.5, color: s.qty <= s.low_at ? "var(--color-warning)" : "var(--color-muted)" }}>
                {toFa(s.qty)} {s.unit}{s.qty <= s.low_at ? " — رو به اتمام" : ""}
              </p>
            </div>
            <div className="flex gap-1.5">
              <button className="tap ghost-btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setMoving({ s, kind: "use" })}>مصرف</button>
              {isManager && <button className="tap ghost-btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setMoving({ s, kind: "purchase" })}>خرید</button>}
              {isManager && <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label={`ویرایش ${s.name}`} onClick={() => setEditing(s)}><Pencil size={13} style={{ margin: "auto" }} /></button>}
            </div>
          </div>
        ))}
      </div>
      {editing && <SupplyModal s={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); }} />}
      {moving && <SupplyMoveModal {...moving} notify={notify} onClose={() => setMoving(null)} onDone={() => { setMoving(null); setTick((t) => t + 1); }} />}
    </div>
  );
}

function SupplyModal({ s: initial, onClose, onSaved }) {
  const [s, setS] = useState(initial);
  const [err, setErr] = useState("");
  async function save() {
    const res = await saveSupply(s);
    if (!res.ok) { setErr(res.error); return; }
    onSaved();
  }
  return (
    <Modal title={s.id ? "ویرایش قلم" : "قلم جدید انبار"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>نام<input value={s.name} maxLength={60} onChange={(e) => setS({ ...s, name: e.target.value })} style={input} /></label>
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>واحد<input value={s.unit} maxLength={15} placeholder="لیتر، عدد، بسته" onChange={(e) => setS({ ...s, unit: e.target.value })} style={input} /></label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>هشدار وقتی کمتر از
            <input dir="ltr" inputMode="decimal" className="tabular" value={s.low_at} onChange={(e) => setS({ ...s, low_at: e.target.value })} style={{ ...input, textAlign: "left" }} />
          </label>
        </div>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
      </div>
    </Modal>
  );
}

function SupplyMoveModal({ s, kind, onClose, onDone, notify }) {
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go() {
    const q = Number(String(qty).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
    if (!(q > 0)) { setErr("مقدار را وارد کنید"); return; }
    setBusy(true);
    const res = await supplyMove(s, kind, q, kind === "purchase" ? Number(cost) || null : null);
    setBusy(false);
    if (!res?.ok) { setErr(res?.error || "ثبت ناموفق بود"); return; }
    notify(kind === "purchase" ? `خرید ${s.name} ثبت شد${Number(cost) ? " و به هزینه‌ها اضافه شد" : ""}` : `مصرف ${s.name} ثبت شد${res.low ? " — رو به اتمام است" : ""}`);
    onDone();
  }
  return (
    <Modal title={`${kind === "purchase" ? "خرید" : "مصرف"} ${s.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>مقدار ({s.unit})
          <input dir="ltr" inputMode="decimal" className="tabular" value={qty} onChange={(e) => setQty(e.target.value)} style={{ ...input, textAlign: "left" }} />
        </label>
        {kind === "purchase" && <label className="muted" style={{ fontSize: 12 }}>مبلغ خرید (اختیاری — در هزینه‌ها ثبت می‌شود)<input {...money(cost, setCost)} /></label>}
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={busy} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={go}>
          {busy && <Loader2 size={14} className="salon-spin" />} ثبت
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------- 2. profile settings --- */
export function ProfileSettingsCard({ notify }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { fetchProfileSettings().then((d) => setP(d ? { ...d, hadReviewUrl: !!d.review_url } : d)); }, []);
  if (!p) return null;
  const set = (k) => (v) => setP((x) => ({ ...x, [k]: v }));
  async function addPhotos(files) {
    setUploading(true);
    const added = [];
    for (const f of [...files].slice(0, 24 - p.gallery.length)) {
      const r = await uploadGalleryPhoto(f);
      if (r.ok) added.push(r.path); else notify(r.error);
    }
    setUploading(false);
    setP((x) => ({ ...x, gallery: [...x.gallery, ...added] }));
  }
  async function save() {
    setBusy(true);
    const r = await saveProfileSettings(p);
    setBusy(false);
    notify(r.ok ? "صفحهٔ معرفی سالن ذخیره شد" : r.error);
  }
  const slug = window.location.pathname.split("/").filter(Boolean)[0] || "";
  return (
    <div className="card mb-6" style={{ padding: 14 }} data-card="profile">
      {cardTitle(ImageIcon, "صفحهٔ معرفی سالن")}
      <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8, marginBottom: 8 }}>
        صفحهٔ عمومی با آدرس، نقشه، ساعات کاری، گالری و نظر مشتری‌ها:
        {" "}<a href={`/${slug}/about`} target="_blank" rel="noreferrer" dir="ltr" style={{ color: "var(--color-accent-500)" }}>/{slug}/about</a> — لینکش را در اینستاگرام بگذارید.
      </p>
      <label className="muted" style={{ fontSize: 12 }}>درباره سالن<textarea rows={3} maxLength={1500} value={p.about} onChange={(e) => set("about")(e.target.value)} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} /></label>
      <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>آدرس<input value={p.address} maxLength={300} onChange={(e) => set("address")(e.target.value)} style={input} /></label>
      <div className="flex gap-2" style={{ marginTop: 8 }}>
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>تلفن<input dir="ltr" value={p.phone} maxLength={20} onChange={(e) => set("phone")(e.target.value)} style={{ ...input, textAlign: "left" }} /></label>
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>اینستاگرام<input dir="ltr" value={p.instagram} maxLength={31} placeholder="salon.page" onChange={(e) => set("instagram")(e.target.value)} style={{ ...input, textAlign: "left" }} /></label>
      </div>
      <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>لینک نقشه (نشان، بلد یا گوگل‌مپ)
        <input dir="ltr" value={p.map_url} maxLength={500} placeholder="https://nshn.ir/..." onChange={(e) => set("map_url")(e.target.value)} style={{ ...input, textAlign: "left" }} />
      </label>
      <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>لینک ثبت نظر در گوگل‌مپ یا نشان (برای مشتری‌های ۵ ستاره)
        <input dir="ltr" value={p.review_url || ""} maxLength={250} placeholder="https://g.page/r/.../review" onChange={(e) => set("review_url")(e.target.value)} style={{ ...input, textAlign: "left" }} />
      </label>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>گالری ({toFa(p.gallery.length)} از ۲۴)</p>
      <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
        {p.gallery.map((g) => (
          <div key={g} style={{ position: "relative", width: 64, height: 64 }}>
            <img src={galleryUrl(g)} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
            <button type="button" className="tap" aria-label="حذف عکس" onClick={() => set("gallery")(p.gallery.filter((x) => x !== g))}
              style={{ position: "absolute", top: -6, left: -6, width: 22, height: 22, minHeight: 0, borderRadius: "50%", background: "var(--color-danger)", color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}><X size={12} /></button>
          </div>
        ))}
        {p.gallery.length < 24 && (
          <button type="button" className="tap" onClick={() => fileRef.current?.click()} disabled={uploading}
            style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", border: "1px dashed var(--color-accent-500)", color: "var(--color-accent-500)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {uploading ? <Loader2 size={16} className="salon-spin" /> : <Camera size={18} />}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="افزودن عکس گالری" onChange={(e) => { addPhotos(e.target.files || []); e.target.value = ""; }} />
      </div>
      <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
        <span style={{ fontSize: 13 }}>نمایش نظرهای خوب مشتری‌ها</span>
        <Switch checked={p.show_reviews !== false} onChange={set("show_reviews")} label="نمایش نظرها" />
      </div>
      <button disabled={busy || uploading} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 11, marginTop: 12 }} onClick={save}>
        {busy && <Loader2 size={14} className="salon-spin" />} ذخیره
      </button>
    </div>
  );
}

/* ------------------------------------------ 13. two-step login + backups --- */
export function SecurityCard({ notify, isManager = true }) {
  const [st, setSt] = useState(null);
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState("");
  const [backups, setBackups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    mfaStatus().then(setSt).catch(() => setSt({ available: false }));
    fetchBackups().then(setBackups);
  }, [tick]);
  async function start() {
    const r = await mfaEnroll();
    if (!r.ok) { notify(r.error); return; }
    setEnroll(r); setCode("");
  }
  async function confirm() {
    setBusy(true);
    const r = await mfaVerify(enroll.factorId, code);
    setBusy(false);
    if (!r.ok) { notify(r.error); return; }
    setEnroll(null); notify("ورود دومرحله‌ای فعال شد"); setTick((t) => t + 1);
  }
  async function disable() {
    if (!window.confirm("ورود دومرحله‌ای غیرفعال شود؟")) return;
    const r = await mfaDisable(st.factorId);
    notify(r.ok ? "غیرفعال شد" : r.error); setTick((t) => t + 1);
  }
  async function backup() {
    setBusy(true);
    const r = await backupNow();
    setBusy(false);
    notify(r.ok ? "نسخهٔ پشتیبان گرفته شد" : r.error); setTick((t) => t + 1);
  }
  return (
    <div className="card mb-6" style={{ padding: 14 }} data-card="security">
      {cardTitle(ShieldCheck, "امنیت و پشتیبان‌گیری", "var(--color-success)")}
      <p style={{ fontSize: 13.5, fontWeight: 700 }}>ورود دومرحله‌ای</p>
      {!st ? <Loader2 size={14} className="salon-spin" /> : !st.available ? (
        <p className="muted" style={{ fontSize: 12 }}>در حالت دمو در دسترس نیست.</p>
      ) : st.enabled ? (
        <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
          <span style={{ fontSize: 12.5, color: "var(--color-success)" }}>فعال است — هنگام ورود، کد برنامهٔ احراز هویت هم لازم است.</span>
          <button className="tap ghost-btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={disable}>غیرفعال</button>
        </div>
      ) : enroll ? (
        <div style={{ marginTop: 6 }}>
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>این کد را با Google Authenticator یا Microsoft Authenticator اسکن کنید، سپس کد ۶ رقمی را وارد کنید.</p>
          {enroll.qr && <img src={enroll.qr} alt="QR ورود دومرحله‌ای" style={{ width: 170, height: 170, background: "white", padding: 6, borderRadius: 8, margin: "8px auto", display: "block" }} />}
          {enroll.secret && <p className="tabular" dir="ltr" style={{ fontSize: 11.5, textAlign: "center", wordBreak: "break-all" }}>{enroll.secret}</p>}
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <input dir="ltr" inputMode="numeric" value={code} maxLength={6} onChange={(e) => setCode(digitsOnly(e.target.value, 6))} aria-label="کد ۶ رقمی" style={{ ...input, marginTop: 0, textAlign: "center" }} />
            <button disabled={busy || code.length !== 6} className="tap accent-btn" style={{ padding: "0 16px" }} onClick={confirm}>تایید</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
          <span className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>با رمز تنها نمی‌شود وارد پنل شما شد.</span>
          <button className="tap accent-btn" style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={start}>فعال‌سازی</button>
        </div>
      )}
      {isManager && <>
      <hr style={{ border: 0, borderTop: "1px dashed var(--color-border)", margin: "12px 0" }} />
      <div className="flex items-center justify-between">
        <p style={{ fontSize: 13.5, fontWeight: 700 }}><Database size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> نسخه‌های پشتیبان</p>
        <button disabled={busy} className="tap ghost-btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={backup}>پشتیبان‌گیری الان</button>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>هر شب خودکار؛ ۷ نسخهٔ آخر نگه داشته می‌شود.</p>
      {backups.map((b) => (
        <div key={b.id} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "6px 0", borderTop: "1px dashed var(--color-border)" }}>
          <span className="tabular">{new Date(b.created_at).toLocaleString("fa-IR", { dateStyle: "medium", timeStyle: "short" })} · {toFa(Math.max(1, Math.round(b.size_bytes / 1024)))} KB</span>
          <button className="tap ghost-btn flex items-center gap-1" style={{ padding: "5px 10px", fontSize: 12 }}
            onClick={async () => { const r = await downloadBackup(b.id, `backup-${b.created_at.slice(0, 10)}.json`); if (!r.ok) notify(r.error); }}>
            <Download size={12} /> دانلود
          </button>
        </div>
      ))}
      </>}
    </div>
  );
}

/* ----------------------------------------------------------- 12. branches --- */
export function BranchBar({ notify }) {
  const [list, setList] = useState([]);
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { fetchBranches().then(setList); }, []);
  if (list.length < 2) return null;
  const current = list.find((b) => b.current);
  async function go(b) {
    const r = await switchBranch(b.salon_id);
    if (!r?.ok) { notify(r?.error || "تغییر شعبه ناموفق بود"); return; }
    window.location.assign(`/${r.slug}`);
  }
  return (
    <div className="card mb-3" style={{ padding: 10 }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700 }}><Building2 size={14} /> شعبه: {current?.name}</span>
        <div className="flex gap-1.5">
          <select aria-label="تغییر شعبه" value={current?.salon_id} onChange={(e) => go(list.find((b) => b.salon_id === e.target.value))} style={{ padding: "5px 8px", fontSize: 12.5 }}>
            {list.map((b) => <option key={b.salon_id} value={b.salon_id}>{b.name}</option>)}
          </select>
          <button className="tap ghost-btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => { setOpen((o) => !o); if (!summary) fetchBranchesSummary().then(setSummary); }}>خلاصهٔ شعبه‌ها</button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {!summary ? <Loader2 size={14} className="salon-spin" /> : summary.map((s) => (
            <div key={s.salon_id} className="flex justify-between gap-2" style={{ fontSize: 12.5, padding: "6px 0", borderTop: "1px dashed var(--color-border)" }}>
              <b>{s.name}</b>
              <span className="tabular muted">امروز {toFa(s.today)} نوبت · این ماه {formatToman(s.month_revenue)}{s.month_orders ? ` + فروشگاه ${formatToman(s.month_orders)}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- 11. check-in --- */
export function CheckInModal({ onClose, onCheckedIn, notify, bookings }) {
  const videoRef = useRef(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState("idle"); // idle | on | unsupported | denied
  const [result, setResult] = useState(null);
  const streamRef = useRef(null);
  const doneRef = useRef(false);

  async function submit(value) {
    const v = (value ?? code).trim();
    if (!v || busy) return;
    setBusy(true);
    const r = await checkIn(v, bookings);
    setBusy(false);
    if (!r?.ok) { notify(r?.error || "ثبت ورود ناموفق بود"); doneRef.current = false; return; }
    setResult(r);
    onCheckedIn?.(r);
  }
  async function startCamera() {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) { setCamera("unsupported"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCamera("on");
      const det = new window.BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current || doneRef.current) return;
        try {
          const found = await det.detect(videoRef.current);
          if (found[0]?.rawValue) { doneRef.current = true; setCode(found[0].rawValue); submit(found[0].rawValue); return; }
        } catch { /* keep scanning */ }
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setCamera("denied");
    }
  }
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; }, []);

  return (
    <Modal title="ثبت ورود مشتری" onClose={onClose}>
      {result ? (
        <div style={{ textAlign: "center", padding: 8 }}>
          <ShieldCheck size={36} color="var(--color-success)" style={{ margin: "0 auto 8px" }} />
          <p style={{ fontWeight: 800, fontSize: 16 }}>{result.pet_name ? `${result.pet_name} · ` : ""}{result.customer_name}</p>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>نوبت ساعت {formatClock(result.start_min)} — {result.already ? "قبلاً ورودش ثبت شده بود" : "ورود ثبت شد"}</p>
          <button className="tap accent-btn w-full" style={{ padding: 11, marginTop: 12 }} onClick={() => { setResult(null); setCode(""); doneRef.current = false; }}>مشتری بعدی</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: "var(--radius-md)", background: "#000", display: camera === "on" ? "block" : "none" }} />
          {camera !== "on" && (
            <button className="tap ghost-btn flex items-center justify-center gap-1.5" style={{ padding: 12 }} onClick={startCamera}>
              <ScanLine size={16} /> اسکن QR با دوربین
            </button>
          )}
          {camera === "unsupported" && <p className="muted" style={{ fontSize: 12 }}>این مرورگر اسکن QR ندارد — کد پیگیری را وارد کنید.</p>}
          {camera === "denied" && <p className="muted" style={{ fontSize: 12 }}>اجازهٔ دوربین داده نشد — کد پیگیری را وارد کنید.</p>}
          <div className="flex gap-2">
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="MN-12345" aria-label="کد پیگیری نوبت" style={{ ...input, marginTop: 0, textAlign: "left" }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            <button disabled={busy || !code.trim()} className="tap accent-btn" style={{ padding: "0 16px" }} onClick={() => submit()}>
              {busy ? <Loader2 size={14} className="salon-spin" /> : "ثبت"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11.5 }}>مشتری QR را در «داشبورد من» روی نوبت امروزش می‌بیند.</p>
        </div>
      )}
    </Modal>
  );
}

