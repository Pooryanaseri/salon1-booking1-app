import { useEffect, useRef, useState } from "react";
import { ArrowRight, Camera, Check, CheckCircle2, Loader2, MessageSquareText, Sparkles, X } from "lucide-react";
import { CATEGORY_LABEL, PET_SIZE_LABEL, SERVICE_ICONS, hasPrice } from "../app/shared";
import { formatToman, normalizeMobile, toFa } from "../lib/format";
import { MAX_QUOTE_PHOTOS, requestQuote, uploadQuotePhotos } from "../lib/api";

/* ============================================================
   v2.46 pet salons — price quotes. The customer tells the salon
   what the animal needs; a groomer looks at it and sends the
   price by SMS (and in "داشبورد من") with a link to pick a time.
   ============================================================ */

const TIME_CHIPS = ["صبح", "ظهر", "عصر", "آخر هفته", "هر زمان"];

/** Step 2 in quote mode: several services can be picked; prices are indicative. */
export function QuoteServicePicker({ services, section, pet, selected, onToggle, onContinue, onBack }) {
  return (
    <div className="fade-in">
      <button className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12.5, fontWeight: 700, color: section.color }} onClick={onBack}>
        <section.Icon size={14} /> {pet.name.trim()} · {section.label}، {PET_SIZE_LABEL[pet.size] || ""}
        <span className="muted" style={{ fontWeight: 400 }}>· ویرایش مشخصات</span>
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>چه خدماتی لازم دارد؟</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14, lineHeight: 1.8 }}>
        یک یا چند خدمت را انتخاب کنید. آرایشگر با توجه به وضعیت {pet.name.trim() || "حیوان"} و حجم کار، قیمت دقیق را پیامک می‌کند و بعد زمان را انتخاب می‌کنید.
      </p>
      <div className="flex flex-col gap-2">
        {services.map((s) => {
          const on = selected.includes(s.id);
          const Icon = SERVICE_ICONS[s.category] || Sparkles;
          return (
            <button key={s.id} type="button" aria-pressed={on} onClick={() => onToggle(s.id)} className="tap card"
              style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, textAlign: "right", borderColor: on ? section.color : "var(--color-border)" }}>
              <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: section.tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={19} color={section.color} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: "var(--color-heading)", fontSize: 14 }}>{s.name}</div>
                <div className="muted tabular" style={{ fontSize: 12, marginTop: 2 }}>
                  {CATEGORY_LABEL[s.category]} · حدود {toFa(s.duration_minutes)} دقیقه
                  {hasPrice(s) ? <> · قیمت تقریبی {formatToman(s.price)}</> : null}
                </div>
              </div>
              <span style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${on ? section.color : "var(--color-border)"}`, background: on ? section.color : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {on && <Check size={14} color="white" />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="sticky-cta mt-5">
        <button disabled={selected.length === 0} onClick={onContinue} className="tap accent-btn w-full" style={{ padding: 13 }}>
          {selected.length === 0 ? "حداقل یک خدمت انتخاب کنید" : `ادامه — درخواست قیمت (${toFa(selected.length)} خدمت)`}
        </button>
      </div>
    </div>
  );
}

/** Contact + note, then the request is sent. */
export function QuoteContactForm({ species, pet, services, onBack, onSent, section }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [times, setTimes] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // v2.47: photos of the animal (coat, mats, size) help the groomer price it
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
  const phoneValid = /^09\d{9}$/.test(phone);
  const label = services.map((s) => s.name).join(" + ");

  async function submit(e) {
    e.preventDefault();
    if (!phoneValid || sending) return;
    setSending(true); setError("");
    const res = await requestQuote({
      name: name.trim(), phone, species,
      pet: {
        name: pet.name.trim(), size: pet.size, breed: pet.breed.trim(), temperament: pet.temperament,
        weight_kg: pet.weight_kg || null, vaccine_valid_until: pet.vaccine_valid_until || null, notes: pet.notes.trim(),
      },
      serviceIds: services.map((s) => s.id), servicesLabel: label,
      note: note.trim(), preferredTime: times.join("، "),
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
  return (
    <div className="fade-in">
      <button className="muted flex items-center gap-1 mb-3" style={{ fontSize: 13 }} onClick={onBack}>
        <ArrowRight size={14} /> بازگشت
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>درخواست قیمت</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{pet.name.trim()} · {label}</p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="quote-phone" className="muted" style={{ fontSize: 12 }}>شماره موبایل (قیمت به این شماره پیامک می‌شود)</label>
          <input id="quote-phone" dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone} placeholder="09xxxxxxxxx" className="tabular"
            onChange={(e) => setPhone(normalizeMobile(e.target.value))} style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4, textAlign: "left" }} />
        </div>
        <div>
          <label htmlFor="quote-name" className="muted" style={{ fontSize: 12 }}>نام و نام‌خانوادگی (اگر قبلاً آمده‌اید، لازم نیست)</label>
          <input id="quote-name" autoComplete="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 }} />
        </div>
        <div>
          <label htmlFor="quote-note" className="muted" style={{ fontSize: 12 }}>توضیح برای آرایشگر</label>
          <textarea id="quote-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="مثلاً موهایش گره زیادی دارد، مدل خاصی می‌خواهم، بار اول است…" style={{ width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <span className="muted" style={{ fontSize: 12 }}>عکس {pet.name.trim() || "حیوان"} (اختیاری، تا {toFa(MAX_QUOTE_PHOTOS)} عکس)</span>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.8 }}>یک عکس از کل بدن و یکی از نزدیکِ موها کمک می‌کند آرایشگر قیمت دقیق‌تری بدهد.</p>
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
          <span className="muted" style={{ fontSize: 12 }}>چه زمانی برایتان بهتر است؟ (اختیاری)</span>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
            {TIME_CHIPS.map((t) => (
              <button key={t} type="button" aria-pressed={times.includes(t)} className="tap" style={chip(times.includes(t))}
                onClick={() => setTimes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}>{t}</button>
            ))}
          </div>
        </div>
        {error && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{error}</p>}
        <div className="sticky-cta">
          <button type="submit" disabled={!phoneValid || sending} className="tap accent-btn w-full flex items-center justify-center gap-1.5" style={{ padding: 13 }}>
            {sending && <Loader2 size={15} className="salon-spin" />}
            {sending ? (photos.length ? "در حال ارسال درخواست و عکس‌ها..." : "در حال ارسال...") : "ارسال درخواست قیمت"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function QuoteSent({ petName, onTrack, onNew, demo, photoNote }) {
  return (
    <div className="fade-in" style={{ textAlign: "center", paddingTop: 12 }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "color-mix(in oklch, var(--color-success) 18%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
        <CheckCircle2 size={30} color="var(--color-success)" />
      </div>
      <h2 style={{ fontSize: 18 }}>درخواست شما ثبت شد</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.9 }}>
        آرایشگر درخواست {petName} را بررسی می‌کند و قیمت را همراه لینک انتخاب زمان برایتان پیامک می‌کند.
        قیمت در «داشبورد من» هم نمایش داده می‌شود.
      </p>
      {photoNote && <p role="alert" style={{ fontSize: 12, marginTop: 6, color: "var(--color-warning)" }}>{photoNote} — درخواست بدون آن ثبت شد.</p>}
      {demo && <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>حالت نمایشی: درخواست در «پنل مدیریت ← استعلام قیمت» دیده می‌شود.</p>}
      <div className="flex gap-2 mt-5">
        {onTrack && (
          <button onClick={onTrack} className="tap ghost-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "11px 8px", fontSize: 13, fontWeight: 700 }}>
            <MessageSquareText size={15} /> داشبورد من
          </button>
        )}
        <button onClick={onNew} className="tap accent-btn flex-1" style={{ padding: "11px 8px", fontSize: 13, fontWeight: 700 }}>درخواست جدید</button>
      </div>
    </div>
  );
}
