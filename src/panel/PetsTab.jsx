import { useEffect, useMemo, useRef, useState } from "react";
import { PawPrint, Search, Syringe, AlertTriangle, Pencil, Minus, Plus, Camera, Cake, ShieldCheck, Loader2 } from "lucide-react";
import { toFa, jalaliLabel, parseDateKey, isoToJalaliLabel, formatToman } from "../lib/format";
import { updatePet } from "../lib/api";
import { GenderBadge, Modal, PanelSectionHeader, Row } from "../components/ui";
import { PET_SIZES, PET_SIZE_LABEL, PET_TEMPERAMENTS, PET_TEMPERAMENT_LABEL, STATUS_META, extraChargesTotal } from "../app/shared";
import { JalaliDateInput } from "../booking/PetForm";
import { PackagesSection } from "./PetCare";
import { fetchPetReports, petPhotoUrl, uploadPetPhoto, HEALTH_CHECKS, BEHAVIOR_LABEL } from "../lib/petcare";
import { fetchPetWeights } from "../lib/business";

/* ============================================================
   v2.44 pet salons — the animals the salon grooms. Profiles are
   created by bookings; here staff see each pet's history and
   keep its details and grooming notes up to date.
   ============================================================ */

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 'valid' | 'soon' (within 30 days) | 'expired' | 'unknown' */
export function vaccineStatus(iso, now = todayIso()) {
  if (!iso) return "unknown";
  if (iso < now) return "expired";
  const [y, m, d] = now.split("-").map(Number);
  const soon = new Date(y, m - 1, d + 30);
  const soonIso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  return iso <= soonIso ? "soon" : "valid";
}
const VACCINE_META = {
  valid: { label: "واکسن معتبر", color: "var(--color-success)" },
  soon: { label: "واکسن نزدیک انقضا", color: "var(--color-warning)" },
  expired: { label: "واکسن منقضی", color: "var(--color-danger)" },
  unknown: { label: "واکسن نامشخص", color: "var(--color-muted)" },
};

/** Bookings of this pet: by id, or (older rows / demo) by owner + name. */
export function bookingsOfPet(pet, bookings) {
  return bookings.filter((b) => (pet.id && b.pet_id === pet.id)
    || (!b.pet_id && b.customer_phone === pet.owner_phone && b.customer_gender === pet.species && (b.pet_name || "").trim() === pet.name.trim()));
}

/** Demo mode has no pets table — build profiles from the bookings. */
export function derivePetsFromBookings(bookings) {
  const map = new Map();
  for (const b of bookings) {
    if (!b.pet_name) continue;
    const key = `${b.customer_phone}|${b.customer_gender}|${b.pet_name.trim()}`;
    if (!map.has(key)) {
      map.set(key, {
        id: null, owner_phone: b.customer_phone, name: b.pet_name.trim(), species: b.customer_gender,
        breed: "", size: b.pet_size || "medium", weight_kg: null, temperament: "calm",
        vaccine_valid_until: null, owner_notes: "", grooming_notes: "", last_visit_date: null,
      });
    }
  }
  return [...map.values()];
}

export function TemperamentBadge({ temperament }) {
  if (!temperament || temperament === "calm") return null;
  const danger = temperament === "aggressive";
  const color = danger ? "var(--color-danger)" : "var(--color-warning)";
  return (
    <span className="badge" style={{ background: `color-mix(in oklch, ${color} 15%, transparent)`, color }}>
      <AlertTriangle size={11} /> {PET_TEMPERAMENT_LABEL[temperament]}
    </span>
  );
}

/** v2.51 — weight over time (simple SVG line, newest on the left in RTL reading). */
function WeightChart({ weights }) {
  const w = 280, h = 90, pad = 14;
  const kgs = weights.map((x) => x.kg);
  const min = Math.min(...kgs), max = Math.max(...kgs), span = max - min || 1;
  const pts = weights.map((x, i) => [pad + (i * (w - pad * 2)) / (weights.length - 1), h - pad - ((x.kg - min) * (h - pad * 2)) / span]);
  const last = weights[weights.length - 1], first = weights[0];
  const diff = Math.round((last.kg - first.kg) * 10) / 10;
  return (
    <div style={{ marginTop: 10 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        نمودار وزن — الان {toFa(last.kg)} کیلو
        {diff !== 0 && <span style={{ color: Math.abs(diff) >= first.kg * 0.1 ? "var(--color-warning)" : "var(--color-muted)" }}> ({diff > 0 ? "+" : ""}{toFa(diff)} از اولین ثبت)</span>}
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="نمودار وزن" style={{ direction: "ltr" }}>
        <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--color-pet-500)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill="var(--color-pet-500)"><title>{`${weights[i].date}: ${weights[i].kg} kg`}</title></circle>)}
      </svg>
    </div>
  );
}

export function PetProfileModal({ pet, bookings, services, ownerName, onClose, onSaved, notify }) {
  const [draft, setDraft] = useState({
    breed: pet.breed || "", size: pet.size, weight_kg: pet.weight_kg ?? "", temperament: pet.temperament,
    vaccine_valid_until: pet.vaccine_valid_until || "", owner_notes: pet.owner_notes || "", grooming_notes: pet.grooming_notes || "",
    birth_date: pet.birth_date || "", groom_every_days: pet.groom_every_days ?? "", vaccine_card_path: pet.vaccine_card_path || "",
    allergies: pet.allergies || "", medications: pet.medications || "", vet_name: pet.vet_name || "", vet_phone: pet.vet_phone || "",
  });
  const [weights, setWeights] = useState([]); // v2.51
  useEffect(() => { fetchPetWeights(pet.id).then(setWeights); }, [pet.id]);
  // v2.49: visit reports (photos + health checklist) of this pet
  const [reports, setReports] = useState([]);
  const [cardBusy, setCardBusy] = useState(false);
  const cardRef = useRef(null);
  useEffect(() => {
    let alive = true;
    fetchPetReports(pet.id, bookingsOfPet(pet, bookings).map((b) => b.id)).then((r) => { if (alive) setReports(r); });
    return () => { alive = false; };
  }, [pet, bookings]);
  async function pickCard(file) {
    if (!file) return;
    setCardBusy(true);
    const res = await uploadPetPhoto(pet.id, "vaccine", file);
    setCardBusy(false);
    if (!res.ok) { notify(res.error); return; }
    setDraft((d) => ({ ...d, vaccine_card_path: res.path }));
  }
  const [saving, setSaving] = useState(false);
  const history = bookingsOfPet(pet, bookings).sort((a, b) => (a.date === b.date ? b.start_min - a.start_min : parseDateKey(b.date) - parseDateKey(a.date)));
  const sizes = pet.species === "cat" ? PET_SIZES.filter((s) => s.v !== "giant") : PET_SIZES;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const vs = vaccineStatus(draft.vaccine_valid_until || null);

  async function save() {
    if (!pet.id) { notify("در حالت نمایشی پروفایل ذخیره نمی‌شود"); onClose(); return; }
    setSaving(true);
    const weight = draft.weight_kg === "" ? null : Number(draft.weight_kg);
    const patch = {
      breed: draft.breed.trim().slice(0, 40), size: draft.size,
      weight_kg: Number.isFinite(weight) && weight > 0 && weight <= 150 ? weight : null,
      temperament: draft.temperament, vaccine_valid_until: draft.vaccine_valid_until || null,
      owner_notes: draft.owner_notes.slice(0, 300), grooming_notes: draft.grooming_notes.slice(0, 1000),
      birth_date: draft.birth_date || null,
      groom_every_days: draft.groom_every_days === "" ? null : Math.min(365, Math.max(7, Number(draft.groom_every_days) || 42)),
      vaccine_card_path: draft.vaccine_card_path || null,
      allergies: draft.allergies.trim().slice(0, 300), medications: draft.medications.trim().slice(0, 300),
      vet_name: draft.vet_name.trim().slice(0, 80), vet_phone: draft.vet_phone.trim().slice(0, 20),
    };
    const res = await updatePet(pet.id, patch);
    setSaving(false);
    if (!res.ok) { notify(res.error); return; }
    onSaved({ ...pet, ...patch });
    notify(`پروفایل ${pet.name} ذخیره شد`);
    onClose();
  }

  const input = { width: "100%", padding: "9px 12px", fontSize: 13.5, marginTop: 4 };
  const chip = (active) => ({
    padding: "7px 11px", borderRadius: "var(--radius-full)", fontSize: 12, fontWeight: 700,
    border: `1px solid ${active ? "var(--color-accent-500)" : "var(--color-border)"}`,
    background: active ? "var(--color-accent-100)" : "var(--color-surface)",
    color: active ? "var(--color-accent-700)" : "var(--color-body)",
  });

  return (
    <Modal title={`پروفایل ${pet.name}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="card" style={{ padding: 12 }}>
          <Row label="نوع" value={<GenderBadge gender={pet.species} />} />
          <Row label="صاحب" value={<span>{ownerName || "—"} · <span dir="ltr" className="tabular">{toFa(pet.owner_phone)}</span></span>} />
          <Row label="تعداد مراجعه" value={toFa(history.filter((b) => b.status === "completed").length)} />
          {pet.last_visit_date && <Row label="آخرین مراجعه" value={isoToJalaliLabel(pet.last_visit_date)} />}
        </div>

        <div>
          <span className="muted" style={{ fontSize: 12 }}>جثه</span>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
            {sizes.map((s) => <button key={s.v} type="button" className="tap" style={chip(draft.size === s.v)} onClick={() => set({ size: s.v })}>{s.label}</button>)}
          </div>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 2 }}>
            <label htmlFor="pp-breed" className="muted" style={{ fontSize: 12 }}>نژاد</label>
            <input id="pp-breed" maxLength={40} value={draft.breed} onChange={(e) => set({ breed: e.target.value })} style={input} />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="pp-weight" className="muted" style={{ fontSize: 12 }}>وزن (کیلو)</label>
            <input id="pp-weight" type="number" min={0} max={150} step={0.5} value={draft.weight_kg} onChange={(e) => set({ weight_kg: e.target.value })} className="tabular" style={input} />
          </div>
        </div>
        <div>
          <span className="muted" style={{ fontSize: 12 }}>رفتار</span>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 4 }}>
            {PET_TEMPERAMENTS.map((t) => <button key={t.v} type="button" className="tap" style={chip(draft.temperament === t.v)} onClick={() => set({ temperament: t.v })}>{t.label}</button>)}
          </div>
        </div>
        <div>
          <span className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
            <Syringe size={12} /> اعتبار واکسن تا
            <span style={{ color: VACCINE_META[vs].color, fontWeight: 700, marginRight: 6 }}>{VACCINE_META[vs].label}</span>
          </span>
          <JalaliDateInput value={draft.vaccine_valid_until} onChange={(iso) => set({ vaccine_valid_until: iso })} accent="var(--color-accent-500)" />
          <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
            {draft.vaccine_card_path && petPhotoUrl(draft.vaccine_card_path) && (
              <a href={petPhotoUrl(draft.vaccine_card_path)} target="_blank" rel="noreferrer">
                <img src={petPhotoUrl(draft.vaccine_card_path)} alt="کارت واکسن" style={{ width: 54, height: 54, objectFit: "cover", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }} />
              </a>
            )}
            <button type="button" className="tap ghost-btn flex items-center gap-1" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => cardRef.current?.click()} disabled={cardBusy}>
              {cardBusy ? <Loader2 size={13} className="salon-spin" /> : <Camera size={13} />} {draft.vaccine_card_path ? "عکس جدید کارت واکسن" : "عکس کارت واکسن"}
            </button>
            <input ref={cardRef} type="file" accept="image/*" hidden aria-label="انتخاب عکس کارت واکسن" onChange={(e) => { pickCard(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 1 }}>
            <span className="muted flex items-center gap-1" style={{ fontSize: 12 }}><Cake size={12} /> تاریخ تولد</span>
            <JalaliDateInput value={draft.birth_date} onChange={(iso) => set({ birth_date: iso })} accent="var(--color-accent-500)" pastYears={25} />
          </div>
        </div>
        <div>
          <label htmlFor="pp-cycle" className="muted" style={{ fontSize: 12 }}>هر چند روز یک‌بار آرایش؟ (خالی = پیش‌فرض سالن؛ برای یادآوری)</label>
          <input id="pp-cycle" type="number" min={7} max={365} value={draft.groom_every_days} onChange={(e) => set({ groom_every_days: e.target.value })} className="tabular" style={input} />
        </div>
        <div className="card" style={{ padding: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>پروندهٔ سلامت</p>
          <label className="muted" style={{ fontSize: 12 }}>حساسیت‌ها
            <input value={draft.allergies} maxLength={300} placeholder="مثلاً شامپوی عطردار" onChange={(e) => set({ allergies: e.target.value })} style={input} />
          </label>
          <label className="muted" style={{ fontSize: 12, display: "block", marginTop: 8 }}>داروها
            <input value={draft.medications} maxLength={300} onChange={(e) => set({ medications: e.target.value })} style={input} />
          </label>
          <div className="flex gap-2" style={{ marginTop: 8 }}>
            <label className="muted" style={{ fontSize: 12, flex: 1 }}>دامپزشک<input value={draft.vet_name} maxLength={80} onChange={(e) => set({ vet_name: e.target.value })} style={input} /></label>
            <label className="muted" style={{ fontSize: 12, flex: 1 }}>تلفن دامپزشک<input dir="ltr" value={draft.vet_phone} maxLength={20} onChange={(e) => set({ vet_phone: e.target.value })} style={{ ...input, textAlign: "left" }} /></label>
          </div>
          {weights.length > 1 && <WeightChart weights={weights} />}
          {weights.length === 1 && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>وزن ثبت‌شده: {toFa(weights[0].kg)} کیلو</p>}
        </div>
        {pet.consent_at && (
          <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "var(--color-success)" }}>
            <ShieldCheck size={14} /> رضایت‌نامه در {isoToJalaliLabel(String(pet.consent_at).slice(0, 10))} پذیرفته شد
          </p>
        )}
        <div>
          <label htmlFor="pp-owner" className="muted" style={{ fontSize: 12 }}>توضیحات صاحب حیوان</label>
          <textarea id="pp-owner" rows={2} maxLength={300} value={draft.owner_notes} onChange={(e) => set({ owner_notes: e.target.value })} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <label htmlFor="pp-groom" className="muted" style={{ fontSize: 12 }}>یادداشت آرایشگر (فقط برای کارکنان)</label>
          <textarea id="pp-groom" rows={3} maxLength={1000} value={draft.grooming_notes} onChange={(e) => set({ grooming_notes: e.target.value })}
            placeholder="مثلاً تیغ ۷ میلی‌متری، روی گوش‌ها حساس است، با شامپوی ضدحساسیت" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>

        {reports.length > 0 && (
          <div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>گزارش‌ها و عکس‌ها</p>
            <div className="flex flex-col gap-2">
              {reports.slice(0, 10).map((r) => {
                const found = HEALTH_CHECKS.filter((h) => r.checks?.[h.id]).map((h) => h.label);
                const photos = r.demoBefore ? [...r.demoBefore, ...(r.demoAfter || [])] : (r.photos || []);
                const b = bookings.find((x) => x.id === r.appointment_id);
                return (
                  <div key={r.appointment_id} className="card" style={{ padding: 10 }}>
                    <p style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {b ? jalaliLabel(parseDateKey(b.date), { short: true }) : isoToJalaliLabel(String(r.created_at).slice(0, 10))}
                      {r.checks?.behavior ? ` · ${BEHAVIOR_LABEL[r.checks.behavior]}` : ""}
                    </p>
                    <p style={{ fontSize: 12, marginTop: 2, color: found.length ? "var(--color-warning)" : "var(--color-success)" }}>
                      {found.length ? found.join("، ") : "مشکلی دیده نشد"}
                    </p>
                    {r.note && <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>{r.note}</p>}
                    {photos.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
                        {photos.map((p) => petPhotoUrl(p) && (
                          <a key={p} href={petPhotoUrl(p)} target="_blank" rel="noreferrer">
                            <img src={petPhotoUrl(p)} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>سابقهٔ نوبت‌ها</p>
            <div className="flex flex-col gap-1">
              {history.slice(0, 8).map((b) => (
                <div key={b.id} className="flex items-center justify-between" style={{ fontSize: 12.5, padding: "6px 0", borderBottom: "1px dashed var(--color-border)" }}>
                  <span>{jalaliLabel(parseDateKey(b.date), { short: true })} · {services.find((s) => s.id === b.service_id)?.name || "خدمت"}{b.pet_size ? ` (${PET_SIZE_LABEL[b.pet_size]})` : ""}</span>
                  <span style={{ color: STATUS_META[b.status]?.fg, fontWeight: 700, fontSize: 11.5 }}>{STATUS_META[b.status]?.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button disabled={saving} className="tap accent-btn w-full mt-1" style={{ padding: 12 }} onClick={save}>
          {saving ? "در حال ذخیره…" : "ذخیرهٔ پروفایل"}
        </button>
      </div>
    </Modal>
  );
}

export function PetsTab({ pets, setPets, bookings, services, notify, isManager = true }) {
  const [seg, setSeg] = useState("pets"); // v2.49: pets | packages
  const [query, setQuery] = useState("");
  const [species, setSpecies] = useState("all");
  const [open, setOpen] = useState(null);

  const ownerNames = useMemo(() => {
    const m = new Map();
    for (const b of bookings) if (b.customer_name) m.set(b.customer_phone, b.customer_name);
    return m;
  }, [bookings]);

  const q = query.trim().replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  const list = pets
    .filter((p) => species === "all" || p.species === species)
    .filter((p) => !q || p.name.includes(q) || p.owner_phone.includes(q) || (p.breed || "").includes(q) || (ownerNames.get(p.owner_phone) || "").includes(q))
    .sort((a, b) => (b.last_visit_date || "").localeCompare(a.last_visit_date || "") || a.name.localeCompare(b.name, "fa"));

  const counts = { dog: pets.filter((p) => p.species === "dog").length, cat: pets.filter((p) => p.species === "cat").length };
  const expiring = pets.filter((p) => ["expired", "soon"].includes(vaccineStatus(p.vaccine_valid_until))).length;

  return (
    <div>
      <PanelSectionHeader Icon={PawPrint} title="حیوانات" subtitle="پروفایل، سابقه و یادداشت آرایش هر سگ و گربه" color="var(--color-pet-500)" />
      <div className="flex gap-2 mb-3" role="tablist" aria-label="بخش حیوانات">
        {[["pets", "پروفایل‌ها"], ["packages", "بسته‌های پیش‌پرداخت"]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={seg === id} className="tap flex-1" onClick={() => setSeg(id)}
            style={{ padding: "8px 6px", borderRadius: "var(--radius-md)", fontSize: 12.5, fontWeight: 700,
              background: seg === id ? "var(--color-pet-500)" : "var(--color-surface)", color: seg === id ? "white" : "var(--color-body)",
              border: seg === id ? "none" : "1px solid var(--color-border)" }}>{label}</button>
        ))}
      </div>
      {seg === "packages" ? <PackagesSection services={services} notify={notify} isManager={isManager} /> : <>

      <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {[{ l: "سگ", v: counts.dog }, { l: "گربه", v: counts.cat }, { l: "واکسن منقضی/نزدیک", v: expiring }].map((x) => (
          <div key={x.l} className="card" style={{ padding: "10px 8px", textAlign: "center" }}>
            <div className="tabular" style={{ fontSize: 18, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(x.v)}</div>
            <div className="muted" style={{ fontSize: 11 }}>{x.l}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-3 items-center">
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={14} className="muted" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جستجو: نام، نژاد، صاحب یا موبایل" aria-label="جستجوی حیوان"
            style={{ width: "100%", padding: "9px 32px 9px 12px", fontSize: 13 }} />
        </div>
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "all", l: "همه" }, { v: "dog", l: "سگ" }, { v: "cat", l: "گربه" }].map((f) => (
            <button key={f.v} onClick={() => setSpecies(f.v)} className="tap"
              style={{ padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: species === f.v ? "var(--color-surface)" : "transparent", color: species === f.v ? "var(--color-heading)" : "var(--color-muted)" }}>
              {f.l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {list.map((p) => {
          const vs = vaccineStatus(p.vaccine_valid_until);
          const visits = bookingsOfPet(p, bookings).filter((b) => b.status === "completed").length;
          return (
            <button key={p.id || `${p.owner_phone}|${p.species}|${p.name}`} className="tap card" onClick={() => setOpen(p)}
              style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, textAlign: "right" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span style={{ fontWeight: 800, fontSize: 14, color: "var(--color-heading)" }}>{p.name}</span>
                  <GenderBadge gender={p.species} />
                  <TemperamentBadge temperament={p.temperament} />
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {[p.breed, PET_SIZE_LABEL[p.size], p.weight_kg ? `${toFa(p.weight_kg)} کیلو` : ""].filter(Boolean).join(" · ")}
                </div>
                <div className="muted tabular" style={{ fontSize: 11, marginTop: 2 }}>
                  {ownerNames.get(p.owner_phone) || "صاحب"} · <span dir="ltr">{toFa(p.owner_phone)}</span> · {toFa(visits)} مراجعه
                  {" · "}<span style={{ color: VACCINE_META[vs].color, fontWeight: 700 }}>{VACCINE_META[vs].label}</span>
                </div>
              </div>
              <Pencil size={14} className="muted" />
            </button>
          );
        })}
        {list.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: "center" }}>
            <p className="muted" style={{ fontSize: 13 }}>{pets.length ? "حیوانی با این مشخصات پیدا نشد" : "هنوز حیوانی ثبت نشده — پروفایل‌ها با اولین نوبت هر حیوان ساخته می‌شوند"}</p>
          </div>
        )}
      </div>

      {open && (
        <PetProfileModal
          pet={open}
          bookings={bookings}
          services={services}
          ownerName={ownerNames.get(open.owner_phone)}
          notify={notify}
          onClose={() => setOpen(null)}
          onSaved={(saved) => setPets((list) => list.map((p) => (p.id === saved.id ? saved : p)))}
        />
      )}
      </>}
    </div>
  );
}

/* v2.45 — finishing a visit: add-on items (e.g. detangling per half hour),
   the salon's aggression surcharge, or any other charge. Everything goes
   into extra_charges and final_price, so reports and the customer's
   receipt show it. */
export function CompleteVisitModal({ booking, services, surchargePct, onClose, onConfirm, packages = [] }) {
  const [usePkg, setUsePkg] = useState(packages[0]?.id || null); // v2.49 prepaid package
  const addons = services.filter((s) => s.is_addon && s.is_active && s.gender === booking.customer_gender && s.price > 0);
  const [qty, setQty] = useState({});
  const already = extraChargesTotal(booking);
  const hasSurcharge = (booking.extra_charges || []).some((x) => x.label === "حیوان پرخاشگر");
  const [surcharge, setSurcharge] = useState(false);
  const [basePrice, setBasePrice] = useState(""); // only when the price was "announced in salon"
  const [otherLabel, setOtherLabel] = useState("");
  const [otherAmount, setOtherAmount] = useState("");

  const base = booking.final_price != null ? booking.final_price - already : (basePrice === "" ? null : Math.max(0, Math.round(Number(basePrice))));
  const lines = [];
  for (const a of addons) {
    const n = qty[a.id] || 0;
    if (n > 0) lines.push({ label: `${a.name} × ${toFa(n)}`, amount: a.price * n });
  }
  if (surcharge && base) lines.push({ label: "حیوان پرخاشگر", amount: Math.round((base * surchargePct) / 100) });
  const other = Math.round(Number(otherAmount));
  if (otherLabel.trim() && Number.isFinite(other) && other > 0) lines.push({ label: otherLabel.trim().slice(0, 60), amount: other });
  const added = lines.reduce((t, x) => t + x.amount, 0);
  const total = base == null && added === 0 ? null : (base || 0) + already + added;

  function confirm() {
    const pkg = packages.find((p) => p.id === usePkg);
    if (pkg) { onConfirm({ usePackage: pkg, newCharges: lines }); return; }
    if (lines.length === 0 && (booking.final_price != null || base == null)) { onConfirm({}); return; }
    onConfirm({ final_price: total, extra_charges: [...(booking.extra_charges || []), ...lines] });
  }

  const step = { width: 30, height: 30, padding: 0, borderRadius: "var(--radius-sm)" };
  return (
    <Modal title={`پایان کار ${booking.pet_name || booking.customer_name || ""}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {booking.final_price == null && (
          <div>
            <label htmlFor="cv-base" className="muted" style={{ fontSize: 12 }}>مبلغ خدمت (قیمت در سالن تعیین می‌شد)</label>
            <input id="cv-base" type="number" min={0} step={1000} value={basePrice} onChange={(e) => setBasePrice(e.target.value)} className="tabular" style={{ width: "100%", padding: "9px 12px", fontSize: 14, marginTop: 4 }} />
          </div>
        )}
        {addons.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="muted" style={{ fontSize: 12 }}>افزودنی‌ها</span>
            {addons.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2">
                <span style={{ fontSize: 13 }}>{a.name} <span className="muted tabular" style={{ fontSize: 11.5 }}>({formatToman(a.price)})</span></span>
                <span className="flex items-center gap-2">
                  <button type="button" className="tap ghost-btn" style={step} aria-label={`کم کردن ${a.name}`} onClick={() => setQty((q) => ({ ...q, [a.id]: Math.max(0, (q[a.id] || 0) - 1) }))}><Minus size={13} style={{ margin: "auto" }} /></button>
                  <span className="tabular" style={{ minWidth: 18, textAlign: "center", fontWeight: 700 }}>{toFa(qty[a.id] || 0)}</span>
                  <button type="button" className="tap ghost-btn" style={step} aria-label={`افزودن ${a.name}`} onClick={() => setQty((q) => ({ ...q, [a.id]: Math.min(12, (q[a.id] || 0) + 1) }))}><Plus size={13} style={{ margin: "auto" }} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
        {packages.length > 0 && (
          <div className="card" style={{ padding: 10, borderColor: "var(--color-tab-panel)" }}>
            <span className="muted" style={{ fontSize: 12 }}>بستهٔ پیش‌پرداخت این مشتری</span>
            {packages.map((p) => (
              <label key={p.id} className="flex items-center gap-2" style={{ fontSize: 13, marginTop: 4 }}>
                <input type="radio" name="cv-pkg" checked={usePkg === p.id} onChange={() => setUsePkg(p.id)} />
                {p.package_name} — {toFa(p.sessions_left)} جلسه مانده
              </label>
            ))}
            <label className="flex items-center gap-2" style={{ fontSize: 13, marginTop: 4 }}>
              <input type="radio" name="cv-pkg" checked={!usePkg} onChange={() => setUsePkg(null)} /> پرداخت عادی
            </label>
          </div>
        )}
        {surchargePct > 0 && !hasSurcharge && (
          <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={surcharge} onChange={(e) => setSurcharge(e.target.checked)} />
            حیوان پرخاشگر بود ({toFa(surchargePct)}٪ اضافه)
          </label>
        )}
        <div className="flex gap-2">
          <input aria-label="شرح هزینهٔ دیگر" value={otherLabel} onChange={(e) => setOtherLabel(e.target.value)} placeholder="هزینهٔ دیگر (شرح)" style={{ flex: 2, minWidth: 0, padding: "9px 12px", fontSize: 13 }} />
          <input aria-label="مبلغ هزینهٔ دیگر" type="number" min={0} step={1000} value={otherAmount} onChange={(e) => setOtherAmount(e.target.value)} placeholder="مبلغ" className="tabular" style={{ flex: 1, minWidth: 0, padding: "9px 12px", fontSize: 13 }} />
        </div>
        <div className="card" style={{ padding: 12 }}>
          {base != null && <Row label="مبلغ خدمت" value={formatToman(base)} />}
          {(booking.extra_charges || []).map((x, i) => <Row key={`o${i}`} label={x.label} value={"+ " + formatToman(x.amount)} />)}
          {lines.map((x, i) => <Row key={`n${i}`} label={x.label} value={"+ " + formatToman(x.amount)} />)}
          <Row label="مبلغ نهایی" value={total == null ? "تعیین نشده" : formatToman(total)} bold />
        </div>
        <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={confirm}>ثبت «انجام شد»</button>
      </div>
    </Modal>
  );
}
