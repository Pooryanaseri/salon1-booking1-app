// ============================================================================
//  BI → مرکز اقدام (action center) — v2.43
//  Turns the BI numbers into a short, prioritised list of findings. Each one
//  says what is happening (diagnosis + evidence), what it is worth (an
//  estimated monthly impact in toman, with the formula shown to the manager),
//  how sure we are (confidence from the sample size), and the one action that
//  addresses it. Pure: no React, no network. The ActionCenter UI runs actions
//  only after the manager reviews and confirms them.
//
//  Finding: {
//    id, category, tone: "warn"|"info"|"good", priority: "urgent"|"high"|"normal"|"info",
//    title, diagnosis, evidence: [{label, value}],
//    impact?: { amount, recurring: boolean, basis },     // toman
//    confidence: { level: "high"|"medium"|"low", reason },
//    action?: { kind, label, ... }
//  }
//  Action kinds:
//    campaign   — SMS to an audience  { audience: "segment"|"lapsed", segment, draftKey, dKey?, dayLabel? }
//    automation — flip app_settings switches { patch, confirm }
//    reminder   — turn the customer reminder back on { hours, confirm }
//    goto       — open the panel tab where the manager finishes it { tab }
// ============================================================================
import { toFa, formatToman, SCHEMA_DAY_LABELS } from "../lib/format";

const MIN_BOOKINGS = 5; // below this, rates are noise — say nothing
const pct = (v) => `${toFa(Math.round(v * 100))}٪`;
const MONTH = 30;

// Conservative response rates used until the salon has its own history
// (≥ 20 SMS sent for that audience — then its real conversion rate is used).
export const DEFAULT_RESPONSE = { at_risk: 0.12, new: 0.15, champions_vip: 0.25, fill_day: 0.06 };
// Share of no-shows each measure typically prevents (conservative).
const NO_SHOW_REDUCTION = { attendance: 0.35, reminder: 0.3, deposit: 0.5 };
const WAITLIST_REFILL = 0.3;
const SNOOZE_HIDE_DONE_DAYS = 14;

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, info: 3 };

function confidenceFor(n, { high = 50, medium = 15 } = {}) {
  if (n >= high) return { level: "high", reason: `بر پایهٔ ${toFa(n)} مورد` };
  if (n >= medium) return { level: "medium", reason: `بر پایهٔ ${toFa(n)} مورد` };
  return { level: "low", reason: `فقط ${toFa(n)} مورد — با احتیاط` };
}

/** Real response rate for an audience if there's enough history, else the default. */
export function responseRate(audience, campaignStats) {
  const s = campaignStats?.[audience];
  if (s && s.sent >= 20) return { rate: s.conversions / s.sent, measured: true, sent: s.sent };
  return { rate: DEFAULT_RESPONSE[audience] ?? 0.1, measured: false, sent: s?.sent || 0 };
}

/**
 * Hide a finding the manager already handled: snoozed (until it expires),
 * dismissed (30 days), or acted on recently (14 days — the result shows in
 * the history tab meanwhile).
 */
export function isSuppressed(id, recentActions, now = Date.now()) {
  const a = recentActions?.[id];
  if (!a) return false;
  const age = now - new Date(a.created_at).getTime();
  if (a.status === "snoozed") return a.until ? new Date(a.until).getTime() > now : age < 7 * 86400000;
  if (a.status === "dismissed") return age < 30 * 86400000;
  return age < SNOOZE_HIDE_DONE_DAYS * 86400000;
}

/**
 * @param {object} c
 * @param {number} c.spanDays
 * @param {{revenue:number, noShowRate:number, returnRate60:number, newCustomers:number}} c.cur
 * @param {{revenue:number, noShowRate:number, returnRate60:number, newCustomers:number}} c.prev
 * @param {Array} c.periodBookings      bookings of the selected period (filtered)
 * @param {Array} c.prevPeriodBookings  same length, the period before
 * @param {Array} c.services
 * @param {number[][]} c.heatmapGrid    [schemaDay][hourIdx] booking counts
 * @param {number[]} c.heatmapHours
 * @param {{pctOfCustomers:number, pctOfRevenue:number, topCustomers:Array}} c.pareto
 * @param {Array<{dKey, label, date, fillRate, hasCapacity, totalCapacity, totalBooked}>} c.nextDays  today first
 * @param {Array<{name:string, value:number}>} c.serviceShare
 * @param {Array<{name:string, count:number, returnRate:number}>} c.stylistPerf
 * @param {object} c.automation          app_settings switches
 * @param {Record<string, number>} c.segmentCounts  reachable customers per RFM segment
 * @param {Record<string, {sent:number, conversions:number}>} [c.campaignStats]  per audience
 * @param {Record<string, {status, until, created_at}>} [c.recentActions]  latest bi_action per finding id
 * @returns {{ actions: Array, notes: Array, totalImpact: number }}
 */
export function buildBIInsights(c) {
  const out = [];
  const automation = c.automation || {};
  const seg = c.segmentCounts || {};
  const period = c.periodBookings || [];
  const prevPeriod = c.prevPeriodBookings || [];
  const spanLabel = `${toFa(c.spanDays)} روز اخیر`;
  const perMonth = MONTH / Math.max(1, c.spanDays);

  const completed = period.filter((b) => b.status === "completed" && b.final_price != null);
  const servicePrice = (id) => c.services?.find((x) => x.id === id)?.price ?? 0;
  const avgService = (c.services || []).filter((s) => s.price > 0);
  const avgTicket = completed.length
    ? completed.reduce((s, b) => s + b.final_price, 0) / completed.length
    : (avgService.length ? avgService.reduce((s, x) => s + x.price, 0) / avgService.length : 0);
  const avgDuration = (() => {
    const d = (c.services || []).map((s) => s.duration_minutes).filter((x) => x > 0);
    return d.length ? d.reduce((s, x) => s + x, 0) / d.length : 45;
  })();
  const monthlyRevenue = c.cur.revenue * perMonth;
  const ticketBasis = completed.length
    ? `میانگین هر نوبت ${formatToman(avgTicket)} (از ${toFa(completed.length)} نوبت تکمیل‌شده)`
    : `میانگین قیمت خدمات ${formatToman(avgTicket)}`;

  // ---- 1. no-shows: the most direct revenue leak --------------------------
  const noShows = period.filter((b) => b.status === "no_show");
  if (period.length >= MIN_BOOKINGS && noShows.length >= 2 && c.cur.noShowRate >= 0.08) {
    const lost = noShows.reduce((s, b) => s + (b.final_price ?? servicePrice(b.service_id)), 0);
    const monthlyLost = lost * perMonth;
    let action, reduction, measure;
    if (!automation.attendance_confirmation) {
      reduction = NO_SHOW_REDUCTION.attendance; measure = "تایید حضور";
      action = { kind: "automation", patch: { attendance_confirmation: true }, label: "روشن کردن تایید حضور",
        confirm: "از این به بعد پیامک یادآوری لینک «می‌آیم / نمی‌آیم» دارد؛ نوبتی که مشتری لغو کند خودکار به لیست انتظار پیشنهاد می‌شود." };
    } else if (!(automation.reminder_hours_before > 0)) {
      reduction = NO_SHOW_REDUCTION.reminder; measure = "پیامک یادآوری";
      action = { kind: "reminder", hours: 3, label: "روشن کردن پیامک یادآوری",
        confirm: "پیامک یادآوری ۳ ساعت قبل از هر نوبت (برای نوبت‌های آینده هم) ارسال می‌شود." };
    } else if (!(automation.deposit_percent > 0)) {
      reduction = NO_SHOW_REDUCTION.deposit; measure = "بیعانهٔ آنلاین";
      action = { kind: "goto", tab: "schedule", label: "تنظیم بیعانهٔ آنلاین" };
    }
    out.push({
      id: "no-show", category: "revenue", tone: "warn",
      metric: { key: "no_show_rate", value: c.cur.noShowRate },
      title: `${pct(c.cur.noShowRate)} نوبت‌ها بدون حضور`,
      diagnosis: action?.kind === "goto"
        ? "یادآوری و تایید حضور روشن است و هنوز نوبت‌ها خالی می‌مانند؛ قدم بعدی گرفتن بیعانه برای خدمات گران است (مرچنت‌کد زرین‌پال سالن لازم است)."
        : `در ${spanLabel} ${toFa(noShows.length)} نوبت بدون حضور بود. ${measure} معمولاً بخش قابل‌توجهی از آن را برمی‌گرداند.`,
      evidence: [
        { label: "بدون حضور", value: `${toFa(noShows.length)} از ${toFa(period.length)} نوبت` },
        { label: "درآمد از دست‌رفته", value: formatToman(lost) },
        ...(c.prev.noShowRate > 0 ? [{ label: "دورهٔ قبل", value: pct(c.prev.noShowRate) }] : []),
      ],
      impact: action && monthlyLost > 0 ? {
        amount: monthlyLost * reduction, recurring: true,
        basis: `${formatToman(monthlyLost)} ضرر ماهانه × ${pct(reduction)} کاهش معمول با ${measure}`,
      } : undefined,
      confidence: confidenceFor(period.length, { high: 80, medium: 25 }),
      action,
    });
  }

  // ---- 2. customers drifting away ------------------------------------------
  if (seg.at_risk >= 3) {
    const r = responseRate("at_risk", c.campaignStats);
    out.push({
      id: "at-risk", category: "retention", tone: "warn",
      title: `${toFa(seg.at_risk)} مشتری در خطر ریزش`,
      diagnosis: "این مشتری‌ها قبلاً مرتب می‌آمدند ولی بیشتر از فاصلهٔ معمولشان نوبت نگرفته‌اند. هر چه زودتر دعوت شوند، احتمال برگشتشان بیشتر است.",
      evidence: [
        { label: "در خطر ریزش", value: `${toFa(seg.at_risk)} نفر` },
        { label: r.measured ? "پاسخ کمپین‌های قبلی سالن" : "پاسخ معمول", value: pct(r.rate) },
      ],
      impact: { amount: seg.at_risk * r.rate * avgTicket, recurring: false,
        basis: `${toFa(seg.at_risk)} نفر × ${pct(r.rate)} پاسخ × ${ticketBasis}` },
      confidence: r.measured ? confidenceFor(r.sent, { high: 100, medium: 20 }) : { level: "medium", reason: "نرخ پاسخ معمول؛ بعد از اولین کمپین، از دادهٔ خود سالن" },
      action: { kind: "campaign", audience: "segment", segment: "at_risk", draftKey: "at_risk", label: "دعوت به بازگشت" },
    });
  }

  // ---- 3. second visits ------------------------------------------------------
  const anchors = period.filter((b) => b.status === "completed").length;
  if (anchors >= MIN_BOOKINGS && c.cur.returnRate60 < 0.3) {
    const r = responseRate("new", c.campaignStats);
    out.push({
      id: "return-rate", category: "retention", tone: "warn",
      title: `فقط ${pct(c.cur.returnRate60)} مشتری‌ها ظرف ۶۰ روز برگشتند`,
      diagnosis: "سخت‌ترین قدم، نوبت دوم است. پیامک تشکر چند روز بعد از اولین مراجعه، احتمال برگشت مشتری تازه را بالا می‌برد.",
      evidence: [
        { label: "نرخ بازگشت", value: pct(c.cur.returnRate60) },
        ...(c.prev.returnRate60 > 0 ? [{ label: "دورهٔ قبل", value: pct(c.prev.returnRate60) }] : []),
        { label: "مشتری تازه", value: `${toFa(seg.new || 0)} نفر` },
      ],
      impact: seg.new > 0 ? { amount: seg.new * r.rate * avgTicket, recurring: false,
        basis: `${toFa(seg.new)} مشتری تازه × ${pct(r.rate)} پاسخ × ${ticketBasis}` } : undefined,
      confidence: confidenceFor(anchors),
      action: seg.new > 0 ? { kind: "campaign", audience: "segment", segment: "new", draftKey: "new", label: "پیامک تشکر به مشتری‌های تازه" } : undefined,
    });
  }

  // ---- 4. an emptyish day coming up (today excluded: too late to fill) ----
  const empty = (c.nextDays || []).slice(1).filter((d) => d.hasCapacity && d.fillRate < 0.2)
    .sort((a, b) => a.fillRate - b.fillRate)[0];
  if (empty) {
    const emptySlots = Math.floor(Math.max(0, (empty.totalCapacity || 0) - (empty.totalBooked || 0)) / avgDuration);
    const r = responseRate("fill_day", c.campaignStats);
    const expected = Math.min(emptySlots, Math.round(100 * r.rate));
    out.push({
      id: `empty-${empty.dKey}`, category: "capacity", tone: "warn",
      title: `${empty.label} تقریباً خالی است`,
      diagnosis: "وقتی روزی تا این حد خالی است، دعوت مشتری‌هایی که بیش از یک ماه نیامده‌اند (به‌خصوص کسانی که معمولاً همین روز هفته می‌آیند) بهترین راه پر کردن آن است.",
      evidence: [
        { label: "پرشدگی", value: pct(empty.fillRate) },
        { label: "جای خالی تقریبی", value: `${toFa(emptySlots)} نوبت` },
      ],
      impact: expected > 0 ? { amount: expected * avgTicket, recurring: false,
        basis: `حداکثر ۱۰۰ دعوت × ${pct(r.rate)} پاسخ (و نه بیشتر از ${toFa(emptySlots)} جای خالی) × ${ticketBasis}` } : undefined,
      confidence: { level: r.measured ? "medium" : "low", reason: r.measured ? "از پاسخ دعوت‌های قبلی سالن" : "نرخ پاسخ معمول" },
      action: { kind: "campaign", audience: "lapsed", segment: "fill_day", draftKey: "fill_day", dKey: empty.dKey,
        dayLabel: empty.label, weekday: empty.date ? (empty.date.getDay() + 1) % 7 : null, label: "دعوت برای این روز" },
    });
  }

  // ---- 5. fully booked days without a waitlist -----------------------------
  const full = (c.nextDays || []).filter((d) => d.hasCapacity && d.fillRate >= 0.9);
  if (full.length && !automation.waitlist_auto_offer) {
    const cancelled = period.filter((b) => b.status === "cancelled").length;
    const monthlyCancelled = cancelled * perMonth;
    out.push({
      id: "waitlist", category: "capacity", tone: "info",
      title: `${toFa(full.length)} روز از هفتهٔ پیش رو تقریباً پر است`,
      diagnosis: "مشتری‌هایی که وقت خالی پیدا نمی‌کنند از دست می‌روند. با لیست انتظار خودکار، هر لغو به نفر بعدی پیامک می‌شود.",
      evidence: [
        { label: "روزهای پر", value: `${toFa(full.length)} روز` },
        { label: `لغو در ${spanLabel}`, value: `${toFa(cancelled)} نوبت` },
      ],
      impact: monthlyCancelled > 0 ? { amount: monthlyCancelled * WAITLIST_REFILL * avgTicket, recurring: true,
        basis: `${toFa(Math.round(monthlyCancelled))} لغو در ماه × ${pct(WAITLIST_REFILL)} پر شدن دوباره × ${ticketBasis}` } : undefined,
      confidence: confidenceFor(cancelled, { high: 30, medium: 8 }),
      action: { kind: "automation", patch: { waitlist_auto_offer: true }, label: "روشن کردن لیست انتظار خودکار",
        confirm: "وقت‌های لغوشده خودکار با پیامک به افراد لیست انتظار همان روز پیشنهاد می‌شود." },
    });
  }

  // ---- 6. revenue concentrated in a few customers --------------------------
  const p = c.pareto;
  if (p && p.topCustomers?.length >= 3 && p.pctOfCustomers > 0 && p.pctOfCustomers <= 25) {
    const r = responseRate("champions_vip", c.campaignStats);
    const vipVisits = p.topCustomers.reduce((s, x) => s + (x.visits || 0), 0);
    const vipTicket = vipVisits ? p.topCustomers.reduce((s, x) => s + (x.revenue || 0), 0) / vipVisits : avgTicket;
    out.push({
      id: "vip", category: "retention", tone: "info",
      title: `${toFa(Math.round(p.pctOfCustomers))}٪ مشتری‌ها ${toFa(Math.round(p.pctOfRevenue))}٪ درآمد را می‌سازند`,
      diagnosis: "درآمد به چند مشتری وفادار وابسته است؛ از دست دادن حتی چند نفرشان اثر جدی دارد. قدردانی شخصی ارزان‌ترین بیمهٔ این درآمد است.",
      evidence: [
        { label: "مشتری‌های اصلی", value: `${toFa(p.topCustomers.length)} نفر` },
        { label: "سهم از درآمد", value: `${toFa(Math.round(p.pctOfRevenue))}٪` },
      ],
      impact: seg.champions_vip > 0 ? { amount: seg.champions_vip * r.rate * vipTicket, recurring: false,
        basis: `${toFa(seg.champions_vip)} VIP × ${pct(r.rate)} پاسخ × میانگین هر نوبت VIP ${formatToman(vipTicket)}` } : undefined,
      confidence: confidenceFor(completed.length),
      action: seg.champions_vip > 0 ? { kind: "campaign", audience: "segment", segment: "champions_vip", draftKey: "champions_vip", label: "پیامک قدردانی به VIPها" } : undefined,
    });
  }

  // ---- notes (no action of their own) --------------------------------------
  if (c.prev.revenue > 0) {
    const delta = (c.cur.revenue - c.prev.revenue) / c.prev.revenue;
    if (Math.abs(delta) >= 0.1) {
      const prevDone = prevPeriod.filter((b) => b.status === "completed" && b.final_price != null);
      const countDelta = prevDone.length ? (completed.length - prevDone.length) / prevDone.length : 0;
      const avg = (l) => (l.length ? l.reduce((s, b) => s + b.final_price, 0) / l.length : 0);
      const ticketDelta = avg(prevDone) ? (avg(completed) - avg(prevDone)) / avg(prevDone) : 0;
      const byCount = Math.abs(countDelta) >= Math.abs(ticketDelta);
      out.push({
        id: delta > 0 ? "revenue-up" : "revenue-down", category: "trend", tone: delta > 0 ? "good" : "warn",
        title: `درآمد ${toFa(Math.round(Math.abs(delta) * 100))}٪ ${delta > 0 ? "بیشتر" : "کمتر"} از دورهٔ قبل`,
        diagnosis: byCount
          ? `بیشتر به خاطر ${countDelta >= 0 ? "افزایش" : "کاهش"} تعداد نوبت‌هاست${countDelta < 0 && seg.at_risk >= 3 ? " — دعوت مشتری‌های در خطر ریزش (بالا) مستقیم‌ترین راه جبران است" : ""}.`
          : `بیشتر به خاطر ${ticketDelta >= 0 ? "افزایش" : "کاهش"} میانگین مبلغ هر نوبت است${ticketDelta < 0 ? " — تخفیف‌ها و ترکیب خدمات را بررسی کنید" : ""}.`,
        evidence: [
          { label: "درآمد", value: `${formatToman(c.prev.revenue)} ← ${formatToman(c.cur.revenue)}` },
          { label: "نوبت تکمیل‌شده", value: `${toFa(prevDone.length)} ← ${toFa(completed.length)}` },
          { label: "میانگین هر نوبت", value: `${formatToman(avg(prevDone))} ← ${formatToman(avg(completed))}` },
        ],
        confidence: confidenceFor(prevDone.length + completed.length, { high: 60, medium: 20 }),
      });
    }
  }

  if (c.heatmapGrid && period.length >= MIN_BOOKINGS * 2) {
    let best = null;
    c.heatmapGrid.forEach((row, day) => row.forEach((v, h) => { if (!best || v > best.v) best = { v, day, h }; }));
    const dayTotals = c.heatmapGrid.map((row, day) => ({ day, v: row.reduce((s, x) => s + x, 0) }));
    const quiet = dayTotals.filter((d) => d.v > 0).sort((a, b) => a.v - b.v)[0];
    if (best?.v > 0 && quiet && quiet.day !== best.day) {
      const hour = c.heatmapHours[best.h];
      out.push({
        id: "peak", category: "operations", tone: "info",
        title: `اوج شلوغی: ${SCHEMA_DAY_LABELS[best.day]} ساعت ${toFa(hour)} تا ${toFa(hour + 1)}`,
        diagnosis: `خلوت‌ترین روز ${SCHEMA_DAY_LABELS[quiet.day]} است. تخفیف یا خدمت ویژه را روی ${SCHEMA_DAY_LABELS[quiet.day]} بگذارید و در ساعات اوج آرایشگر کافی داشته باشید.`,
        evidence: [
          { label: "اوج", value: `${toFa(best.v)} نوبت` },
          { label: SCHEMA_DAY_LABELS[quiet.day], value: `${toFa(quiet.v)} نوبت در کل روز` },
        ],
        confidence: confidenceFor(period.length),
      });
    }
  }

  const shareTotal = (c.serviceShare || []).reduce((s, x) => s + x.value, 0);
  const top = c.serviceShare?.[0];
  if (top && shareTotal > 0 && top.value / shareTotal >= 0.5 && (c.serviceShare || []).length > 1) {
    out.push({
      id: "service-concentration", category: "operations", tone: "info",
      title: `${toFa(Math.round((top.value / shareTotal) * 100))}٪ درآمد از «${top.name}»`,
      diagnosis: "درآمد به یک خدمت وابسته است. پیشنهاد خدمت مکمل به همین مشتری‌ها (پکیج یا تخفیف ترکیبی) ریسک را کم و میانگین فاکتور را زیاد می‌کند.",
      evidence: [{ label: top.name, value: formatToman(top.value) }],
      confidence: confidenceFor(completed.length),
    });
  }

  const perf = (c.stylistPerf || []).filter((s) => s.count >= MIN_BOOKINGS);
  if (perf.length >= 2) {
    const avgReturn = perf.reduce((s, r) => s + r.returnRate, 0) / perf.length;
    const low = [...perf].sort((a, b) => a.returnRate - b.returnRate)[0];
    if (avgReturn - low.returnRate >= 20) {
      out.push({
        id: `stylist-${low.name}`, category: "operations", tone: "info",
        title: `مشتری‌های ${low.name} کمتر برمی‌گردند`,
        diagnosis: "نظرسنجی‌های این آرایشگر را ببینید یا با او صحبت کنید؛ تفاوت معمولاً در زمان‌بندی، کیفیت یا برخورد است.",
        evidence: [
          { label: "نرخ بازگشت", value: `${toFa(Math.round(low.returnRate))}٪` },
          { label: "میانگین سالن", value: `${toFa(Math.round(avgReturn))}٪` },
        ],
        confidence: confidenceFor(low.count, { high: 40, medium: 12 }),
      });
    }
  }

  if (c.prev.newCustomers >= 3) {
    const d = (c.cur.newCustomers - c.prev.newCustomers) / c.prev.newCustomers;
    if (d >= 0.2 || d <= -0.3) {
      out.push({
        id: d > 0 ? "new-up" : "new-down", category: "trend", tone: d > 0 ? "good" : "info",
        title: `مشتری جدید ${toFa(Math.round(Math.abs(d) * 100))}٪ ${d > 0 ? "بیشتر" : "کمتر"} شد`,
        diagnosis: d > 0 ? "همین مسیر جذب را ادامه دهید." : "کد معرفی باشگاه مشتریان را به مشتری‌های فعلی یادآوری کنید.",
        evidence: [{ label: "مشتری جدید", value: `${toFa(c.prev.newCustomers)} ← ${toFa(c.cur.newCustomers)}` }],
        confidence: confidenceFor(c.prev.newCustomers + c.cur.newCustomers, { high: 40, medium: 10 }),
      });
    }
  }

  // ---- priority + ordering --------------------------------------------------
  for (const f of out) {
    const share = f.impact && monthlyRevenue > 0 ? f.impact.amount / monthlyRevenue : 0;
    f.priority = !f.action ? "info"
      : f.tone === "warn" && (share >= 0.1 || f.id === "no-show") ? "urgent"
      : f.tone === "warn" ? "high" : "normal";
  }
  const visible = out.filter((f) => !isSuppressed(f.id, c.recentActions));
  const byValue = (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (b.impact?.amount || 0) - (a.impact?.amount || 0);
  const actions = visible.filter((f) => f.action).sort(byValue).slice(0, c.limit ?? 6);
  const notes = visible.filter((f) => !f.action).sort(byValue).slice(0, 4);
  const totalImpact = actions.reduce((s, f) => s + (f.impact?.amount || 0), 0);
  return { actions, notes, totalImpact };
}

/** SMS for the fill-a-day campaign. {{name}} / {{salon}} are filled per recipient server-side. */
export function fillDayDraft(dayLabel, bookingUrl) {
  return `سلام {{name}} عزیز، ${dayLabel} در {{salon}} وقت خالی داریم و خوشحال می‌شیم ببینیمت 🌸${bookingUrl ? `\nرزرو: ${bookingUrl}` : ""}`;
}

/** Iranian SMS parts: 70 chars for Persian (UCS-2), 67 per part when split. */
export function smsPartCount(text) {
  const n = [...(text || "")].length;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/**
 * Lapsed customers to invite for one day, best first: those who have come on
 * the same weekday before, then the longest-absent. Anyone already booked
 * that day is left out.
 * @param {Array<{phone, name, days_since}>} lapsed   inactive_customers() rows
 * @param {Array} bookings   the salon's bookings (for weekday habits and that day's bookings)
 */
export function rankFillDayAudience(lapsed, bookings, { dKey, weekday, cap = 100 } = {}) {
  const bookedThatDay = new Set(bookings.filter((b) => b.date === dKey && !["cancelled", "no_show"].includes(b.status)).map((b) => b.customer_phone));
  const sameWeekday = new Map();
  if (weekday != null) {
    for (const b of bookings) {
      if (b.status !== "completed" || !b.date) continue;
      const [y, m, d] = b.date.split("-").map(Number);
      if ((new Date(y, m - 1, d).getDay() + 1) % 7 === weekday) sameWeekday.set(b.customer_phone, (sameWeekday.get(b.customer_phone) || 0) + 1);
    }
  }
  return lapsed
    .filter((c) => c.phone && !bookedThatDay.has(c.phone))
    .map((c) => ({ ...c, habit: sameWeekday.get(c.phone) || 0 }))
    .sort((a, b) => b.habit - a.habit || (b.days_since || 0) - (a.days_since || 0))
    .slice(0, cap);
}
