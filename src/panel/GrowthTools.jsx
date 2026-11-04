import { useEffect, useState } from "react";
import { Loader2, Sparkles, CreditCard, AlertTriangle } from "lucide-react";
import { Modal, Switch } from "../components/ui";
import { formatToman, toFa, digitsOnly, isoToJalaliLabel } from "../lib/format";
import {
  fetchGrowthSettings, saveGrowthSettings, EVENT_STATUS, eventKindLabel,
  fetchEventRequests, quoteEvent, setEventStatus, recordEventPayment,
  fetchMyPlan, buyPlan,
} from "../lib/growth";

/* ============================================================
   v2.53 — panel screens of the growth tools.
   ============================================================ */
const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-body)" };
const Spinner = () => <div className="card flex justify-center" style={{ padding: 20 }}><Loader2 size={16} className="salon-spin" /></div>;
const money = (v, on) => ({ dir: "ltr", inputMode: "numeric", className: "tabular", value: v === "" || v == null ? "" : toFa(Number(v).toLocaleString("en-US")),
  onChange: (e) => on(digitsOnly(e.target.value, 11)), style: { ...input, textAlign: "left" } });
const slug = () => window.location.pathname.split("/").filter(Boolean)[0] || "";

/* ------------------------------------------------------------ automation --- */
export function GrowthAutomations({ notify }) {
  const [s, setS] = useState(null);
  useEffect(() => { fetchGrowthSettings().then((d) => setS(d || { unavailable: true })); }, []);
  if (!s) return <Spinner />;
  if (s.unavailable) return <div className="card" style={{ padding: 16 }}><p className="muted" style={{ fontSize: 13 }}>برای این بخش، migration نسخهٔ v2.53 را اجرا کنید.</p></div>;
  async function save(patch) {
    setS((x) => ({ ...x, ...patch }));
    const r = await saveGrowthSettings(patch);
    notify(r.ok ? "ذخیره شد" : r.error);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="card" style={{ padding: 14 }}>
        <div className="flex items-center justify-between gap-2">
          <span style={{ fontSize: 14, fontWeight: 800 }}>نوبت لغوشده: پیشنهاد به مشتری‌های قدیمی</span>
          <Switch checked={!!s.slot_offer_lapsed} onChange={(v) => save({ slot_offer_lapsed: v })} label="پیشنهاد نوبت لغوشده به مشتری‌های قدیمی" />
        </div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.9, marginTop: 6 }}>
          وقتی نوبتی برای امروز یا فردا لغو می‌شود، علاوه بر لیست انتظار، به ۵ مشتری ثابتی که مدتی نیامده‌اند پیامک «یک نوبت خالی شد» می‌رود (هر نفر حداکثر هر ۱۴ روز یک بار). اولین نفری که رزرو کند، نوبت مال اوست.
        </p>
        <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>مشتری‌هایی که بیش از این تعداد روز نیامده‌اند
          <select value={s.slot_offer_lapsed_days} onChange={(e) => save({ slot_offer_lapsed_days: Number(e.target.value) })} style={input}>
            {[21, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{toFa(d)} روز</option>)}
          </select>
        </label>
      </div>
      <div className="card" style={{ padding: 14 }}>
        <div className="flex items-center justify-between gap-2">
          <span style={{ fontSize: 14, fontWeight: 800 }}>هشدار امتیاز پایین</span>
          <Switch checked={s.low_rating_alert !== false} onChange={(v) => save({ low_rating_alert: v })} label="هشدار امتیاز پایین" />
        </div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.9, marginTop: 6 }}>
          اگر مشتری ۳ ستاره یا کمتر بدهد، همان لحظه به موبایل مدیر پیامک می‌رود تا تماس بگیرید. مشتری‌های ۵ ستاره به صفحهٔ ثبت نظر در نقشه دعوت می‌شوند (لینکش را در «صفحهٔ معرفی سالن» بگذارید).
        </p>
      </div>
    </div>
  );
}

/* ================================================================ events tab */
export function EventsTab({ notify, isManager }) {
  const [list, setList] = useState(null);
  const [filter, setFilter] = useState("open");
  const [quoting, setQuoting] = useState(null);
  const [paying, setPaying] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchEventRequests().then(setList); }, [tick]);
  if (!list) return <Spinner />;
  const shown = list.filter((e) => (filter === "open" ? ["new", "quoted", "accepted"].includes(e.status) : !["new", "quoted", "accepted"].includes(e.status)));
  const link = `${window.location.origin}/${slug()}/events`;
  async function status(e, st) {
    if (!window.confirm(st === "done" ? "این مراسم انجام شد؟" : "این درخواست بسته شود؟")) return;
    const r = await setEventStatus(e.id, st);
    notify(r?.ok ? "ذخیره شد" : r?.error || "ناموفق بود");
    setTick((t) => t + 1);
  }
  return (
    <div className="fade-in">
      <div className="card mb-3" style={{ padding: 12 }}>
        <p style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          مشتری‌ها از صفحهٔ <a href={link} target="_blank" rel="noreferrer" dir="ltr" style={{ color: "var(--color-accent-500)" }}>/{slug()}/events</a> درخواست مراسم می‌دهند.
          شما پیش‌فاکتور و شرایط را می‌فرستید، مشتری تایید می‌کند و بیعانه را آنلاین یا در سالن می‌پردازد؛ باقی مبلغ را مرحله‌ای ثبت کنید.
        </p>
      </div>
      <div className="flex gap-2 mb-3">
        {[["open", "در جریان"], ["closed", "بسته‌شده"]].map(([id, label]) => (
          <button key={id} className="tap" aria-pressed={filter === id} onClick={() => setFilter(id)}
            style={{ padding: "7px 14px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700, border: `1px solid ${filter === id ? "var(--color-accent-500)" : "var(--color-border)"}`, background: filter === id ? "var(--color-accent-50)" : "var(--color-surface)" }}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="card" style={{ padding: 20, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>درخواستی نیست</p></div>}
      <div className="flex flex-col gap-2">
        {shown.map((e) => {
          const st = EVENT_STATUS[e.status] || EVENT_STATUS.new;
          const left = Math.max(0, (e.quote_total || 0) - (e.paid || 0));
          return (
            <div key={e.id} className="card" style={{ padding: 12 }} data-event={e.customer_name}>
              <div className="flex items-center justify-between gap-2">
                <span style={{ fontWeight: 800, fontSize: 14 }}>{eventKindLabel(e.kind)} — {e.customer_name}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color, whiteSpace: "nowrap" }}>{st.label}</span>
              </div>
              <p className="muted tabular" style={{ fontSize: 12.5, marginTop: 2 }}>
                {isoToJalaliLabel(String(e.event_date).slice(0, 10))} · {toFa(e.guests)} نفر · <a href={`tel:${e.customer_phone}`} dir="ltr">{e.customer_phone}</a>
              </p>
              {e.services && <p style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.8 }}>{e.services}</p>}
              {e.note && <p className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>{e.note}</p>}
              {e.quote_total != null && (
                <p className="tabular" style={{ fontSize: 12.5, marginTop: 4 }}>
                  کل {formatToman(e.quote_total)} · بیعانه {formatToman(e.deposit_amount || 0)} · پرداخت‌شده <b>{formatToman(e.paid || 0)}</b>{left > 0 ? ` · مانده ${formatToman(left)}` : " · تسویه"}
                </p>
              )}
              {["new", "quoted", "accepted"].includes(e.status) && (
                <div className="flex gap-2 flex-wrap" style={{ marginTop: 8 }}>
                  {isManager && e.status !== "accepted" && (
                    <button className="tap accent-btn" style={{ padding: "8px 12px", fontSize: 12.5 }} onClick={() => setQuoting(e)}>
                      {e.status === "quoted" ? "ویرایش پیش‌فاکتور" : "ارسال پیش‌فاکتور"}
                    </button>
                  )}
                  <button className="tap ghost-btn" style={{ padding: "8px 12px", fontSize: 12.5 }} onClick={() => setPaying(e)}><CreditCard size={13} /> ثبت پرداخت</button>
                  {isManager && e.status === "accepted" && <button className="tap ghost-btn" style={{ padding: "8px 12px", fontSize: 12.5 }} onClick={() => status(e, "done")}>انجام شد</button>}
                  {isManager && <button className="tap ghost-btn" style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--color-danger)" }} onClick={() => status(e, e.status === "accepted" ? "cancelled" : "declined")}>{e.status === "accepted" ? "لغو" : "رد"}</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {quoting && <QuoteModal ev={quoting} onClose={() => setQuoting(null)} onDone={(m) => { setQuoting(null); notify(m); setTick((t) => t + 1); }} />}
      {paying && <EventPayModal ev={paying} onClose={() => setPaying(null)} onDone={(m) => { setPaying(null); notify(m); setTick((t) => t + 1); }} />}
    </div>
  );
}
const DEFAULT_TERMS = "بیعانه برای رزرو قطعی تاریخ است و در صورت انصراف کمتر از ۷ روز مانده به مراسم برگشت داده نمی‌شود.\nباقی مبلغ تا روز مراسم پرداخت می‌شود.\nتغییر تاریخ تا ۱۴ روز قبل از مراسم، در صورت خالی بودن وقت، رایگان است.";
function QuoteModal({ ev, onClose, onDone }) {
  const [f, setF] = useState({ total: ev.quote_total ?? "", deposit: ev.deposit_amount ?? "", terms: ev.quote_terms || DEFAULT_TERMS, note: ev.quote_note || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  async function send() {
    setBusy(true); setErr("");
    const r = await quoteEvent(ev.id, Number(f.total), Number(f.deposit) || 0, f.terms, f.note);
    setBusy(false);
    if (!r?.ok) { setErr(r?.error || "ارسال ناموفق بود"); return; }
    onDone(r.sent ? "پیش‌فاکتور برای مشتری پیامک شد" : "ذخیره شد (لینک ساخته نشد — آدرس سایت تنظیم نشده)");
  }
  return (
    <Modal title={`پیش‌فاکتور ${eventKindLabel(ev.kind)} — ${ev.customer_name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>مبلغ کل (تومان)<input {...money(f.total, set("total"))} /></label>
          <label className="muted" style={{ fontSize: 12, flex: 1 }}>بیعانه (تومان)<input {...money(f.deposit, set("deposit"))} /></label>
        </div>
        <label className="muted" style={{ fontSize: 12 }}>توضیح برای مشتری (اختیاری)<input value={f.note} maxLength={600} onChange={(e) => set("note")(e.target.value)} style={input} /></label>
        <label className="muted" style={{ fontSize: 12 }}>شرایط و قوانین (مشتری باید بپذیرد)
          <textarea rows={5} maxLength={1500} value={f.terms} onChange={(e) => set("terms")(e.target.value)} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </label>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={busy || !(Number(f.total) >= 1000)} className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 12 }} onClick={send}>
          {busy && <Loader2 size={14} className="salon-spin" />} ذخیره و پیامک به مشتری
        </button>
      </div>
    </Modal>
  );
}
function EventPayModal({ ev, onClose, onDone }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    const r = await recordEventPayment(ev.id, Number(amount), note);
    if (!r?.ok) { setErr(r?.error || "ثبت ناموفق بود"); return; }
    onDone(`پرداخت ثبت شد — مانده: ${formatToman(r.left || 0)}`);
  }
  return (
    <Modal title={`پرداخت در سالن — ${ev.customer_name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="muted" style={{ fontSize: 12 }}>مبلغ (تومان)<input {...money(amount, setAmount)} /></label>
        <label className="muted" style={{ fontSize: 12 }}>یادداشت (اختیاری)<input value={note} maxLength={200} placeholder="نقد / کارتخوان / قسط دوم" onChange={(e) => setNote(e.target.value)} style={input} /></label>
        {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
        <button disabled={!(Number(amount) >= 1000)} className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ثبت پرداخت</button>
      </div>
    </Modal>
  );
}

/* ================================================================ plan ===== */
export function PlanCard({ notify }) {
  const [p, setP] = useState(null);
  const [months, setMonths] = useState(1);
  const [busy, setBusy] = useState(null);
  useEffect(() => { fetchMyPlan().then((d) => setP(d || { ok: false })); }, []);
  if (!p || !p.ok) return null;
  async function buy(id) {
    setBusy(id);
    const r = await buyPlan(id, months);
    if (r?.ok && r.url) { window.location.assign(r.url); return; }
    setBusy(null);
    notify(r?.error || "اتصال به درگاه پرداخت ناموفق بود");
  }
  const quotaPct = p.sms_quota > 0 ? Math.min(1, p.sms_used / p.sms_quota) : 0;
  // discounts are set by the platform owner (v2.58); older servers: the v2.53 defaults
  const disc = (m) => Number((p.discounts || { 3: 5, 6: 10, 12: 20 })[m] || 0);
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="plan">
      <p className="flex items-center gap-1.5 mb-2" style={{ fontSize: 15, fontWeight: 800 }}><Sparkles size={15} color="var(--color-accent-500)" /> اشتراک نرم‌افزار</p>
      <p style={{ fontSize: 13.5 }}>
        پلن: <b>{p.plan_name || "بدون پلن"}</b>
        {p.expires_at && <span className="muted tabular"> · تا {isoToJalaliLabel(String(p.expires_at).slice(0, 10))}</span>}
      </p>
      {p.state === "locked" && <p className="flex items-center gap-1" style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 4 }}><AlertTriangle size={13} /> اشتراک تمام شده و سرویس غیرفعال است — با تمدید همان لحظه فعال می‌شود</p>}
      {p.state === "grace" && <p className="flex items-center gap-1" style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 4 }}><AlertTriangle size={13} /> اشتراک تمام شده — تا {isoToJalaliLabel(String(p.grace_until).slice(0, 10))} فرصت تمدید دارید</p>}
      {p.state !== "locked" && p.state !== "grace" && p.expired && <p className="flex items-center gap-1" style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 4 }}><AlertTriangle size={13} /> اشتراک تمام شده — تمدید کنید</p>}
      {p.state === "active" && p.days_left != null && p.days_left >= 0 && p.days_left <= 14 && <p style={{ fontSize: 12.5, color: "var(--color-warning)", marginTop: 4, fontWeight: 700 }}>{toFa(p.days_left)} روز تا پایان اشتراک</p>}
      {p.sms_quota > 0 && (
        <>
          <p className="muted tabular" style={{ fontSize: 12, marginTop: 6 }}>پیامک این ماه: {toFa(p.sms_used)} از {toFa(p.sms_quota)}</p>
          <div style={{ height: 6, borderRadius: 3, background: "var(--color-surface-raised)", marginTop: 3, overflow: "hidden" }}>
            <div style={{ width: `${quotaPct * 100}%`, height: "100%", background: quotaPct > 0.9 ? "var(--color-danger)" : "var(--color-accent-500)" }} />
          </div>
        </>
      )}
      {p.payment_fee_pct > 0 && (
        <p className="muted tabular" style={{ fontSize: 12, marginTop: 6 }}>
          پرداخت‌های آنلاین این ماه: {formatToman(p.online_volume)} · کارمزد پلتفرم ({toFa(p.payment_fee_pct)}٪): {formatToman(p.payment_fee)}
        </p>
      )}
      {(p.online || p.demo) && (p.plans || []).length > 0 && (
        <>
          <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 10 }} role="radiogroup" aria-label="مدت">
            {[1, 3, 6, 12].map((m) => [m, `${toFa(m)} ماه${disc(m) > 0 ? ` (${toFa(disc(m))}٪ کمتر)` : ""}`]).map(([m, l]) => (
              <button key={m} role="radio" aria-checked={months === m} className="tap" onClick={() => setMonths(m)}
                style={{ padding: "6px 10px", borderRadius: "var(--radius-full)", fontSize: 11.5, fontWeight: 700, border: `1px solid ${months === m ? "var(--color-accent-500)" : "var(--color-border)"}`, background: months === m ? "var(--color-accent-50)" : "var(--color-surface)" }}>{l}</button>
            ))}
          </div>
          <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
            {p.plans.filter((x) => x.monthly_price > 0).map((x) => (
              <div key={x.id} className="flex items-center justify-between gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", border: `1px solid ${x.id === p.plan_id ? "var(--color-accent-500)" : "var(--color-border)"}` }}>
                <span style={{ fontSize: 13 }}>
                  <b>{x.name}</b> <span className="muted tabular" style={{ fontSize: 11.5 }}>{formatToman(x.monthly_price)} در ماه{x.sms_quota ? ` · ${toFa(x.sms_quota)} پیامک` : ""}</span>
                  {months > 1 && <span className="tabular" style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{toFa(months)} ماه: {formatToman(Math.round(x.monthly_price * months * (1 - disc(months) / 100)))}</span>}
                </span>
                <button disabled={!!busy} className="tap accent-btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => buy(x.id)}>
                  {busy === x.id ? <Loader2 size={13} className="salon-spin" /> : x.id === p.plan_id ? "تمدید" : "خرید"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {p.demo && <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>در حالت دمو پرداخت فعال نیست.</p>}
      {p.support_phone && <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 6 }}>پشتیبانی: <span dir="ltr">{toFa(p.support_phone)}</span></p>}
    </div>
  );
}
