import { useEffect, useMemo, useState } from "react";
import { Building2, Plus, Search, LogOut, Loader2, CheckCircle2, AlertTriangle, Power, Pencil, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { SUPABASE_ENABLED } from "./lib/supabase";
import { getSession, signOut, signInPlatformAdmin, registerPlatformAdmin } from "./lib/auth";
import { isPlatformAdmin, adminListSalons, adminCreateSalon, adminUpdateSalon } from "./lib/api";
import { toFa, normalizeMobile, jalaliLabel, parseDateKey } from "./lib/format";

/**
 * /admin — the platform owner's panel (v2.41): create salons and bind each to
 * its owner's phone, see which salons are set up and in use, switch a salon
 * off. Access = a row in public.platform_admins (granted once with SQL).
 */
const C = {
  brand: "#c2703a", bg: "#f6f3f0", card: "#fff", border: "#e8e1db", text: "#2b2420", muted: "#7a6e66",
  ok: "#2f8a57", warn: "#b7791f", danger: "#b4483a",
};
const S = {
  page: { minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "Vazirmatn, system-ui, sans-serif", padding: "20px 16px 40px" },
  wrap: { maxWidth: 980, margin: "0 auto" },
  card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 },
  input: { width: "100%", padding: "10px 12px", fontSize: 14, borderRadius: 10, border: `1px solid ${C.border}`, fontFamily: "inherit", background: "#fff", color: C.text, boxSizing: "border-box" },
  btn: { padding: "10px 14px", borderRadius: 10, border: "none", background: C.brand, color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 40 },
  ghost: { padding: "8px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: "#fff", color: C.text, fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5, minHeight: 36 },
  chip: (color) => ({ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 700, color, background: `${color}14`, borderRadius: 999, padding: "3px 8px" }),
  label: { fontSize: 12, color: C.muted, marginBottom: 4, display: "block" },
};

export default function AdminPage() {
  const [state, setState] = useState("loading"); // loading | login | ready
  useEffect(() => {
    (async () => {
      if (!SUPABASE_ENABLED) { setState("login"); return; }
      const session = await getSession();
      setState(session && (await isPlatformAdmin()) ? "ready" : "login");
    })();
  }, []);

  return (
    <div dir="rtl" style={S.page}>
      <style>{"@keyframes spin { to { transform: rotate(360deg); } } .adm-spin { animation: spin .9s linear infinite; }"}</style>
      <div style={S.wrap}>
        {state === "loading" && <Loader2 className="adm-spin" color={C.brand} style={{ display: "block", margin: "80px auto" }} />}
        {state === "login" && <AdminLogin onDone={() => setState("ready")} />}
        {state === "ready" && <AdminDashboard onLogout={async () => { await signOut(); setState("login"); }} />}
      </div>
    </div>
  );
}

function AdminLogin({ onDone }) {
  const [mode, setMode] = useState("login"); // login | register
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [registeredEmail, setRegisteredEmail] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    if (mode === "login") {
      const res = await signInPlatformAdmin(phone, password);
      setBusy(false);
      if (res.ok) onDone(); else setError(res.error);
    } else {
      const res = await registerPlatformAdmin(phone, password);
      setBusy(false);
      if (res.ok) setRegisteredEmail(res.email); else setError(res.error);
    }
  }

  return (
    <div style={{ ...S.card, maxWidth: 400, margin: "60px auto 0" }}>
      <p style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, fontWeight: 800, marginBottom: 4 }}>
        <ShieldCheck size={20} color={C.brand} /> پنل مدیر کل
      </p>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 16 }}>مدیریت همهٔ سالن‌های این سامانه</p>
      {!SUPABASE_ENABLED && <p style={{ fontSize: 13, color: C.warn }}>در حالت دمو (بدون Supabase) این پنل کار نمی‌کند.</p>}

      {registeredEmail ? (
        <div style={{ fontSize: 13, lineHeight: 2 }}>
          <p style={{ color: C.ok, fontWeight: 700 }}>حساب ساخته شد.</p>
          <p>برای فعال شدن دسترسی مدیر کل، این دستور را یک‌بار در Supabase → SQL Editor اجرا کنید:</p>
          <pre dir="ltr" style={{ background: C.bg, padding: 10, borderRadius: 8, fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {`insert into public.platform_admins (user_id)\nselect id from auth.users where email = '${registeredEmail}';`}
          </pre>
          <button style={{ ...S.btn, width: "100%", marginTop: 8 }} onClick={() => { setRegisteredEmail(""); setMode("login"); }}>ورود</button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={S.label} htmlFor="adm-phone">شمارهٔ موبایل</label>
            <input id="adm-phone" dir="ltr" type="tel" inputMode="tel" autoComplete="username" value={phone} onChange={(e) => setPhone(normalizeMobile(e.target.value))} placeholder="09xxxxxxxxx" style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="adm-pass">رمز عبور</label>
            <input id="adm-pass" dir="ltr" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} style={S.input} />
          </div>
          {error && <p role="alert" style={{ color: C.danger, fontSize: 12.5 }}>{error}</p>}
          <button type="submit" style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} disabled={busy || !/^09\d{9}$/.test(phone) || password.length < 6 || !SUPABASE_ENABLED}>
            {busy && <Loader2 size={15} className="adm-spin" />} {mode === "login" ? "ورود" : "ساخت حساب"}
          </button>
          <button type="button" style={{ ...S.ghost, justifyContent: "center" }} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
            {mode === "login" ? "اولین بار است؟ ساخت حساب مدیر کل" : "حساب دارم — ورود"}
          </button>
        </form>
      )}
    </div>
  );
}

const FILTERS = [
  { id: "all", label: "همه" },
  { id: "attention", label: "نیاز به پیگیری" },
  { id: "inactive", label: "غیرفعال" },
];
const PAGE_SIZE = 50;

function needsAttention(s) {
  return s.active && (!s.owner_registered || !s.sms_configured || s.sms_failed_30d > 0 || s.bookings_30d === 0);
}

function AdminDashboard({ onLogout }) {
  const [salons, setSalons] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState("");

  async function reload() {
    const rows = await adminListSalons();
    if (rows === null) setError("بارگذاری فهرست سالن‌ها ناموفق بود");
    else { setSalons(rows); setError(""); }
  }
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); }, [toast]);

  const stats = useMemo(() => {
    const list = salons || [];
    return {
      total: list.length,
      active: list.filter((s) => s.active).length,
      noOwner: list.filter((s) => s.active && !s.owner_registered).length,
      noSms: list.filter((s) => s.active && !s.sms_configured).length,
      bookings: list.reduce((n, s) => n + (s.bookings_30d || 0), 0),
    };
  }, [salons]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (salons || []).filter((s) =>
      (filter === "all" || (filter === "inactive" ? !s.active : needsAttention(s)))
      && (!q || s.name.toLowerCase().includes(q) || s.slug.includes(q) || (s.owner_phone || "").includes(q)));
  }, [salons, query, filter]);

  async function toggleActive(s) {
    const verb = s.active ? "غیرفعال" : "فعال";
    if (!window.confirm(`سالن «${s.name}» ${verb} شود؟${s.active ? "\nصفحهٔ رزرو و پنل کارکنان آن از دسترس خارج می‌شود و پیامک‌های در صفش لغو می‌شوند." : ""}`)) return;
    const res = await adminUpdateSalon(s.id, { active: !s.active });
    if (!res.ok) { setToast(res.error || "ناموفق بود"); return; }
    setToast(`سالن ${verb} شد`);
    reload();
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 19, fontWeight: 800 }}>
          <ShieldCheck size={21} color={C.brand} /> پنل مدیر کل
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.btn} onClick={() => setCreating(true)}><Plus size={16} /> سالن جدید</button>
          <button style={S.ghost} onClick={onLogout} aria-label="خروج"><LogOut size={15} /></button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Stat label="سالن فعال" value={`${toFa(stats.active)} از ${toFa(stats.total)}`} />
        <Stat label="بدون مدیر ثبت‌نام‌شده" value={toFa(stats.noOwner)} tone={stats.noOwner ? C.warn : C.ok} />
        <Stat label="بدون حساب پیامک" value={toFa(stats.noSms)} tone={stats.noSms ? C.warn : C.ok} />
        <Stat label="نوبت‌های ۳۰ روز اخیر" value={toFa(stats.bookings.toLocaleString("en-US"))} />
      </div>

      <div style={{ ...S.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px" }}>
          <Search size={15} color={C.muted} style={{ position: "absolute", insetInlineStart: 10, top: 12 }} />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE); }} placeholder="جستجو: نام، آدرس یا شمارهٔ مدیر" aria-label="جستجو" style={{ ...S.input, paddingInlineStart: 32 }} />
        </div>
        <div role="radiogroup" aria-label="فیلتر" style={{ display: "flex", gap: 6 }}>
          {FILTERS.map((f) => (
            <button key={f.id} role="radio" aria-checked={filter === f.id} onClick={() => { setFilter(f.id); setShown(PAGE_SIZE); }}
              style={{ ...S.ghost, ...(filter === f.id ? { border: `1px solid ${C.brand}`, color: C.brand, background: `${C.brand}10` } : {}) }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" style={{ color: C.danger, marginBottom: 12 }}>{error}</p>}
      {!salons && !error && <Loader2 className="adm-spin" color={C.brand} style={{ display: "block", margin: "40px auto" }} />}
      {salons && filtered.length === 0 && (
        <p style={{ ...S.card, color: C.muted, textAlign: "center" }}>{salons.length ? "سالنی با این مشخصات نیست" : "هنوز سالنی ساخته نشده — «سالن جدید» را بزنید"}</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.slice(0, shown).map((s) => <SalonRow key={s.id} s={s} onToggle={() => toggleActive(s)} onEdit={() => setEditing(s)} />)}
      </div>
      {filtered.length > shown && (
        <button style={{ ...S.ghost, display: "flex", margin: "14px auto 0" }} onClick={() => setShown((n) => n + PAGE_SIZE)}>
          نمایش بیشتر ({toFa(filtered.length - shown)} سالن دیگر)
        </button>
      )}

      {creating && <CreateSalonDialog onClose={() => setCreating(false)} onCreated={() => { reload(); }} />}
      {editing && <EditSalonDialog salon={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setToast("ذخیره شد"); reload(); }} />}
      {toast && (
        <div role="status" style={{ position: "fixed", bottom: 20, insetInlineStart: "50%", transform: "translateX(50%)", background: C.text, color: "#fff", padding: "10px 16px", borderRadius: 10, fontSize: 13, zIndex: 100 }}>{toast}</div>
      )}
    </>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={S.card}>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone || C.text }}>{value}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SalonRow({ s, onToggle, onEdit }) {
  const url = `${window.location.origin}/${s.slug}`;
  return (
    <div style={{ ...S.card, opacity: s.active ? 1 : 0.65 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 15 }}>
            <Building2 size={16} color={C.brand} /> {s.name}
          </p>
          <a href={url} target="_blank" rel="noreferrer" dir="ltr" style={{ fontSize: 12, color: C.muted, display: "inline-flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            /{s.slug} <ExternalLink size={11} />
          </a>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={S.ghost} onClick={onEdit}><Pencil size={13} /> ویرایش</button>
          <button style={{ ...S.ghost, color: s.active ? C.danger : C.ok }} onClick={onToggle}><Power size={13} /> {s.active ? "غیرفعال" : "فعال"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {!s.active && <span style={S.chip(C.danger)}>غیرفعال</span>}
        <span style={S.chip(s.owner_registered ? C.ok : C.warn)}>
          {s.owner_registered ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
          {s.owner_registered ? "مدیر ثبت‌نام کرده" : `منتظر ثبت‌نام مدیر${s.owner_phone ? ` (${toFa(s.owner_phone)})` : ""}`}
        </span>
        <span style={S.chip(s.sms_configured ? C.ok : C.warn)}>
          {s.sms_configured ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
          {s.sms_configured ? "پیامک تنظیم شده" : "پیامک تنظیم نشده"}
        </span>
        {s.sms_failed_30d > 0 && <span style={S.chip(C.danger)}><AlertTriangle size={12} /> {toFa(s.sms_failed_30d)} پیامک ناموفق</span>}
      </div>
      <p style={{ fontSize: 12.5, color: C.muted, marginTop: 10, lineHeight: 1.9 }}>
        {toFa(s.stylists)} آرایشگر · {toFa(s.services)} خدمت · {toFa(s.bookings_30d)} نوبت در ۳۰ روز ({toFa(s.completed_30d)} انجام‌شده) · {toFa(s.sms_sent_30d)} پیامک
        {s.last_booking_date ? ` · آخرین نوبت: ${jalaliLabel(parseDateKey(s.last_booking_date), { short: true })}` : " · هنوز نوبتی ندارد"}
      </p>
    </div>
  );
}

function Dialog({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...S.card, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto" }}>
        <p style={{ fontWeight: 800, fontSize: 16, marginBottom: 14 }}>{title}</p>
        {children}
      </div>
    </div>
  );
}

function CreateSalonDialog({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const slugOk = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await adminCreateSalon({ slug, name: name.trim(), ownerPhone });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setCreated({ ...res, name: name.trim(), ownerPhone });
    onCreated();
  }

  if (created) {
    const url = `${window.location.origin}/${created.slug}`;
    const message = `سالن «${created.name}» در سامانهٔ نوبت‌دهی ساخته شد.\nآدرس: ${url}\nبرای ورود: «پنل مدیریت ← ورود مدیر سالن ← ثبت‌نام» با شمارهٔ ${created.ownerPhone}.\nبعد از ورود: ساعات کاری، خدمات، آرایشگرها و «پیامک ← حساب پیامک سالن» را تنظیم کنید.`;
    return (
      <Dialog title="سالن ساخته شد" onClose={onClose}>
        <p style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>این پیام را برای مدیر سالن بفرستید:</p>
        <pre style={{ background: C.bg, padding: 12, borderRadius: 10, fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.9, fontFamily: "inherit" }}>{message}</pre>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={{ ...S.btn, flex: 1 }} onClick={() => navigator.clipboard?.writeText(message)}><Copy size={14} /> کپی پیام</button>
          <button style={{ ...S.ghost, flex: 1, justifyContent: "center" }} onClick={onClose}>بستن</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="سالن جدید" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={S.label} htmlFor="ns-name">نام سالن</label>
          <input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="آرایشگاه …" style={S.input} />
        </div>
        <div>
          <label style={S.label} htmlFor="ns-slug">آدرس صفحه (حروف کوچک انگلیسی، عدد، خط تیره)</label>
          <input id="ns-slug" dir="ltr" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="mana-salon" style={S.input} />
          <p dir="ltr" style={{ fontSize: 11.5, color: slug && !slugOk ? C.danger : C.muted, marginTop: 4, textAlign: "right" }}>{window.location.origin}/{slug || "…"}</p>
        </div>
        <div>
          <label style={S.label} htmlFor="ns-owner">موبایل مدیر سالن (فقط همین شماره می‌تواند مدیر شود)</label>
          <input id="ns-owner" dir="ltr" type="tel" inputMode="tel" value={ownerPhone} onChange={(e) => setOwnerPhone(normalizeMobile(e.target.value))} placeholder="09xxxxxxxxx" style={S.input} />
        </div>
        {error && <p role="alert" style={{ color: C.danger, fontSize: 12.5 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" style={{ ...S.btn, flex: 1, opacity: busy ? 0.6 : 1 }} disabled={busy || !name.trim() || !slugOk || !/^09\d{9}$/.test(ownerPhone)}>
            {busy && <Loader2 size={15} className="adm-spin" />} ساخت سالن
          </button>
          <button type="button" style={{ ...S.ghost, flex: 1, justifyContent: "center" }} onClick={onClose}>انصراف</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditSalonDialog({ salon, onClose, onSaved }) {
  const [name, setName] = useState(salon.name);
  const [ownerPhone, setOwnerPhone] = useState(salon.owner_phone || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await adminUpdateSalon(salon.id, { name: name.trim(), ownerPhone: ownerPhone || null });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onSaved();
  }

  return (
    <Dialog title={`ویرایش ${salon.name}`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={S.label} htmlFor="es-name">نام سالن</label>
          <input id="es-name" value={name} onChange={(e) => setName(e.target.value)} style={S.input} />
        </div>
        <div>
          <label style={S.label} htmlFor="es-owner">موبایل مدیر سالن</label>
          <input id="es-owner" dir="ltr" type="tel" inputMode="tel" value={ownerPhone} onChange={(e) => setOwnerPhone(normalizeMobile(e.target.value))} placeholder="09xxxxxxxxx" style={S.input} />
          {salon.owner_registered && <p style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>مدیر فعلی قبلاً ثبت‌نام کرده؛ تغییر این شماره روی حساب او اثری ندارد.</p>}
        </div>
        {error && <p role="alert" style={{ color: C.danger, fontSize: 12.5 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" style={{ ...S.btn, flex: 1, opacity: busy ? 0.6 : 1 }} disabled={busy || !name.trim() || (ownerPhone && !/^09\d{9}$/.test(ownerPhone))}>
            {busy && <Loader2 size={15} className="adm-spin" />} ذخیره
          </button>
          <button type="button" style={{ ...S.ghost, flex: 1, justifyContent: "center" }} onClick={onClose}>انصراف</button>
        </div>
      </form>
    </Dialog>
  );
}
