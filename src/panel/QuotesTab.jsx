import { useCallback, useEffect, useState } from "react";
import { MessageSquareText, RefreshCw, Clock, Phone, Send, X, ChevronLeft, ChevronRight } from "lucide-react";
import { formatToman, toFa } from "../lib/format";
import { fetchQuotes, fetchQuotePhotos, sendQuote, declineQuote } from "../lib/api";
import { GenderBadge, Modal, PanelSectionHeader } from "../components/ui";
import { PET_SIZE_LABEL, hasPrice, petService, staffServesSection } from "../app/shared";
import { TemperamentBadge } from "./PetsTab";

/* ============================================================
   v2.46 pet salons — price quotes. A customer describes what the
   animal needs; staff answer with a price, a duration and the
   groomer. The customer gets it by SMS (and in "داشبورد من") with
   a link to pick a time at that price.
   ============================================================ */

const STATUS = {
  pending: { label: "در انتظار قیمت", color: "var(--color-warning)" },
  quoted: { label: "قیمت ارسال شد", color: "var(--color-success)" },
  booked: { label: "رزرو شد", color: "var(--color-info)" },
  declined: { label: "رد شد", color: "var(--color-danger)" },
  cancelled: { label: "لغو توسط مشتری", color: "var(--color-muted)" },
  expired: { label: "منقضی شد", color: "var(--color-muted)" },
};
const effectiveStatus = (q) => (q.status === "quoted" && q.expires_at && new Date(q.expires_at) <= new Date() ? "expired" : q.status);

function timeAgo(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${toFa(min)} دقیقه پیش`;
  if (min < 1440) return `${toFa(Math.round(min / 60))} ساعت پیش`;
  return `${toFa(Math.round(min / 1440))} روز پیش`;
}

export function QuotesTab({ services, stylists, pets, automation, notify, onPendingChange }) {
  const [quotes, setQuotes] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [pricing, setPricing] = useState(null);

  const load = useCallback(async () => {
    const list = await fetchQuotes();
    setQuotes(list);
    onPendingChange?.(list.filter((q) => q.status === "pending").length);
  }, [onPendingChange]);
  useEffect(() => { load(); }, [load]);

  async function decline(q) {
    const reason = window.prompt("دلیل (برای مشتری پیامک می‌شود — اختیاری):", "");
    if (reason === null) return;
    const res = await declineQuote(q.id, reason.trim());
    notify(res?.ok ? "درخواست رد شد و به مشتری اطلاع داده شد" : res?.error || "ناموفق بود");
    load();
  }

  const list = (quotes || []).filter((q) => filter === "all" || (filter === "pending" ? q.status === "pending" : effectiveStatus(q) === "quoted"));
  const counts = { pending: (quotes || []).filter((q) => q.status === "pending").length, quoted: (quotes || []).filter((q) => effectiveStatus(q) === "quoted").length };

  return (
    <div>
      <PanelSectionHeader Icon={MessageSquareText} title="استعلام قیمت" subtitle="درخواست‌های مشتری‌ها را ببینید و قیمت و زمان پیشنهادی بفرستید" color="var(--color-pet-500)" />
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "pending", l: `در انتظار (${toFa(counts.pending)})` }, { v: "quoted", l: `قیمت‌داده (${toFa(counts.quoted)})` }, { v: "all", l: "همه" }].map((f) => (
            <button key={f.v} onClick={() => setFilter(f.v)} className="tap"
              style={{ padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: filter === f.v ? "var(--color-surface)" : "transparent", color: filter === f.v ? "var(--color-heading)" : "var(--color-muted)" }}>
              {f.l}
            </button>
          ))}
        </div>
        <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} onClick={load} aria-label="به‌روزرسانی">
          <RefreshCw size={14} style={{ margin: "auto" }} />
        </button>
      </div>

      {quotes === null ? (
        <p className="muted" style={{ fontSize: 13, textAlign: "center", padding: 20 }}>در حال بارگذاری…</p>
      ) : list.length === 0 ? (
        <div className="card" style={{ padding: 20, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>{filter === "pending" ? "درخواستی منتظر قیمت نیست" : "موردی نیست"}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((q) => {
            const st = STATUS[effectiveStatus(q)] || STATUS.pending;
            const pet = (q.pet_id && pets.find((p) => p.id === q.pet_id)) || q.demoPet || null;
            return (
              <div key={q.id} className="card" style={{ padding: 12 }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span style={{ fontWeight: 800, fontSize: 14, color: "var(--color-heading)" }}>{q.pet_name}</span>
                    <GenderBadge gender={q.pet_species} />
                    {pet && <TemperamentBadge temperament={pet.temperament} />}
                  </div>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color, whiteSpace: "nowrap" }}>{st.label}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                  {[PET_SIZE_LABEL[q.pet_size], pet?.breed, pet?.weight_kg ? `${toFa(pet.weight_kg)} کیلو` : ""].filter(Boolean).join(" · ")}
                </div>
                <p style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>{q.services_label}</p>
                {q.customer_note && <p style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.8, background: "var(--color-surface-raised)", padding: "6px 10px", borderRadius: "var(--radius-sm)" }}>«{q.customer_note}»</p>}
                <QuotePhotos quote={q} />
                {pet?.owner_notes && pet.owner_notes !== q.customer_note && <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>توضیح پروفایل: {pet.owner_notes}</p>}
                <div className="muted flex items-center gap-3 flex-wrap tabular" style={{ fontSize: 11.5, marginTop: 6 }}>
                  <span className="flex items-center gap-1"><Phone size={11} /> {q.customer_name} · <span dir="ltr">{toFa(q.customer_phone)}</span></span>
                  {q.preferred_time && <span className="flex items-center gap-1"><Clock size={11} /> {q.preferred_time}</span>}
                  <span>{timeAgo(q.created_at)}</span>
                </div>
                {q.status !== "pending" && q.quoted_price != null && (
                  <p className="tabular" style={{ fontSize: 12.5, marginTop: 6 }}>
                    قیمت: <b>{formatToman(q.quoted_price)}</b> · {toFa(q.quoted_duration)} دقیقه
                    {q.quote_note ? ` · ${q.quote_note}` : ""}
                  </p>
                )}
                {q.status === "declined" && q.quote_note && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>دلیل: {q.quote_note}</p>}
                {(q.status === "pending" || q.status === "quoted") && (
                  <div className="flex gap-2 mt-3">
                    <button className="tap accent-btn flex-1 flex items-center justify-center gap-1" style={{ padding: "9px 8px", fontSize: 12.5, fontWeight: 700 }} onClick={() => setPricing(q)}>
                      <Send size={13} /> {q.status === "pending" ? "تعیین و ارسال قیمت" : "تغییر قیمت"}
                    </button>
                    <button className="tap ghost-btn flex items-center gap-1" style={{ padding: "9px 12px", fontSize: 12.5, color: "var(--color-danger)" }} onClick={() => decline(q)}>
                      <X size={13} /> رد
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pricing && (
        <SendQuoteModal
          quote={pricing}
          services={services}
          stylists={stylists}
          pet={(pricing.pet_id && pets.find((p) => p.id === pricing.pet_id)) || pricing.demoPet || null}
          validDays={automation?.pet_quote_valid_days || 3}
          onClose={() => setPricing(null)}
          onSent={() => { setPricing(null); notify("قیمت برای مشتری پیامک شد"); load(); }}
          notify={notify}
        />
      )}
    </div>
  );
}

/* v2.47 — the customer's photos (signed URLs, loaded per card). */
function QuotePhotos({ quote }) {
  const [urls, setUrls] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchQuotePhotos(quote).then((u) => { if (alive) setUrls(u); });
    return () => { alive = false; };
  }, [quote]);
  if (!urls.length) return null;
  return (
    <>
      <div className="flex gap-2 flex-wrap" style={{ marginTop: 8 }}>
        {urls.map((u, i) => (
          <button key={u} type="button" className="tap" onClick={() => setOpen(i)} aria-label={`نمایش عکس ${toFa(i + 1)}`} style={{ padding: 0, borderRadius: "var(--radius-md)" }}>
            <img src={u} alt="" loading="lazy" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", display: "block" }} />
          </button>
        ))}
      </div>
      {open != null && (
        <Modal title={`عکس ${toFa(open + 1)} از ${toFa(urls.length)} — ${quote.pet_name}`} onClose={() => setOpen(null)} wide>
          <img src={urls[open]} alt={`عکس ${quote.pet_name}`} style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }} />
          {urls.length > 1 && (
            <div className="flex justify-between mt-3">
              <button className="tap ghost-btn flex items-center gap-1" style={{ padding: "8px 12px" }} onClick={() => setOpen((open + 1) % urls.length)}><ChevronRight size={14} /> بعدی</button>
              <button className="tap ghost-btn flex items-center gap-1" style={{ padding: "8px 12px" }} onClick={() => setOpen((open - 1 + urls.length) % urls.length)}>قبلی <ChevronLeft size={14} /></button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function SendQuoteModal({ quote, services, stylists, pet, validDays, onClose, onSent, notify }) {
  // a starting point: the list price/duration of each service for this animal
  const chosen = services.filter((s) => (quote.service_ids || []).includes(s.id)).map((s) => petService(s, quote.pet_size, pet?.breed));
  const suggestedPrice = chosen.every(hasPrice) && chosen.length ? chosen.reduce((t, s) => t + s.price, 0) : null;
  const suggestedDuration = chosen.reduce((t, s) => t + (s.duration_minutes || 0), 0) || 60;
  const [price, setPrice] = useState(quote.quoted_price != null ? String(quote.quoted_price) : suggestedPrice != null ? String(suggestedPrice) : "");
  const [duration, setDuration] = useState(String(quote.quoted_duration || suggestedDuration));
  const [staffId, setStaffId] = useState(quote.quoted_staff_id || "");
  const [note, setNote] = useState(quote.quote_note || "");
  const [sending, setSending] = useState(false);
  const groomers = stylists.filter((s) => s.active && staffServesSection(s, quote.pet_species));
  const priceNum = Math.round(Number(price));
  const durNum = Math.round(Number(duration));
  const valid = Number.isFinite(priceNum) && priceNum >= 1000 && Number.isFinite(durNum) && durNum >= 5 && durNum <= 600;

  async function send() {
    if (!valid || sending) return;
    setSending(true);
    const res = await sendQuote(quote.id, { price: priceNum, duration: durNum, staffId: staffId || null, note: note.trim() });
    setSending(false);
    if (!res?.ok) { notify(res?.error || "ارسال ناموفق بود"); return; }
    onSent();
  }
  const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4 };
  return (
    <Modal title={`قیمت برای ${quote.pet_name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          {quote.services_label}
          {suggestedPrice != null && <> — قیمت فهرست: {formatToman(suggestedPrice)}</>}
        </p>
        <div className="flex gap-3">
          <div style={{ flex: 3 }}>
            <label htmlFor="sq-price" className="muted" style={{ fontSize: 12 }}>قیمت کل (تومان)</label>
            <input id="sq-price" type="number" min={1000} step={10000} value={price} onChange={(e) => setPrice(e.target.value)} className="tabular" style={input} />
          </div>
          <div style={{ flex: 2 }}>
            <label htmlFor="sq-dur" className="muted" style={{ fontSize: 12 }}>مدت (دقیقه)</label>
            <input id="sq-dur" type="number" min={5} max={600} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} className="tabular" style={input} />
          </div>
        </div>
        <div>
          <label htmlFor="sq-staff" className="muted" style={{ fontSize: 12 }}>آرایشگر</label>
          <select id="sq-staff" value={staffId} onChange={(e) => setStaffId(e.target.value)} style={input}>
            <option value="">فرقی ندارد</option>
            {groomers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sq-note" className="muted" style={{ fontSize: 12 }}>توضیح برای مشتری (اختیاری)</label>
          <textarea id="sq-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="مثلاً شامل گره‌زدایی؛ لطفاً ۱۰ دقیقه زودتر بیایید" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
          مشتری پیامکی با این قیمت و لینک انتخاب زمان می‌گیرد؛ قیمت {toFa(validDays)} روز معتبر است و نوبت با همین مبلغ ثبت می‌شود.
        </p>
        <button disabled={!valid || sending} className="tap accent-btn w-full" style={{ padding: 12 }} onClick={send}>
          {sending ? "در حال ارسال…" : `ارسال قیمت ${valid ? formatToman(priceNum) : ""}`}
        </button>
      </div>
    </Modal>
  );
}
