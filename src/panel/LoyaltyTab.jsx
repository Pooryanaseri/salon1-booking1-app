import { useState, useEffect, useMemo } from "react";
import { Calendar as CalendarIcon, CalendarClock, CalendarCheck, Users, UserPlus, Gift, Crown, RefreshCw, Star } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { fetchCustomers, fetchCustomerLoyalty, fetchLoyaltySettings, updateLoyaltySettings, redeemLoyaltyReward } from "../lib/api";
import { toFa } from "../lib/format";
import { CategoryMatrixCard, RfmSegmentsCard, SegmentSettingsCard } from "./biCards";
import { GenderBadge, Modal, PanelSectionHeader, Row } from "../components/ui";

/* ============================================================
   NEW — پنل ارسال پیامک (owner/manager only)
   ------------------------------------------------------------
   One place to send real SMS: pick an audience, pick a template,
   preview it against a real recipient, send in bulk. Also hosts
   the win-back campaign (phase 3), because it's the same machinery:
   an audience + a template + a send, plus return tracking.

   Nothing here talks to the SMS provider directly — every send
   goes through the `send-sms` Edge Function, which is the only
   thing holding the کاوه‌نگار / ملی‌پیامک API key.
   ============================================================ */
export const AUDIENCES = [
  { id: "today",    label: "نوبت‌های امروز",   Icon: CalendarCheck },
  { id: "tomorrow", label: "نوبت‌های فردا",    Icon: CalendarClock },
  { id: "week",     label: "۷ روز آینده",      Icon: CalendarIcon },
  { id: "all",      label: "همهٔ مشتری‌ها",     Icon: Users },
  { id: "manual",   label: "شمارهٔ دستی",      Icon: UserPlus },
];

/* ============================================================
   Loyalty club tab — the phase-4 piece the changelog flagged as
   "database complete, no UI". Points are already accruing live
   via a database trigger every time a booking completes; this
   tab is purely a read/write surface over that existing data.
   ============================================================ */
export function loyaltyTierOf(points, settings) {
  const per = Math.max(1, settings?.points_per_tier || 100);
  const tier = Math.floor((points || 0) / per);
  const discount = Math.min(tier * (settings?.discount_per_tier || 0), settings?.max_discount || 0);
  const toNext = Math.max(per - ((points || 0) % per), 0);
  return { tier, discount, toNext };
}

export function LoyaltyCustomerModal({ customer, settings, onClose, notify, onRedeemed }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState(false);
  useEffect(() => {
    (async () => {
      setLoading(true);
      setDetail(await fetchCustomerLoyalty(customer.phone));
      setLoading(false);
    })();
  }, [customer.phone]);

  const { tier, discount, toNext } = loyaltyTierOf(customer.loyalty_points, settings);

  async function handleRedeem() {
    setRedeeming(true);
    const res = await redeemLoyaltyReward(customer.phone);
    setRedeeming(false);
    if (!res.ok) { notify(res.error || "استفاده از جایزه ناموفق بود"); return; }
    notify(`تخفیف ${toFa(res.redeemed_discount_percent)}٪ استفاده شد — امتیاز مشتری صفر شد`);
    setDetail(await fetchCustomerLoyalty(customer.phone));
    onRedeemed?.();
  }

  return (
    <Modal title={customer.name || "مشتری"} onClose={onClose}>
      <Row label="شماره تماس" value={<span dir="ltr" className="tabular">{toFa(customer.phone)}</span>} />
      <Row label="امتیاز فعلی" value={<span className="tabular">{toFa(customer.loyalty_points || 0)}</span>} bold />
      <Row label="سطح فعلی" value={<span className="flex items-center gap-1"><Crown size={13} color="var(--color-accent-500)" /> {toFa(tier)}</span>} />
      <Row label="تخفیف پلکانی" value={`${toFa(discount)}٪`} />
      <Row label="تا سطح بعد" value={`${toFa(toNext)} امتیاز`} />
      <Row label="تعداد ویزیت" value={toFa(customer.total_visits || 0)} />
      <Row label="کد معرفی" value={<span dir="ltr" className="tabular">{customer.referral_code}</span>} />
      {customer.referred_by && <Row label="معرف" value={<span dir="ltr" className="tabular">{toFa(customer.referred_by)}</span>} />}

      {!loading && detail?.at_cap && (
        <div className="fade-in" style={{ marginTop: 10, padding: 12, borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--color-success) 12%, transparent)" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-success)" }}>
            <Crown size={14} /> این مشتری به سقف تخفیف ({toFa(detail.max_discount)}٪) رسیده
          </p>
          <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8, lineHeight: 1.7 }}>
            وقتی این تخفیف واقعاً به مشتری داده شد، اینجا ثبتش کن — امتیازش صفر می‌شه و از نو شروع می‌کنه.
          </p>
          <button disabled={redeeming} className="tap accent-btn w-full" style={{ padding: 10, fontSize: 12.5 }} onClick={handleRedeem}>
            {redeeming ? "در حال ثبت..." : `ثبت استفاده از تخفیف ${toFa(detail.max_discount)}٪`}
          </button>
        </div>
      )}

      <div style={{ borderTop: "1px dashed var(--color-border)", margin: "12px 0" }} />
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>تاریخچهٔ امتیاز</p>
      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
      ) : !detail?.history?.length ? (
        <p className="muted" style={{ fontSize: 12 }}>هنوز تراکنشی ثبت نشده</p>
      ) : (
        <div className="flex flex-col gap-1.5" style={{ maxHeight: 220, overflowY: "auto" }}>
          {detail.history.map((h, i) => (
            <div key={i} className="flex items-center justify-between" style={{ fontSize: 12, padding: "6px 8px", borderRadius: "var(--radius-sm)", background: "var(--color-surface-raised)" }}>
              <span className="muted">{h.reason || "—"}</span>
              <span className="tabular" style={{ fontWeight: 700, color: h.delta >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                {h.delta >= 0 ? "+" : ""}{toFa(h.delta)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function LoyaltyTab({ notify, currentStylist, onNavigateToSmsSegment }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);

  async function loadCustomers() {
    setLoading(true);
    setCustomers(await fetchCustomers());
    setLoading(false);
  }
  async function loadSettings() {
    const s = await fetchLoyaltySettings();
    setSettings(s);
    setForm(s ? { ...s } : null);
  }
  useEffect(() => { loadCustomers(); loadSettings(); }, []);

  async function saveSettings() {
    if (!form) return;
    setSavingSettings(true);
    await updateLoyaltySettings({
      points_per_visit: Number(form.points_per_visit) || 0,
      points_per_tier: Math.max(1, Number(form.points_per_tier) || 1),
      discount_per_tier: Number(form.discount_per_tier) || 0,
      max_discount: Number(form.max_discount) || 0,
      referral_points: Number(form.referral_points) || 0,
    });
    setSavingSettings(false);
    setSettings(form);
    notify("تنظیمات باشگاه مشتریان ذخیره شد");
  }

  const filtered = useMemo(() => {
    const q = search.trim();
    const list = !q ? customers : customers.filter((c) => (c.name || "").includes(q) || (c.phone || "").includes(q));
    return [...list].sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0));
  }, [customers, search]);

  if (!SUPABASE_ENABLED) {
    return (
      <div>
        <PanelSectionHeader Icon={Gift} title="باشگاه مشتریان" subtitle="امتیاز، تخفیف پلکانی، و برنامهٔ معرفی دوستان" color="var(--color-success)" />
        <div className="fade-in card" style={{ padding: 20, textAlign: "center" }}>
          <Gift size={22} color="var(--color-muted)" style={{ margin: "0 auto 8px" }} />
          <p className="muted" style={{ fontSize: 13 }}>باشگاه مشتریان به دیتابیس Supabase نیاز دارد و در حالت دمو در دسترس نیست.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PanelSectionHeader Icon={Gift} title="باشگاه مشتریان" subtitle="امتیاز، تخفیف پلکانی، و برنامهٔ معرفی دوستان" color="var(--color-success)" />
      {/* Program settings */}
      <div className="card mb-4" style={{ padding: 14 }}>
        <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", marginBottom: 10 }}>
          <Gift size={14} color="var(--color-accent-700)" /> تنظیمات باشگاه
        </p>
        {!form ? (
          <p className="muted" style={{ fontSize: 12 }}>در حال بارگذاری...</p>
        ) : (
          <>
            <div className="flex gap-3">
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>امتیاز هر ویزیت</label>
                <input type="number" min={0} value={form.points_per_visit} onChange={(e) => setForm({ ...form, points_per_visit: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>امتیاز هر سطح</label>
                <input type="number" min={1} value={form.points_per_tier} onChange={(e) => setForm({ ...form, points_per_tier: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
            </div>
            <div className="flex gap-3 mt-2">
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>تخفیف هر سطح (٪)</label>
                <input type="number" min={0} value={form.discount_per_tier} onChange={(e) => setForm({ ...form, discount_per_tier: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="muted" style={{ fontSize: 11 }}>سقف تخفیف (٪)</label>
                <input type="number" min={0} value={form.max_discount} onChange={(e) => setForm({ ...form, max_discount: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
              </div>
            </div>
            <div className="mt-2">
              <label className="muted" style={{ fontSize: 11 }}>امتیاز پاداش معرفی</label>
              <input type="number" min={0} value={form.referral_points} onChange={(e) => setForm({ ...form, referral_points: e.target.value })} className="tabular" style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginTop: 3 }} />
            </div>
            <button disabled={savingSettings} className="tap accent-btn w-full mt-3" style={{ padding: 10, fontSize: 13 }} onClick={saveSettings}>
              ذخیرهٔ تنظیمات
            </button>
            <p className="muted" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.7 }}>
              تخفیف پلکانی فقط اینجا محاسبه و نمایش داده می‌شود؛ هنوز به‌صورت خودکار روی قیمت نهایی نوبت اعمال نمی‌شود — اعمالش نیاز به یک تصمیم دارد (روی قیمت اصلی باشد یا بعد از تخفیف خدمت).
            </p>
          </>
        )}
      </div>

      {/* Segment threshold configuration — manager-only. Stylists can VIEW
          segmentation below (RfmSegmentsCard, opened to them earlier) but
          must not see or change the thresholds that produce it; the RLS on
          customer_segment_settings enforces this server-side regardless,
          this is just keeping the UI honest about who can act on it. */}
      {!currentStylist && <SegmentSettingsCard notify={notify} />}

      {/* Customer segmentation (RFM) — v2.15: reverted to manager-only.
          get_customer_rfm_segments() now enforces is_manager() again —
          this exposes the full customer bank's names/phones/spend, which
          is exactly what "customer bank access blocked for stylist" means. */}
      {!currentStylist && <RfmSegmentsCard onSendToSegment={onNavigateToSmsSegment} />}

      {/* Category-level segmentation matrix — v2.15: reverted to
          manager-only, same reasoning as RFM above. */}
      {!currentStylist && <CategoryMatrixCard notify={notify} />}

      {/* Customer list */}
      <div className="card" style={{ padding: 14 }}>
        <div className="flex items-center justify-between mb-3">
          <p className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
            <Star size={14} color="var(--color-accent-500)" /> مشتریان
          </p>
          <button className="tap ghost-btn" style={{ width: 28, height: 28, padding: 0 }} onClick={loadCustomers} disabled={loading}>
            <RefreshCw size={13} style={{ margin: "auto", animation: loading ? "salonSpin 1s linear infinite" : "none" }} />
          </button>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی نام یا شماره..." style={{ width: "100%", padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }} />

        {filtered.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>{loading ? "در حال بارگذاری..." : "مشتری‌ای یافت نشد"}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((c) => {
              const { tier, discount } = loyaltyTierOf(c.loyalty_points, settings);
              return (
                <button
                  key={c.phone}
                  onClick={() => setSelected(c)}
                  className="tap flex items-center gap-2"
                  style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--color-surface-raised)", textAlign: "right" }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-1.5">
                      <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--color-heading)" }}>{c.name || "بدون نام"}</span>
                      <GenderBadge gender={c.gender} />
                    </div>
                    <div className="muted tabular" style={{ fontSize: 10.5, marginTop: 1 }} dir="ltr">{toFa(c.phone)}</div>
                  </div>
                  <span className="badge" style={{ background: "color-mix(in oklch, var(--color-accent-500) 16%, transparent)", color: "var(--color-accent-700)" }}>
                    <Crown size={11} /> {toFa(tier)} · {toFa(c.loyalty_points || 0)}
                  </span>
                  {discount > 0 && (
                    <span className="badge" style={{ background: "color-mix(in oklch, var(--color-success) 16%, transparent)", color: "var(--color-success)" }}>
                      {toFa(discount)}٪
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selected && settings && (
        <LoyaltyCustomerModal
          customer={selected}
          settings={settings}
          onClose={() => setSelected(null)}
          notify={notify}
          onRedeemed={loadCustomers}
        />
      )}
    </div>
  );
}
