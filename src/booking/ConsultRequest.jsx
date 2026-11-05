import { useEffect, useRef, useState } from "react";
import { ArrowRight, Camera, Loader2, X } from "lucide-react";
import { normalizeMobile, toFa } from "../lib/format";
import { MAX_QUOTE_PHOTOS, uploadQuotePhotos } from "../lib/api";
import { CONSULT_FIELDS, CONSULT_QUESTIONS, EMPTY_CONSULT, consultMissing, consultPayload, requestConsultation } from "../lib/consult";

/* ============================================================
   v2.68 beauty salons — consultation and pricing. The customer
   describes their hair / skin and the result they want; a stylist
   or the manager looks at it and sends the price by SMS (and in
   «داشبورد من») with a link to pick a time — like the pet quote.
   ============================================================ */

const TIME_CHIPS = ["صبح", "ظهر", "عصر", "آخر هفته", "هر زمان"];

export function ConsultForm({ gender, section, services, onBack, onSent }) {
  const [d, setD] = useState(EMPTY_CONSULT);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [times, setTimes] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [photos, setPhotos] = useState([]); // [{file, url}]
  const fileRef = useRef(null);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  function addPhotos(fileList) {
    const picked = Array.from(fileList || []).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    setPhotos((cur) => [...cur, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_QUOTE_PHOTOS));
  }
  function removePhoto(i) {
    setPhotos((cur) => { URL.revokeObjectURL(cur[i].url); return cur.filter((_, j) => j !== i); });
  }
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const fields = CONSULT_FIELDS[gender] || CONSULT_FIELDS.female;
  const missing = consultMissing(gender, d);
  const phoneValid = /^09\d{9}$/.test(phone);
  const label = services.map((s) => s.name).join(" + ");
  const ready = phoneValid && !missing && !sending;

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setSending(true); setError("");
    const res = await requestConsultation({
      name: name.trim(), phone, gender, serviceIds: services.map((s) => s.id), servicesLabel: label,
      details: consultPayload(gender, d), note: note.trim(), preferredTime: times.join("، "),
    });
    if (!res?.ok) { setSending(false); setError(res?.error || "ثبت درخواست ناموفق بود"); return; }
    let photoNote = "";
    if (photos.length && res.id) {
      const up = await uploadQuotePhotos(res.id, photos.map((p) => p.file));
      if (up.failed) photoNote = up.uploaded ? `${toFa(up.failed)} عکس ارسال نشد` : "عکس‌ها ارسال نشدند";
    }
    setSending(false);
    onSent({ phone, photoNote });
  }

  const chip = (on) => ({
    padding: "7px 12px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
    border: `1px solid ${on ? section.color : "var(--color-border)"}`, background: on ? section.tint : "var(--color-surface)", color: on ? section.color : "var(--color-body)",
  });
  const input = { width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 };
  const cta = !phoneValid ? "شماره موبایل را وارد کنید" : missing ? `${missing} را انتخاب کنید` : "ارسال درخواست مشاوره";
  return (
    <div className="fade-in" data-step="consult-form">
      <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={onBack}>
        <ArrowRight size={14} /> بازگشت
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>مشاوره و تعیین قیمت</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{section.label} · {label}</p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {fields.ask.map((key) => {
          const q = CONSULT_QUESTIONS[key];
          const required = fields.required.includes(key);
          return (
            <div key={key}>
              <span id={`consult-${key}`} className="muted" style={{ fontSize: 12 }}>{q.label}{required ? "" : " (اختیاری)"}</span>
              <div className="flex gap-2 flex-wrap" style={{ marginTop: 6 }} role="radiogroup" aria-labelledby={`consult-${key}`} data-question={key}>
                {q.options.map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={d[key] === v} className="tap" style={chip(d[key] === v)}
                    onClick={() => set({ [key]: d[key] === v && !required ? "" : v })}>{l}</button>
                ))}
              </div>
            </div>
          );
        })}
        <div>
          <label htmlFor="consult-treatments" className="muted" style={{ fontSize: 12 }}>خدمات شیمیایی قبلی (اختیاری)</label>
          <input id="consult-treatments" maxLength={120} value={d.treatments} onChange={(e) => set({ treatments: e.target.value })}
            placeholder="مثلاً کراتین ۲ ماه پیش، حنا، احیا…" style={input} />
        </div>
        <div>
          <label htmlFor="consult-allergy" className="muted" style={{ fontSize: 12 }}>حساسیت یا حساسیت پوستی (اختیاری)</label>
          <input id="consult-allergy" maxLength={150} value={d.allergy} onChange={(e) => set({ allergy: e.target.value })}
            placeholder="مثلاً به آمونیاک، پوست سر حساس" style={input} />
        </div>
        <div>
          <label htmlFor="consult-goal" className="muted" style={{ fontSize: 12 }}>چه نتیجه‌ای می‌خواهید؟</label>
          <textarea id="consult-goal" rows={2} maxLength={300} value={d.goal} onChange={(e) => set({ goal: e.target.value })}
            placeholder={gender === "male" ? "مثلاً فید کوتاه کنار، رنگ ریش…" : "مثلاً بالیاژ عسلی روی موی تیره، لایت روشن…"}
            style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <span className="muted" style={{ fontSize: 12 }}>عکس (اختیاری، تا {toFa(MAX_QUOTE_PHOTOS)} عکس)</span>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.8 }}>یک عکس از وضعیت فعلی و یک عکس نمونه از مدل دلخواه کمک می‌کند قیمت دقیق‌تر باشد.</p>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 6 }}>
            {photos.map((p, i) => (
              <div key={p.url} style={{ position: "relative", width: 72, height: 72 }}>
                <img src={p.url} alt={`عکس ${toFa(i + 1)}`} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }} />
                <button type="button" onClick={() => removePhoto(i)} aria-label={`حذف عکس ${toFa(i + 1)}`} className="tap"
                  style={{ position: "absolute", top: -6, left: -6, width: 22, height: 22, borderRadius: "50%", background: "var(--color-danger)", color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <X size={12} />
                </button>
              </div>
            ))}
            {photos.length < MAX_QUOTE_PHOTOS && (
              <button type="button" className="tap" onClick={() => fileRef.current?.click()}
                style={{ width: 72, height: 72, borderRadius: "var(--radius-md)", border: `1px dashed ${section.color}`, color: section.color, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, fontSize: 11, fontWeight: 700 }}>
                <Camera size={20} /> افزودن عکس
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="انتخاب عکس"
            onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
        </div>
        <div>
          <label htmlFor="consult-note" className="muted" style={{ fontSize: 12 }}>توضیح بیشتر (اختیاری)</label>
          <textarea id="consult-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
            style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <span className="muted" style={{ fontSize: 12 }}>چه زمانی برایتان بهتر است؟ (اختیاری)</span>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
            {TIME_CHIPS.map((t) => (
              <button key={t} type="button" aria-pressed={times.includes(t)} className="tap" style={chip(times.includes(t))}
                onClick={() => setTimes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}>{t}</button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="consult-phone" className="muted" style={{ fontSize: 12 }}>شماره موبایل (قیمت به این شماره پیامک می‌شود)</label>
          <input id="consult-phone" dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone} placeholder="09xxxxxxxxx" className="tabular"
            onChange={(e) => setPhone(normalizeMobile(e.target.value))} style={{ ...input, textAlign: "left" }} />
        </div>
        <div>
          <label htmlFor="consult-name" className="muted" style={{ fontSize: 12 }}>نام و نام‌خانوادگی (اگر قبلاً آمده‌اید، لازم نیست)</label>
          <input id="consult-name" autoComplete="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={input} />
        </div>
        {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{error}</p>}
        <div className="sticky-cta">
          <button type="submit" disabled={!ready} className="tap accent-btn w-full flex items-center justify-center gap-1.5" style={{ padding: 13 }}>
            {sending && <Loader2 size={15} className="salon-spin" />}
            {sending ? (photos.length ? "در حال ارسال درخواست و عکس‌ها..." : "در حال ارسال...") : cta}
          </button>
        </div>
      </form>
    </div>
  );
}
