import { useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, Zap, Layers, Link2, Sparkles, Target, CreditCard, Copy, AlertTriangle, Download } from "lucide-react";
import QRCode from "qrcode";
import { Modal, Switch } from "../components/ui";
import { formatToman, toFa, digitsOnly, formatClock, isoToJalaliLabel } from "../lib/format";
import {
  SCHEMA_DAYS, fetchOffpeakRules, saveOffpeakRule, deleteOffpeakRule, quietHours,
  fetchUpsellAdmin, saveUpsell, deleteUpsell, SOURCES, sourceStats,
  fetchGrowthSettings, saveGrowthSettings, EVENT_STATUS, eventKindLabel,
  fetchEventRequests, quoteEvent, setEventStatus, recordEventPayment,
  monthStart, fetchTargetsProgress, saveTarget, targetStatus, fetchMyPlan, buyPlan,
} from "../lib/growth";

/* ============================================================
   v2.53 — panel screens of the growth tools.
   ============================================================ */
const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-body)" };
const Spinner = () => <div className="card flex justify-center" style={{ padding: 20 }}><Loader2 size={16} className="salon-spin" /></div>;
const money = (v, on) => ({ dir: "ltr", inputMode: "numeric", className: "tabular", value: v === "" || v == null ? "" : toFa(Number(v).toLocaleString("en-US")),
  onChange: (e) => on(digitsOnly(e.target.value, 11)), style: { ...input, textAlign: "left" } });
const slug = () => window.location.pathname.split("/").filter(Boolean)[0] || "";
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + (m || 0); };

function Segments({ value, onChange, items }) {
  return (
    <div className="flex gap-1.5 mb-3" role="tablist" style={{ overflowX: "auto", paddingBottom: 2 }}>
      {items.map(([id, label, Icon]) => (
        <button key={id} role="tab" aria-selected={value === id} className="tap flex items-center justify-center gap-1" onClick={() => onChange(id)}
          style={{ padding: "8px 11px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0,
            background: value === id ? "var(--color-accent-500)" : "var(--color-surface)", color: value === id ? "white" : "var(--color-body)",
            border: value === id ? "none" : "1px solid var(--color-border)" }}>
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

/* =============================================================== growth tab */
export function GrowthTab({ services, bookings, notify }) {
  const [seg, setSeg] = useState("offpeak");
  return (
    <div className="fade-in">
      <Segments value={seg} onChange={setSeg} items={[
        ["offpeak", "ساعت طلایی", Zap], ["upsell", "پیشنهاد افزودنی", Layers], ["sources", "لینک‌ها و منبع مشتری", Link2],
      ]} />
      {seg === "offpeak" && <OffpeakSection bookings={bookings} notify={notify} />}
      {seg === "upsell" && <UpsellSection services={services} notify={notify} />}
      {seg === "sources" && <SourcesSection bookings={bookings} notify={notify} />}
    </div>
  );
}

/* ------------------------------------------------------------- off-peak --- */
function OffpeakSection({ bookings, notify }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchOffpeakRules().then(setList); }, [tick]);
  if (!list) return <Spinner />;
  const quiet = quietHours(bookings).slice(0, 4);
  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.9, marginBottom: 10 }}>
        برای ساعت‌های خلوت تخفیف بگذارید. در صفحهٔ رزرو کنار همان ساعت‌ها «٪− ساعت طلایی» دیده می‌شود و تخفیف خودکار روی نوبت اعمال می‌شود.
      </p>
      {quiet.length > 0 && (
        <div className="card mb-3" style={{ padding: 12, background: "color-mix(in oklch, var(--color-info) 7%, var(--color-surface))" }}>
          <p style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>کم‌کارترین ساعت‌های ۶۰ روز اخیر</p>
          <p className="tabular" style={{ fontSize: 12.5, lineHeight: 2 }}>
            {quiet.map((q) => `${SCHEMA_DAYS[q.dow]} ${formatClock(q.hour * 60)} (${toFa(q.count)} نوبت)`).join(" · ")}
          </p>
        </div>
      )}
      <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }}
        onClick={() => setEditing({ day_of_week: "", start: "10:00", end: "13:00", percent: "15", label: "ساعت طلایی", active: true })}>
        <Plus size={15} /> قانون جدید
      </button>
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز قانونی نساخته‌اید</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((r) => (
          <div key={r.id} className="card flex items-center gap-3" style={{ padding: 12, opacity: r.active ? 1 : 0.55 }} data-offpeak={r.id}>
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 800, fontSize: 14 }}>{toFa(r.percent)}٪ تخفیف — {r.label}</p>
              <p className="muted tabular" style={{ fontSize: 12 }}>{r.day_of_week == null ? "همهٔ روزها" : SCHEMA_DAYS[r.day_of_week]} · {formatClock(r.start_min)} تا {formatClock(r.end_min)}</p>
            </div>
            <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label="ویرایش" onClick={() => setEditing({ ...r, day_of_week: r.day_of_week ?? "", start: hhmm(r.start_min), end: hhmm(r.end_min), percent: String(r.percent) })}><Pencil size={13} style={{ margin: "auto" }} /></button>
            <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0, color: "var(--color-danger)" }} aria-label="حذف"
              onClick={async () => { if (window.confirm("این قانون حذف شود؟")) { await deleteOffpeakRule(r.id); setTick((t) => t + 1); } }}><Trash2 size={13} style={{ margin: "auto" }} /></button>
          </div>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? "ویرایش ساعت طلایی" : "ساعت طلایی جدید"} onClose={() => setEditing(null)}>
          <OffpeakForm rule={editing} onDone={(msg) => { setEditing(null); notify(msg); setTick((t) => t + 1); }} />
        </Modal>
      )}
    </div>
  );
}
function OffpeakForm({ rule, onDone }) {
  const [r, setR] = useState(rule);
  const [err, setErr] = useState("");
  const set = (k) => (v) => setR((x) => ({ ...x, [k]: v }));
  async function save() {
    const res = await saveOffpeakRule({ ...r, start_min: toMin(r.start), end_min: toMin(r.end) });
    if (!res.ok) { setErr(res.error); return; }
    onDone("ذخیره شد");
  }
  return (
    <div className="flex flex-col gap-3">
      <label className="muted" style={{ fontSize: 12 }}>روز
        <select value={r.day_of_week} onChange={(e) => set("day_of_week")(e.target.value)} style={input}>
          <option value="">همهٔ روزها</option>
          {SCHEMA_DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>از ساعت<input type="time" dir="ltr" value={r.start} onChange={(e) => set("start")(e.target.value)} style={input} /></label>
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>تا ساعت<input type="time" dir="ltr" value={r.end} onChange={(e) => set("end")(e.target.value)} style={input} /></label>
      </div>
      <div className="flex gap-2">
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>درصد تخفیف<input dir="ltr" inputMode="numeric" value={toFa(r.percent)} onChange={(e) => set("percent")(digitsOnly(e.target.value, 2))} style={{ ...input, textAlign: "left" }} /></label>
        <label className="muted" style={{ fontSize: 12, flex: 2 }}>عنوان<input value={r.label} maxLength={30} onChange={(e) => set("label")(e.target.value)} style={input} /></label>
      </div>
      <div className="flex items-center justify-between"><span style={{ fontSize: 13 }}>فعال</span><Switch checked={r.active !== false} onChange={set("active")} label="فعال" /></div>
      {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
      <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
    </div>
  );
}

/* --------------------------------------------------------------- upsell --- */
function UpsellSection({ services, notify }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchUpsellAdmin(services).then(setList); }, [tick, services]);
  if (!list) return <Spinner />;
  const name = (id) => services.find((s) => s.id === id)?.name || "—";
  const active = services.filter((s) => s.is_active !== false && s.price > 0);
  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.9, marginBottom: 10 }}>
        وقتی مشتری خدمت اصلی را انتخاب می‌کند، پیشنهاد افزودنی با قیمت ویژه می‌بیند (مثلاً «+ ماسک مو فقط …»). با یک تیک به همان نوبت اضافه می‌شود.
      </p>
      <button className="tap accent-btn w-full flex items-center justify-center gap-1.5 mb-3" style={{ padding: 11 }}
        onClick={() => setEditing({ service_id: active[0]?.id || "", addon_service_id: active[1]?.id || "", price: "", extra_minutes: "0", pitch: "", active: true })}>
        <Plus size={15} /> پیشنهاد جدید
      </button>
      {list.length === 0 && <div className="card" style={{ padding: 18, textAlign: "center" }}><p className="muted" style={{ fontSize: 13 }}>هنوز پیشنهادی نساخته‌اید</p></div>}
      <div className="flex flex-col gap-2">
        {list.map((o) => (
          <div key={o.id} className="card flex items-center gap-3" style={{ padding: 12, opacity: o.active ? 1 : 0.55 }} data-upsell={o.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontWeight: 800, fontSize: 13.5 }}>{name(o.service_id)} ← + {name(o.addon_service_id)}</p>
              <p className="muted tabular" style={{ fontSize: 12 }}>
                {formatToman(o.price)}{o.extra_minutes > 0 ? ` · ${toFa(o.extra_minutes)} دقیقه` : ""} · {toFa(o.accepted_count || 0)} بار پذیرفته شد
              </p>
            </div>
            <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label="ویرایش" onClick={() => setEditing({ ...o, price: String(o.price), extra_minutes: String(o.extra_minutes) })}><Pencil size={13} style={{ margin: "auto" }} /></button>
            <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0, color: "var(--color-danger)" }} aria-label="حذف"
              onClick={async () => { if (window.confirm("این پیشنهاد حذف شود؟")) { await deleteUpsell(o.id); setTick((t) => t + 1); } }}><Trash2 size={13} style={{ margin: "auto" }} /></button>
          </div>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? "ویرایش پیشنهاد" : "پیشنهاد افزودنی جدید"} onClose={() => setEditing(null)}>
          <UpsellForm offer={editing} services={active} onDone={(msg) => { setEditing(null); notify(msg); setTick((t) => t + 1); }} />
        </Modal>
      )}
    </div>
  );
}
function UpsellForm({ offer, services, onDone }) {
  const [o, setO] = useState(offer);
  const [err, setErr] = useState("");
  const set = (k) => (v) => setO((x) => ({ ...x, [k]: v }));
  const addon = services.find((s) => s.id === o.addon_service_id);
  async function save() {
    const res = await saveUpsell(o);
    if (!res.ok) { setErr(res.error); return; }
    onDone("پیشنهاد ذخیره شد");
  }
  return (
    <div className="flex flex-col gap-3">
      <label className="muted" style={{ fontSize: 12 }}>وقتی مشتری این را انتخاب کرد
        <select value={o.service_id} onChange={(e) => set("service_id")(e.target.value)} style={input}>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({formatToman(s.price)})</option>)}
        </select>
      </label>
      <label className="muted" style={{ fontSize: 12 }}>این را پیشنهاد بده
        <select value={o.addon_service_id} onChange={(e) => set("addon_service_id")(e.target.value)} style={input}>
          {services.filter((s) => s.id !== o.service_id).map((s) => <option key={s.id} value={s.id}>{s.name} ({formatToman(s.price)})</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="muted" style={{ fontSize: 12, flex: 2 }}>قیمت ویژه (تومان)<input {...money(o.price, set("price"))} /></label>
        <label className="muted" style={{ fontSize: 12, flex: 1 }}>دقیقهٔ اضافه<input dir="ltr" inputMode="numeric" value={toFa(o.extra_minutes)} onChange={(e) => set("extra_minutes")(digitsOnly(e.target.value, 3))} style={{ ...input, textAlign: "left" }} /></label>
      </div>
      {addon && Number(o.price) > 0 && Number(o.price) < addon.price && (
        <p style={{ fontSize: 12, color: "var(--color-success)", marginTop: -6 }}>{toFa(Math.round(100 - (Number(o.price) * 100) / addon.price))}٪ ارزان‌تر از قیمت عادی</p>
      )}
      <label className="muted" style={{ fontSize: 12 }}>یک جملهٔ کوتاه (اختیاری)<input value={o.pitch} maxLength={120} placeholder="مثلاً براق‌تر و نرم‌تر تا ۴ هفته" onChange={(e) => set("pitch")(e.target.value)} style={input} /></label>
      <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }}>اگر «دقیقهٔ اضافه» بگذارید، فقط وقتی اضافه می‌شود که بعد از نوبت وقت خالی باشد.</p>
      <div className="flex items-center justify-between"><span style={{ fontSize: 13 }}>فعال</span><Switch checked={o.active !== false} onChange={set("active")} label="فعال" /></div>
      {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
      <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
    </div>
  );
}

/* -------------------------------------------------------------- sources --- */
function SourcesSection({ bookings, notify }) {
  const [qr, setQr] = useState(null);
  const base = `${window.location.origin}/${slug()}`;
  const stats = sourceStats(bookings, 90);
  const total = stats.reduce((t, r) => t + r.bookings, 0) || 1;
  async function showQr(src, label) {
    const url = `${base}?src=${src}`;
    setQr({ label, url, img: await QRCode.toDataURL(url, { width: 360, margin: 1 }) });
  }
  return (
    <div>
      <div className="card mb-3" style={{ padding: 14 }}>
        <p style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>از کجا مشتری می‌آید؟ (۹۰ روز اخیر)</p>
        {stats.length === 0 ? <p className="muted" style={{ fontSize: 12.5 }}>هنوز داده‌ای نیست</p> : stats.map((r) => (
          <div key={r.source || "none"} style={{ padding: "7px 0", borderTop: "1px dashed var(--color-border)" }}>
            <div className="flex justify-between gap-2 tabular" style={{ fontSize: 13 }}>
              <b>{r.label}</b><span>{formatToman(r.revenue)}</span>
            </div>
            <div className="muted tabular" style={{ fontSize: 11.5 }}>{toFa(r.bookings)} نوبت · {toFa(r.newClients)} مشتری جدید</div>
            <div style={{ height: 5, borderRadius: 3, background: "var(--color-surface-raised)", marginTop: 4 }}>
              <div style={{ width: `${(r.bookings / total) * 100}%`, height: "100%", borderRadius: 3, background: "var(--color-accent-500)" }} />
            </div>
          </div>
        ))}
        <p className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.8 }}>برای اینکه این گزارش دقیق شود، در هر جا فقط لینک مخصوص همان‌جا را بگذارید.</p>
      </div>
      <div className="card" style={{ padding: 14 }}>
        <p style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>لینک‌های مخصوص هر کانال</p>
        {SOURCES.map(([src, label]) => (
          <div key={src} className="flex items-center gap-2" style={{ padding: "6px 0", borderTop: "1px dashed var(--color-border)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, width: 110, flexShrink: 0 }}>{label}</span>
            <span className="muted" dir="ltr" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>?src={src}</span>
            <button className="tap ghost-btn" style={{ padding: "5px 8px", fontSize: 11.5 }} aria-label={`کپی لینک ${label}`}
              onClick={() => { navigator.clipboard?.writeText(`${base}?src=${src}`); notify("لینک کپی شد"); }}><Copy size={12} /></button>
            <button className="tap ghost-btn" style={{ padding: "5px 8px", fontSize: 11.5 }} onClick={() => showQr(src, label)}>QR</button>
          </div>
        ))}
      </div>
      {qr && (
        <Modal title={`QR ${qr.label}`} onClose={() => setQr(null)}>
          <img src={qr.img} alt={qr.url} style={{ width: "100%", maxWidth: 300, margin: "0 auto", display: "block" }} />
          <p className="muted" dir="ltr" style={{ fontSize: 11.5, textAlign: "center", marginTop: 6, wordBreak: "break-all" }}>{qr.url}</p>
          <a className="tap accent-btn w-full flex items-center justify-center gap-1" style={{ padding: 11, marginTop: 10, textDecoration: "none" }} href={qr.img} download={`qr-${qr.label}.png`}>
            <Download size={14} /> دانلود برای چاپ روی کارت ویزیت
          </a>
        </Modal>
      )}
    </div>
  );
}

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

/* ============================================================== targets ==== */
export function TargetsCard({ bookings, stylists, isManager, currentStylistId, notify }) {
  const [month] = useState(monthStart());
  const [r, setR] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    fetchTargetsProgress(month, bookings, stylists, isManager ? null : currentStylistId).then(setR);
  }, [month, bookings, stylists, isManager, currentStylistId, tick]);
  if (!r) return null;
  if (!r.ok) return null;
  const rows = (r.rows || []).filter((x) => isManager || x.id === currentStylistId);
  if (!isManager && !rows.some((x) => targetStatus(x).hasTarget)) return null;
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="targets">
      <p className="flex items-center gap-1.5 mb-2" style={{ fontSize: 14, fontWeight: 800 }}><Target size={15} color="var(--color-accent-500)" /> هدف این ماه و پاداش</p>
      {rows.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>آرایشگری ثبت نشده</p>}
      {rows.map((x) => {
        const t = targetStatus(x);
        return (
          <div key={x.id} style={{ padding: "8px 0", borderTop: "1px dashed var(--color-border)" }}>
            <div className="flex items-center justify-between gap-2" style={{ fontSize: 13 }}>
              <b>{x.name}</b>
              {isManager && <button className="tap muted" style={{ fontSize: 11.5 }} onClick={() => setEditing(x)}>{t.hasTarget ? "ویرایش هدف" : "تعیین هدف"}</button>}
            </div>
            {t.hasTarget ? (
              <>
                <p className="muted tabular" style={{ fontSize: 11.5 }}>
                  {x.revenue_target > 0 && `فروش ${formatToman(x.revenue)} از ${formatToman(x.revenue_target)}`}
                  {x.revenue_target > 0 && x.visits_target > 0 && " · "}
                  {x.visits_target > 0 && `${toFa(x.visits)} از ${toFa(x.visits_target)} نوبت`}
                </p>
                <div style={{ height: 7, borderRadius: 4, background: "var(--color-surface-raised)", marginTop: 4, overflow: "hidden" }}>
                  <div style={{ width: `${t.progress * 100}%`, height: "100%", background: t.earned ? "var(--color-success)" : "var(--color-accent-500)" }} />
                </div>
                {x.bonus > 0 && (
                  <p className="tabular" style={{ fontSize: 12, marginTop: 4, color: t.earned ? "var(--color-success)" : "var(--color-body)", fontWeight: t.earned ? 800 : 400 }}>
                    {t.earned ? `🎉 پاداش ${formatToman(x.bonus)} گرفته شد` : `پاداش با رسیدن به هدف: ${formatToman(x.bonus)}`}
                  </p>
                )}
              </>
            ) : <p className="muted" style={{ fontSize: 11.5 }}>هدفی تعیین نشده</p>}
          </div>
        );
      })}
      {editing && (
        <Modal title={`هدف ${editing.name} برای این ماه`} onClose={() => setEditing(null)}>
          <TargetForm row={editing} onSave={async (v) => {
            const res = await saveTarget(editing.id, month, v);
            notify(res.ok ? "هدف ذخیره شد" : res.error);
            if (res.ok) { setEditing(null); setTick((t) => t + 1); }
          }} />
        </Modal>
      )}
    </div>
  );
}
function TargetForm({ row, onSave }) {
  const [v, setV] = useState({ revenue_target: row.revenue_target || "", visits_target: row.visits_target || "", bonus: row.bonus || "" });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <div className="flex flex-col gap-3">
      <label className="muted" style={{ fontSize: 12 }}>هدف فروش خدمات (تومان)<input {...money(v.revenue_target, set("revenue_target"))} /></label>
      <label className="muted" style={{ fontSize: 12 }}>هدف تعداد نوبت<input dir="ltr" inputMode="numeric" value={toFa(v.visits_target)} onChange={(e) => set("visits_target")(digitsOnly(e.target.value, 4))} style={{ ...input, textAlign: "left" }} /></label>
      <label className="muted" style={{ fontSize: 12 }}>پاداش با رسیدن به هدف (تومان)<input {...money(v.bonus, set("bonus"))} /></label>
      <p className="muted" style={{ fontSize: 11.5 }}>آرایشگر پیشرفتش را در پنل خودش می‌بیند. اگر هر دو هدف را بگذارید، هر دو باید کامل شوند.</p>
      <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={() => onSave(v)}>ذخیره</button>
    </div>
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
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="plan">
      <p className="flex items-center gap-1.5 mb-2" style={{ fontSize: 15, fontWeight: 800 }}><Sparkles size={15} color="var(--color-accent-500)" /> اشتراک نرم‌افزار</p>
      <p style={{ fontSize: 13.5 }}>
        پلن: <b>{p.plan_name || "بدون پلن"}</b>
        {p.expires_at && <span className="muted tabular"> · تا {isoToJalaliLabel(String(p.expires_at).slice(0, 10))}</span>}
      </p>
      {p.expired && <p className="flex items-center gap-1" style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 4 }}><AlertTriangle size={13} /> اشتراک تمام شده — تمدید کنید</p>}
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
      {p.online && (p.plans || []).length > 0 && (
        <>
          <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 10 }} role="radiogroup" aria-label="مدت">
            {[[1, "۱ ماه"], [3, "۳ ماه (۵٪ کمتر)"], [6, "۶ ماه (۱۰٪ کمتر)"], [12, "۱۲ ماه (۲۰٪ کمتر)"]].map(([m, l]) => (
              <button key={m} role="radio" aria-checked={months === m} className="tap" onClick={() => setMonths(m)}
                style={{ padding: "6px 10px", borderRadius: "var(--radius-full)", fontSize: 11.5, fontWeight: 700, border: `1px solid ${months === m ? "var(--color-accent-500)" : "var(--color-border)"}`, background: months === m ? "var(--color-accent-50)" : "var(--color-surface)" }}>{l}</button>
            ))}
          </div>
          <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
            {p.plans.filter((x) => x.monthly_price > 0).map((x) => (
              <div key={x.id} className="flex items-center justify-between gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", border: `1px solid ${x.id === p.plan_id ? "var(--color-accent-500)" : "var(--color-border)"}` }}>
                <span style={{ fontSize: 13 }}>
                  <b>{x.name}</b> <span className="muted tabular" style={{ fontSize: 11.5 }}>{formatToman(x.monthly_price)} در ماه{x.sms_quota ? ` · ${toFa(x.sms_quota)} پیامک` : ""}</span>
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
    </div>
  );
}
