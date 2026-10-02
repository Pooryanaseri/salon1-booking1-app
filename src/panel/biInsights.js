// ============================================================================
//  BI → "تحلیل و اقدام پیشنهادی" (v2.40)
//  Turns the numbers the BI tab already computes into a few plain-language
//  findings, each with the one action that addresses it. Pure: no React, no
//  network — BITab passes in what it has, BIInsightsCard runs the action
//  only after the manager confirms it.
//
//  Every finding: { id, tone: "warn"|"info"|"good", title, text,
//                   action?: { kind, label, confirm, ...params } }
//  Action kinds (executed by BIInsightsCard):
//    campaign   — SMS to one RFM segment            { segment }
//    fill_day   — invite lapsed customers for a mostly-empty day { dKey, dayLabel }
//    automation — flip an app_settings switch        { patch }
//    reminder   — turn the customer reminder back on { hours }
//    goto       — open the panel tab where only the manager can finish it { tab }
// ============================================================================
import { toFa, formatToman, SCHEMA_DAY_LABELS } from "../lib/format";

const MIN_BOOKINGS = 5; // below this, rates are noise — say nothing
const pct = (v) => `${toFa(Math.round(v * 100))}٪`;
const TONE_ORDER = { warn: 0, info: 1, good: 2 };

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
 * @param {Array<{dKey:string, label:string, fillRate:number, hasCapacity:boolean}>} c.nextDays  today first
 * @param {Array<{name:string, value:number}>} c.serviceShare
 * @param {Array<{name:string, count:number, returnRate:number}>} c.stylistPerf
 * @param {object} c.automation          app_settings switches
 * @param {Record<string, number>} c.segmentCounts  reachable customers per RFM segment
 * @param {number} [c.limit=6]
 */
export function buildBIInsights(c) {
  const out = [];
  const automation = c.automation || {};
  const seg = c.segmentCounts || {};
  const period = c.periodBookings || [];
  const prevPeriod = c.prevPeriodBookings || [];
  const spanLabel = `${toFa(c.spanDays)} روز اخیر`;

  // ---- 1. no-shows: the most direct revenue leak --------------------------
  const noShows = period.filter((b) => b.status === "no_show");
  if (period.length >= MIN_BOOKINGS && noShows.length >= 2 && c.cur.noShowRate >= 0.08) {
    const lost = noShows.reduce((s, b) => s + (b.final_price ?? c.services?.find((x) => x.id === b.service_id)?.price ?? 0), 0);
    let action;
    if (!automation.attendance_confirmation) {
      action = { kind: "automation", patch: { attendance_confirmation: true }, label: "روشن کردن تایید حضور",
        confirm: "از این به بعد در پیامک یادآوری لینک «می‌آیم / نمی‌آیم» فرستاده می‌شود و نوبت لغوشده خودکار به لیست انتظار پیشنهاد می‌شود." };
    } else if (!(automation.reminder_hours_before > 0)) {
      action = { kind: "reminder", hours: 3, label: "روشن کردن پیامک یادآوری",
        confirm: "پیامک یادآوری ۳ ساعت قبل از هر نوبت (برای نوبت‌های آینده هم) ارسال می‌شود." };
    } else if (!(automation.deposit_percent > 0)) {
      action = { kind: "goto", tab: "schedule", label: "تنظیم بیعانهٔ آنلاین",
        confirm: "بیعانه به مرچنت‌کد زرین‌پال خود سالن نیاز دارد، پس این مرحله را خودتان در «ساعات کاری ← پیش‌پرداخت آنلاین» کامل کنید." };
    }
    out.push({
      id: "no-show", tone: "warn",
      title: `${pct(c.cur.noShowRate)} نوبت‌ها بدون حضور`,
      text: `در ${spanLabel} ${toFa(noShows.length)} نوبت بدون حضور بود${lost > 0 ? `؛ حدود ${formatToman(lost)} درآمد از دست رفت` : ""}.`
        + (action?.kind === "goto" ? " یادآوری و تایید حضور روشن است؛ قدم بعدی گرفتن بیعانه برای خدمات گران است." : ""),
      action,
    });
  }

  // ---- 2. revenue vs. the previous equal period, with the reason ----------
  if (c.prev.revenue > 0 && c.cur.revenue >= 0) {
    const delta = (c.cur.revenue - c.prev.revenue) / c.prev.revenue;
    if (Math.abs(delta) >= 0.1) {
      const done = (list) => list.filter((b) => b.status === "completed" && b.final_price != null);
      const curDone = done(period), prevDone = done(prevPeriod);
      const countDelta = prevDone.length ? (curDone.length - prevDone.length) / prevDone.length : 0;
      const avg = (l) => (l.length ? l.reduce((s, b) => s + b.final_price, 0) / l.length : 0);
      const ticketDelta = avg(prevDone) ? (avg(curDone) - avg(prevDone)) / avg(prevDone) : 0;
      const driver = Math.abs(countDelta) >= Math.abs(ticketDelta)
        ? `بیشتر به خاطر ${countDelta >= 0 ? "افزایش" : "کاهش"} تعداد نوبت‌ها (${toFa(prevDone.length)} ← ${toFa(curDone.length)})`
        : `بیشتر به خاطر ${ticketDelta >= 0 ? "افزایش" : "کاهش"} میانگین مبلغ هر نوبت (${formatToman(avg(prevDone))} ← ${formatToman(avg(curDone))})`;
      out.push({
        id: delta > 0 ? "revenue-up" : "revenue-down",
        tone: delta > 0 ? "good" : "warn",
        title: `درآمد ${toFa(Math.round(Math.abs(delta) * 100))}٪ ${delta > 0 ? "بیشتر" : "کمتر"} از دورهٔ قبل`,
        text: `${formatToman(c.prev.revenue)} ← ${formatToman(c.cur.revenue)}؛ ${driver}.`,
        // The at-risk finding below carries the win-back action; only attach it
        // here when that finding won't be shown.
        action: delta < 0 && countDelta < 0 && seg.at_risk > 0 && seg.at_risk < 3 ? winBack(seg.at_risk) : undefined,
      });
    }
  }

  // ---- 3. customers drifting away ------------------------------------------
  if (seg.at_risk >= 3) {
    out.push({
      id: "at-risk", tone: "warn",
      title: `${toFa(seg.at_risk)} مشتری در خطر ریزش`,
      text: "این مشتری‌ها قبلاً مرتب می‌آمدند ولی مدتی است نوبت نگرفته‌اند. یک پیامک با تخفیف بازگشت معمولاً بخشی از آن‌ها را برمی‌گرداند.",
      action: winBack(seg.at_risk),
    });
  }

  // ---- 4. second visits ------------------------------------------------------
  const anchors = period.filter((b) => b.status === "completed").length;
  if (anchors >= MIN_BOOKINGS && c.cur.returnRate60 < 0.3) {
    out.push({
      id: "return-rate", tone: "warn",
      title: `فقط ${pct(c.cur.returnRate60)} مشتری‌ها ظرف ۶۰ روز برگشتند`,
      text: "سخت‌ترین قدم، نوبت دوم است. یک پیامک تشکر به مشتری‌های تازه بعد از اولین مراجعه، احتمال برگشتشان را بالا می‌برد.",
      action: seg.new > 0 ? {
        kind: "campaign", segment: "new", count: seg.new, label: `پیامک تشکر به ${toFa(seg.new)} مشتری تازه`,
        confirm: `پیامک تشکر و دعوت دوباره برای ${toFa(seg.new)} مشتری تازه ارسال می‌شود.`,
      } : undefined,
    });
  }

  // ---- 5. an emptyish day coming up (today excluded: too late to fill) ----
  const empty = (c.nextDays || []).slice(1).filter((d) => d.hasCapacity && d.fillRate < 0.2)
    .sort((a, b) => a.fillRate - b.fillRate)[0];
  if (empty) {
    out.push({
      id: `empty-${empty.dKey}`, tone: "warn",
      title: `${empty.label} تقریباً خالی است`,
      text: `فقط ${pct(empty.fillRate)} ظرفیت آن روز رزرو شده. با یک پیامک به مشتری‌هایی که بیش از یک ماه نیامده‌اند می‌شود بخشی از آن را پر کرد.`,
      action: { kind: "fill_day", dKey: empty.dKey, dayLabel: empty.label, label: "دعوت مشتری‌ها برای این روز",
        confirm: `به مشتری‌هایی که بیش از ۳۰ روز نیامده‌اند (حداکثر ۱۰۰ نفر) پیامک «${empty.label} وقت خالی داریم» با لینک رزرو ارسال می‌شود.` },
    });
  }

  // ---- 6. fully booked days without a waitlist -----------------------------
  const full = (c.nextDays || []).filter((d) => d.hasCapacity && d.fillRate >= 0.9);
  if (full.length && !automation.waitlist_auto_offer) {
    out.push({
      id: "waitlist", tone: "info",
      title: `${toFa(full.length)} روز از هفتهٔ پیش رو تقریباً پر است`,
      text: "با روشن بودن لیست انتظار، اگر کسی نوبتش را لغو کند وقت خالی‌شده خودکار به نفر بعدی پیشنهاد می‌شود.",
      action: { kind: "automation", patch: { waitlist_auto_offer: true }, label: "روشن کردن لیست انتظار خودکار",
        confirm: "وقت‌های لغوشده خودکار با پیامک به افراد لیست انتظار همان روز پیشنهاد می‌شود." },
    });
  }

  // ---- 7. revenue concentrated in a few customers --------------------------
  const p = c.pareto;
  if (p && p.topCustomers?.length >= 3 && p.pctOfCustomers > 0 && p.pctOfCustomers <= 25) {
    out.push({
      id: "vip", tone: "info",
      title: `${toFa(Math.round(p.pctOfCustomers))}٪ مشتری‌ها ${toFa(Math.round(p.pctOfRevenue))}٪ درآمد را می‌سازند`,
      text: `${toFa(p.topCustomers.length)} مشتری اصلی سالن را نگه دارید. از دست دادن حتی چند نفر از آن‌ها روی درآمد اثر جدی دارد.`,
      action: seg.champions_vip > 0 ? {
        kind: "campaign", segment: "champions_vip", count: seg.champions_vip, label: `پیامک قدردانی به ${toFa(seg.champions_vip)} مشتری VIP`,
        confirm: `پیامک قدردانی با ۲۰٪ تخفیف ویژه برای ${toFa(seg.champions_vip)} مشتری VIP ارسال می‌شود.`,
      } : undefined,
    });
  }

  // ---- 8. busiest / quietest time slots (info only: pricing is a judgement call)
  if (c.heatmapGrid && period.length >= MIN_BOOKINGS * 2) {
    let best = null;
    c.heatmapGrid.forEach((row, day) => row.forEach((v, h) => { if (!best || v > best.v) best = { v, day, h }; }));
    const dayTotals = c.heatmapGrid.map((row, day) => ({ day, v: row.reduce((s, x) => s + x, 0) }));
    const quiet = dayTotals.filter((d) => d.v > 0).sort((a, b) => a.v - b.v)[0];
    if (best?.v > 0 && quiet && quiet.day !== best.day) {
      const hour = c.heatmapHours[best.h];
      out.push({
        id: "peak", tone: "info",
        title: `اوج شلوغی: ${SCHEMA_DAY_LABELS[best.day]} ساعت ${toFa(hour)} تا ${toFa(hour + 1)}`,
        text: `خلوت‌ترین روز ${SCHEMA_DAY_LABELS[quiet.day]} است. برای پخش مشتری‌ها، تخفیف یا خدمت ویژه را روی ${SCHEMA_DAY_LABELS[quiet.day]} بگذارید و در ساعات اوج آرایشگر کافی داشته باشید.`,
      });
    }
  }

  // ---- 9. one service carries the salon -------------------------------------
  const shareTotal = (c.serviceShare || []).reduce((s, x) => s + x.value, 0);
  const top = c.serviceShare?.[0];
  if (top && shareTotal > 0 && top.value / shareTotal >= 0.5 && (c.serviceShare || []).length > 1) {
    out.push({
      id: "service-concentration", tone: "info",
      title: `${toFa(Math.round((top.value / shareTotal) * 100))}٪ درآمد از «${top.name}»`,
      text: "درآمد به یک خدمت وابسته است. پیشنهاد خدمت مکمل به همین مشتری‌ها (پکیج یا تخفیف ترکیبی) ریسک را کم و میانگین فاکتور را زیاد می‌کند.",
    });
  }

  // ---- 10. a stylist whose customers don't come back -----------------------
  const perf = (c.stylistPerf || []).filter((s) => s.count >= MIN_BOOKINGS);
  if (perf.length >= 2) {
    const avgReturn = perf.reduce((s, r) => s + r.returnRate, 0) / perf.length;
    const low = [...perf].sort((a, b) => a.returnRate - b.returnRate)[0];
    if (avgReturn - low.returnRate >= 20) {
      out.push({
        id: `stylist-${low.name}`, tone: "info",
        title: `مشتری‌های ${low.name} کمتر برمی‌گردند`,
        text: `نرخ بازگشت ${toFa(Math.round(low.returnRate))}٪ در برابر میانگین ${toFa(Math.round(avgReturn))}٪. نظرسنجی‌های این آرایشگر را ببینید یا با او صحبت کنید.`,
      });
    }
  }

  // ---- 11. new-customer momentum --------------------------------------------
  if (c.prev.newCustomers >= 3) {
    const d = (c.cur.newCustomers - c.prev.newCustomers) / c.prev.newCustomers;
    if (d >= 0.2) {
      out.push({ id: "new-up", tone: "good", title: `مشتری جدید ${toFa(Math.round(d * 100))}٪ بیشتر شد`,
        text: `${toFa(c.prev.newCustomers)} ← ${toFa(c.cur.newCustomers)} نفر. همین مسیر جذب را ادامه دهید.` });
    } else if (d <= -0.3) {
      out.push({ id: "new-down", tone: "info", title: `مشتری جدید ${toFa(Math.round(-d * 100))}٪ کمتر شد`,
        text: `${toFa(c.prev.newCustomers)} ← ${toFa(c.cur.newCustomers)} نفر. کد معرفی باشگاه مشتریان را به مشتری‌های فعلی یادآوری کنید.` });
    }
  }

  return out
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
    .slice(0, c.limit ?? 6);
}

function winBack(count) {
  return {
    kind: "campaign", segment: "at_risk", count, label: `پیامک بازگشت به ${toFa(count)} مشتری`,
    confirm: `پیامک «دلمون برات تنگ شده» با ۲۰٪ تخفیف برای ${toFa(count)} مشتری در خطر ریزش ارسال می‌شود.`,
  };
}

/** SMS for the fill_day action. {{name}} is filled per recipient. */
export function fillDayDraft(dayLabel, bookingUrl) {
  return `سلام {{name}} عزیز، ${dayLabel} در {{salon}} وقت خالی داریم و خوشحال می‌شیم ببینیمت 🌸${bookingUrl ? `\nرزرو: ${bookingUrl}` : ""}`;
}
