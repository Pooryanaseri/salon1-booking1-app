import { useEffect, useState } from "react";
import { Loader2, MapPin, Phone, Instagram, Star, Clock, Gift, CalendarPlus, ShoppingBag, CheckCircle2, CreditCard, Sparkles } from "lucide-react";
import { createEventRequest, getEventQuote, acceptEventQuote, startEventPayment, EVENT_KINDS, eventKindLabel } from "./lib/growth";
import { fetchPublicProfile, galleryUrl, buyGiftCardOnline, startPurchasePayment, giftCardBalance } from "./lib/business";
import { fetchDepositTerms } from "./lib/api";
import { getSalonName } from "./lib/tenant";
import { formatToman, toFa, normalizeMobile, digitsOnly, isoToJalaliLabel } from "./lib/format";

/* ============================================================
   v2.50 — public pages of a salon: /<slug>/about and /<slug>/gift.
   Plain inline styles (they render outside the app shell).
   ============================================================ */
const C = { bg: "#f6f2ec", card: "#fff", text: "#2b2420", muted: "#7a6a5e", brand: "#c2703a", line: "#eadfd4" };
const FONT = "'Vazirmatn Variable', Vazirmatn, system-ui, sans-serif";
const DISPLAY = "'Noto Kufi Arabic Variable', 'Vazirmatn Variable', system-ui, sans-serif";
const wrap = { minHeight: "100vh", background: C.bg, color: C.text, fontFamily: FONT, padding: "20px 16px 48px" };
const card = { maxWidth: 520, margin: "0 auto 14px", background: C.card, borderRadius: 18, padding: 18, boxShadow: "0 6px 24px -14px rgba(60,40,20,.35)" };
const btn = { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px 14px", borderRadius: 12, background: `linear-gradient(135deg, #e9a24b, ${C.brand} 55%, #b8462f)`, color: "white", fontWeight: 800, textDecoration: "none", border: 0, fontFamily: FONT, fontSize: 14.5, cursor: "pointer", width: "100%", boxSizing: "border-box" };
const ghost = { ...btn, background: "white", color: C.brand, border: `1.5px solid ${C.brand}` };
const slug = () => window.location.pathname.split("/").filter(Boolean)[0] || "";
const DAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];

function setMeta(title, description) {
  document.title = title;
  let m = document.querySelector('meta[name="description"]');
  if (!m) { m = document.createElement("meta"); m.name = "description"; document.head.appendChild(m); }
  m.content = description.slice(0, 160);
}

/* ---------------------------------------------------------- profile ---- */
export function SalonProfilePage() {
  const [p, setP] = useState(null);
  const [zoom, setZoom] = useState(null);
  useEffect(() => {
    fetchPublicProfile().then((d) => {
      setP(d || { error: true });
      if (d) setMeta(`${d.name || getSalonName()} — نوبت آنلاین`, d.about || `رزرو آنلاین نوبت در ${d.name || getSalonName()}`);
    });
  }, []);
  if (!p) return <div dir="rtl" style={{ ...wrap, display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 size={24} color={C.brand} /></div>;
  if (p.error) return <div dir="rtl" style={wrap}><div style={card}>صفحهٔ سالن در دسترس نیست</div></div>;
  const name = p.name || getSalonName();
  const rating = p.rating?.count ? p.rating : null;
  // day_of_week 0 = Saturday (SCHEMA_DAY_LABELS)
  const hours = [...(p.hours || [])].sort((a, b) => a.day - b.day);
  return (
    <div dir="rtl" style={wrap}>
      <div style={{ ...card, background: `linear-gradient(135deg, #e9a24b, ${C.brand} 55%, #b8462f)`, color: "white" }}>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 24, margin: 0, lineHeight: 1.5 }}>{name}</h1>
        {rating && (
          <p style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 14 }}>
            <Star size={16} fill="white" /> {toFa(rating.avg)} از ۵ · {toFa(rating.count)} نظر
          </p>
        )}
        {p.about && <p style={{ fontSize: 14, lineHeight: 2, marginTop: 10, opacity: 0.95, whiteSpace: "pre-line" }}>{p.about}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <a href={`/${slug()}`} style={{ ...btn, background: "white", color: C.brand }}><CalendarPlus size={16} /> رزرو نوبت</a>
          {p.shop && <a href={`/${slug()}?tab=shop`} style={{ ...btn, background: "rgba(255,255,255,.18)", border: "1px solid rgba(255,255,255,.4)" }}><ShoppingBag size={16} /> فروشگاه</a>}
        </div>
      </div>

      {(p.address || p.phone || p.instagram || p.map_url) && (
        <div style={card}>
          {p.address && <p style={{ display: "flex", gap: 8, fontSize: 14, lineHeight: 1.9 }}><MapPin size={17} color={C.brand} style={{ flexShrink: 0, marginTop: 4 }} />{p.address}</p>}
          {p.phone && <p style={{ display: "flex", gap: 8, fontSize: 14, marginTop: 6 }}><Phone size={17} color={C.brand} /><a href={`tel:${p.phone}`} dir="ltr" style={{ color: C.text }}>{toFa(p.phone)}</a></p>}
          {p.instagram && <p style={{ display: "flex", gap: 8, fontSize: 14, marginTop: 6 }}><Instagram size={17} color={C.brand} /><a href={`https://instagram.com/${p.instagram}`} target="_blank" rel="noreferrer" dir="ltr" style={{ color: C.text }}>@{p.instagram}</a></p>}
          {p.map_url && <a href={p.map_url} target="_blank" rel="noreferrer" style={{ ...ghost, marginTop: 12 }}><MapPin size={16} /> مسیریابی روی نقشه</a>}
        </div>
      )}

      {hours.length > 0 && (
        <div style={card}>
          <p style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Clock size={17} color={C.brand} /> ساعات کاری</p>
          {hours.map((h) => (
            <div key={h.day} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: `1px dashed ${C.line}`, fontSize: 14 }}>
              <span>{DAYS[h.day]}</span>
              <span style={{ color: h.closed ? C.muted : C.text }}>{h.closed ? "تعطیل" : `${toFa(h.start)} تا ${toFa(h.end)}`}</span>
            </div>
          ))}
        </div>
      )}

      {(p.gallery || []).length > 0 && (
        <div style={card}>
          <p style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 10 }}>نمونه‌کارها</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {p.gallery.map((g) => (
              <button key={g} onClick={() => setZoom(g)} style={{ border: 0, padding: 0, background: "none", cursor: "zoom-in" }} aria-label="بزرگ‌نمایی">
                <img src={galleryUrl(g)} alt="" loading="lazy" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 10 }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {(p.reviews || []).length > 0 && (
        <div style={card}>
          <p style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 6 }}>نظر مشتری‌ها</p>
          {p.reviews.map((r, i) => (
            <div key={i} style={{ padding: "10px 0", borderTop: `1px dashed ${C.line}` }}>
              <p style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <b>{r.name}</b>
                <span style={{ color: "#e2a01f" }}>{"★".repeat(r.rating)}</span>
              </p>
              <p style={{ fontSize: 14, lineHeight: 1.9, marginTop: 4 }}>{r.comment}</p>
              <p style={{ fontSize: 11.5, color: C.muted }}>{isoToJalaliLabel(String(r.date).slice(0, 10))}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <a href={`/${slug()}/gift`} style={ghost}><Gift size={16} /> کارت هدیه بدهید</a>
      </div>

      {zoom && (
        <div role="dialog" aria-label="عکس" onClick={() => setZoom(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <img src={galleryUrl(zoom)} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- gift card ---- */
const AMOUNTS = [300000, 500000, 1000000, 2000000];
export function GiftCardPage() {
  const [terms, setTerms] = useState(null);
  const [f, setF] = useState({ amount: 500000, custom: "", buyerName: "", buyerPhone: "", recipientName: "", recipientPhone: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [code, setCode] = useState("");
  const [bal, setBal] = useState(null);
  useEffect(() => { fetchDepositTerms().then((t) => setTerms(t || {})); setMeta(`کارت هدیهٔ ${getSalonName()}`, `کارت هدیهٔ ${getSalonName()} — هدیه‌ای برای عزیزانتان`); }, []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const amount = f.custom ? Number(f.custom) : f.amount;
  const ok = amount >= 50000 && /^09\d{9}$/.test(f.buyerPhone) && /^09\d{9}$/.test(f.recipientPhone);
  async function pay() {
    setBusy(true); setErr("");
    const r = await buyGiftCardOnline({ ...f, amount });
    if (!r?.ok) { setBusy(false); setErr(r?.error || "ثبت ناموفق بود"); return; }
    const p = await startPurchasePayment("gift", r.id);
    if (p?.ok && p.url) { window.location.assign(p.url); return; }
    setBusy(false); setErr(p?.error || "اتصال به درگاه پرداخت ناموفق بود");
  }
  const input = { width: "100%", padding: "11px 12px", fontSize: 15, marginTop: 4, borderRadius: 12, border: `1.5px solid ${C.line}`, fontFamily: FONT, boxSizing: "border-box" };
  const label = { fontSize: 12.5, color: C.muted, display: "block", marginTop: 10 };
  return (
    <div dir="rtl" style={wrap}>
      <div style={{ ...card, background: `linear-gradient(135deg, #e9a24b, ${C.brand} 55%, #b8462f)`, color: "white", textAlign: "center" }}>
        <Gift size={34} style={{ margin: "0 auto" }} />
        <h1 style={{ fontFamily: DISPLAY, fontSize: 22, margin: "8px 0 0" }}>کارت هدیهٔ {getSalonName()}</h1>
        <p style={{ fontSize: 13.5, opacity: 0.92, marginTop: 6 }}>کد کارت برای گیرنده پیامک می‌شود و تا یک سال اعتبار دارد.</p>
      </div>
      <div style={card}>
        {!terms ? <Loader2 size={18} color={C.brand} /> : !terms.online ? (
          <p style={{ fontSize: 14, lineHeight: 1.9 }}>خرید آنلاین کارت هدیه در این سالن فعال نیست — کارت هدیه را می‌توانید حضوری در سالن بخرید.</p>
        ) : (
          <>
            <p style={{ fontWeight: 800, fontSize: 14 }}>مبلغ</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              {AMOUNTS.map((a) => (
                <button key={a} onClick={() => setF((x) => ({ ...x, amount: a, custom: "" }))}
                  style={{ padding: 12, borderRadius: 12, fontFamily: FONT, fontWeight: 700, fontSize: 14, cursor: "pointer",
                    border: `1.5px solid ${!f.custom && f.amount === a ? C.brand : C.line}`, background: !f.custom && f.amount === a ? "#fbeee0" : "white", color: C.text }}>
                  {formatToman(a)}
                </button>
              ))}
            </div>
            <label style={label}>مبلغ دلخواه (تومان)
              <input dir="ltr" inputMode="numeric" value={f.custom ? toFa(Number(f.custom).toLocaleString("en-US")) : ""} onChange={(e) => set("custom")(digitsOnly(e.target.value, 9))} style={{ ...input, textAlign: "left" }} />
            </label>
            <label style={label}>نام گیرنده<input value={f.recipientName} maxLength={80} onChange={(e) => set("recipientName")(e.target.value)} style={input} /></label>
            <label style={label}>موبایل گیرنده (کد به این شماره پیامک می‌شود)
              <input dir="ltr" type="tel" inputMode="tel" value={f.recipientPhone} placeholder="09xxxxxxxxx" onChange={(e) => set("recipientPhone")(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
            </label>
            <label style={label}>پیام شما (اختیاری)<input value={f.message} maxLength={200} placeholder="تولدت مبارک!" onChange={(e) => set("message")(e.target.value)} style={input} /></label>
            <label style={label}>نام شما<input value={f.buyerName} maxLength={80} onChange={(e) => set("buyerName")(e.target.value)} style={input} /></label>
            <label style={label}>موبایل شما
              <input dir="ltr" type="tel" inputMode="tel" value={f.buyerPhone} placeholder="09xxxxxxxxx" onChange={(e) => set("buyerPhone")(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
            </label>
            {err && <p role="alert" style={{ color: "#b4483a", fontSize: 13, marginTop: 10 }}>{err}</p>}
            <button disabled={!ok || busy} onClick={pay} style={{ ...btn, marginTop: 16, opacity: !ok || busy ? 0.5 : 1 }}>
              {busy ? <Loader2 size={16} /> : <CreditCard size={16} />} پرداخت {formatToman(amount || 0)}
            </button>
          </>
        )}
      </div>
      <div style={card}>
        <p style={{ fontWeight: 800, fontSize: 14 }}>مانده کارت هدیه</p>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="GXXXXXXXX" aria-label="کد کارت هدیه" style={{ ...input, marginTop: 0, textAlign: "left" }} />
          <button onClick={async () => setBal(await giftCardBalance(code))} style={{ ...ghost, width: "auto", padding: "0 16px" }}>استعلام</button>
        </div>
        {bal && (
          <p style={{ marginTop: 8, fontSize: 14, color: bal.ok ? "#2f8f6b" : "#b4483a", display: "flex", alignItems: "center", gap: 6 }}>
            {bal.ok && <CheckCircle2 size={16} />}{bal.ok ? `مانده: ${formatToman(bal.balance)} — تا ${isoToJalaliLabel(bal.expires_at)}` : bal.error}
          </p>
        )}
      </div>
      <div style={{ maxWidth: 520, margin: "0 auto" }}><a href={`/${slug()}`} style={ghost}><CalendarPlus size={16} /> رزرو نوبت</a></div>
    </div>
  );
}

/* ---------------------------------------------- v2.53 events (request) ---- */
export function EventRequestPage() {
  const [f, setF] = useState({ kind: "bride", date: "", guests: "1", name: "", phone: "", services: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { setMeta(`رزرو مراسم در ${getSalonName()}`, `میکاپ و آرایش عروس، نامزدی و مهمانی در ${getSalonName()} — درخواست بدهید، پیش‌فاکتور می‌گیرید.`); }, []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const minDate = (() => { const d = new Date(Date.now() + 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const ok = f.name.trim() && /^09\d{9}$/.test(f.phone) && f.date >= minDate;
  async function send() {
    setBusy(true); setErr("");
    const r = await createEventRequest(f);
    setBusy(false);
    if (!r?.ok) { setErr(r?.error || "ثبت ناموفق بود"); return; }
    setDone(true);
  }
  const input = { width: "100%", padding: "11px 12px", fontSize: 15, marginTop: 4, borderRadius: 12, border: `1.5px solid ${C.line}`, fontFamily: FONT, boxSizing: "border-box", background: "white" };
  const label = { fontSize: 12.5, color: C.muted, display: "block", marginTop: 10 };
  return (
    <div dir="rtl" style={wrap}>
      <div style={{ ...card, background: `linear-gradient(135deg, #e9a24b, ${C.brand} 55%, #b8462f)`, color: "white", textAlign: "center" }}>
        <Sparkles size={32} style={{ margin: "0 auto" }} />
        <h1 style={{ fontFamily: DISPLAY, fontSize: 22, margin: "8px 0 0" }}>رزرو مراسم در {getSalonName()}</h1>
        <p style={{ fontSize: 13.5, opacity: 0.92, marginTop: 6, lineHeight: 1.9 }}>عروس، داماد، نامزدی و مهمانی — درخواست بدهید، پیش‌فاکتور و شرایط را پیامک می‌گیرید.</p>
      </div>
      <div style={card}>
        {done ? (
          <div style={{ textAlign: "center" }}>
            <CheckCircle2 size={36} color="#3a8f5c" style={{ margin: "0 auto 8px" }} />
            <p style={{ fontWeight: 800, fontSize: 16 }}>درخواست شما ثبت شد</p>
            <p style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.9, marginTop: 6 }}>سالن به‌زودی پیش‌فاکتور و شرایط را برایتان پیامک می‌کند. با تایید و پرداخت بیعانه، تاریخ برایتان رزرو می‌شود.</p>
            <a href={`/${slug()}`} style={{ ...ghost, marginTop: 14 }}><CalendarPlus size={16} /> بازگشت به صفحهٔ سالن</a>
          </div>
        ) : (
          <>
            <label style={{ ...label, marginTop: 0 }}>نوع مراسم
              <select value={f.kind} onChange={(e) => set("kind")(e.target.value)} style={input}>
                {EVENT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ ...label, flex: 2 }}>تاریخ مراسم
                <input type="date" dir="ltr" min={minDate} value={f.date} onChange={(e) => set("date")(e.target.value)} style={input} />
              </label>
              <label style={{ ...label, flex: 1 }}>تعداد نفرات
                <input inputMode="numeric" dir="ltr" value={toFa(f.guests)} onChange={(e) => set("guests")(digitsOnly(e.target.value, 2) || "1")} style={input} />
              </label>
            </div>
            <label style={label}>نام
              <input value={f.name} maxLength={80} onChange={(e) => set("name")(e.target.value)} style={input} />
            </label>
            <label style={label}>موبایل
              <input dir="ltr" type="tel" inputMode="tel" value={f.phone} onChange={(e) => set("phone")(normalizeMobile(e.target.value))} placeholder="09xxxxxxxxx" style={input} />
            </label>
            <label style={label}>خدمات مورد نظر (اختیاری)
              <input value={f.services} maxLength={400} placeholder="مثلاً میکاپ و شینیون عروس + ۲ همراه" onChange={(e) => set("services")(e.target.value)} style={input} />
            </label>
            <label style={label}>توضیحات (اختیاری)
              <textarea rows={2} maxLength={600} value={f.note} placeholder="ساعت آماده بودن، آتلیه، …" onChange={(e) => set("note")(e.target.value)} style={{ ...input, resize: "vertical" }} />
            </label>
            {err && <p role="alert" style={{ color: "#b4483a", fontSize: 13, marginTop: 8 }}>{err}</p>}
            <button disabled={!ok || busy} onClick={send} style={{ ...btn, marginTop: 14, opacity: !ok || busy ? 0.6 : 1 }}>
              {busy && <Loader2 size={16} />} ارسال درخواست
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------- v2.53 events (quote) ---- */
export function EventQuotePage({ token }) {
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [agree, setAgree] = useState(false);
  useEffect(() => { getEventQuote(token).then((r) => setQ(r?.ok ? r : { invalid: true })); }, [token]);
  if (!q) return <div dir="rtl" style={{ ...wrap, display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 size={24} color={C.brand} /></div>;
  if (q.invalid) return <div dir="rtl" style={wrap}><div style={{ ...card, textAlign: "center" }}>این پیش‌فاکتور پیدا نشد یا دیگر معتبر نیست.</div></div>;
  const left = Math.max(0, (q.quote_total || 0) - (q.paid || 0));
  const depositLeft = Math.max(0, (q.deposit_amount || 0) - (q.paid || 0));
  async function accept() {
    setBusy(true); setErr("");
    const r = await acceptEventQuote(token);
    if (!r?.ok) { setBusy(false); setErr(r?.error || "تایید ناموفق بود"); return; }
    if (depositLeft > 0 && q.online) {
      const p = await startEventPayment(token);
      if (p?.ok && p.url) { window.location.assign(p.url); return; }
      setErr(p?.error || "اتصال به درگاه پرداخت ناموفق بود");
    }
    setBusy(false);
    setQ((x) => ({ ...x, status: "accepted" }));
  }
  const row = (l, v, bold) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0", borderTop: `1px dashed ${C.line}`, fontSize: 14, fontWeight: bold ? 800 : 400 }}>
      <span>{l}</span><span>{v}</span>
    </div>
  );
  return (
    <div dir="rtl" style={wrap}>
      <div style={{ ...card, background: `linear-gradient(135deg, #e9a24b, ${C.brand} 55%, #b8462f)`, color: "white" }}>
        <p style={{ fontSize: 12.5, opacity: 0.9 }}>{q.salon_name}</p>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 21, margin: "4px 0 0" }}>پیش‌فاکتور {eventKindLabel(q.kind)} — {q.customer_name}</h1>
        <p style={{ fontSize: 13.5, opacity: 0.92, marginTop: 4 }}>{isoToJalaliLabel(String(q.event_date).slice(0, 10))} · {toFa(q.guests)} نفر</p>
      </div>
      <div style={card}>
        {q.services && <p style={{ fontSize: 14, lineHeight: 1.9, marginBottom: 6 }}>{q.services}</p>}
        {row("مبلغ کل", formatToman(q.quote_total || 0), true)}
        {q.deposit_amount > 0 && row("بیعانه برای قطعی شدن تاریخ", formatToman(q.deposit_amount))}
        {q.paid > 0 && row("پرداخت‌شده", formatToman(q.paid))}
        {q.paid > 0 && row("مانده", formatToman(left), true)}
        {q.quote_note && <p style={{ fontSize: 13.5, lineHeight: 1.9, marginTop: 10, background: "#faf6f1", borderRadius: 12, padding: "10px 12px" }}>{q.quote_note}</p>}
        {q.quote_terms && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontWeight: 800, fontSize: 14 }}>شرایط و قوانین</p>
            <p style={{ fontSize: 13, lineHeight: 2, color: C.muted, whiteSpace: "pre-wrap" }}>{q.quote_terms}</p>
          </div>
        )}
      </div>
      <div style={card}>
        {q.status === "accepted" && depositLeft === 0 ? (
          <p style={{ display: "flex", alignItems: "center", gap: 6, color: "#3a8f5c", fontWeight: 800, fontSize: 15 }}><CheckCircle2 size={18} /> تاریخ مراسم برای شما رزرو است</p>
        ) : q.status === "accepted" && !q.online ? (
          <p style={{ fontSize: 14, lineHeight: 1.9 }}>پیش‌فاکتور را تایید کردید. برای قطعی شدن تاریخ، بیعانه ({formatToman(depositLeft)}) را در سالن پرداخت کنید.</p>
        ) : (
          <>
            {q.quote_terms && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> شرایط را خواندم و می‌پذیرم
              </label>
            )}
            {err && <p role="alert" style={{ color: "#b4483a", fontSize: 13, marginBottom: 8 }}>{err}</p>}
            <button disabled={busy || (q.quote_terms && !agree)} onClick={accept} style={{ ...btn, opacity: busy || (q.quote_terms && !agree) ? 0.6 : 1 }}>
              {busy ? <Loader2 size={16} /> : <CreditCard size={16} />}
              {depositLeft > 0 && q.online ? `تایید و پرداخت بیعانه (${formatToman(depositLeft)})` : "تایید پیش‌فاکتور"}
            </button>
            {depositLeft > 0 && !q.online && <p style={{ color: C.muted, fontSize: 12.5, marginTop: 8 }}>بیعانه در سالن دریافت می‌شود.</p>}
          </>
        )}
      </div>
    </div>
  );
}
