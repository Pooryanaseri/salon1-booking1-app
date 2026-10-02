import React, { useState, useMemo } from "react";
import { Clock, Percent, Banknote, XCircle, TrendingUp, TrendingDown, ChevronLeft, Wallet, Users, UserPlus, Repeat2, Award, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { gregorianToJalali, jalaliDayNum, MONTHS_FA, WEEKDAYS_FA_FULL, SCHEMA_DAY_LABELS, toFa, formatToman, jalaliLabel, hhmmToMin, dateKey, parseDateKey, bookingTimestamp } from "../lib/format";
import { BookingHeatmap, CampaignPerformanceCard, CampaignReturnRateCard, FeedbackStatsCard, RevenueTrendChart, ServiceShareDonut } from "./biCards";
import { GENDER_TYPE_LABEL, schemaDayOf } from "../app/shared";
import { GenderBadge } from "../components/ui";

/* ============================================================
   Business Intelligence tab — owner-only (RBAC enforced by PanelView:
   this tab is excluded from a logged-in stylist's subTabs list and the
   render is double-guarded with `!currentStylist`).

   4 KPIs, each comparable against the previous equal-length period, with
   a shared hierarchical drill-down: کل ← شعبه ← جنسیت ← خدمت ← آرایشگر ← روز ← فاکتور.
   Every level renders the same 4 columns (مقدار / دورهٔ قبل / Δ٪ / سهم٪).

   Design notes (this app has no real multi-branch data model):
   - "شعبه" is derived from an optional `booking.branch` field, defaulting
     to a single "شعبه اصلی" — the hierarchy level exists and works, it's
     just a single bucket until real branch data is introduced.
   - "فاکتور" (leaf level) = each individual priced booking. A single
     invoice has no natural "previous period" counterpart, so that column
     shows "—" there; مقدار/سهم٪ are still fully computed.
   - "روز" (day) compares each date against the same relative day in the
     previous period (date shifted back by the period length), not a
     literal calendar match — previous-period dates are a different date
     range entirely, so a literal match would always be empty.
   ============================================================ */
export const BI_DRILL_LEVELS = [
  { key: "branch", label: "شعبه" },
  { key: "gender", label: "جنسیت" },
  { key: "service", label: "خدمت" },
  { key: "staff", label: "آرایشگر" },
  { key: "day", label: "روز" },
  { key: "invoice", label: "فاکتور" },
];

export function biDeriveKey(levelKey, b, services) {
  switch (levelKey) {
    case "branch":
      return { raw: b.branch || "شعبه اصلی", label: b.branch || "شعبه اصلی" };
    case "gender":
      return { raw: b.customer_gender, label: GENDER_TYPE_LABEL[b.customer_gender] || b.customer_gender };
    case "service": {
      const svc = services.find((s) => s.id === b.service_id);
      return { raw: b.service_id, label: svc ? svc.name : "نامشخص" };
    }
    case "staff":
      return { raw: b.staff_id || "none", label: b.staff_name || "بدون آرایشگر مشخص" };
    case "day":
      return { raw: b.date, label: jalaliLabel(parseDateKey(b.date), { short: true }) };
    default:
      return { raw: b.id, label: b.id };
  }
}
export function biEntryMatches(b, entry) {
  switch (entry.levelKey) {
    case "branch": return (b.branch || "شعبه اصلی") === entry.rawValue;
    case "gender": return b.customer_gender === entry.rawValue;
    case "service": return b.service_id === entry.rawValue;
    case "staff": return (b.staff_id || "none") === entry.rawValue;
    case "day": return b.date === entry.rawValue;
    case "invoice": return b.id === entry.rawValue;
    default: return true;
  }
}

export function biPriced(list) { return list.filter((b) => b.final_price != null); }

export const BI_KPIS = [
  {
    id: "newCustomers", label: "مشتری جدید", Icon: UserPlus, higherIsBetter: true,
    format: (v) => `${toFa(Math.round(v))} نفر`,
    compute: (subset, allBookings, periodStartTs) => {
      const seen = new Set();
      let count = 0;
      for (const b of subset) {
        if (seen.has(b.customer_phone)) continue;
        seen.add(b.customer_phone);
        const hadEarlier = allBookings.some((ob) => ob.customer_phone === b.customer_phone && bookingTimestamp(ob) < periodStartTs);
        if (!hadEarlier) count++;
      }
      return count;
    },
    single: (b, allBookings, periodStartTs) => {
      const hadEarlier = allBookings.some((ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && bookingTimestamp(ob) < periodStartTs);
      return hadEarlier ? 0 : 1;
    },
  },
  {
    id: "returnRate60", label: "نرخ بازگشت ۶۰ روزه", Icon: Repeat2, higherIsBetter: true,
    format: (v) => `${toFa(Math.round(v * 100))}٪`,
    compute: (subset, allBookings) => {
      const anchors = new Map();
      for (const b of subset) {
        if (b.status !== "completed") continue;
        const ts = bookingTimestamp(b);
        if (!anchors.has(b.customer_phone) || ts < anchors.get(b.customer_phone)) anchors.set(b.customer_phone, ts);
      }
      if (anchors.size === 0) return 0;
      let returned = 0;
      for (const [phone, anchorTs] of anchors) {
        const hasReturn = allBookings.some(
          (ob) => ob.customer_phone === phone && ob.status === "completed" && bookingTimestamp(ob) > anchorTs && bookingTimestamp(ob) <= anchorTs + 60 * 86400000
        );
        if (hasReturn) returned++;
      }
      return returned / anchors.size;
    },
    single: (b, allBookings) => {
      if (b.status !== "completed") return 0;
      const ts = bookingTimestamp(b);
      const hasReturn = allBookings.some(
        (ob) => ob.customer_phone === b.customer_phone && ob.id !== b.id && ob.status === "completed" && bookingTimestamp(ob) > ts && bookingTimestamp(ob) <= ts + 60 * 86400000
      );
      return hasReturn ? 1 : 0;
    },
  },
  {
    id: "totalRevenue", label: "درآمد کل", Icon: Wallet, higherIsBetter: true,
    format: (v) => formatToman(v),
    compute: (subset) => biPriced(subset.filter((b) => b.status === "completed")).reduce((s, b) => s + b.final_price, 0),
    single: (b) => (b.status === "completed" && b.final_price != null ? b.final_price : 0),
  },
  {
    id: "noShowRate", label: "نرخ عدم حضور", Icon: XCircle, higherIsBetter: false,
    format: (v) => `${toFa(Math.round(v * 100))}٪`,
    compute: (subset) => (subset.length === 0 ? 0 : subset.filter((b) => b.status === "no_show").length / subset.length),
    single: (b) => (b.status === "no_show" ? 1 : 0),
  },
];

const DONUT_COLORS = ["var(--color-accent-500)", "var(--color-info)", "var(--color-success)", "var(--color-warning)", "var(--color-tab-panel)"];

export function BITab({ bookings, services, stylists, workingHours, staffWorkingHours, timeOff, approvedDates }) {
  const [range, setRange] = useState("30"); // default 30 days
  const [branchFilter, setBranchFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState("all");
  const [drill, setDrill] = useState(null); // { kpiId, path: [{ levelKey, rawValue, label }] }

  const branches = useMemo(() => Array.from(new Set(bookings.map((b) => b.branch || "شعبه اصلی"))), [bookings]);
  const spanDays = Number(range);

  const { periodStart, periodEnd, prevPeriodStart, prevPeriodEnd } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setDate(end.getDate() + 1); // exclusive — through end of today
    const start = new Date(today);
    start.setDate(start.getDate() - (spanDays - 1));
    const prevEnd = new Date(start);
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - spanDays);
    return { periodStart: start, periodEnd: end, prevPeriodStart: prevStart, prevPeriodEnd: prevEnd };
  }, [spanDays]);

  // Branch/stylist-filtered, but NOT date-filtered — this is the pool used for
  // "has this customer been seen before" lookback checks (new customer / return rate),
  // so history outside the selected date window still counts correctly.
  const baseFiltered = useMemo(
    () => bookings.filter((b) => (branchFilter === "all" || (b.branch || "شعبه اصلی") === branchFilter) && (staffFilter === "all" || b.staff_id === staffFilter)),
    [bookings, branchFilter, staffFilter]
  );
  const periodBookings = useMemo(
    () => baseFiltered.filter((b) => { const ts = bookingTimestamp(b); return ts >= periodStart.getTime() && ts < periodEnd.getTime(); }),
    [baseFiltered, periodStart, periodEnd]
  );
  const prevPeriodBookings = useMemo(
    () => baseFiltered.filter((b) => { const ts = bookingTimestamp(b); return ts >= prevPeriodStart.getTime() && ts < prevPeriodEnd.getTime(); }),
    [baseFiltered, prevPeriodStart, prevPeriodEnd]
  );

  // ---- v2.12: weekday × hour heatmap — same two dimensions as peakHours/
  // weekdayDist above, combined into one grid so an interaction like
  // "Thursday evenings specifically" is visible, not just each axis alone.
  const heatmapHours = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 8), []); // 08..19
  const heatmapGrid = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => new Array(heatmapHours.length).fill(0));
    for (const b of periodBookings) {
      const day = schemaDayOf(parseDateKey(b.date));
      const hourIdx = Math.floor(b.start_min / 60) - heatmapHours[0];
      if (hourIdx >= 0 && hourIdx < heatmapHours.length) grid[day][hourIdx] += 1;
    }
    return grid;
  }, [periodBookings, heatmapHours]);

  // ---- Stylist performance table: sortable, with a "score" combining volume,
  // average ticket, and return rate. Return rate is computed over baseFiltered
  // (full history, not just the current period) since it measures a lasting
  // customer relationship, not a one-window snapshot. ----
  const [perfSortKey, setPerfSortKey] = useState("count");
  const [perfSortDir, setPerfSortDir] = useState("desc");
  const stylistPerf = useMemo(() => {
    const activeStylists = stylists.filter((s) => s.active);
    const rows = activeStylists.map((st) => {
      const completedTheirs = periodBookings.filter((b) => b.staff_id === st.id && b.status === "completed" && b.final_price != null);
      const count = completedTheirs.length;
      const totalRevenue = completedTheirs.reduce((s, b) => s + b.final_price, 0);
      const avgRevenue = count > 0 ? totalRevenue / count : 0;
      const customerVisits = new Map();
      for (const b of baseFiltered.filter((b) => b.staff_id === st.id && b.status === "completed")) {
        customerVisits.set(b.customer_phone, (customerVisits.get(b.customer_phone) || 0) + 1);
      }
      const totalCustomers = customerVisits.size;
      const returningCustomers = Array.from(customerVisits.values()).filter((v) => v > 1).length;
      const returnRate = totalCustomers > 0 ? (returningCustomers / totalCustomers) * 100 : 0;
      return { id: st.id, name: st.name, gender: st.gender, count, avgRevenue, returnRate };
    });
    const maxCount = Math.max(1, ...rows.map((r) => r.count));
    const maxAvgRevenue = Math.max(1, ...rows.map((r) => r.avgRevenue));
    return rows.map((r) => ({
      ...r,
      score: (0.4 * (r.count / maxCount) + 0.35 * (r.avgRevenue / maxAvgRevenue) + 0.25 * (r.returnRate / 100)) * 100,
    }));
  }, [stylists, periodBookings, baseFiltered]);
  const stylistPerfAvg = useMemo(() => {
    const n = stylistPerf.length || 1;
    return {
      count: stylistPerf.reduce((s, r) => s + r.count, 0) / n,
      avgRevenue: stylistPerf.reduce((s, r) => s + r.avgRevenue, 0) / n,
      returnRate: stylistPerf.reduce((s, r) => s + r.returnRate, 0) / n,
      score: stylistPerf.reduce((s, r) => s + r.score, 0) / n,
    };
  }, [stylistPerf]);
  const sortedStylistPerf = useMemo(() => {
    const arr = [...stylistPerf];
    arr.sort((a, b) => (perfSortDir === "desc" ? b[perfSortKey] - a[perfSortKey] : a[perfSortKey] - b[perfSortKey]));
    return arr;
  }, [stylistPerf, perfSortKey, perfSortDir]);
  function togglePerfSort(key) {
    if (perfSortKey === key) setPerfSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setPerfSortKey(key); setPerfSortDir("desc"); }
  }

  // ---- Pareto: the customers who make up 80% of this period's revenue ----
  const paretoData = useMemo(() => {
    const byCustomer = new Map();
    for (const b of periodBookings.filter((b) => b.status === "completed" && b.final_price != null)) {
      const cur = byCustomer.get(b.customer_phone) || { phone: b.customer_phone, name: b.customer_name, revenue: 0, visits: 0 };
      cur.revenue += b.final_price;
      cur.visits += 1;
      byCustomer.set(b.customer_phone, cur);
    }
    const sorted = Array.from(byCustomer.values()).sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = sorted.reduce((s, c) => s + c.revenue, 0);
    let cumulative = 0, paretoCount = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += sorted[i].revenue;
      if (totalRevenue > 0 && cumulative / totalRevenue >= 0.8) { paretoCount = i + 1; break; }
    }
    const topCustomers = sorted.slice(0, paretoCount);
    const topRevenue = topCustomers.reduce((s, c) => s + c.revenue, 0);
    return {
      topCustomers, totalRevenue,
      pctOfCustomers: sorted.length > 0 ? (paretoCount / sorted.length) * 100 : 0,
      pctOfRevenue: totalRevenue > 0 ? (topRevenue / totalRevenue) * 100 : 0,
    };
  }, [periodBookings]);

  // ---- Demand forecast: 7-day trailing moving average of completed bookings,
  // plus an EXACT (not estimated) capacity model for the next 7 days — each
  // active stylist's real working minutes that day (respecting their own
  // hours, time off, and day-approval), minus minutes already booked.
  // "کم‌پرشدگی" alert = fill rate under 20% (i.e. the day is mostly empty —
  // the missed-opportunity case), shown alongside the raw numbers so the fill
  // vs. empty reading is never ambiguous.
  const demandForecast = useMemo(() => {
    const dailyCounts = new Map();
    for (const b of baseFiltered.filter((b) => b.status === "completed")) {
      dailyCounts.set(b.date, (dailyCounts.get(b.date) || 0) + 1);
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const last7Keys = [];
    for (let i = 1; i <= 7; i++) { const d = new Date(today); d.setDate(d.getDate() - i); last7Keys.push(dateKey(d)); }
    const movingAvg = last7Keys.reduce((s, k) => s + (dailyCounts.get(k) || 0), 0) / 7;

    const activeStylists = stylists.filter((s) => s.active && (staffFilter === "all" || s.id === staffFilter));
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const dKey = dateKey(d);
      const approved = (approvedDates || []).includes(dKey);
      let totalCapacity = 0, totalBooked = 0;
      for (const st of activeStylists) {
        const whList = (staffWorkingHours && staffWorkingHours[st.id]) || workingHours;
        const wh = whList.find((w) => w.day_of_week === schemaDayOf(d));
        const isOff = (timeOff || []).some((t) => (!t.staff_id || t.staff_id === st.id) && t.date === dKey);
        if (!wh || wh.is_closed || isOff || !approved) continue;
        totalCapacity += Math.max(0, hhmmToMin(wh.end_time) - hhmmToMin(wh.start_time));
        const theirBookings = bookings.filter(
          (b) => b.staff_id === st.id && b.date === dKey && ["confirmed", "pending", "rescheduled", "completed"].includes(b.status)
        );
        totalBooked += theirBookings.reduce((s, b) => s + (b.end_min - b.start_min) + (b.buffer_minutes || 0), 0);
      }
      const fillRate = totalCapacity > 0 ? Math.min(1, totalBooked / totalCapacity) : 0;
      days.push({ date: d, dKey, totalCapacity, totalBooked, fillRate, hasCapacity: totalCapacity > 0, lowFill: totalCapacity > 0 && fillRate < 0.2 });
    }
    return { movingAvg, days };
  }, [baseFiltered, bookings, stylists, staffFilter, workingHours, staffWorkingHours, timeOff, approvedDates]);

  function applyPath(list, path) {
    return path.reduce((acc, entry) => acc.filter((b) => biEntryMatches(b, entry)), list);
  }
  const pathFilteredPeriod = drill ? applyPath(periodBookings, drill.path) : periodBookings;
  const pathFilteredPrev = drill ? applyPath(prevPeriodBookings, drill.path) : prevPeriodBookings;

  // Moved here from Accounting: service popularity and new-vs-returning are analytical,
  // not transactional, so they live in BI now. All scoped to the current period/filters,
  // same pool the KPI cards use (periodBookings), not affected by the drill-down path.
  const periodCompleted = periodBookings.filter((b) => b.status === "completed");
  const periodPricedCompleted = periodCompleted.filter((b) => b.final_price != null);

  const topByCount = useMemo(() => {
    const map = new Map();
    for (const b of periodCompleted) map.set(b.service_id, (map.get(b.service_id) || 0) + 1);
    const totalCount = periodCompleted.length || 1;
    return Array.from(map.entries())
      .map(([serviceId, count]) => ({ service: services.find((s) => s.id === serviceId), count, pct: (count / totalCount) * 100 }))
      .filter((x) => x.service)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }, [periodCompleted, services]);

  // ---- v2.12: daily revenue trend for the selected range (max range here
  // is 90 days, so daily buckets stay readable without needing a
  // monthly-rollup mode the way Accounting's longer-range chart does). ----
  const revenueTrend = useMemo(() => {
    const byDay = new Map();
    for (const b of periodPricedCompleted) byDay.set(b.date, (byDay.get(b.date) || 0) + b.final_price);
    const days = [];
    for (let d = new Date(periodStart); d < periodEnd; d.setDate(d.getDate() + 1)) {
      const key = dateKey(d);
      days.push({ label: jalaliLabel(new Date(d), { short: true }).split(" ")[0], value: byDay.get(key) || 0 });
    }
    return days;
  }, [periodPricedCompleted, periodStart, periodEnd]);

  // ---- v2.12: service revenue share for the donut — top 5 + یک سهم "سایر"
  // برای بقیه، تا مجموع سهم‌ها همیشه ۱۰۰٪ بمونه. ----
  const serviceShareSlices = useMemo(() => {
    const map = new Map();
    for (const b of periodPricedCompleted) map.set(b.service_id, (map.get(b.service_id) || 0) + b.final_price);
    const ranked = Array.from(map.entries())
      .map(([serviceId, revenue]) => ({ name: services.find((s) => s.id === serviceId)?.name, revenue }))
      .filter((x) => x.name)
      .sort((a, b) => b.revenue - a.revenue);
    const top = ranked.slice(0, 5).map((x, i) => ({ name: x.name, value: x.revenue, color: DONUT_COLORS[i] }));
    const restTotal = ranked.slice(5).reduce((s, x) => s + x.revenue, 0);
    if (restTotal > 0) top.push({ name: "سایر", value: restTotal, color: "var(--color-muted)" });
    return top;
  }, [periodPricedCompleted, services]);

  // A customer counts as "returning" if they had a completed visit before this period
  // started, anywhere in baseFiltered (branch/staff-filtered but not date-filtered).
  const customerMix = useMemo(() => {
    const rangeStartTs = periodStart.getTime();
    let newRevenue = 0, returningRevenue = 0, newCount = 0, returningCount = 0;
    for (const b of periodPricedCompleted) {
      const hadPriorVisit = baseFiltered.some(
        (ob) => ob.customer_phone === b.customer_phone && ob.status === "completed" && bookingTimestamp(ob) < rangeStartTs
      );
      if (hadPriorVisit) { returningRevenue += b.final_price; returningCount += 1; }
      else { newRevenue += b.final_price; newCount += 1; }
    }
    return { newRevenue, returningRevenue, newCount, returningCount, total: newRevenue + returningRevenue || 1 };
  }, [periodPricedCompleted, baseFiltered, periodStart]);

  const activeKpi = drill ? BI_KPIS.find((k) => k.id === drill.kpiId) : null;
  const currentLevel = drill && drill.path.length < BI_DRILL_LEVELS.length ? BI_DRILL_LEVELS[drill.path.length] : null;

  const levelRows = useMemo(() => {
    if (!activeKpi || !currentLevel) return [];
    const parentTotal = activeKpi.compute(pathFilteredPeriod, baseFiltered, periodStart.getTime()) || 1;

    if (currentLevel.key === "invoice") {
      return pathFilteredPeriod
        .map((b) => {
          const svc = services.find((s) => s.id === b.service_id);
          const value = activeKpi.single(b, baseFiltered, periodStart.getTime());
          return {
            rawValue: b.id,
            label: `${b.customer_name || "بدون نام"} · ${svc?.name || ""}`,
            value, prevValue: null,
            share: (value / parentTotal) * 100,
          };
        })
        .sort((a, b) => b.value - a.value);
    }

    const groups = new Map();
    for (const b of pathFilteredPeriod) {
      const { raw, label } = biDeriveKey(currentLevel.key, b, services);
      if (!groups.has(raw)) groups.set(raw, { label, bookings: [] });
      groups.get(raw).bookings.push(b);
    }
    const rows = [];
    for (const [raw, g] of groups) {
      const value = activeKpi.compute(g.bookings, baseFiltered, periodStart.getTime());
      let prevSubset;
      if (currentLevel.key === "day") {
        const shifted = new Date(parseDateKey(raw));
        shifted.setDate(shifted.getDate() - spanDays);
        const shiftedKey = dateKey(shifted);
        prevSubset = pathFilteredPrev.filter((b) => b.date === shiftedKey);
      } else {
        prevSubset = pathFilteredPrev.filter((b) => biDeriveKey(currentLevel.key, b, services).raw === raw);
      }
      const prevValue = activeKpi.compute(prevSubset, baseFiltered, prevPeriodStart.getTime());
      rows.push({ rawValue: raw, label: g.label, value, prevValue, share: (value / parentTotal) * 100 });
    }
    return rows.sort((a, b) => b.value - a.value);
  }, [activeKpi, currentLevel, pathFilteredPeriod, pathFilteredPrev, baseFiltered, services, periodStart, prevPeriodStart, spanDays]);

  function openDrill(kpiId) { setDrill({ kpiId, path: [] }); }
  function drillInto(row) {
    if (!currentLevel || currentLevel.key === "invoice") return;
    setDrill((d) => ({ ...d, path: [...d.path, { levelKey: currentLevel.key, rawValue: row.rawValue, label: row.label }] }));
  }
  function jumpTo(index) {
    if (index < 0) { setDrill(null); return; }
    setDrill((d) => ({ ...d, path: d.path.slice(0, index + 1) }));
  }

  return (
    <div className="fade-in">
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex gap-1" style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
          {[{ v: "7", l: "۷ روز اخیر" }, { v: "30", l: "۳۰ روز اخیر" }, { v: "90", l: "۹۰ روز اخیر" }].map((o) => (
            <button
              key={o.v}
              onClick={() => { setRange(o.v); setDrill(null); }}
              className="tap"
              style={{
                flex: 1, padding: "6px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700,
                background: range === o.v ? "var(--color-surface)" : "transparent",
                color: range === o.v ? "var(--color-heading)" : "var(--color-muted)",
              }}
            >
              {o.l}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <select value={branchFilter} onChange={(e) => { setBranchFilter(e.target.value); setDrill(null); }} style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: "var(--radius-md)" }}>
            <option value="all">همه شعبه‌ها</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={staffFilter} onChange={(e) => { setStaffFilter(e.target.value); setDrill(null); }} style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: "var(--radius-md)" }}>
            <option value="all">همه آرایشگرها</option>
            {stylists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {!drill && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {BI_KPIS.map((kpi) => {
            const value = kpi.compute(periodBookings, baseFiltered, periodStart.getTime());
            const prevValue = kpi.compute(prevPeriodBookings, baseFiltered, prevPeriodStart.getTime());
            const delta = prevValue > 0 ? ((value - prevValue) / prevValue) * 100 : null;
            const good = delta == null ? null : kpi.higherIsBetter ? delta >= 0 : delta <= 0;
            const kpiGrad =
              kpi.id === "totalRevenue" ? "var(--grad-brand)" :
              kpi.id === "returnRate60" ? "var(--grad-success)" :
              kpi.id === "newCustomers" ? "var(--grad-info)" :
              "var(--grad-warning)";
            return (
              <button key={kpi.id} onClick={() => openDrill(kpi.id)} className="tap card" style={{ padding: 14, textAlign: "right", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, color-mix(in oklch, ${kpiGrad === "var(--grad-brand)" ? "var(--color-accent-500)" : kpiGrad === "var(--grad-success)" ? "var(--color-success)" : kpiGrad === "var(--grad-info)" ? "var(--color-info)" : "var(--color-warning)"} 7%, transparent), transparent 60%)`, pointerEvents: "none" }} />
                <div className="flex items-center justify-between mb-2.5" style={{ position: "relative" }}>
                  <div style={{ width: 32, height: 32, borderRadius: "var(--radius-md)", background: kpiGrad, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-sm)" }}>
                    <kpi.Icon size={16} color="white" />
                  </div>
                  {delta != null && (
                    <span
                      className="tabular flex items-center gap-0.5"
                      style={{
                        fontSize: 10.5, fontWeight: 800, padding: "3px 7px", borderRadius: "var(--radius-full)",
                        color: good ? "var(--color-success)" : "var(--color-danger)",
                        background: good ? "color-mix(in oklch, var(--color-success) 14%, transparent)" : "color-mix(in oklch, var(--color-danger) 14%, transparent)",
                      }}
                    >
                      {good ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                      {delta >= 0 ? "+" : ""}{toFa(Math.round(delta))}٪
                    </span>
                  )}
                </div>
                <div className="tabular" style={{ fontSize: 19, fontWeight: 800, color: "var(--color-heading)", position: "relative", letterSpacing: "-0.01em" }}>{kpi.format(value)}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2, position: "relative" }}>{kpi.label}</div>
                <div className="muted tabular" style={{ fontSize: 10, marginTop: 4, position: "relative" }}>دورهٔ قبل: {kpi.format(prevValue)}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* ---- v2.12: Revenue trend (SVG line/area) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 8 }}>
            <TrendingUp size={16} color="var(--color-accent-700)" /> روند درآمد
          </p>
          {revenueTrend.every((d) => d.value === 0) ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <RevenueTrendChart points={revenueTrend} />
          )}
        </div>
      )}

      {!drill && <CampaignPerformanceCard />}
      {!drill && <FeedbackStatsCard />}
      {!drill && <CampaignReturnRateCard />}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>
            <Award size={13} color="var(--color-accent-700)" /> پرفروش‌ترین خدمات (تعداد نوبت)
          </p>
          {topByCount.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <div className="flex flex-col gap-2">
              {topByCount.map((row, idx) => (
                <div key={row.service.id} className="flex items-center gap-2">
                  <span style={{ fontSize: 16 }}>{["🥇", "🥈", "🥉"][idx]}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--color-heading)" }}>{row.service.name}</span>
                  <span className="tabular muted" style={{ fontSize: 11.5 }}>{toFa(row.count)} نوبت · {toFa(Math.round(row.pct))}٪</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5 mb-3" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-accent-700)" }}>
            <Banknote size={13} /> سهم خدمات از درآمد
          </p>
          {serviceShareSlices.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <ServiceShareDonut slices={serviceShareSlices} />
          )}
        </div>
      )}

      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-info) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-info)", marginBottom: 10 }}>
            <Users size={13} /> مشتریان جدید در برابر بازگشتی
          </p>
          {customerMix.newCount + customerMix.returningCount === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <>
              <div className="flex" style={{ height: 10, borderRadius: "var(--radius-full)", overflow: "hidden", background: "color-mix(in oklch, var(--color-info) 12%, transparent)" }}>
                <div style={{ width: `${(customerMix.newRevenue / customerMix.total) * 100}%`, background: "var(--color-info)" }} />
                <div style={{ width: `${(customerMix.returningRevenue / customerMix.total) * 100}%`, background: "var(--color-accent-500)" }} />
              </div>
              <div className="flex justify-between mt-2" style={{ flexWrap: "wrap", gap: 6 }}>
                <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
                  <UserPlus size={12} color="var(--color-info)" />
                  <span className="muted">جدید ({toFa(customerMix.newCount)}):</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(customerMix.newRevenue)}</span>
                </span>
                <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
                  <Repeat2 size={12} color="var(--color-accent-700)" />
                  <span className="muted">بازگشتی ({toFa(customerMix.returningCount)}):</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(customerMix.returningRevenue)}</span>
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- v2.12: weekday × hour heatmap (replaces the two separate
           peak-hours / weekday-distribution charts — same two dimensions,
           combined so an interaction like "Thursday evenings" is visible) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 12 }}>
            <Clock size={16} color="var(--color-accent-700)" /> نقشهٔ حرارتی نوبت‌ها (روز و ساعت)
          </p>
          {heatmapGrid.flat().every((v) => v === 0) ? (
            <p className="muted" style={{ fontSize: 12.5 }}>هنوز نوبتی در این بازه ثبت نشده</p>
          ) : (
            <BookingHeatmap grid={heatmapGrid} hours={heatmapHours} dayLabels={SCHEMA_DAY_LABELS} />
          )}
        </div>
      )}

      {/* ---- Stylist performance table (sortable, conditional formatting) ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 12 }}>
            <Award size={16} color="var(--color-accent-700)" /> عملکرد آرایشگران
          </p>
          {stylistPerf.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>آرایشگر فعالی یافت نشد</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tabular" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700 }}>آرایشگر</th>
                    {[
                      { key: "count", label: "نوبت" },
                      { key: "avgRevenue", label: "میانگین درآمد" },
                      { key: "returnRate", label: "نرخ بازگشت" },
                      { key: "score", label: "امتیاز" },
                    ].map((col) => (
                      <th
                        key={col.key}
                        onClick={() => togglePerfSort(col.key)}
                        className="tap"
                        style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                      >
                        <span className="flex items-center justify-center gap-0.5">
                          {col.label}
                          {perfSortKey === col.key && (perfSortDir === "desc" ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedStylistPerf.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "7px 8px", fontWeight: 700, color: "var(--color-heading)" }}>
                        <span className="flex items-center gap-1.5">{r.name} <GenderBadge gender={r.gender} /></span>
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.count >= stylistPerfAvg.count ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(r.count)}</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.avgRevenue >= stylistPerfAvg.avgRevenue ? "var(--color-success)" : "var(--color-danger)" }}>{formatToman(Math.round(r.avgRevenue))}</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", color: r.returnRate >= stylistPerfAvg.returnRate ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(Math.round(r.returnRate))}٪</td>
                      <td style={{ padding: "7px 8px", textAlign: "center", fontWeight: 800, color: r.score >= stylistPerfAvg.score ? "var(--color-success)" : "var(--color-danger)" }}>{toFa(Math.round(r.score))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 9.5, marginTop: 8, lineHeight: 1.6 }}>
                رنگ نسبت به میانگین همین لیست است. امتیاز = ترکیب وزنی تعداد نوبت (۴۰٪)، میانگین درآمد (۳۵٪)، نرخ بازگشت مشتری (۲۵٪).
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---- Pareto: top customers ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-accent-500) 6%, var(--color-surface)), var(--color-surface))" }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-accent-700)", marginBottom: 4 }}>
            <Percent size={16} /> مشتریان برتر (اصل پارتو)
          </p>
          {paretoData.topCustomers.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>هنوز نوبت تکمیل‌شده‌ای در این بازه ثبت نشده</p>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
                <b className="tabular" style={{ color: "var(--color-heading)" }}>{toFa(Math.round(paretoData.pctOfCustomers))}٪</b> از مشتریان،
                {" "}<b className="tabular" style={{ color: "var(--color-heading)" }}>{toFa(Math.round(paretoData.pctOfRevenue))}٪</b> از درآمد این بازه را ساخته‌اند
              </p>
              <div className="flex flex-col gap-2">
                {paretoData.topCustomers.slice(0, 8).map((c, i) => (
                  <div key={c.phone} className="flex items-center gap-2">
                    <span className="tabular" style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--color-accent-100)", color: "var(--color-accent-700)", fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {toFa(i + 1)}
                    </span>
                    <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{c.name || "بدون نام"}</span>
                    <span className="tabular muted" style={{ fontSize: 11.5 }}>{formatToman(c.revenue)} · {toFa(c.visits)} ویزیت</span>
                  </div>
                ))}
                {paretoData.topCustomers.length > 8 && (
                  <p className="muted" style={{ fontSize: 10.5 }}>و {toFa(paretoData.topCustomers.length - 8)} مشتری دیگر از این گروه</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Demand forecast: 7-day moving average + next-7-days capacity ---- */}
      {!drill && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)", marginBottom: 4 }}>
            <TrendingUp size={16} color="var(--color-accent-700)" /> پیش‌بینی تقاضا
          </p>
          <p className="muted tabular" style={{ fontSize: 11.5, marginBottom: 10 }}>
            میانگین متحرک ۷ روز گذشته: {toFa(Math.round(demandForecast.movingAvg * 10) / 10)} نوبت در روز
          </p>
          <div className="flex flex-col gap-2">
            {demandForecast.days.map((d) => (
              <div key={d.dKey}>
                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)" }}>
                    {WEEKDAYS_FA_FULL[d.date.getDay()]} {toFa(jalaliDayNum(d.date))} {MONTHS_FA[gregorianToJalali(d.date.getFullYear(), d.date.getMonth() + 1, d.date.getDate()).jm - 1]}
                    {d.lowFill && <AlertTriangle size={12} color="var(--color-warning)" />}
                  </span>
                  <span className="tabular muted" style={{ fontSize: 11 }}>
                    {d.hasCapacity ? `${toFa(Math.round(d.fillRate * 100))}٪ پر شده` : "تعطیل / تایید نشده"}
                  </span>
                </div>
                {d.hasCapacity && (
                  <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "color-mix(in oklch, var(--color-warning) 14%, transparent)", overflow: "hidden" }}>
                    <div style={{ width: `${d.fillRate * 100}%`, height: "100%", background: d.lowFill ? "var(--color-warning)" : "var(--color-success)", borderRadius: "var(--radius-full)" }} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {demandForecast.days.some((d) => d.lowFill) && (
            <p className="flex items-center gap-1.5" style={{ fontSize: 11, marginTop: 10, color: "var(--color-warning)" }}>
              <AlertTriangle size={12} /> روزهای با کمتر از ۲۰٪ پرشدگی، فرصت از دست رفته‌اند — برای این روزها کمپین یا تخفیف در نظر بگیرید
            </p>
          )}
        </div>
      )}

      {drill && activeKpi && (
        <div className="fade-in">
          <div className="flex items-center gap-1 mb-3 flex-wrap" style={{ fontSize: 12 }}>
            <button className="tap" style={{ color: "var(--color-muted)" }} onClick={() => jumpTo(-1)}>کل ({activeKpi.label})</button>
            {drill.path.map((p, i) => (
              <React.Fragment key={i}>
                <ChevronLeft size={12} color="var(--color-muted)" />
                <button
                  className="tap"
                  onClick={() => jumpTo(i)}
                  style={{ color: i === drill.path.length - 1 ? "var(--color-heading)" : "var(--color-muted)", fontWeight: i === drill.path.length - 1 ? 700 : 400 }}
                >
                  {p.label}
                </button>
              </React.Fragment>
            ))}
            {currentLevel && (
              <>
                <ChevronLeft size={12} color="var(--color-muted)" />
                <span style={{ fontWeight: 700, color: "var(--color-accent-700)" }}>{currentLevel.label}</span>
              </>
            )}
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 420 }}>
                <thead>
                  <tr style={{ background: "var(--color-surface-raised)" }}>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700 }}>{currentLevel?.label || "—"}</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>مقدار</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>دورهٔ قبل</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>Δ٪</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700 }}>سهم٪</th>
                  </tr>
                </thead>
                <tbody>
                  {levelRows.map((row) => {
                    const delta = row.prevValue != null && row.prevValue > 0 ? ((row.value - row.prevValue) / row.prevValue) * 100 : null;
                    const good = delta == null ? null : activeKpi.higherIsBetter ? delta >= 0 : delta <= 0;
                    const clickable = currentLevel?.key !== "invoice";
                    return (
                      <tr
                        key={row.rawValue}
                        onClick={() => clickable && drillInto(row)}
                        style={{ borderTop: "1px solid var(--color-border)", cursor: clickable ? "pointer" : "default" }}
                      >
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: "var(--color-heading)", whiteSpace: "nowrap" }}>{row.label}</td>
                        <td className="tabular" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>{activeKpi.format(row.value)}</td>
                        <td className="tabular muted" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                          {row.prevValue != null ? activeKpi.format(row.prevValue) : "—"}
                        </td>
                        <td
                          className="tabular"
                          style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, whiteSpace: "nowrap", color: delta == null ? "var(--color-muted)" : good ? "var(--color-success)" : "var(--color-danger)" }}
                        >
                          {delta != null ? `${delta >= 0 ? "+" : ""}${toFa(Math.round(delta))}٪` : "—"}
                        </td>
                        <td className="tabular muted" style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>{toFa(Math.round(row.share))}٪</td>
                      </tr>
                    );
                  })}
                  {levelRows.length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 16, textAlign: "center" }} className="muted">داده‌ای در این سطح نیست</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
