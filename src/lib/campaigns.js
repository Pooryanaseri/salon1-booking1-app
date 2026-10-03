// ============================================================================
//  One bulk campaign send — shared by the SMS tab's smart-campaign cards and
//  the BI tab's "اقدام پیشنهادی" actions so both record the same rows:
//  campaigns + campaign_targets (who was targeted), campaign_logs (per-send
//  conversion tracking), then the SMS themselves through send-sms.
// ============================================================================
import { createCampaign, addCampaignTargets, logCampaignSend, updateCampaignLogResult } from "./api";
import { sendBulkSms, renderTemplate } from "./sms";
import { toFa } from "./format";

const VALID_PHONE = /^09\d{9}$/;

/** Reachable customers of one RFM segment (rows of get_customer_rfm_segments).
 *  champions_vip isn't a real `segment` value — it's the VIP-flagged subset
 *  of "champions" — so it gets its own filter. */
export function segmentMembers(rfmRows, segmentKey) {
  return (rfmRows || []).filter((c) =>
    (segmentKey === "champions_vip" ? c.segment === "champions" && c.is_vip : c.segment === segmentKey)
    && !c.sms_opt_out && VALID_PHONE.test(c.phone || ""));
}

/**
 * @param {{ name: string, templateId: string, templateLabel: string, segment?: string,
 *           draft: string, recipients: Array<{phone: string, name?: string, vars?: object}> }} opts
 * @returns {Promise<{ok: boolean, demo?: boolean, sent?: number, failed?: number, error?: string, targeted: number}>}
 */
export async function sendCampaign({ name, templateId, templateLabel, segment = null, draft, recipients }) {
  const seen = new Set();
  const members = recipients.filter((r) => {
    if (!VALID_PHONE.test(r.phone || "") || seen.has(r.phone)) return false;
    seen.add(r.phone);
    return true;
  });
  if (!members.length) return { ok: false, error: "گیرنده‌ای برای ارسال یافت نشد", targeted: 0 };

  const campaignId = "cmp-" + Date.now().toString(36);
  await createCampaign({
    id: campaignId, name, inactive_days: null, discount_percent: null,
    template_id: null, valid_until: null, targeted_count: members.length,
  });
  await addCampaignTargets(campaignId, members.map((m) => m.phone));
  const campaignLog = await logCampaignSend({ templateId, templateLabel, segment, totalSent: members.length });

  const res = await sendBulkSms(members.map((m) => ({
    to: m.phone,
    body: renderTemplate(draft, { name: m.name || "مشتری", ...(m.vars || {}) }),
    kind: "campaign",
    campaign_id: campaignId,
    campaign_log_id: campaignLog?.id ?? null,
  })));
  if (campaignLog?.id && typeof res?.sent === "number") await updateCampaignLogResult(campaignLog.id, res.sent);
  return { ...(res || { ok: false }), targeted: members.length };
}

/** Toast text for a sendCampaign result. */
export function campaignResultMessage(res) {
  if (res?.demo) return "حالت دمو — پیامک واقعی ارسال نشد";
  if (res?.ok) return `${toFa(res.sent ?? res.targeted)} پیامک ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`;
  return res?.error || "ارسال ناموفق بود";
}
