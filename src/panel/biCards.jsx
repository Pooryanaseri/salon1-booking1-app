import React, { useState, useEffect, useMemo } from "react";
import { useData } from "../hooks/useData";
import { Scissors, Palette, Sparkles, Hand, Eye, Droplet, SlidersHorizontal, LayoutGrid, TrendingUp, Users, Layers, Send, Loader2, AlertTriangle, RefreshCw, Star } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { fetchFeedbackStats, fetchCampaigns, fetchRfmSegments, fetchCategoryMatrix, fetchCampaignPerformance, fetchSegmentSettings, updateSegmentSettings, previewSegmentDistribution } from "../lib/api";
import { sendBulkSms, renderTemplate } from "../lib/sms";
import { toFa, formatToman, jalaliLabel } from "../lib/format";
import { CATEGORY_LABEL } from "../app/shared";
import { Modal } from "../components/ui";

// Surfaces the win-back campaign data that SmsTab already writes to the
// database (campaigns / campaign_targets) — this card is the "missing"
// display piece the phase-3 changelog flagged.
export function CampaignReturnRateCard() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setCampaigns(await fetchCampaigns());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <RefreshCw size={13} color="var(--color-accent-700)" /> نرخ بازگشت کمپین‌های جذب مجدد
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={load} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED && (
        <p className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>در حالت دمو، کمپین‌ها از سرور خوانده نمی‌شوند.</p>
      )}
      {SUPABASE_ENABLED && campaigns.length === 0 && !loading && (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز کمپینی از تب «پیامک» ارسال نشده</p>
      )}

      <div className="flex flex-col gap-2">
        {campaigns.slice(0, 8).map((c) => {
          const denom = c.sent_count > 0 ? c.sent_count : c.targeted_count;
          const rate = denom > 0 ? (c.returned_count / denom) * 100 : null;
          return (
            <div key={c.id} style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.name || "کمپین بدون نام"}</span>
                <span className="tabular" style={{ fontSize: 13, fontWeight: 800, color: rate == null ? "var(--color-muted)" : rate >= 15 ? "var(--color-success)" : "var(--color-heading)" }}>
                  {rate == null ? "—" : `${toFa(Math.round(rate))}٪`}
                </span>
              </div>
              <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 2 }}>
                {toFa(c.targeted_count)} هدف · {toFa(c.sent_count)} ارسال‌شده · {toFa(c.returned_count)} بازگشته
                {c.created_at && <> · {jalaliLabel(new Date(c.created_at), { withWeekday: false })}</>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const RFM_SEGMENT_META = {
  champions: { label: "مشتریان وفادار", emoji: "👑", color: "var(--color-accent-500)" },
  champions_vip: { label: "وفادار ویژه VIP", emoji: "💎", color: "var(--color-tab-panel)" },
  at_risk: { label: "در خطر ریزش", emoji: "🚨", color: "var(--color-danger)" },
  new: { label: "مشتریان جدید", emoji: "🌱", color: "var(--color-success)" },
  inactive: { label: "غیرفعال", emoji: "💤", color: "var(--color-muted)" },
};
// The database's `segment` column only ever returns these 4 values —
// champions_vip above is a display-only entry (VIP is a boolean flag
// WITHIN champions, not a 5th segment value) used by the smart-campaigns
// list and the member-list badge, so it's deliberately excluded here.
export const RFM_BASE_SEGMENT_KEYS = ["champions", "at_risk", "new", "inactive"];

// Reads the get_customer_rfm_segments() RPC directly — a separate data source from
// the bookings prop, so it fetches and refreshes on its own.
// Manager-only: configure the thresholds that drive customer segmentation.
// Mirrors the loyalty-settings form pattern (load → edit locally → save),
// plus a live preview against hypothetical values before committing.
export function SegmentSettingsCard({ notify }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recency, setRecency] = useState(60);
  const [visits, setVisits] = useState(4);
  const [inactiveAfter, setInactiveAfter] = useState(120);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const s = await fetchSegmentSettings();
      if (s) {
        setRecency(s.loyal_recency_days);
        setVisits(s.loyal_min_visits);
        setInactiveAfter(s.inactive_after_days);
      }
      setLoading(false);
    })();
  }, []);

  const rangeValid = inactiveAfter > recency;

  async function handlePreview() {
    if (!rangeValid) return;
    setPreviewLoading(true);
    setPreview(await previewSegmentDistribution({ recency, visits, inactive: inactiveAfter }));
    setPreviewLoading(false);
  }

  async function handleSave() {
    if (!rangeValid) { notify("روز «غیرفعال» باید بیشتر از روز «وفادار» باشد"); return; }
    setSaving(true);
    await updateSegmentSettings({ loyal_recency_days: recency, loyal_min_visits: visits, inactive_after_days: inactiveAfter });
    setSaving(false);
    notify("تنظیمات دسته‌بندی مشتریان ذخیره شد");
  }

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", marginBottom: 10 }}>
        <SlidersHorizontal size={14} color="var(--color-accent-700)" /> تنظیمات دسته‌بندی هوشمند مشتریان
      </p>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : loading ? (
        <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>حداکثر روز از آخرین ویزیت برای «وفادار»</label>
              <input
                type="number" min="1" max="365" value={recency}
                onChange={(e) => setRecency(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                مشتری‌ای که ظرف {toFa(recency)} روز اخیر نوبت تکمیل‌شده داشته، «به‌روز» حساب می‌شود
              </p>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>حداقل تعداد ویزیت برای «وفادار»</label>
              <input
                type="number" min="1" max="100" value={visits}
                onChange={(e) => setVisits(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                {toFa(visits)} ویزیت تکمیل‌شده یا بیشتر، مشتری را «پرتردد» می‌کند
              </p>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>روز عدم مراجعه برای «غیرفعال»</label>
              <input
                type="number" min="1" max="365" value={inactiveAfter}
                onChange={(e) => setInactiveAfter(Number(e.target.value))}
                className="tabular" style={{ width: "100%", padding: "9px 10px", fontSize: 13, marginTop: 4 }}
              />
              {rangeValid ? (
                <p className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                  مشتری وفاداری که بین آستانهٔ «وفادار» بالا و این عدد لپس کرده «در خطر ریزش» است؛
                  فراتر از این عدد (یا اگر هیچ‌وقت وفادار نبوده) «غیرفعال» حساب می‌شود
                </p>
              ) : (
                <p style={{ fontSize: 10.5, marginTop: 3, color: "var(--color-danger)" }}>باید بزرگ‌تر از {toFa(recency)} باشد</p>
              )}
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <button disabled={previewLoading || !rangeValid} className="tap ghost-btn flex-1" style={{ padding: 10, fontSize: 12.5 }} onClick={handlePreview}>
              {previewLoading ? "در حال محاسبه..." : "پیش‌نمایش توزیع مشتریان"}
            </button>
            <button disabled={saving || !rangeValid} className="tap accent-btn flex-1" style={{ padding: 10, fontSize: 12.5 }} onClick={handleSave}>
              {saving ? "در حال ذخیره..." : "ذخیره تنظیمات"}
            </button>
          </div>

          {preview && (
            <div className="fade-in" style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {preview.map((p) => {
                const meta = RFM_SEGMENT_META[p.segment] || { color: "var(--color-muted)" };
                return (
                  <div key={p.segment} style={{ padding: 10, borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 10%, var(--color-surface-raised))` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-heading)" }}>{p.segment_fa}</div>
                    <div className="tabular" style={{ fontSize: 15, fontWeight: 800, color: meta.color }}>{toFa(p.customer_count)} نفر</div>
                    <div className="muted tabular" style={{ fontSize: 10 }}>{toFa(p.pct)}٪</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RfmSegmentsCard({ onSendToSegment }) {
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openSegment, setOpenSegment] = useState(null); // segment key currently drilled into

  async function load() {
    setLoading(true);
    setSegments(await fetchRfmSegments());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const bySegment = useMemo(() => {
    const map = new Map();
    for (const s of segments) map.set(s.segment, (map.get(s.segment) || 0) + 1);
    const total = segments.length || 1;
    return RFM_BASE_SEGMENT_KEYS.map((key) => ({
      key, meta: RFM_SEGMENT_META[key], count: map.get(key) || 0, pct: ((map.get(key) || 0) / total) * 100,
    }));
  }, [segments]);

  // Members of the currently open segment, most valuable (highest revenue) first.
  const openMembers = useMemo(() => {
    if (!openSegment) return [];
    return segments.filter((s) => s.segment === openSegment).sort((a, b) => (b.monetary || 0) - (a.monetary || 0));
  }, [segments, openSegment]);

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <Layers size={13} color="var(--color-accent-700)" /> سگمنت‌بندی مشتریان (RFM)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={load} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>سگمنت‌بندی RFM به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : segments.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز مشتری‌ای برای سگمنت‌بندی یافت نشد</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {bySegment.map(({ key, meta, count, pct }) => (
            <button
              key={key}
              onClick={() => count > 0 && setOpenSegment(key)}
              className="tap"
              style={{ padding: "12px 10px 10px", borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))`, position: "relative", overflow: "hidden", textAlign: "right", cursor: count > 0 ? "pointer" : "default" }}
            >
              <div style={{ position: "absolute", top: 0, insetInlineStart: 0, insetInlineEnd: 0, height: 3, background: `color-mix(in oklch, ${meta.color} 80%, transparent)` }} />
              <div
                style={{
                  width: 30, height: 30, borderRadius: "var(--radius-md)", fontSize: 15,
                  background: `color-mix(in oklch, ${meta.color} 16%, transparent)`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {meta.emoji}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-heading)", marginTop: 6, lineHeight: 1.5 }}>{meta.label}</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: meta.color, marginTop: 4 }}>{toFa(count)} نفر</div>
              <div className="muted tabular" style={{ fontSize: 10.5 }}>{toFa(Math.round(pct))}٪ از کل</div>
              {count > 0 && (
                <span className="flex items-center gap-1" style={{ marginTop: 6, fontSize: 10.5, fontWeight: 700, color: meta.color }}>
                  <Users size={10} /> مشاهدهٔ اعضا
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {openSegment && (
        <Modal title={`${RFM_SEGMENT_META[openSegment].emoji} ${RFM_SEGMENT_META[openSegment].label} (${toFa(openMembers.length)} نفر)`} onClose={() => setOpenSegment(null)}>
          <div className="flex flex-col gap-2" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {openMembers.map((m, i) => (
              <div key={m.phone} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                <span className="tabular" style={{ width: 20, height: 20, borderRadius: "50%", background: `color-mix(in oklch, ${RFM_SEGMENT_META[openSegment].color} 16%, transparent)`, color: RFM_SEGMENT_META[openSegment].color, fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {toFa(i + 1)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center gap-1.5">
                    <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{m.name || "بدون نام"}</span>
                    {m.is_vip && (
                      <span className="badge" style={{ background: "var(--color-tab-panel)", color: "white", fontSize: 9.5 }}>💎 VIP</span>
                    )}
                  </div>
                  <div className="muted tabular" style={{ fontSize: 10.5 }} dir="ltr">{toFa(m.phone)}</div>
                </div>
                <div style={{ textAlign: "left" }}>
                  <div className="tabular" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(m.monetary || 0)}</div>
                  <div className="muted tabular" style={{ fontSize: 10 }}>{toFa(m.frequency || 0)} ویزیت · {toFa(m.recency_days ?? 0)} روز پیش</div>
                </div>
              </div>
            ))}
          </div>
          {openSegment === "champions" && openMembers.some((m) => m.is_vip) && (
            <button
              className="tap w-full mt-3 flex items-center justify-center gap-1.5"
              style={{ padding: 10, fontSize: 12.5, borderRadius: "var(--radius-md)", background: "var(--color-tab-panel)", color: "white" }}
              onClick={() => { onSendToSegment("champions_vip"); setOpenSegment(null); }}
            >
              💎 ارسال پیامک ویژه VIP ({toFa(openMembers.filter((m) => m.is_vip).length)} نفر)
            </button>
          )}
          <button
            className="tap accent-btn w-full mt-3"
            style={{ padding: 10, fontSize: 12.5 }}
            onClick={() => { onSendToSegment(openSegment); setOpenSegment(null); }}
          >
            <Send size={13} style={{ display: "inline", marginLeft: 6 }} /> ارسال پیامک به این دسته
          </button>
        </Modal>
      )}
    </div>
  );
}

export const SERVICE_CATEGORY_ICON = { hair: Scissors, beard: Scissors, color: Palette, makeup: Sparkles, nails: Hand, skin: Droplet, permanent_makeup: Eye };
export const LINE_STATUS_META = {
  active: { label: "فعال", color: "var(--color-success)" },
  at_risk: { label: "در خطر ریزش", color: "var(--color-warning)" },
  dormant: { label: "غیرفعال", color: "var(--color-muted)" },
};

// Per-service-category view of customer recency (v2.11) — a hair-color
// regular who's overdue for skincare looks very different line by line vs.
// as one blended average. Uses the useData hook (unlike the other
// self-contained fetch components in this file) since it's a brand-new
// component with no existing pattern to disrupt.
// Default win-back message for the category-matrix "ارسال پیشنهاد" action —
// editable in the preview modal before sending, never sent as-is silently.
export const CATEGORY_OFFER_DEFAULT_BODY =
  "سلام {{name}} عزیز، مدتیه توی بخش {{category}} پیشمون نیومدید! دلمون براتون تنگ شده — برای بازگشت، یه پیشنهاد ویژه منتظرتونه 🎁";

export function CategoryMatrixCard({ notify }) {
  const { data: rows, loading, refetch } = useData(fetchCategoryMatrix, [], { cacheKey: "category_matrix" });
  const [openCategory, setOpenCategory] = useState(null);
  const [offerPreview, setOfferPreview] = useState(null); // { category, category_fa, recipients, body }
  const [sendingOffer, setSendingOffer] = useState(false);

  const byCategory = useMemo(() => {
    const map = new Map();
    for (const r of rows || []) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category).push(r);
    }
    return [...map.entries()].map(([category, members]) => ({
      category,
      category_fa: members[0]?.category_fa || CATEGORY_LABEL[category] || category,
      members,
      active: members.filter((m) => m.line_status === "active").length,
      at_risk: members.filter((m) => m.line_status === "at_risk").length,
      dormant: members.filter((m) => m.line_status === "dormant").length,
    }));
  }, [rows]);

  const openMembers = useMemo(() => {
    if (!openCategory) return [];
    const cat = byCategory.find((c) => c.category === openCategory);
    return cat ? [...cat.members].sort((a, b) => a.last_visit_days - b.last_visit_days) : [];
  }, [byCategory, openCategory]);

  // at_risk + dormant only — "active" customers in this line don't need a
  // win-back nudge. Deduplicated by phone and validated against the same
  // Iranian mobile format used everywhere else in the app, so a stray
  // malformed or repeated number can't slip into a send.
  const winBackCandidates = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const m of openMembers) {
      if (m.line_status !== "at_risk" && m.line_status !== "dormant") continue;
      if (!/^09\d{9}$/.test(m.phone || "")) continue;
      if (seen.has(m.phone)) continue;
      seen.add(m.phone);
      out.push(m);
    }
    return out;
  }, [openMembers]);

  function openOfferPreview() {
    if (!winBackCandidates.length) return;
    const cat = byCategory.find((c) => c.category === openCategory);
    setOfferPreview({
      category: openCategory,
      category_fa: cat?.category_fa || CATEGORY_LABEL[openCategory] || openCategory,
      recipients: winBackCandidates,
      body: CATEGORY_OFFER_DEFAULT_BODY,
    });
  }

  async function handleSendOffer() {
    if (!offerPreview || !offerPreview.body.trim()) return;
    setSendingOffer(true);
    const messages = offerPreview.recipients.map((r) => ({
      to: r.phone,
      body: renderTemplate(offerPreview.body, { name: r.name || "مشتری", category: offerPreview.category_fa }),
      kind: "custom",
    }));
    const res = await sendBulkSms(messages);
    setSendingOffer(false);
    setOfferPreview(null);
    setOpenCategory(null);

    if (res?.demo) notify("حالت دمو — پیامک واقعی ارسال نشد");
    else if (res?.ok) notify(`${toFa(res.sent)} پیشنهاد ارسال شد${res.failed ? ` · ${toFa(res.failed)} ناموفق` : ""}`);
    else notify(res?.error ? "ارسال ناموفق بود" : "هیچ پیامکی ارسال نشد");
  }

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <LayoutGrid size={13} color="var(--color-accent-700)" /> ماتریس خط خدمات مشتریان
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : byCategory.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز داده‌ای برای این ماتریس یافت نشد</p>
      ) : (
        <div className="flex flex-col gap-2">
          {byCategory.map((c) => {
            const Icon = SERVICE_CATEGORY_ICON[c.category] || Scissors;
            const total = c.active + c.at_risk + c.dormant;
            return (
              <button
                key={c.category}
                onClick={() => setOpenCategory(c.category)}
                className="tap flex items-center gap-3"
                style={{ padding: 10, borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", textAlign: "right" }}
              >
                <div style={{ width: 32, height: 32, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-accent-500) 14%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon size={15} color="var(--color-accent-700)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.category_fa}</div>
                  <div className="flex items-center gap-2 mt-1" style={{ flexWrap: "wrap" }}>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-success)" }}>● {toFa(c.active)} فعال</span>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-warning)" }}>● {toFa(c.at_risk)} در خطر</span>
                    <span className="tabular" style={{ fontSize: 10.5, color: "var(--color-muted)" }}>● {toFa(c.dormant)} غیرفعال</span>
                  </div>
                </div>
                <span className="tabular muted" style={{ fontSize: 11, flexShrink: 0 }}>{toFa(total)} نفر</span>
              </button>
            );
          })}
        </div>
      )}

      {openCategory && (
        <Modal title={`${CATEGORY_LABEL[openCategory] || openCategory} — وضعیت مشتریان`} onClose={() => setOpenCategory(null)}>
          <div className="flex flex-col gap-2" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {openMembers.map((m) => {
              const meta = LINE_STATUS_META[m.line_status] || LINE_STATUS_META.dormant;
              return (
                <div key={m.phone} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{m.name || "بدون نام"}</div>
                    <div className="muted tabular" style={{ fontSize: 10.5 }} dir="ltr">{toFa(m.phone)}</div>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <span className="badge" style={{ background: meta.color, color: "white" }}>{m.line_status_fa}</span>
                    <div className="muted tabular" style={{ fontSize: 10, marginTop: 3 }}>{toFa(m.visit_count)} ویزیت · {toFa(m.last_visit_days)} روز پیش</div>
                  </div>
                </div>
              );
            })}
          </div>
          {winBackCandidates.length > 0 && (
            <button
              className="tap accent-btn w-full mt-3 flex items-center justify-center gap-1.5"
              style={{ padding: 10, fontSize: 12.5 }}
              onClick={openOfferPreview}
            >
              <Send size={13} /> ارسال پیشنهاد به {toFa(winBackCandidates.length)} نفر در خطر/غیرفعال
            </button>
          )}
        </Modal>
      )}

      {offerPreview && (
        <Modal title={`پیشنهاد بازگشت — ${offerPreview.category_fa}`} onClose={() => setOfferPreview(null)}>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
            متن زیر برای هرکدوم از {toFa(offerPreview.recipients.length)} نفر با نام خودشون شخصی‌سازی می‌شه. قبل از ارسال، متن رو بررسی و در صورت نیاز ویرایش کنید.
          </p>
          <textarea
            value={offerPreview.body}
            onChange={(e) => setOfferPreview((p) => ({ ...p, body: e.target.value }))}
            style={{ width: "100%", padding: 11, fontSize: 13, minHeight: 100, resize: "vertical", lineHeight: 1.7 }}
          />
          <div className="flex gap-1 mt-2">
            <span className="badge" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>{"{{name}}"} = نام مشتری</span>
            <span className="badge" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>{"{{category}}"} = {offerPreview.category_fa}</span>
          </div>

          <p className="muted" style={{ fontSize: 11, marginTop: 12, marginBottom: 4 }}>پیش‌نمایش برای نفر اول:</p>
          <div className="surface-raised" style={{ borderRadius: "var(--radius-md)", padding: 10, fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
            {renderTemplate(offerPreview.body, { name: offerPreview.recipients[0]?.name || "مشتری", category: offerPreview.category_fa }) || <span className="muted">متنی وارد نشده</span>}
          </div>

          <button
            disabled={sendingOffer || !offerPreview.body.trim()}
            className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
            style={{ padding: 12, fontSize: 13 }}
            onClick={handleSendOffer}
          >
            {sendingOffer ? <Loader2 size={15} className="salon-spin" /> : <Send size={15} />}
            تایید و ارسال به {toFa(offerPreview.recipients.length)} نفر
          </button>
          {!SUPABASE_ENABLED && (
            <p className="muted flex items-center gap-1 mt-3" style={{ fontSize: 11 }}>
              <AlertTriangle size={12} /> دیتابیس متصل نیست — ارسال واقعی انجام نمی‌شود
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---- v2.12 BI charts: pure SVG/CSS, no charting library, RTL-aware ----

// Line + area chart. RTL: oldest point on the right, newest on the left,
// matching how a Persian reader's eye naturally moves through a timeline.
export function RevenueTrendChart({ points }) {
  const width = 600, height = 140, padTop = 10, padBottom = 20, padSide = 4;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const xFor = (i) => n <= 1 ? width / 2 : width - padSide - (i / (n - 1)) * (width - padSide * 2);
  const yFor = (v) => padTop + (1 - v / max) * (height - padTop - padBottom);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(" ");
  const areaPath = n > 0
    ? `${linePath} L ${xFor(n - 1).toFixed(1)} ${height - padBottom} L ${xFor(0).toFixed(1)} ${height - padBottom} Z`
    : "";

  // Thin out x-axis labels so they don't collide when there are many points.
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", overflow: "visible" }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="revenueTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-500)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-accent-500)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {n > 0 && <path d={areaPath} fill="url(#revenueTrendFill)" stroke="none" />}
      {n > 1 && <path d={linePath} fill="none" stroke="var(--color-accent-500)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {points.map((p, i) => (
        (i % labelEvery === 0 || i === n - 1) && (
          <text key={i} x={xFor(i)} y={height - 4} fontSize="8" fill="var(--color-muted)" textAnchor="middle">{p.label}</text>
        )
      ))}
      {n > 0 && (
        <circle cx={xFor(n - 1)} cy={yFor(points[n - 1].value)} r="3" fill="var(--color-accent-500)" />
      )}
    </svg>
  );
}

// Donut (ring) chart built from stroke-dasharray arcs on stacked circles —
// no path-arc trigonometry needed. Legend lists exact values beside it so
// nothing shown only as a proportion is lost as a real number.
export function ServiceShareDonut({ slices }) {
  const size = 120, stroke = 16, r = (size - stroke) / 2, circumference = 2 * Math.PI * r;
  let offsetSoFar = 0;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  return (
    <div className="flex items-center gap-4" style={{ flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0, transform: "scaleX(-1)" /* RTL: first slice starts from the right */ }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-raised)" strokeWidth={stroke} />
        {slices.map((s, i) => {
          const frac = s.value / total;
          const dash = frac * circumference;
          const el = (
            <circle
              key={i}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}`}
              strokeDashoffset={(-offsetSoFar).toFixed(1)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offsetSoFar += dash;
          return el;
        })}
      </svg>
      <div className="flex flex-col gap-1.5" style={{ flex: 1, minWidth: 140 }}>
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: "var(--color-heading)" }}>{s.name}</span>
            <span className="tabular muted" style={{ fontSize: 10.5 }}>{toFa(Math.round((s.value / total) * 100))}٪</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// weekday × hour density grid — replaces the two separate 1D bar charts
// (peak hours, busy weekdays) that used to sit here: a heatmap shows the
// INTERACTION between the two dimensions (e.g. "Thursday evenings" as its
// own hot spot), which two independent 1D charts can't.
export function BookingHeatmap({ grid, hours, dayLabels }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "inline-grid", gridTemplateColumns: `28px repeat(${hours.length}, 16px)`, gap: 2, direction: "rtl" }}>
        <div />
        {hours.map((h) => (
          <div key={h} className="tabular muted" style={{ fontSize: 7, textAlign: "center" }}>{toFa(h)}</div>
        ))}
        {dayLabels.map((label, dayIdx) => (
          <React.Fragment key={label}>
            <div className="muted" style={{ fontSize: 9, display: "flex", alignItems: "center" }}>{label.slice(0, 2)}</div>
            {hours.map((h, hourIdx) => {
              const count = grid[dayIdx][hourIdx];
              const intensity = count / max;
              return (
                <div
                  key={h}
                  title={`${label} ساعت ${toFa(h)} — ${toFa(count)} نوبت`}
                  style={{
                    width: 16, height: 16, borderRadius: 3,
                    background: count === 0 ? "var(--color-surface-raised)" : `color-mix(in oklch, var(--color-accent-500) ${Math.round(18 + intensity * 82)}%, var(--color-surface-raised))`,
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// v2.13: campaign conversion & ROI analytics. Own useData call (like
// CategoryMatrixCard), so it loads independently of BITab's own range-
// filtered bookings data — campaign performance is lifetime-to-date, not
// scoped to BITab's 7/30/90-day range toggle.
export function CampaignPerformanceCard() {
  const { data: rows, loading, refetch } = useData(fetchCampaignPerformance, [null], { cacheKey: "campaign_performance:all" });

  const templates = useMemo(() => (rows || []).filter((r) => r.total_sent > 0), [rows]);

  const totals = useMemo(() => {
    const totalSent = templates.reduce((s, r) => s + Number(r.total_sent || 0), 0);
    const successful = templates.reduce((s, r) => s + Number(r.successful_count || 0), 0);
    const conversions = templates.reduce((s, r) => s + Number(r.total_conversions || 0), 0);
    const revenue = templates.reduce((s, r) => s + Number(r.attributed_revenue || 0), 0);
    const conversionRate = successful > 0 ? (conversions / successful) * 100 : 0;
    return { totalSent, successful, conversions, revenue, conversionRate };
  }, [templates]);

  const maxRate = Math.max(1, ...templates.map((t) => Number(t.conversion_rate || 0)));

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <TrendingUp size={13} color="var(--color-accent-700)" /> عملکرد کمپین‌ها (تبدیل و ROI)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : templates.length === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز کمپینی ارسال نشده</p>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>پیامک ارسال‌شده</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(totals.successful)}</div>
            </div>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-success) 10%, var(--color-surface-raised))" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>نرخ بازگشت</div>
              <div className="tabular" style={{ fontSize: 16, fontWeight: 800, color: "var(--color-success)" }}>{toFa(Math.round(totals.conversionRate * 10) / 10)}٪</div>
            </div>
            <div style={{ padding: 10, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-accent-500) 10%, var(--color-surface-raised))" }}>
              <div className="muted" style={{ fontSize: 10.5 }}>درآمد کمپین</div>
              <div className="tabular" style={{ fontSize: 14, fontWeight: 800, color: "var(--color-accent-700)" }}>{formatToman(totals.revenue)}</div>
            </div>
          </div>

          {templates.length > 1 && (
            <div className="flex flex-col gap-2 mt-4">
              <p className="muted" style={{ fontSize: 11 }}>مقایسهٔ نرخ تبدیل قالب‌ها</p>
              {templates
                .slice()
                .sort((a, b) => Number(b.conversion_rate || 0) - Number(a.conversion_rate || 0))
                .map((t) => (
                  <div key={t.template_id || t.template_label}>
                    <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                      <span style={{ fontWeight: 700, color: "var(--color-heading)" }}>{t.template_label || t.template_id}</span>
                      <span className="tabular muted">{toFa(t.conversion_rate)}٪ · {toFa(t.total_conversions)} تبدیل</span>
                    </div>
                    <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", marginTop: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(Number(t.conversion_rate || 0) / maxRate) * 100}%`, height: "100%", background: "var(--grad-brand)" }} />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// v2.18 — average rating + distribution from customer feedback (v2.14),
// which was collected but never surfaced anywhere until now.
export function FeedbackStatsCard() {
  const { data: stats, loading, refetch } = useData(fetchFeedbackStats, [], { cacheKey: "feedback_stats" });
  const total = stats?.total_count || 0;
  const maxCount = Math.max(1, ...[1, 2, 3, 4, 5].map((n) => Number(stats?.[`rating_${n}`] || 0)));

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div className="flex items-center justify-between mb-3">
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
          <Star size={13} color="var(--color-warning)" /> رضایت مشتریان (نظرسنجی)
        </p>
        <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={refetch} disabled={loading}>
          <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!SUPABASE_ENABLED ? (
        <p className="muted" style={{ fontSize: 11.5 }}>این بخش به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
      ) : !stats ? (
        <p className="muted" style={{ fontSize: 12.5 }}>در حال بارگذاری...</p>
      ) : total === 0 && !loading ? (
        <p className="muted" style={{ fontSize: 12.5 }}>هنوز نظری ثبت نشده</p>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-3">
            <div className="tabular" style={{ fontSize: 28, fontWeight: 800, color: "var(--color-heading)" }}>{toFa(stats?.avg_rating)}</div>
            <div>
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} size={14} fill={n <= Math.round(stats?.avg_rating || 0) ? "var(--color-warning)" : "none"} color="var(--color-warning)" />
                ))}
              </div>
              <div className="muted tabular" style={{ fontSize: 11 }}>از {toFa(total)} نظر</div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {[5, 4, 3, 2, 1].map((n) => {
              const count = Number(stats?.[`rating_${n}`] || 0);
              return (
                <div key={n} className="flex items-center gap-2">
                  <span className="tabular muted" style={{ fontSize: 10.5, width: 14 }}>{toFa(n)}</span>
                  <Star size={10} fill="var(--color-warning)" color="var(--color-warning)" />
                  <div style={{ flex: 1, height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", overflow: "hidden" }}>
                    <div style={{ width: `${(count / maxCount) * 100}%`, height: "100%", background: "var(--color-warning)" }} />
                  </div>
                  <span className="tabular muted" style={{ fontSize: 10.5, width: 24, textAlign: "left" }}>{toFa(count)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
