import { useMemo, useState } from "react";
import { ArrowRight, Syringe, Weight, Info, Cake } from "lucide-react";
import { PET_TEMPERAMENTS, SECTION_META, normBreed, petSizes, sizeFromWeight } from "../app/shared";
import { MONTHS_FA, toFa, gregorianToJalali, jalaliToIso, isoToJalaliLabel } from "../lib/format";

/* ============================================================
   v2.44 pet salons — the animal being booked. Shown right after
   the customer picks dog / cat: its size decides the price and
   duration of every service on the next screen.
   Pets used on this device are remembered (localStorage) so a
   returning customer picks theirs with one tap.
   ============================================================ */

const BREEDS = {
  dog: ["پامرانین", "شیتزو", "یورکشایر تریر", "مالتیز", "پودل", "پاگ", "شیپ داگ", "گلدن رتریور", "لابرادور", "ژرمن شپرد", "هاسکی", "سامویید", "دوبرمن", "پیت بول", "مخلوط"],
  cat: ["خانگی (مخلوط)", "پرشین", "هیمالیا", "اسکاتیش فولد", "بریتیش شورت‌هیر", "سیامی", "مین‌کون", "اگزوتیک", "رگدال"],
};

const storageKey = (salonId) => `salon:pets:${salonId}`;
export function loadSavedPets(salonId) {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey(salonId)) || "[]");
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === "string" && p.species) : [];
  } catch {
    return [];
  }
}
export function rememberPet(salonId, pet) {
  try {
    const rest = loadSavedPets(salonId).filter((p) => !(p.species === pet.species && p.name.trim() === pet.name.trim()));
    localStorage.setItem(storageKey(salonId), JSON.stringify([pet, ...rest].slice(0, 6)));
  } catch { /* private mode — fine */ }
}

export const EMPTY_PET = { name: "", size: null, weight_kg: "", breed: "", temperament: "calm", vaccine_valid_until: "", notes: "", birth_date: "" };

/** True when the form has what the server requires. */
export function petReady(pet, requireVaccination) {
  return !!pet && pet.name.trim().length > 0 && pet.name.trim().length <= 40 && !!pet.size
    && (!requireVaccination || !!pet.vaccine_valid_until);
}

export function JalaliDateInput({ value, onChange, accent, pastYears = 0 }) {
  const now = new Date();
  const today = gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const parsed = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    return m ? gregorianToJalali(+m[1], +m[2], +m[3]) : null;
  }, [value]);
  const [jy, setJy] = useState(parsed?.jy || "");
  const [jm, setJm] = useState(parsed?.jm || "");
  const [jd, setJd] = useState(parsed?.jd || "");
  // pastYears: a date in the past (birthdays) — this year back to N years ago
  const years = pastYears ? Array.from({ length: pastYears + 1 }, (_, i) => today.jy - i) : [today.jy - 1, today.jy, today.jy + 1, today.jy + 2];

  function update(next) {
    const y = next.jy ?? jy, m = next.jm ?? jm, d = next.jd ?? jd;
    if ("jy" in next) setJy(y);
    if ("jm" in next) setJm(m);
    if ("jd" in next) setJd(d);
    onChange(jalaliToIso(Number(y), Number(m), Number(d)));
  }
  const sel = { padding: "10px 8px", fontSize: 13.5, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-body)" };
  return (
    <div className="flex gap-2" style={{ marginTop: 4 }}>
      <select aria-label="روز" value={jd} onChange={(e) => update({ jd: e.target.value })} style={{ ...sel, flex: 1 }}>
        <option value="">روز</option>
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{toFa(d)}</option>)}
      </select>
      <select aria-label="ماه" value={jm} onChange={(e) => update({ jm: e.target.value })} style={{ ...sel, flex: 2 }}>
        <option value="">ماه</option>
        {MONTHS_FA.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
      </select>
      <select aria-label="سال" value={jy} onChange={(e) => update({ jy: e.target.value })} style={{ ...sel, flex: 1.4, borderColor: value ? accent : "var(--color-border)" }}>
        <option value="">سال</option>
        {years.map((y) => <option key={y} value={y}>{toFa(y)}</option>)}
      </select>
    </div>
  );
}

export function PetForm({ species, pet, onChange, onContinue, onBack, requireVaccination, savedPets, sizeLimits, pricedBreeds = [], surchargePct = 0 }) {
  const meta = SECTION_META[species];
  const [sizeTouched, setSizeTouched] = useState(!!pet.size);
  const [pickedKey, setPickedKey] = useState(0); // remounts the date selects when a saved pet is picked
  const mine = savedPets.filter((p) => p.species === species);
  const allSizes = petSizes(sizeLimits);
  const sizes = species === "cat" ? allSizes.filter((s) => s.v !== "giant") : allSizes;
  const breedPriced = !!pet.breed.trim() && pricedBreeds.some((b) => normBreed(b) === normBreed(pet.breed));
  const set = (patch) => onChange({ ...pet, ...patch });
  const nameTooLong = pet.name.trim().length > 40;
  const ready = petReady(pet, requireVaccination) && !nameTooLong;
  const kind = species === "cat" ? "گربه" : "سگ";

  const input = { width: "100%", padding: "11px 14px", fontSize: 14, marginTop: 4 };
  const chip = (active) => ({
    padding: "8px 12px", borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
    border: `1px solid ${active ? meta.color : "var(--color-border)"}`,
    background: active ? meta.tint : "var(--color-surface)",
    color: active ? meta.color : "var(--color-body)",
  });

  return (
    <div className="fade-in">
      <button className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12.5, fontWeight: 700, color: meta.color }} onClick={onBack}>
        <meta.Icon size={14} /> {meta.label} <span className="muted" style={{ fontWeight: 400 }}>· تغییر</span>
      </button>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>مشخصات {kind} شما</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>قیمت و مدت هر خدمت به جثهٔ {kind} بستگی دارد</p>

      {mine.length > 0 && (
        <div className="mb-4">
          <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{kind}های قبلی شما روی این دستگاه</p>
          <div className="flex gap-2 flex-wrap">
            {mine.map((p) => (
              <button key={p.name} type="button" className="tap" style={chip(pet.name.trim() === p.name.trim())}
                onClick={() => { onChange({ ...EMPTY_PET, ...p }); setSizeTouched(true); setPickedKey((k) => k + 1); }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); if (ready) onContinue(); }} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="pet-name" className="muted" style={{ fontSize: 12 }}>نام {kind}</label>
          <input id="pet-name" autoComplete="off" value={pet.name} maxLength={40} onChange={(e) => set({ name: e.target.value })}
            placeholder={species === "cat" ? "مثلاً ملوس" : "مثلاً پاپی"} style={input} aria-invalid={nameTooLong} />
        </div>

        <div>
          <label htmlFor="pet-weight" className="muted flex items-center gap-1" style={{ fontSize: 12 }}><Weight size={12} /> وزن تقریبی (کیلوگرم، اختیاری)</label>
          <input id="pet-weight" dir="ltr" inputMode="decimal" className="tabular" value={pet.weight_kg}
            onChange={(e) => {
              const v = e.target.value.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^0-9.]/g, "").slice(0, 5);
              const suggested = sizeFromWeight(v, sizeLimits);
              set({ weight_kg: v, ...(!sizeTouched && suggested && sizes.some((s) => s.v === suggested) ? { size: suggested } : {}) });
            }}
            placeholder="مثلاً 12" style={{ ...input, textAlign: "left" }} />
        </div>

        <div>
          <span className="muted" style={{ fontSize: 12 }}>جثه</span>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${sizes.length}, 1fr)`, gap: 8, marginTop: 4 }}>
            {sizes.map((s) => (
              <button key={s.v} type="button" aria-pressed={pet.size === s.v} className="tap"
                onClick={() => { set({ size: s.v }); setSizeTouched(true); }}
                style={{ ...chip(pet.size === s.v), borderRadius: "var(--radius-md)", padding: "10px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <span>{s.label}</span>
                <span className="muted" style={{ fontSize: 10.5, fontWeight: 400 }}>{s.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="pet-breed" className="muted" style={{ fontSize: 12 }}>نژاد (اختیاری)</label>
          <input id="pet-breed" list={`breeds-${species}`} autoComplete="off" maxLength={40} value={pet.breed} onChange={(e) => set({ breed: e.target.value })}
            placeholder="انتخاب یا تایپ کنید" style={input} />
          <datalist id={`breeds-${species}`}>{[...new Set([...pricedBreeds, ...BREEDS[species]])].map((b) => <option key={b} value={b} />)}</datalist>
          {breedPriced && <p style={{ fontSize: 11.5, marginTop: 4, color: meta.color, fontWeight: 700 }}>این سالن برای این نژاد قیمت ویژه دارد</p>}
        </div>

        <div>
          <span className="muted" style={{ fontSize: 12 }}>رفتار هنگام آرایش</span>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
            {PET_TEMPERAMENTS.map((t) => (
              <button key={t.v} type="button" aria-pressed={pet.temperament === t.v} className="tap" style={chip(pet.temperament === t.v)} onClick={() => set({ temperament: t.v })}>
                {t.label}
              </button>
            ))}
          </div>
          {pet.temperament === "aggressive" && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.8 }}>
              به آرایشگر اطلاع داده می‌شود تا با احتیاط و آمادگی کار کند.
              {surchargePct > 0 && <> طبق تعرفهٔ سالن {toFa(surchargePct)}٪ به مبلغ اضافه می‌شود.</>}
            </p>
          )}
        </div>

        <div>
          <span className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
            <Syringe size={12} /> اعتبار واکسن تا تاریخ {requireVaccination ? "(الزامی)" : "(اختیاری)"}
          </span>
          <JalaliDateInput key={pickedKey} value={pet.vaccine_valid_until} onChange={(iso) => set({ vaccine_valid_until: iso })} accent={meta.color} />
          {pet.vaccine_valid_until && <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>معتبر تا {isoToJalaliLabel(pet.vaccine_valid_until)}</p>}
          {requireVaccination && (
            <p className="muted flex items-start gap-1" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.8 }}>
              <Info size={12} style={{ flexShrink: 0, marginTop: 3 }} /> این سالن فقط حیوانات با واکسن معتبر در روز نوبت را می‌پذیرد؛ کارت واکسن را همراه بیاورید.
            </p>
          )}
        </div>

        <div>
          <span className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
            <Cake size={12} /> تاریخ تولد (اختیاری — روز تولدش تبریک می‌گوییم 🎂)
          </span>
          <JalaliDateInput key={`b-${pickedKey}`} value={pet.birth_date || ""} onChange={(iso) => set({ birth_date: iso })} accent={meta.color} pastYears={25} />
        </div>

        <div>
          <label htmlFor="pet-notes" className="muted" style={{ fontSize: 12 }}>نکته برای آرایشگر (اختیاری)</label>
          <textarea id="pet-notes" rows={2} maxLength={300} value={pet.notes} onChange={(e) => set({ notes: e.target.value })}
            placeholder="مثلاً حساسیت پوستی، از سشوار می‌ترسد…" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>

        <div className="sticky-cta">
          <button type="submit" disabled={!ready} className="tap accent-btn w-full flex items-center justify-center gap-1.5" style={{ padding: "13px" }}>
            {ready ? <>ادامه — انتخاب خدمت <ArrowRight size={15} style={{ transform: "rotate(180deg)" }} /></> : !pet.name.trim() ? `نام ${kind} را وارد کنید` : !pet.size ? "جثه را انتخاب کنید" : "تاریخ اعتبار واکسن را وارد کنید"}
          </button>
        </div>
      </form>
    </div>
  );
}
