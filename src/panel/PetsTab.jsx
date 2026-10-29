import { useMemo, useState } from "react";
import { PawPrint, Search, Syringe, AlertTriangle, Pencil } from "lucide-react";
import { toFa, jalaliLabel, parseDateKey, isoToJalaliLabel } from "../lib/format";
import { updatePet } from "../lib/api";
import { GenderBadge, Modal, PanelSectionHeader, Row } from "../components/ui";
import { PET_SIZES, PET_SIZE_LABEL, PET_TEMPERAMENTS, PET_TEMPERAMENT_LABEL, STATUS_META } from "../app/shared";
import { JalaliDateInput } from "../booking/PetForm";

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

export function PetProfileModal({ pet, bookings, services, ownerName, onClose, onSaved, notify }) {
  const [draft, setDraft] = useState({
    breed: pet.breed || "", size: pet.size, weight_kg: pet.weight_kg ?? "", temperament: pet.temperament,
    vaccine_valid_until: pet.vaccine_valid_until || "", owner_notes: pet.owner_notes || "", grooming_notes: pet.grooming_notes || "",
  });
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
        </div>
        <div>
          <label htmlFor="pp-owner" className="muted" style={{ fontSize: 12 }}>توضیحات صاحب حیوان</label>
          <textarea id="pp-owner" rows={2} maxLength={300} value={draft.owner_notes} onChange={(e) => set({ owner_notes: e.target.value })} style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <div>
          <label htmlFor="pp-groom" className="muted" style={{ fontSize: 12 }}>یادداشت آرایشگر (فقط برای کارکنان)</label>
          <textarea id="pp-groom" rows={3} maxLength={1000} value={draft.grooming_notes} onChange={(e) => set({ grooming_notes: e.target.value })}
            placeholder="مثلاً تیغ ۷ میلی‌متری، روی گوش‌ها حساس است، با شامپوی ضدحساسیت" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>

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

export function PetsTab({ pets, setPets, bookings, services, notify }) {
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
    </div>
  );
}
