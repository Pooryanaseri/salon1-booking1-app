import { useEffect, useMemo, useState } from "react";
import {
  Target, AlertTriangle, TrendingUp, Info, CheckCircle2, Loader2, Wand2, ChevronLeft, Clock, BellOff, X,
  Users, MessageSquareText, CalendarClock, History, ChevronDown, ChevronUp, Sparkles, Send,
} from "lucide-react";
import { Modal } from "../components/ui";
import { toFa, formatToman, jalaliLabel, bookingTimestamp } from "../lib/format";
import { RFM_SMART_DRAFTS } from "../app/shared";
import {
  fetchInactiveCustomers, updateAutomationSettings, setReminderHours,
  queueCampaign, recordBiAction, fetchRecentCampaignPhones,
} from "../lib/api";
import { segmentMembers } from "../lib/campaigns";
import { renderTemplate } from "../lib/sms";
import { getSalonBookingUrl } from "../lib/tenant";
import { fillDayDraft, rankFillDayAudience, smsPartCount } from "./biInsights";

/* ============================================================
   مرکز اقدام (v2.43) — the BI tab's prioritised action list.
   Suggestions → reviewed in a wizard → executed server-side →
   measured in «سابقه و نتیجه». Nothing runs without the manager's
   confirmation; snooze / dismiss are stored per salon.
   ============================================================ */

const PRIORITY = {
  urgent: { label: "فوری", color: "var(--color-danger)" },
  high:   { label: "مهم", color: "var(--color-warning)" },
  normal: { label: "فرصت", color: "var(--color-info)" },
  info:   { label: "نکته", color: "var(--color-muted)" },
};
const CATEGORY = { revenue: "درآمد", retention: "حفظ مشتری", capacity: "ظرفیت", operations: "عملیات", trend: "روند" };
const CONFIDENCE = {
  high:   { label: "اطمینان بالا", color: "var(--color-success)" },
  medium: { label: "اطمینان متوسط", color: "var(--color-warning)" },
  low:    { label: "اطمینان کم", color: "var(--color-muted)" },
};
const AUDIENCE_LABEL = { at_risk: "مشتری‌های در خطر ریزش", new: "مشتری‌های تازه", champions_vip: "مشتری‌های VIP", fill_day: "مشتری‌هایی که بیش از ۳۰ روز نیامده‌اند" };
const FILL_DAY_CAP = 100;
const CAP_DAYS = 14;

const chip = (color) => ({
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 800, color,
  background: `color-mix(in oklch, ${color} 13%, transparent)`, borderRadius: "var(--radius-full)", padding: "2px 8px",
});

export function ActionCenter({ insights, history, onHistoryChange, rfmRows, bookings, automation, onAutomationChange, onReminderHoursSaved, onNavigate, notify }) {
  const [tab, setTab] = useState("suggestions");
  const [wizard, setWizard] = useState(null);       // finding (campaign)
  const [confirming, setConfirming] = useState(null); // finding (automation / reminder)
  const [running, setRunning] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const { actions, notes, totalImpact } = insights;

  async function snooze(f, status) {
    const res = await recordBiAction({ insightKey: f.id, kind: f.action.kind, status, title: f.title, snoozeDays: 7 });
    if (!res?.ok) { notify(res?.error || "ثبت ناموفق بود"); return; }
    if (res.demo) { notify("حالت دمو — بدون دیتابیس ذخیره نمی‌شود"); return; }
    notify(status === "snoozed" ? "تا ۷ روز دیگر نشان داده نمی‌شود" : "این پیشنهاد کنار گذاشته شد");
    onHistoryChange();
  }

  function start(f) {
    if (f.action.kind === "goto") { onNavigate?.(f.action.tab); return; }
    if (f.action.kind === "campaign") setWizard(f);
    else setConfirming(f);
  }

  async function runSetting() {
    const f = confirming;
    const a = f.action;
    setRunning(true);
    try {
      if (a.kind === "automation") {
        const { error, approvedDates } = await updateAutomationSettings(a.patch);
        if (error) { notify("ذخیره ناموفق بود"); return; }
        onAutomationChange?.({ ...automation, ...a.patch }, approvedDates);
      } else if (a.kind === "reminder") {
        const res = await setReminderHours(a.hours);
        if (!res?.ok) { notify(res?.error || "ذخیره ناموفق بود"); return; }
        onReminderHoursSaved?.(a.hours);
      }
      await recordBiAction({ insightKey: f.id, kind: a.kind, title: f.title, params: a.patch || { hours: a.hours }, baseline: baselineOf(f) });
      notify("انجام شد — نتیجه را در «سابقه و نتیجه» دنبال کنید");
      setConfirming(null);
      onHistoryChange();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card mb-4" style={{ padding: 0, overflow: "hidden" }}>
      {/* ---- header ---- */}
      <div style={{ padding: "14px 14px 12px", background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 10%, var(--color-surface)), var(--color-surface))" }}>
        <p className="flex items-center gap-2" style={{ fontSize: 15.5, fontWeight: 800, color: "var(--color-heading)" }}>
          <Target size={17} color="var(--color-accent-700)" /> مرکز اقدام
        </p>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.8 }}>
          مهم‌ترین کارهایی که اعداد همین صفحه پیشنهاد می‌کنند، به ترتیب اثر. هیچ کاری بدون تایید شما انجام نمی‌شود.
        </p>
        <div className="flex gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <span style={chip("var(--color-accent-700)")}><Sparkles size={11} /> {toFa(actions.length)} اقدام پیشنهادی</span>
          {totalImpact > 0 && <span style={chip("var(--color-success)")}>اثر تخمینی: حدود {formatToman(roundToman(totalImpact))}</span>}
        </div>
      </div>

      {/* ---- tabs ---- */}
      <div role="tablist" className="flex" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {[
          { id: "suggestions", label: "پیشنهادها", Icon: Wand2, n: actions.length },
          { id: "history", label: "سابقه و نتیجه", Icon: History, n: history.filter((h) => h.status === "done").length },
        ].map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className="tap flex-1 flex items-center justify-center gap-1.5"
            style={{ padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: tab === t.id ? "var(--color-accent-700)" : "var(--color-muted)",
              borderBottom: `2px solid ${tab === t.id ? "var(--color-accent-500)" : "transparent"}`, background: "transparent" }}>
            <t.Icon size={14} /> {t.label} {t.n > 0 && <span className="tabular" style={{ fontSize: 10.5 }}>({toFa(t.n)})</span>}
          </button>
        ))}
      </div>

      <div style={{ padding: 12 }}>
        {tab === "suggestions" ? (
          <>
            {actions.length === 0 ? (
              <div style={{ textAlign: "center", padding: "18px 8px" }}>
                <CheckCircle2 size={22} color="var(--color-success)" style={{ margin: "0 auto 6px" }} />
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>فعلاً اقدام فوری لازم نیست</p>
                <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>همه‌چیز در محدودهٔ عادی است، یا پیشنهادها را اخیراً انجام داده‌اید.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {actions.map((f, i) => <ActionCard key={f.id} f={f} rank={i + 1} onStart={() => start(f)} onSnooze={() => snooze(f, "snoozed")} onDismiss={() => snooze(f, "dismissed")} />)}
              </div>
            )}
            {notes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <button className="tap flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 800, color: "var(--color-heading)", background: "transparent" }} onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}>
                  {showNotes ? <ChevronUp size={14} /> : <ChevronDown size={14} />} نکته‌های دیگر ({toFa(notes.length)})
                </button>
                {showNotes && (
                  <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
                    {notes.map((f) => <NoteCard key={f.id} f={f} />)}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <HistoryList history={history} bookings={bookings} />
        )}
      </div>

      {wizard && (
        <CampaignWizard f={wizard} rfmRows={rfmRows} bookings={bookings} notify={notify}
          onClose={() => setWizard(null)}
          onDone={() => { setWizard(null); onHistoryChange(); setTab("history"); }} />
      )}

      {confirming && (
        <Modal title="تایید اقدام" onClose={() => !running && setConfirming(null)}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)" }}>{confirming.action.label}</p>
          <p style={{ fontSize: 13, lineHeight: 2, marginTop: 6 }}>{confirming.action.confirm}</p>
          {confirming.impact && (
            <p style={{ fontSize: 12, marginTop: 8, color: "var(--color-success)", fontWeight: 700 }}>
              اثر تخمینی: حدود {formatToman(roundToman(confirming.impact.amount))} {confirming.impact.recurring ? "در ماه" : ""}
            </p>
          )}
          <p className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.9 }}>
            اثر واقعی را بعد از چند هفته در «سابقه و نتیجه» ببینید (مقایسهٔ قبل و بعد). هر وقت خواستید از تنظیمات برمی‌گردد.
          </p>
          <div className="flex gap-2" style={{ marginTop: 16 }}>
            <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "11px 12px" }} disabled={running} onClick={runSetting}>
              {running ? <Loader2 size={15} className="salon-spin" /> : <CheckCircle2 size={15} />} تایید و انجام
            </button>
            <button className="tap ghost-btn flex-1" style={{ padding: "11px 12px" }} disabled={running} onClick={() => setConfirming(null)}>انصراف</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Metrics stored with a setting change so the result can be compared later. */
function baselineOf(f) {
  const ev = Object.fromEntries((f.evidence || []).map((e) => [e.label, e.value]));
  return { finding: f.id, title: f.title, evidence: ev, metric: f.metric || null, measured_at: new Date().toISOString() };
}

const roundToman = (n) => (n >= 1e6 ? Math.round(n / 1e5) * 1e5 : Math.round(n / 1e4) * 1e4);

function ActionCard({ f, rank, onStart, onSnooze, onDismiss }) {
  const [open, setOpen] = useState(false);
  const pr = PRIORITY[f.priority];
  const conf = CONFIDENCE[f.confidence?.level || "low"];
  const ToneIcon = f.tone === "warn" ? AlertTriangle : f.tone === "good" ? TrendingUp : Info;
  return (
    <article style={{ border: "1px solid var(--color-border)", borderInlineStart: `3px solid ${pr.color}`, borderRadius: "var(--radius-md)", padding: "11px 12px", background: "var(--color-surface)" }}>
      <div className="flex items-center gap-1.5" style={{ flexWrap: "wrap" }}>
        <span className="tabular" style={{ ...chip("var(--color-heading)"), background: "var(--color-surface-raised)" }}>{toFa(rank)}</span>
        <span style={chip(pr.color)}>{pr.label}</span>
        <span className="muted" style={{ fontSize: 10.5 }}>{CATEGORY[f.category] || ""}</span>
      </div>
      <p className="flex items-start gap-1.5" style={{ fontSize: 13.5, fontWeight: 800, color: "var(--color-heading)", marginTop: 6 }}>
        <ToneIcon size={15} color={pr.color} style={{ flexShrink: 0, marginTop: 2 }} /> {f.title}
      </p>
      <p style={{ fontSize: 12, lineHeight: 1.95, marginTop: 4 }}>{f.diagnosis}</p>

      {f.evidence?.length > 0 && (
        <div className="flex gap-1.5" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {f.evidence.map((e) => (
            <span key={e.label} className="tabular" style={{ fontSize: 11, padding: "3px 8px", borderRadius: "var(--radius-sm)", background: "var(--color-surface-raised)" }}>
              <span className="muted">{e.label}: </span><b style={{ color: "var(--color-heading)" }}>{e.value}</b>
            </span>
          ))}
        </div>
      )}

      {f.impact && (
        <div style={{ marginTop: 9, padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "color-mix(in oklch, var(--color-success) 8%, transparent)" }}>
          <div className="flex items-center justify-between gap-2" style={{ flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--color-success)" }}>
              اثر تخمینی: حدود {formatToman(roundToman(f.impact.amount))} {f.impact.recurring ? "در ماه" : "(یک‌بار)"}
            </span>
            <span style={chip(conf.color)} title={f.confidence?.reason}>{conf.label}</span>
          </div>
          <button className="tap flex items-center gap-1" style={{ fontSize: 11, marginTop: 4, color: "var(--color-muted)", background: "transparent", minHeight: 0, padding: 0 }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} چطور حساب شد؟
          </button>
          {open && <p className="tabular" style={{ fontSize: 11, lineHeight: 1.9, marginTop: 4 }}>{f.impact.basis}. {f.confidence?.reason}.</p>}
        </div>
      )}

      <div className="flex gap-2" style={{ marginTop: 10 }}>
        <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "8px 10px", fontSize: 12.5 }} onClick={onStart}>
          {f.action.kind === "goto" ? <ChevronLeft size={14} /> : <Wand2 size={14} />} {f.action.label}
        </button>
        <button className="tap ghost-btn" style={{ padding: "8px 10px", fontSize: 11.5 }} onClick={onSnooze} title="تا ۷ روز دیگر نشان نده" aria-label="بعداً">
          <Clock size={13} /> بعداً
        </button>
        <button className="tap ghost-btn" style={{ padding: "8px 10px", fontSize: 11.5 }} onClick={onDismiss} title="این پیشنهاد را کنار بگذار" aria-label="نادیده بگیر">
          <BellOff size={13} />
        </button>
      </div>
    </article>
  );
}

function NoteCard({ f }) {
  const color = f.tone === "good" ? "var(--color-success)" : f.tone === "warn" ? "var(--color-warning)" : "var(--color-info)";
  return (
    <div style={{ padding: "9px 11px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", borderInlineStart: `3px solid ${color}` }}>
      <p style={{ fontSize: 12.5, fontWeight: 800, color: "var(--color-heading)" }}>{f.title}</p>
      <p style={{ fontSize: 11.5, lineHeight: 1.9, marginTop: 3 }}>{f.diagnosis}</p>
      {f.evidence?.length > 0 && (
        <p className="muted tabular" style={{ fontSize: 11, marginTop: 4 }}>{f.evidence.map((e) => `${e.label}: ${e.value}`).join(" · ")}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- wizard */
const STEPS = [
  { id: "audience", label: "مخاطبان", Icon: Users },
  { id: "message", label: "متن پیامک", Icon: MessageSquareText },
  { id: "timing", label: "زمان و تایید", Icon: CalendarClock },
];

function tehranNow() {
  // wall clock in the salon's zone (Iran has no DST since 2022)
  const d = new Date(Date.now() + 210 * 60000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}
/** UTC instant for "today/tomorrow at HH:00" in Tehran. */
function tehranAt(dayOffset, hour) {
  const now = new Date(Date.now() + 210 * 60000);
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, 0, 0) - 210 * 60000;
  return new Date(t);
}

function CampaignWizard({ f, rfmRows, bookings, notify, onClose, onDone }) {
  const a = f.action;
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [audience, setAudience] = useState([]);   // [{phone, name, vars, note}]
  const [recent, setRecent] = useState(new Set());
  const [excluded, setExcluded] = useState(new Set());
  const [body, setBody] = useState("");
  const [timing, setTiming] = useState("now");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list = [];
      if (a.audience === "segment") {
        list = segmentMembers(rfmRows, a.segment).map((c) => ({
          phone: c.phone, name: c.name, vars: { days: toFa(c.recency_days ?? "") },
          note: c.recency_days != null ? `${toFa(c.recency_days)} روز پیش` : "",
        }));
        setBody(RFM_SMART_DRAFTS[a.segment] || "");
      } else {
        const lapsed = await fetchInactiveCustomers(30);
        list = rankFillDayAudience(lapsed, bookings, { dKey: a.dKey, weekday: a.weekday, cap: FILL_DAY_CAP })
          .map((c) => ({ phone: c.phone, name: c.name, vars: { days: toFa(c.days_since ?? "") },
            note: c.habit > 0 ? `${toFa(c.habit)} بار همین روز هفته آمده` : `${toFa(c.days_since ?? "")} روز پیش` }));
        setBody(fillDayDraft(a.dayLabel, getSalonBookingUrl()));
      }
      const recentPhones = await fetchRecentCampaignPhones(CAP_DAYS);
      if (cancelled) return;
      setAudience(list);
      setRecent(recentPhones);
      setExcluded(new Set(list.filter((r) => recentPhones.has(r.phone)).map((r) => r.phone)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // the wizard loads its audience once when opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = useMemo(() => audience.filter((r) => !excluded.has(r.phone)), [audience, excluded]);
  const parts = smsPartCount(renderTemplate(body, { name: chosen[0]?.name || "مشتری", ...(chosen[0]?.vars || {}) }));
  const quiet = (() => { const h = tehranNow().hour; return h < 9 || h >= 21; })();
  const timingOptions = [
    { id: "now", label: quiet ? "همین حالا (ساعت سکوت است؛ ساعت ۱۰ صبح ارسال می‌شود)" : "همین حالا" },
    ...(tehranNow().hour < 17 ? [{ id: "evening", label: "امروز ساعت ۱۸" }] : []),
    { id: "tomorrow", label: "فردا ساعت ۱۰ صبح" },
  ];
  const sendAt = timing === "evening" ? tehranAt(0, 18) : timing === "tomorrow" ? tehranAt(1, 10) : null;

  function toggle(phone) {
    setExcluded((prev) => { const n = new Set(prev); if (n.has(phone)) n.delete(phone); else n.add(phone); return n; });
  }

  async function submit() {
    setSending(true);
    const res = await queueCampaign({
      insightKey: f.id,
      title: f.action.label + (a.dayLabel ? ` — ${a.dayLabel}` : ""),
      segment: a.segment,
      body,
      recipients: chosen.map((r) => ({ phone: r.phone, name: r.name || "", vars: r.vars || {} })),
      sendAt: sendAt ? sendAt.toISOString() : null,
      capDays: CAP_DAYS,
      baseline: { finding: f.id, title: f.title, audience: chosen.length, estimate: f.impact?.amount ?? null },
    });
    setSending(false);
    if (res?.demo) { notify(res.error); return; }
    if (!res?.ok) { notify(res?.error || "ثبت کمپین ناموفق بود"); return; }
    setResult(res);
  }

  const canNext = step === 0 ? chosen.length > 0 : step === 1 ? body.trim().length > 0 : true;

  return (
    <Modal title={f.action.label} onClose={() => !sending && onClose()} wide>
      {result ? (
        <div style={{ textAlign: "center", padding: "8px 4px" }}>
          <CheckCircle2 size={34} color="var(--color-success)" style={{ margin: "0 auto 8px" }} />
          <p style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(result.queued)} پیامک در صف ارسال</p>
          <p className="muted tabular" style={{ fontSize: 12, marginTop: 6, lineHeight: 2 }}>
            {result.deferred ? `ارسال: ${jalaliLabel(new Date(result.send_at))} ساعت ${toFa(new Date(new Date(result.send_at).getTime() + 210 * 60000).getUTCHours())}` : "ارسال ظرف یک دقیقه"}
            {result.skipped_opt_out > 0 && ` · ${toFa(result.skipped_opt_out)} نفر انصراف داده بودند`}
            {result.skipped_recent > 0 && ` · ${toFa(result.skipped_recent)} نفر اخیراً پیامک گرفته بودند`}
          </p>
          <p style={{ fontSize: 12, marginTop: 10, lineHeight: 1.9 }}>نتیجه (چند نفر نوبت گرفتند و چقدر درآمد آورد) تا ۷ روز در «سابقه و نتیجه» اندازه‌گیری می‌شود.</p>
          <button className="tap accent-btn w-full" style={{ padding: 11, marginTop: 14 }} onClick={onDone}>دیدن سابقه</button>
        </div>
      ) : (
        <>
          {/* stepper */}
          <ol className="flex gap-1.5" style={{ listStyle: "none", padding: 0, margin: "0 0 14px" }}>
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex-1 flex items-center justify-center gap-1" aria-current={i === step ? "step" : undefined}
                style={{ fontSize: 11.5, fontWeight: 800, padding: "6px 4px", borderRadius: "var(--radius-sm)",
                  color: i === step ? "white" : i < step ? "var(--color-success)" : "var(--color-muted)",
                  background: i === step ? "var(--color-accent-500)" : "var(--color-surface-raised)" }}>
                {i < step ? <CheckCircle2 size={12} /> : <s.Icon size={12} />} {s.label}
              </li>
            ))}
          </ol>

          {loading ? (
            <Loader2 size={22} className="salon-spin" style={{ display: "block", margin: "24px auto" }} />
          ) : step === 0 ? (
            <div>
              <p style={{ fontSize: 13, fontWeight: 800, color: "var(--color-heading)" }}>{AUDIENCE_LABEL[a.segment] || "مخاطبان"}</p>
              <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.9 }}>
                {toFa(chosen.length)} نفر انتخاب شده از {toFa(audience.length)}.
                {[...recent].filter((p) => audience.some((r) => r.phone === p)).length > 0 && ` ${toFa([...recent].filter((p) => audience.some((r) => r.phone === p)).length)} نفر در ${toFa(CAP_DAYS)} روز گذشته پیامک تبلیغاتی گرفته‌اند و کنار گذاشته شدند.`}
                {" "}کسانی که انصراف داده‌اند از قبل حذف شده‌اند.
              </p>
              {audience.length === 0 ? (
                <p style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 12 }}>مخاطبی پیدا نشد.</p>
              ) : (
                <>
                  <div className="flex gap-2" style={{ marginTop: 8 }}>
                    <button className="tap ghost-btn" style={{ padding: "5px 10px", fontSize: 11.5 }} onClick={() => setExcluded(new Set([...recent].filter((p) => audience.some((r) => r.phone === p))))}>انتخاب همه</button>
                    <button className="tap ghost-btn" style={{ padding: "5px 10px", fontSize: 11.5 }} onClick={() => setExcluded(new Set(audience.map((r) => r.phone)))}>هیچ‌کدام</button>
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", maxHeight: 260, overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
                    {audience.map((r) => {
                      const isRecent = recent.has(r.phone);
                      return (
                        <li key={r.phone} style={{ borderBottom: "1px solid var(--color-border)" }}>
                          <label className="flex items-center gap-2" style={{ padding: "7px 10px", fontSize: 12.5, cursor: isRecent ? "not-allowed" : "pointer", opacity: isRecent ? 0.55 : 1 }}>
                            <input type="checkbox" checked={!excluded.has(r.phone)} disabled={isRecent} onChange={() => toggle(r.phone)} />
                            <span style={{ flex: 1, fontWeight: 700, color: "var(--color-heading)" }}>{r.name || "بدون نام"}</span>
                            <span className="muted tabular" style={{ fontSize: 11 }}>{isRecent ? "پیامک اخیر" : r.note}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          ) : step === 1 ? (
            <div>
              <label htmlFor="ac-body" style={{ fontSize: 13, fontWeight: 800, color: "var(--color-heading)" }}>متن پیامک</label>
              <textarea id="ac-body" value={body} onChange={(e) => setBody(e.target.value)} rows={5}
                style={{ width: "100%", marginTop: 6, padding: "10px 12px", fontSize: 13, lineHeight: 1.9, borderRadius: "var(--radius-md)", resize: "vertical" }} />
              <div className="flex gap-1.5" style={{ marginTop: 6, flexWrap: "wrap" }}>
                {[{ t: "{{name}}", l: "نام مشتری" }, { t: "{{salon}}", l: "نام سالن" }, ...(a.audience === "segment" ? [{ t: "{{days}}", l: "روز از آخرین مراجعه" }] : [])].map((p) => (
                  <button key={p.t} className="tap ghost-btn" style={{ padding: "3px 8px", fontSize: 11, minHeight: 0 }} onClick={() => setBody((b) => `${b}${b.endsWith(" ") || !b ? "" : " "}${p.t}`)}>+ {p.l}</button>
                ))}
              </div>
              <p style={{ fontSize: 11.5, fontWeight: 800, marginTop: 12, color: "var(--color-heading)" }}>پیش‌نمایش برای {chosen[0]?.name || "مشتری"}:</p>
              <div style={{ marginTop: 6, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", fontSize: 12.5, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
                {renderTemplate(body, { name: chosen[0]?.name || "مشتری", ...(chosen[0]?.vars || {}) })}
              </div>
              <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 6 }}>
                {toFa(parts)} بخش پیامک برای هر نفر · حدود {toFa(parts * chosen.length)} بخش در کل
                {parts > 2 ? " — متن کوتاه‌تر هزینه را کم می‌کند" : ""}
              </p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 13, fontWeight: 800, color: "var(--color-heading)" }}>زمان ارسال</p>
              <div role="radiogroup" className="flex flex-col gap-1.5" style={{ marginTop: 8 }}>
                {timingOptions.map((o) => (
                  <label key={o.id} className="flex items-center gap-2" style={{ fontSize: 12.5, padding: "8px 10px", borderRadius: "var(--radius-md)", cursor: "pointer",
                    border: `1px solid ${timing === o.id ? "var(--color-accent-500)" : "var(--color-border)"}` }}>
                    <input type="radio" name="ac-timing" checked={timing === o.id} onChange={() => setTiming(o.id)} /> {o.label}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", fontSize: 12.5, lineHeight: 2 }}>
                <div className="flex justify-between"><span className="muted">گیرنده</span><b className="tabular">{toFa(chosen.length)} نفر</b></div>
                <div className="flex justify-between"><span className="muted">بخش پیامک</span><b className="tabular">حدود {toFa(parts * chosen.length)}</b></div>
                {f.impact && <div className="flex justify-between"><span className="muted">اثر تخمینی</span><b className="tabular" style={{ color: "var(--color-success)" }}>حدود {formatToman(roundToman(f.impact.amount))}</b></div>}
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.9 }}>
                قوانین سرور: به انصرافی‌ها و کسی که در {toFa(CAP_DAYS)} روز گذشته پیامک تبلیغاتی گرفته ارسال نمی‌شود؛ بین ساعت ۲۱ تا ۹ ارسال به ساعت ۱۰ صبح منتقل می‌شود.
              </p>
            </div>
          )}

          {!loading && (
            <div className="flex gap-2" style={{ marginTop: 16 }}>
              {step < 2 ? (
                <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "11px 12px" }} disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                  ادامه <ChevronLeft size={15} />
                </button>
              ) : (
                <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "11px 12px" }} disabled={sending || chosen.length === 0} onClick={submit}>
                  {sending ? <Loader2 size={15} className="salon-spin" /> : <Send size={15} />} تایید و ارسال
                </button>
              )}
              <button className="tap ghost-btn flex-1" style={{ padding: "11px 12px" }} disabled={sending} onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}>
                {step === 0 ? "انصراف" : "قبلی"}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- history */
function noShowRateSince(bookings, sinceTs) {
  const after = bookings.filter((b) => bookingTimestamp(b) >= sinceTs && bookingTimestamp(b) < Date.now()
    && ["completed", "no_show"].includes(b.status));
  if (after.length < 5) return null;
  return after.filter((b) => b.status === "no_show").length / after.length;
}

function HistoryList({ history, bookings }) {
  if (!history.length) {
    return <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "16px 8px" }}>هنوز اقدامی ثبت نشده. نتیجهٔ هر اقدام اینجا اندازه‌گیری می‌شود.</p>;
  }
  return (
    <ul className="flex flex-col gap-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {history.map((h) => <HistoryRow key={h.id} h={h} bookings={bookings} />)}
    </ul>
  );
}

function HistoryRow({ h, bookings }) {
  const date = new Date(h.created_at);
  let status = null, result = null, color = "var(--color-muted)", Icon = CheckCircle2;
  if (h.status === "snoozed") { Icon = Clock; status = `به تعویق افتاد${h.until ? ` تا ${jalaliLabel(new Date(h.until), { short: true })}` : ""}`; }
  else if (h.status === "dismissed") { Icon = X; status = "کنار گذاشته شد"; }
  else if (h.kind === "campaign") {
    color = "var(--color-accent-700)"; Icon = Send;
    const total = (h.sms_sent || 0) + (h.sms_queued || 0) + (h.sms_failed || 0);
    status = `${toFa(total)} پیامک · ${toFa(h.sms_sent)} ارسال‌شده${h.sms_queued ? ` · ${toFa(h.sms_queued)} در صف` : ""}${h.sms_failed ? ` · ${toFa(h.sms_failed)} ناموفق` : ""}`;
    const measuring = h.measure_until && new Date(h.measure_until).getTime() > Date.now();
    const rate = h.sms_sent > 0 ? h.conversions / h.sms_sent : 0;
    result = (
      <span style={{ color: h.conversions > 0 ? "var(--color-success)" : "var(--color-muted)", fontWeight: 800 }}>
        {measuring ? "در حال سنجش" : "نتیجه"}: {toFa(h.conversions)} نفر نوبت گرفتند{h.sms_sent > 0 ? ` (${toFa(Math.round(rate * 100))}٪)` : ""}
        {h.revenue > 0 ? ` · ${formatToman(h.revenue)} درآمد` : ""}
        {measuring ? ` — ${toFa(Math.max(1, Math.ceil((new Date(h.measure_until).getTime() - Date.now()) / 86400000)))} روز دیگر` : ""}
      </span>
    );
  } else {
    color = "var(--color-success)"; Icon = CheckCircle2;
    status = "تنظیم روشن شد";
    if (h.insight_key === "no-show") {
      const before = h.baseline?.metric?.key === "no_show_rate" ? h.baseline.metric.value : null;
      const after = noShowRateSince(bookings, date.getTime());
      result = after == null
        ? <span className="muted">نتیجه بعد از چند نوبت دیگر نشان داده می‌شود</span>
        : (
          <span style={{ fontWeight: 800, color: before != null && after < before ? "var(--color-success)" : undefined }}>
            عدم حضور: {before != null ? `${toFa(Math.round(before * 100))}٪ ← ` : ""}{toFa(Math.round(after * 100))}٪ (از روز اجرا)
          </span>
        );
    }
  }
  return (
    <li style={{ padding: "9px 11px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center gap-2">
        <Icon size={14} color={color} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: "var(--color-heading)" }}>{h.title || h.insight_key}</span>
        <span className="muted tabular" style={{ fontSize: 10.5 }}>{jalaliLabel(date, { short: true })}</span>
      </div>
      {status && <p className="muted tabular" style={{ fontSize: 11.5, marginTop: 4 }}>{status}</p>}
      {result && <p className="tabular" style={{ fontSize: 11.5, marginTop: 3 }}>{result}</p>}
    </li>
  );
}
