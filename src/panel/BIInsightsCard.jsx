import { useState } from "react";
import { Lightbulb, AlertTriangle, TrendingUp, Info, CheckCircle2, Loader2, Wand2, ChevronLeft } from "lucide-react";
import { Modal } from "../components/ui";
import { toFa } from "../lib/format";
import { RFM_SMART_DRAFTS } from "../app/shared";
import { RFM_SEGMENT_META } from "./biCards";
import { fetchInactiveCustomers, updateAutomationSettings, setReminderHours } from "../lib/api";
import { sendCampaign, campaignResultMessage, segmentMembers } from "../lib/campaigns";
import { renderTemplate } from "../lib/sms";
import { getSalonBookingUrl } from "../lib/tenant";
import { fillDayDraft } from "./biInsights";

// A sent campaign stays marked "انجام شد" for two weeks so the same SMS isn't
// sent twice by accident; settings actions need no mark (the finding itself
// changes once the switch is on).
const DONE_TTL = 14 * 86400000;
const FILL_DAY_CAP = 100;
const doneKey = (id) => `bi-action-done:${id}`;
function readDone(id) {
  try {
    const ts = Number(localStorage.getItem(doneKey(id)));
    return ts && Date.now() - ts < DONE_TTL ? ts : null;
  } catch { return null; }
}
function markDone(id) {
  try { localStorage.setItem(doneKey(id), String(Date.now())); } catch { /* private mode */ }
}

const TONE = {
  warn: { Icon: AlertTriangle, color: "var(--color-warning)" },
  info: { Icon: Info, color: "var(--color-info)" },
  good: { Icon: TrendingUp, color: "var(--color-success)" },
};

export function BIInsightsCard({ insights, rfmRows, automation, onAutomationChange, onReminderHoursSaved, onNavigate, notify }) {
  const [confirming, setConfirming] = useState(null); // { insight, recipients?, preview? }
  const [preparing, setPreparing] = useState(null);   // insight id while loading recipients
  const [running, setRunning] = useState(false);
  const [, bump] = useState(0);

  async function open(insight) {
    const a = insight.action;
    if (a.kind === "goto") { onNavigate?.(a.tab); return; }
    if (a.kind === "campaign") {
      const recipients = segmentMembers(rfmRows, a.segment).map((c) => ({ phone: c.phone, name: c.name, vars: { days: toFa(c.recency_days ?? "") } }));
      const draft = RFM_SMART_DRAFTS[a.segment];
      setConfirming({ insight, recipients, draft, preview: renderTemplate(draft, { name: recipients[0]?.name || "مشتری", days: recipients[0]?.vars.days }) });
      return;
    }
    if (a.kind === "fill_day") {
      setPreparing(insight.id);
      const list = (await fetchInactiveCustomers(30)).slice(0, FILL_DAY_CAP);
      setPreparing(null);
      const draft = fillDayDraft(a.dayLabel, getSalonBookingUrl());
      setConfirming({ insight, recipients: list.map((c) => ({ phone: c.phone, name: c.name })), draft, preview: renderTemplate(draft, { name: list[0]?.name || "مشتری" }) });
      return;
    }
    setConfirming({ insight });
  }

  async function run() {
    const { insight, recipients, draft } = confirming;
    const a = insight.action;
    setRunning(true);
    try {
      if (a.kind === "campaign" || a.kind === "fill_day") {
        const label = a.kind === "campaign" ? RFM_SEGMENT_META[a.segment]?.label || a.segment : `پر کردن ${a.dayLabel}`;
        const res = await sendCampaign({
          name: `اقدام هوش تجاری — ${label}`,
          templateId: a.kind === "campaign" ? a.segment : "bi_fill_day",
          templateLabel: label,
          segment: a.kind === "campaign" ? a.segment : null,
          draft,
          recipients,
        });
        notify(campaignResultMessage(res));
        if (res?.ok) { markDone(insight.id); bump((n) => n + 1); }
        else if (!res?.demo) return; // keep the sheet open so it can be retried
      } else if (a.kind === "automation") {
        const { error, approvedDates } = await updateAutomationSettings(a.patch);
        if (error) { notify("ذخیره ناموفق بود"); return; }
        onAutomationChange?.({ ...automation, ...a.patch }, approvedDates);
        notify("انجام شد");
      } else if (a.kind === "reminder") {
        const res = await setReminderHours(a.hours);
        if (!res?.ok) { notify(res?.error || "ذخیره ناموفق بود"); return; }
        onReminderHoursSaved?.(a.hours);
        notify("پیامک یادآوری روشن شد");
      }
      setConfirming(null);
    } finally {
      setRunning(false);
    }
  }

  const needsRecipients = confirming && ["campaign", "fill_day"].includes(confirming.insight.action.kind);
  const noRecipients = needsRecipients && !confirming.recipients?.length;

  return (
    <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 7%, var(--color-surface)), var(--color-surface))" }}>
      <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 4 }}>
        <Lightbulb size={16} color="var(--color-accent-700)" /> تحلیل و اقدام پیشنهادی
      </p>
      <p className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
        از روی اعداد همین صفحه. با «انجام بده» برنامه کار را انجام می‌دهد؛ فقط بعد از تایید شما.
      </p>

      {insights.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          فعلاً نکتهٔ مهمی نیست. همه‌چیز در محدودهٔ عادی است (یا هنوز دادهٔ کافی در این بازه نیست).
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {insights.map((ins) => {
            const { Icon, color } = TONE[ins.tone];
            const doneAt = ins.action && ["campaign", "fill_day"].includes(ins.action.kind) ? readDone(ins.id) : null;
            return (
              <div key={ins.id} style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderInlineStart: `3px solid ${color}` }}>
                <p className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 800, color: "var(--color-heading)" }}>
                  <Icon size={14} color={color} style={{ flexShrink: 0 }} /> {ins.title}
                </p>
                <p style={{ fontSize: 12, lineHeight: 1.9, marginTop: 4, color: "var(--color-text)" }}>{ins.text}</p>
                {ins.action && (doneAt ? (
                  <p className="flex items-center gap-1" style={{ fontSize: 11.5, color: "var(--color-success)", marginTop: 6, fontWeight: 700 }}>
                    <CheckCircle2 size={13} /> انجام شد ({new Date(doneAt).toLocaleDateString("fa-IR")})
                  </p>
                ) : (
                  <button
                    className="tap accent-btn flex items-center justify-center gap-1.5"
                    style={{ marginTop: 8, padding: "7px 12px", fontSize: 12, width: "100%" }}
                    disabled={preparing === ins.id}
                    onClick={() => open(ins)}
                  >
                    {preparing === ins.id ? <Loader2 size={13} className="salon-spin" /> : ins.action.kind === "goto" ? <ChevronLeft size={13} /> : <Wand2 size={13} />}
                    {ins.action.kind === "goto" ? ins.action.label : `انجام بده: ${ins.action.label}`}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {confirming && (
        <Modal title="تایید اقدام" onClose={() => !running && setConfirming(null)}>
          <p style={{ fontSize: 14, fontWeight: 800, color: "var(--color-heading)", marginBottom: 6 }}>{confirming.insight.action.label}</p>
          <p style={{ fontSize: 13, lineHeight: 2 }}>{confirming.insight.action.confirm}</p>
          {needsRecipients && (
            noRecipients ? (
              <p style={{ fontSize: 12.5, color: "var(--color-danger)", marginTop: 10 }}>گیرنده‌ای پیدا نشد (یا همه لغو اشتراک پیامک کرده‌اند).</p>
            ) : (
              <>
                <p className="tabular" style={{ fontSize: 12.5, marginTop: 10, fontWeight: 700 }}>تعداد گیرنده: {toFa(confirming.recipients.length)} نفر</p>
                <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", fontSize: 12.5, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
                  {confirming.preview}
                </div>
              </>
            )
          )}
          <div className="flex gap-2" style={{ marginTop: 16 }}>
            <button className="tap accent-btn flex-1 flex items-center justify-center gap-1.5" style={{ padding: "11px 12px" }} disabled={running || noRecipients} onClick={run}>
              {running ? <Loader2 size={15} className="salon-spin" /> : <CheckCircle2 size={15} />} تایید و انجام
            </button>
            <button className="tap ghost-btn flex-1" style={{ padding: "11px 12px" }} disabled={running} onClick={() => setConfirming(null)}>انصراف</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
