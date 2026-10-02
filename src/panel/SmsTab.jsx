import { useState, useEffect, useMemo, useRef } from "react";
import { Eye, MessageSquareText, TrendingUp, History, Users, Zap, Send, Loader2, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { fetchSmsLog, fetchCustomers, fetchRfmSegments, logCampaignSend, updateCampaignLogResult, fetchCampaignPerformance, setReminderHours } from "../lib/api";
import { sendCampaign, campaignResultMessage, segmentMembers } from "../lib/campaigns";
import { sendBulkSms, renderTemplate, smsParts, SMS_PLACEHOLDERS } from "../lib/sms";
import { toFa, jalaliLabel, formatClock, dateKey, parseDateKey } from "../lib/format";
import { AUDIENCES } from "./LoyaltyTab";
import { FALLBACK_SMS_TEMPLATES, RFM_SMART_DRAFTS, SMS_KIND_LABEL, SMS_STATUS_META } from "../app/shared";
import { PanelSectionHeader } from "../components/ui";
import { SmsAccountCard } from "./SmsAccountCard";
import { RFM_SEGMENT_META } from "./biCards";

export const SMS_SEGMENTS = [
  { id: "quick", label: "ارسال سریع", Icon: Zap, color: "var(--color-success)" },
  { id: "manual", label: "پیام دستی", Icon: MessageSquareText, color: "var(--color-tab-panel)" },
  { id: "log", label: "تاریخچه", Icon: History, color: "var(--color-info)" },
];

// v2.39 — when the customer's reminder SMS goes out, for the whole salon.
const REMINDER_HOUR_OPTIONS = [0, 1, 2, 3, 6, 12, 24];
function ReminderTimingCard({ hours, onSaved, notify }) {
  const [value, setValue] = useState(hours);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(hours); }, [hours]);
  async function change(h) {
    const prev = value;
    setValue(h); setSaving(true);
    const res = await setReminderHours(h);
    setSaving(false);
    if (!res?.ok) { setValue(prev); notify(res?.error || "ذخیرهٔ زمان یادآوری ناموفق بود"); return; }
    onSaved?.(h);
    notify(h === 0
      ? "پیامک یادآوری خاموش شد"
      : `یادآوری ${toFa(h)} ساعت قبل از نوبت ارسال می‌شود${res.requeued ? ` — ${toFa(res.requeued)} یادآوری با زمان جدید تنظیم شد` : ""}`);
  }
  const exampleStart = 18 * 60;
  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>
        <Clock size={15} color="var(--color-accent-500)" /> زمان پیامک یادآوری به مشتری
      </p>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 2, marginBottom: 10, lineHeight: 1.8 }}>
        برای همهٔ نوبت‌های تاییدشده خودکار ارسال می‌شود (همراه لینک «می‌آیم / نمی‌توانم بیایم»). تغییر آن، یادآوری نوبت‌های آینده را هم با زمان جدید تنظیم می‌کند.
      </p>
      <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="زمان یادآوری">
        {REMINDER_HOUR_OPTIONS.map((h) => {
          const active = value === h;
          return (
            <button
              key={h}
              role="radio"
              aria-checked={active}
              disabled={saving}
              onClick={() => !active && change(h)}
              className="tap tabular"
              style={{
                padding: "7px 12px", minHeight: 36, borderRadius: "var(--radius-full)", fontSize: 12.5, fontWeight: 700,
                border: `1px solid ${active ? "var(--color-accent-500)" : "var(--color-border)"}`,
                background: active ? "var(--color-accent-500)" : "var(--color-surface)",
                color: active ? "white" : "var(--color-body)",
              }}
            >
              {h === 0 ? "خاموش" : `${toFa(h)} ساعت قبل`}
            </button>
          );
        })}
      </div>
      <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 10 }}>
        {value === 0
          ? "پیامک یادآوری ارسال نمی‌شود."
          : `مثال: برای نوبت ساعت ${formatClock(exampleStart)}، یادآوری ساعت ${formatClock(((exampleStart - value * 60) % 1440 + 1440) % 1440)}${value * 60 > exampleStart ? " روز قبل" : ""} ارسال می‌شود.`}
      </p>
    </div>
  );
}

export function SmsTab({ bookings, services, stylists, smsTemplates, notify, presetSegment, onConsumePresetSegment, reminderHours = 3, onReminderHoursSaved }) {
  const [segment, setSegment] = useState("quick");
  const [audience, setAudience] = useState("today");
  const [templateId, setTemplateId] = useState("");
  const [body, setBody] = useState("");
  const [manualNumbers, setManualNumbers] = useState("");
  const [showRecipients, setShowRecipients] = useState(false);
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [discount, setDiscount] = useState(15); // only used if the {{discount}} token is inserted
  const [allCustomers, setAllCustomers] = useState([]);

  // ---- v2.13: "بهترین عملکرد" suggester ----
  const [suggestingBest, setSuggestingBest] = useState(false);
  const [bestSuggestion, setBestSuggestion] = useState(null); // { template_label, conversion_rate } — last suggestion shown

  // ---- smart RFM campaign cards ----
  const [rfmSegments, setRfmSegments] = useState([]);
  const [rfmLoading, setRfmLoading] = useState(false);
  const [sendingSegment, setSendingSegment] = useState(null); // which segment is mid-send
  const [highlightSegment, setHighlightSegment] = useState(presetSegment || null);

  useEffect(() => {
    (async () => {
      setRfmLoading(true);
      setRfmSegments(await fetchRfmSegments());
      setRfmLoading(false);
    })();
  }, []);

  // Arrived here via the Loyalty tab's "ارسال پیامک به این دسته" button — jump
  // straight to Quick Send and highlight that card.
  useEffect(() => {
    if (!presetSegment) return;
    setSegment("quick");
    setHighlightSegment(presetSegment);
    onConsumePresetSegment?.();
    // only when a new preset arrives — the callback is a fresh arrow each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSegment]);

  async function sendSmartCampaign(segmentKey) {
    const draft = RFM_SMART_DRAFTS[segmentKey];
    const members = segmentMembers(rfmSegments, segmentKey);
    if (!members.length) { notify("مشتری‌ای در این دسته برای ارسال یافت نشد"); return; }

    setSendingSegment(segmentKey);
    const res = await sendCampaign({
      name: `کمپین هوشمند — ${RFM_SEGMENT_META[segmentKey]?.label || segmentKey}`,
      // template_id is a synthetic key (the segment itself), not a real
      // sms_templates row — smart-campaign drafts are hardcoded text.
      templateId: segmentKey,
      templateLabel: RFM_SEGMENT_META[segmentKey]?.label || segmentKey,
      segment: segmentKey,
      draft,
      recipients: members.map((c) => ({ phone: c.phone, name: c.name, vars: { days: toFa(c.recency_days ?? "") } })),
    });
    setSendingSegment(null);
    notify(res?.ok || res?.demo ? campaignResultMessage(res) : res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
    refreshLog();
  }

  const bodyRef = useRef(null);

  const templates = smsTemplates && smsTemplates.length
    ? smsTemplates
    : Object.entries(FALLBACK_SMS_TEMPLATES).map(([kind, b]) => ({
        id: `fallback-${kind}`, kind, title: SMS_KIND_LABEL[kind], body: b, is_default: true,
      }));

  // Pick a sensible default template the first time.
  useEffect(() => {
    if (templateId || !templates.length) return;
    const preferred = templates.find((t) => t.kind === "custom") || templates[0];
    setTemplateId(preferred.id);
    setBody(preferred.body || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  async function refreshLog() {
    setLogLoading(true);
    setLog(await fetchSmsLog(40));
    setLogLoading(false);
  }
  useEffect(() => { refreshLog(); }, []);

  useEffect(() => {
    if (audience !== "all") return;
    (async () => setAllCustomers(await fetchCustomers()))();
  }, [audience]);

  /* -------------------------------------------------- recipient resolution */
  const recipients = useMemo(() => {
    const svcName = (id) => (services.find((s) => s.id === id) || {}).name || "خدمت";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayOffset = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return dateKey(d); };

    const fromBookings = (predicate) => {
      const seen = new Set();
      return bookings
        .filter((b) => ["pending", "confirmed", "rescheduled"].includes(b.status))
        .filter(predicate)
        .filter((b) => /^09\d{9}$/.test(b.customer_phone || ""))
        .filter((b) => (seen.has(b.customer_phone) ? false : seen.add(b.customer_phone)))
        .map((b) => ({
          phone: b.customer_phone,
          vars: {
            name: b.customer_name || "مشتری",
            service: svcName(b.service_id),
            date: jalaliLabel(parseDateKey(b.date), { withWeekday: false }),
            time: formatClock(b.start_min),
            stylist: b.staff_name || "بدون آرایشگر مشخص",
            code: b.tracking_code || "",
            discount: String(discount),
          },
        }));
    };

    if (audience === "today")    return fromBookings((b) => b.date === dayOffset(0));
    if (audience === "tomorrow") return fromBookings((b) => b.date === dayOffset(1));
    if (audience === "week") {
      const window = new Set(Array.from({ length: 7 }, (_, i) => dayOffset(i)));
      return fromBookings((b) => window.has(b.date));
    }

    if (audience === "all") {
      if (allCustomers.length) {
        return allCustomers
          .filter((c) => !c.sms_opt_out && /^09\d{9}$/.test(c.phone))
          .map((c) => ({
            phone: c.phone,
            vars: { name: c.name || "مشتری", points: String(c.loyalty_points ?? 0), discount: String(discount), service: "", date: "", time: "", stylist: "", code: "" },
          }));
      }
      // Offline fallback: derive the customer list from the bookings we hold.
      const seen = new Map();
      for (const b of bookings) {
        if (/^09\d{9}$/.test(b.customer_phone || "") && !seen.has(b.customer_phone)) {
          seen.set(b.customer_phone, { name: b.customer_name || "مشتری" });
        }
      }
      return [...seen.entries()].map(([phone, v]) => ({
        phone, vars: { ...v, discount: String(discount), points: "0", service: "", date: "", time: "", stylist: "", code: "" },
      }));
    }

    // manual
    return [...new Set(
      manualNumbers.split(/[\s,،;\n]+/).map((x) => x.trim()).filter((x) => /^09\d{9}$/.test(x))
    )].map((phone) => ({
      phone,
      vars: { name: "مشتری", discount: String(discount), points: "0", service: "", date: "", time: "", stylist: "", code: "" },
    }));
  }, [audience, bookings, services, manualNumbers, allCustomers, discount]);

  const preview = recipients.length ? renderTemplate(body, recipients[0].vars) : renderTemplate(body, {});
  const parts = smsParts(preview);
  const totalParts = parts * recipients.length;
  const usesDiscountToken = body.includes("{{discount}}");

  function insertToken(token) {
    const el = bodyRef.current;
    if (!el) { setBody((b) => b + token); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  /* --------------------------------------------------------------- sending */
  // v2.13: suggest the best-performing template by conversion rate, and
  // select it if it's a real (non-smart-campaign) template — smart-campaign
  // drafts use a synthetic template_id (the segment key), so those can be
  // shown as the suggestion but can't be auto-loaded into this dropdown.
  async function suggestBestTemplate() {
    setSuggestingBest(true);
    const rows = await fetchCampaignPerformance();
    setSuggestingBest(false);
    const withSends = (rows || []).filter((r) => r.total_sent > 0);
    if (!withSends.length) { notify("هنوز سابقهٔ ارسالی برای مقایسه وجود ندارد"); return; }
    const best = withSends[0]; // RPC already orders by conversion_rate desc
    setBestSuggestion(best);
    const matchingTemplate = templates.find((t) => t.id === best.template_id);
    if (matchingTemplate) {
      setTemplateId(matchingTemplate.id);
      setBody(matchingTemplate.body || "");
    }
    notify(`بهترین عملکرد: «${best.template_label}» با ${toFa(best.conversion_rate)}٪ نرخ تبدیل`);
  }

  async function handleSend() {
    if (!recipients.length) { notify("مخاطبی برای ارسال پیدا نشد"); return; }
    if (!body.trim()) { notify("متن پیام خالی است"); return; }

    setSending(true);
    const selectedTemplate = templates.find((t) => t.id === templateId);
    const campaignLog = await logCampaignSend({
      templateId: selectedTemplate?.id ?? null,
      templateLabel: selectedTemplate?.title || SMS_KIND_LABEL[selectedTemplate?.kind] || "پیام دستی",
      segment: null, // manual composer isn't segment-scoped
      totalSent: recipients.length,
    });

    const messages = recipients.map((r) => ({
      to: r.phone,
      body: renderTemplate(body, r.vars),
      kind: "custom",
      campaign_id: null,
      campaign_log_id: campaignLog?.id ?? null,
    }));

    const res = await sendBulkSms(messages);
    setSending(false);

    if (campaignLog?.id && typeof res?.sent === "number") {
      await updateCampaignLogResult(campaignLog.id, res.sent);
    }

    if (res?.demo) {
      notify("حالت دمو — پیامک واقعی ارسال نشد");
    } else if (res?.ok) {
      notify(`${toFa(res.sent)} پیامک ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`);
    } else {
      notify(res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
    }
    refreshLog();
  }

  /* ----------------------------------------------------------------- render */
  return (
    <div className="fade-in flex flex-col gap-3">
      <PanelSectionHeader Icon={MessageSquareText} title="پیامک" subtitle="کمپین‌های هوشمند، ارسال دستی، و تاریخچهٔ پیامک‌ها" color="var(--color-tab-panel)" />
      <SmsAccountCard notify={notify} />
      <ReminderTimingCard hours={reminderHours} onSaved={onReminderHoursSaved} notify={notify} />

      {/* Segment switcher — three clear, organized sections instead of one long scroll */}
      <div className="flex gap-2">
        {SMS_SEGMENTS.map((seg) => {
          const active = segment === seg.id;
          return (
            <button
              key={seg.id}
              onClick={() => setSegment(seg.id)}
              className="tap flex-1 flex flex-col items-center gap-1"
              style={{
                padding: "10px 4px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: active ? 800 : 700,
                background: active ? seg.color : `color-mix(in oklch, ${seg.color} 11%, var(--color-surface))`,
                color: active ? "white" : seg.color,
                border: active ? "none" : `1px solid color-mix(in oklch, ${seg.color} 22%, transparent)`,
                boxShadow: active ? `0 3px 10px -3px color-mix(in oklch, ${seg.color} 55%, transparent)` : "none",
              }}
            >
              <seg.Icon size={16} />
              {seg.label}
            </button>
          );
        })}
      </div>

      {/* ================= Quick Send: one-click RFM campaigns ================= */}
      {segment === "quick" && (
        <div className="card fade-in" style={{ padding: 14 }}>
          <div className="flex items-center justify-between mb-3">
            <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
              <Zap size={14} color="var(--color-success)" /> کمپین‌های آمادهٔ ارسال
            </p>
            <button className="tap ghost-btn" style={{ width: 26, height: 26, padding: 0 }} onClick={async () => { setRfmLoading(true); setRfmSegments(await fetchRfmSegments()); setRfmLoading(false); }} disabled={rfmLoading}>
              <RefreshCw size={12} style={{ margin: "auto", animation: rfmLoading ? "salonSpin 1s linear infinite" : "none" }} />
            </button>
          </div>
          {!SUPABASE_ENABLED ? (
            <p className="muted" style={{ fontSize: 11.5 }}>کمپین‌های هوشمند به دیتابیس Supabase نیاز دارند.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {Object.keys(RFM_SMART_DRAFTS).map((key) => {
                const meta = RFM_SEGMENT_META[key];
                const count = key === "champions_vip"
                  ? rfmSegments.filter((c) => c.segment === "champions" && c.is_vip).length
                  : rfmSegments.filter((c) => c.segment === key).length;
                const isHighlighted = highlightSegment === key;
                const isSendingThis = sendingSegment === key;
                return (
                  <div
                    key={key}
                    style={{
                      padding: 12, borderRadius: "var(--radius-md)",
                      background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))`,
                      border: isHighlighted ? `2px solid ${meta.color}` : "2px solid transparent",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                        <span style={{ fontSize: 16 }}>{meta.emoji}</span> {meta.label}
                      </span>
                      <span className="muted tabular" style={{ fontSize: 11 }}>{toFa(count)} نفر</span>
                    </div>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.8 }}>
                      {RFM_SMART_DRAFTS[key].replace(/\{\{name\}\}/g, "مریم").replace(/\{\{days\}\}/g, "۴۵")}
                    </p>
                    <button
                      disabled={count === 0 || sendingSegment != null}
                      className="tap accent-btn w-full mt-2 flex items-center justify-center gap-1.5"
                      style={{ padding: 8, fontSize: 12 }}
                      onClick={() => sendSmartCampaign(key)}
                    >
                      {isSendingThis ? <Loader2 size={13} style={{ animation: "salonSpin 1s linear infinite" }} /> : <Send size={13} />}
                      تایید و ارسال سریع
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ================= Manual: audience + template + body + preview + send ================= */}
      {segment === "manual" && (
        <div className="flex flex-col gap-3 fade-in">
          <div className="card" style={{ padding: 14 }}>
            <p className="muted flex items-center gap-1 mb-3" style={{ fontSize: 12 }}>
              <Users size={13} /> مخاطبان
            </p>
            <div className="flex gap-1" style={{ flexWrap: "wrap" }}>
              {AUDIENCES.map((a) => {
                const on = audience === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setAudience(a.id)}
                    className="tap flex items-center gap-1"
                    style={{
                      padding: "7px 10px", borderRadius: "var(--radius-md)", fontSize: 11.5, fontWeight: 700,
                      border: `1px solid ${on ? "var(--color-accent-500)" : "var(--color-border)"}`,
                      background: on ? "var(--color-accent-100)" : "var(--color-surface)",
                      color: on ? "var(--color-accent-700)" : "var(--color-body)",
                    }}
                  >
                    <a.Icon size={12} /> {a.label}
                  </button>
                );
              })}
            </div>

            {audience === "manual" && (
              <textarea
                dir="ltr"
                value={manualNumbers}
                onChange={(e) => setManualNumbers(e.target.value)}
                placeholder="09121234567, 09351112233"
                className="tabular fade-in"
                style={{ width: "100%", padding: 11, fontSize: 13, marginTop: 12, minHeight: 74, resize: "vertical" }}
              />
            )}

            <div className="flex items-center justify-between" style={{ marginTop: 12 }}>
              <p style={{ fontSize: 12.5, fontWeight: 700 }}>
                <span className="tabular" style={{ color: recipients.length ? "var(--color-accent-700)" : "var(--color-muted)" }}>
                  {toFa(recipients.length)}
                </span>{" "}
                گیرنده
              </p>
              {recipients.length > 0 && (
                <button className="muted" style={{ fontSize: 11.5 }} onClick={() => setShowRecipients((v) => !v)}>
                  {showRecipients ? "بستن لیست" : "نمایش لیست"}
                </button>
              )}
            </div>

            {showRecipients && (
              <div className="fade-in surface-raised" style={{ marginTop: 8, borderRadius: "var(--radius-md)", padding: 10, maxHeight: 150, overflowY: "auto" }}>
                {recipients.map((r) => (
                  <div key={r.phone} className="flex items-center justify-between" style={{ padding: "3px 0", fontSize: 11.5 }}>
                    <span>{r.vars.name}</span>
                    <span className="tabular muted" dir="ltr">{toFa(r.phone)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="flex items-center justify-between mb-3">
              <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
                <MessageSquareText size={13} /> قالب پیام
              </p>
              {SUPABASE_ENABLED && (
                <button
                  onClick={suggestBestTemplate}
                  disabled={suggestingBest}
                  className="tap flex items-center gap-1"
                  style={{ padding: "5px 9px", borderRadius: "var(--radius-full)", fontSize: 11, fontWeight: 700, background: "color-mix(in oklch, var(--color-success) 14%, transparent)", color: "var(--color-success)" }}
                >
                  <TrendingUp size={11} /> {suggestingBest ? "در حال بررسی..." : "بهترین عملکرد"}
                </button>
              )}
            </div>
            {bestSuggestion && (
              <p className="muted fade-in" style={{ fontSize: 11, marginBottom: 8 }}>
                «{bestSuggestion.template_label}» با <b className="tabular" style={{ color: "var(--color-success)" }}>{toFa(bestSuggestion.conversion_rate)}٪</b> نرخ تبدیل بهترین سابقه را دارد
              </p>
            )}

            <select
              value={templateId}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value);
                setTemplateId(e.target.value);
                if (t) setBody(t.body || "");
              }}
              style={{ width: "100%", padding: "10px 12px", fontSize: 13 }}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title || SMS_KIND_LABEL[t.kind] || t.kind}
                </option>
              ))}
            </select>

            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="متن پیامک…"
              style={{ width: "100%", padding: 11, fontSize: 13, marginTop: 10, minHeight: 110, resize: "vertical", lineHeight: 1.7 }}
            />

            <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap" }}>
              {SMS_PLACEHOLDERS.map((ph) => (
                <button
                  key={ph.token}
                  onClick={() => insertToken(ph.token)}
                  className="tap"
                  title={ph.label}
                  style={{
                    padding: "4px 8px", borderRadius: "var(--radius-full)", fontSize: 10.5, fontWeight: 700,
                    border: "1px solid var(--color-border)", background: "var(--color-surface-raised)",
                    color: "var(--color-muted)", minHeight: 0,
                  }}
                >
                  {ph.label}
                </button>
              ))}
            </div>

            {usesDiscountToken && (
              <div className="fade-in flex items-center justify-between" style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                <label className="muted" style={{ fontSize: 11.5 }}>درصد تخفیفی که {"{{discount}}"} در پیام نشان می‌دهد</label>
                <div className="flex items-center gap-1">
                  <input
                    type="number" min="0" max="100" value={discount}
                    onChange={(e) => setDiscount(Number(e.target.value))}
                    className="tabular" style={{ width: 52, padding: "5px 6px", fontSize: 12, textAlign: "center" }}
                  />
                  <span className="muted" style={{ fontSize: 11 }}>٪</span>
                </div>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="flex items-center justify-between mb-2">
              <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
                <Eye size={13} /> پیش‌نمایش
              </p>
              <span className="badge tabular" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>
                {toFa(parts)} پیامک × {toFa(recipients.length)} = {toFa(totalParts)}
              </span>
            </div>

            <div
              className="surface-raised"
              style={{
                borderRadius: "var(--radius-md)", padding: 12, fontSize: 12.5, lineHeight: 1.85,
                whiteSpace: "pre-wrap", minHeight: 60, color: "var(--color-body)",
              }}
            >
              {preview || <span className="muted">متنی وارد نشده</span>}
            </div>

            <button
              onClick={handleSend}
              disabled={sending || !recipients.length || !body.trim()}
              className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
              style={{ padding: 13, fontSize: 13.5 }}
            >
              {sending ? <Loader2 size={15} className="salon-spin" /> : <Send size={15} />}
              ارسال دسته‌جمعی به {toFa(recipients.length)} نفر
            </button>

            {!SUPABASE_ENABLED && (
              <p className="muted flex items-center gap-1 mt-3" style={{ fontSize: 11 }}>
                <AlertTriangle size={12} /> دیتابیس متصل نیست — ارسال واقعی انجام نمی‌شود
              </p>
            )}
          </div>
        </div>
      )}

      {/* ================= Log ================= */}
      {segment === "log" && (
        <div className="card fade-in" style={{ padding: 14 }}>
          <div className="flex items-center justify-between mb-3">
            <p className="muted flex items-center gap-1" style={{ fontSize: 12 }}>
              <History size={13} /> تاریخچهٔ ارسال
            </p>
            <button className="muted" style={{ fontSize: 11.5 }} onClick={refreshLog} disabled={logLoading}>
              {logLoading ? "…" : "به‌روزرسانی"}
            </button>
          </div>

          {!log.length ? (
            <p className="muted" style={{ fontSize: 12, textAlign: "center", padding: "14px 0" }}>
              هنوز پیامکی ارسال نشده
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {log.map((m) => {
                const meta = SMS_STATUS_META[m.status] || SMS_STATUS_META.queued;
                return (
                  <div key={m.id} style={{ borderBottom: "1px dashed var(--color-border)", paddingBottom: 7 }}>
                    <div className="flex items-center justify-between">
                      <span className="tabular" dir="ltr" style={{ fontSize: 12, fontWeight: 700 }}>{toFa(m.to_phone)}</span>
                      <span className="badge" style={{ background: meta.color, color: "white" }}>{meta.label}</span>
                    </div>
                    <p className="muted" style={{ fontSize: 11, marginTop: 3, whiteSpace: "pre-wrap" }}>
                      {String(m.body || "").slice(0, 90)}{String(m.body || "").length > 90 ? "…" : ""}
                    </p>
                    <div className="flex items-center gap-1 muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                      <span>{SMS_KIND_LABEL[m.kind] || m.kind}</span>
                      {m.scheduled_for && m.status === "queued" && (
                        <span>· زمان ارسال: {jalaliLabel(new Date(m.scheduled_for), { short: true })} {formatClock(new Date(m.scheduled_for).getHours() * 60 + new Date(m.scheduled_for).getMinutes())}</span>
                      )}
                      {m.error && <span style={{ color: "var(--color-danger)" }}>· {m.error}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
