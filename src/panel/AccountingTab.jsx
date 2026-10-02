import { useState, useMemo } from "react";
import { X, Percent, Banknote, CheckCircle2, XCircle, Plus, TrendingUp, TrendingDown, Hourglass, Wallet, Coins, Users, Receipt, PiggyBank, ReceiptText } from "lucide-react";
import { gregorianToJalali, MONTHS_FA, toFa, formatToman, jalaliLabel, dateKey, parseDateKey } from "../lib/format";
import { EXPENSE_CATEGORY_META, SECTION_META, makeSeedExpense } from "../app/shared";
import { GenderBadge, Modal, StatCard } from "../components/ui";

/* ============================================================
   Accounting tab — real numbers computed from booking + expense data
   (no external service; range toggle over today/7d/30d).
   Tracks revenue, expenses, net profit, growth vs. the previous
   period, cancellation loss, completion rate and new-vs-returning
   customer mix — everything sourced from bookings/expenses props.
   ============================================================ */
export function AccountingTab({ bookings, services, stylists = [], expenses, addExpense, removeExpense, canEditExpenses = true, staffId = null }) {
  const [range, setRange] = useState("7"); // "1" | "7" | "30"
  const [showAddExpense, setShowAddExpense] = useState(false);

  const scopedBookings = staffId ? bookings.filter((b) => b.staff_id === staffId) : bookings;

  const { rangeBookings, days, prevRangeBookings } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const spanDays = Number(range);
    const dayList = [];
    for (let i = spanDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dayList.push(d);
    }
    const keys = new Set(dayList.map((d) => dateKey(d)));
    const prevDayList = [];
    for (let i = spanDays * 2 - 1; i >= spanDays; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      prevDayList.push(d);
    }
    const prevKeys = new Set(prevDayList.map((d) => dateKey(d)));
    return {
      rangeBookings: scopedBookings.filter((b) => keys.has(b.date)),
      days: dayList,
      prevRangeBookings: scopedBookings.filter((b) => prevKeys.has(b.date)),
    };
  }, [scopedBookings, range]);

  const completed = rangeBookings.filter((b) => b.status === "completed");
  const upcoming = rangeBookings.filter((b) => ["pending", "confirmed", "rescheduled"].includes(b.status));
  const cancelled = rangeBookings.filter((b) => b.status === "cancelled" || b.status === "cancelled_by_salon" || b.status === "no_show");
  const priced = (list) => list.filter((b) => b.final_price != null);

  const realizedRevenue = priced(completed).reduce((s, b) => s + b.final_price, 0);
  const expectedRevenue = priced(upcoming).reduce((s, b) => s + b.final_price, 0);
  const discountGiven = priced(completed).reduce((s, b) => s + Math.max(0, (b.original_price || 0) - b.final_price), 0);
  const avgTicket = priced(completed).length > 0 ? Math.round(realizedRevenue / priced(completed).length) : 0;
  const unpricedCount = rangeBookings.filter((b) => b.final_price == null).length;
  const lostRevenue = priced(cancelled).reduce((s, b) => s + b.final_price, 0);
  const completionRate = completed.length + cancelled.length > 0 ? completed.length / (completed.length + cancelled.length) : null;

  // Growth vs. the previous equally-sized window (e.g. this 7 days vs. the 7 days before that)
  const prevCompleted = prevRangeBookings.filter((b) => b.status === "completed");
  const prevRealizedRevenue = priced(prevCompleted).reduce((s, b) => s + b.final_price, 0);
  const growthPct = prevRealizedRevenue > 0 ? Math.round(((realizedRevenue - prevRealizedRevenue) / prevRealizedRevenue) * 100) : null;

  // Revenue broken down per stylist — owner-only (a logged-in stylist already
  // only ever sees their own numbers via the staffId scoping above).
  const byStylist = useMemo(() => {
    if (staffId) return [];
    const buckets = new Map(); // staff_id (or "unassigned") -> revenue
    for (const b of priced(completed)) {
      const key = b.staff_id || "unassigned";
      buckets.set(key, (buckets.get(key) || 0) + b.final_price);
    }
    const rows = Array.from(buckets.entries()).map(([staffKey, revenue]) => {
      const stylist = stylists.find((s) => s.id === staffKey);
      return { key: staffKey, name: stylist ? stylist.name : "بدون آرایشگر مشخص", gender: stylist?.gender, revenue };
    });
    return rows.sort((a, b) => b.revenue - a.revenue);
  }, [completed, staffId, stylists]);
  const byStylistMax = Math.max(1, ...byStylist.map((s) => s.revenue));

  const dailyRevenue = useMemo(() => {
    return days.map((d) => {
      const key = dateKey(d);
      const amt = priced(completed.filter((b) => b.date === key)).reduce((s, b) => s + b.final_price, 0);
      return { date: d, amount: amt };
    });
  }, [days, completed]);

  // For the "year" range, 365 daily bars would be unreadable — bucket the same
  // dailyRevenue data into Jalali months for the trend chart only. All the actual
  // revenue/expense/profit numbers above still cover the full 365-day range.
  const monthlyRevenue = useMemo(() => {
    if (range !== "365") return [];
    const map = new Map(); // "jy-jm" -> { jy, jm, amount }
    for (const d of dailyRevenue) {
      const { jy, jm } = gregorianToJalali(d.date.getFullYear(), d.date.getMonth() + 1, d.date.getDate());
      const key = `${jy}-${jm}`;
      const cur = map.get(key) || { jy, jm, amount: 0 };
      cur.amount += d.amount;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.jy - b.jy || a.jm - b.jm);
  }, [dailyRevenue, range]);

  const trendData = range === "365" ? monthlyRevenue : dailyRevenue;
  const trendMax = Math.max(1, ...trendData.map((d) => d.amount));

  // Expenses for the same range, categorized for the breakdown bar + list
  const rangeExpenses = useMemo(() => {
    if (!canEditExpenses) return [];
    const keys = new Set(days.map((d) => dateKey(d)));
    return expenses.filter((e) => keys.has(e.date));
  }, [expenses, days, canEditExpenses]);
  const totalExpenses = rangeExpenses.reduce((s, e) => s + e.amount, 0);
  const netProfit = realizedRevenue - totalExpenses;
  const profitMargin = realizedRevenue > 0 ? netProfit / realizedRevenue : null;

  const byExpenseCategory = useMemo(() => {
    const map = new Map();
    for (const e of rangeExpenses) map.set(e.category, (map.get(e.category) || 0) + e.amount);
    return Array.from(map.entries())
      .map(([category, amount]) => ({ category, amount, meta: EXPENSE_CATEGORY_META[category] || EXPENSE_CATEGORY_META.other }))
      .sort((a, b) => b.amount - a.amount);
  }, [rangeExpenses]);

  // Conic-gradient stops for the expense donut — a colorful ring instead of a flat bar
  const expenseDonutGradient = useMemo(() => {
    if (totalExpenses <= 0) return null;
    let acc = 0;
    const stops = byExpenseCategory.map((c) => {
      const start = (acc / totalExpenses) * 360;
      acc += c.amount;
      const end = (acc / totalExpenses) * 360;
      return `${c.meta.color} ${start}deg ${end}deg`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  }, [byExpenseCategory, totalExpenses]);

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-3" style={{ gap: 8 }}>
        <p className="muted" style={{ fontSize: 11.5, flexShrink: 0 }}>بازهٔ گزارش</p>
        <div
          className="flex gap-1 scrollbar-none"
          style={{ background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)", overflowX: "auto" }}
        >
          {[{ v: "1", l: "امروز" }, { v: "7", l: "۷ روز اخیر" }, { v: "30", l: "۳۰ روز اخیر" }, { v: "365", l: "یک سال اخیر" }].map((o) => (
            <button
              key={o.v}
              onClick={() => setRange(o.v)}
              className="tap"
              style={{
                padding: "5px 10px", borderRadius: "var(--radius-sm)", fontSize: 11.5, fontWeight: 700,
                background: range === o.v ? "var(--color-surface)" : "transparent",
                color: range === o.v ? "var(--color-heading)" : "var(--color-muted)",
                whiteSpace: "nowrap", flexShrink: 0,
              }}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

      {/* Headline numbers, with a growth badge vs. the previous equally-sized period */}
      <div className="card card-glass mb-3" style={{ padding: 18, background: "var(--grad-brand)" }}>
        <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
        <div className="flex items-center justify-between" style={{ position: "relative" }}>
          <div className="flex items-center gap-2">
            <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: "oklch(100% 0 0 / 0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Wallet size={16} />
            </div>
            <span style={{ fontSize: 14.5, fontWeight: 800, opacity: 0.95 }}>درآمد تحقق‌یافته</span>
          </div>
          {growthPct != null && (
            <span
              className="tabular flex items-center gap-1"
              style={{ fontSize: 11, fontWeight: 800, padding: "4px 9px", borderRadius: "var(--radius-full)", background: "oklch(100% 0 0 / 0.22)", backdropFilter: "blur(4px)" }}
            >
              {growthPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {growthPct >= 0 ? "+" : ""}{toFa(growthPct)}٪
            </span>
          )}
        </div>
        <div className="tabular" style={{ fontSize: 30, fontWeight: 800, marginTop: 10, position: "relative", letterSpacing: "-0.02em" }}>
          {formatToman(realizedRevenue)}
        </div>
        <div className="flex items-center gap-3 mt-2" style={{ opacity: 0.88, fontSize: 11.5, position: "relative" }}>
          <span>{toFa(priced(completed).length)} نوبت تکمیل‌شده</span>
          {unpricedCount > 0 && <span>· {toFa(unpricedCount)} بدون قیمت</span>}
          {growthPct != null && <span>· نسبت به بازهٔ قبل</span>}
        </div>
      </div>

      {byStylist.length > 0 && (
        <div className="card mb-3" style={{ padding: 14 }}>
          <p className="flex items-center gap-2 mb-3" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-heading)" }}>
            <Users size={16} color="var(--color-accent-700)" /> درآمد هر آرایشگر
          </p>
          <div className="flex flex-col gap-2.5">
            {byStylist.map((s) => (
              <div key={s.key}>
                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>
                    {s.name} {s.gender && <GenderBadge gender={s.gender} />}
                  </span>
                  <span className="tabular" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(s.revenue)}</span>
                </div>
                <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-raised)", overflow: "hidden" }}>
                  <div style={{ width: `${(s.revenue / byStylistMax) * 100}%`, height: "100%", borderRadius: "var(--radius-full)", background: s.gender ? SECTION_META[s.gender].color : "var(--color-muted)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        <StatCard label="میانگین هر نوبت" value={formatToman(avgTicket)} icon={Banknote} color="var(--color-accent-500)" />
        <StatCard label="درآمد در انتظار" value={formatToman(expectedRevenue)} icon={Hourglass} color="var(--color-info)" />
        <StatCard label="تخفیف اعطاشده" value={formatToman(discountGiven)} icon={Percent} color="var(--color-accent-700)" />
      </div>

      <div className="flex gap-2 mb-3">
        <StatCard
          label="سود خالص"
          value={formatToman(netProfit)}
          icon={PiggyBank}
          tone={netProfit >= 0 ? "success" : "danger"}
          trend={profitMargin != null ? `حاشیه ${toFa(Math.round(profitMargin * 100))}٪` : undefined}
        />
        <StatCard label="مجموع هزینه‌ها" value={formatToman(totalExpenses)} icon={Receipt} color="var(--color-warning)" />
        <StatCard label="درآمد ازدست‌رفته" value={formatToman(lostRevenue)} icon={XCircle} tone={lostRevenue > 0 ? "danger" : "default"} color={lostRevenue > 0 ? undefined : "var(--color-danger)"} />
      </div>

      {/* Completion-rate gauge */}
      <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-success) 7%, var(--color-surface)), var(--color-surface))" }}>
        <p className="flex items-center gap-2 mb-3" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-success)" }}>
          <CheckCircle2 size={16} /> نرخ تکمیل نوبت‌ها
        </p>
        <div className="flex items-center gap-3">
          <div
            style={{
              width: 56, height: 56, borderRadius: "50%", flexShrink: 0,
              background: completionRate == null
                ? "color-mix(in oklch, var(--color-success) 14%, var(--color-surface))"
                : `conic-gradient(var(--color-success) ${Math.round(completionRate * 360)}deg, color-mix(in oklch, var(--color-success) 14%, var(--color-surface)) 0deg)`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div style={{ width: 42, height: 42, borderRadius: "50%", background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="tabular" style={{ fontSize: 12, fontWeight: 800, color: "var(--color-success)" }}>
                {completionRate == null ? "—" : `${toFa(Math.round(completionRate * 100))}٪`}
              </span>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
            {completed.length + cancelled.length > 0
              ? `${toFa(completed.length)} تکمیل‌شده از ${toFa(completed.length + cancelled.length)} نوبت قطعی‌شده`
              : "هنوز نوبت قطعی‌شده‌ای در این بازه نیست"}
          </p>
        </div>
      </div>

      {/* Revenue trend — daily for short ranges, monthly for the year view */}
      {range !== "1" && (
        <div className="card mb-4" style={{ padding: 14 }}>
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-accent-700)", marginBottom: 10 }}>
            <TrendingUp size={16} />
            {range === "365" ? "روند درآمد ماهانه" : "روند درآمد روزانه"}
          </p>
          <div className="flex items-end gap-1.5 scrollbar-none" style={{ overflowX: "auto", height: 110, paddingBottom: 2 }}>
            {trendData.map((d, i) => {
              const h = Math.max(4, Math.round((d.amount / trendMax) * 86));
              const isToday = range !== "365" && dateKey(d.date) === dateKey(new Date());
              return (
                <div key={i} className="flex flex-col items-center" style={{ flexShrink: 0, width: range === "30" ? 16 : range === "365" ? 40 : 34 }}>
                  <div
                    title={formatToman(d.amount)}
                    style={{
                      width: "100%", height: h, borderRadius: "var(--radius-full) var(--radius-full) 4px 4px",
                      background: isToday ? "var(--grad-brand)" : "linear-gradient(180deg, var(--color-accent-300), var(--color-accent-700))",
                      opacity: d.amount === 0 ? 0.22 : 1,
                      boxShadow: isToday && d.amount > 0 ? "var(--shadow-glow-accent)" : "none",
                    }}
                  />
                  {(range === "7" || range === "365") && (
                    <span className="muted tabular" style={{ fontSize: 9, marginTop: 4, whiteSpace: "nowrap" }}>
                      {range === "365" ? MONTHS_FA[d.jm - 1] : jalaliLabel(d.date, { short: true })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expenses — salon-wide overhead, owner-only */}
      {canEditExpenses && (
      <div className="card mb-4" style={{ padding: 14, background: "linear-gradient(135deg, color-mix(in oklch, var(--color-warning) 7%, var(--color-surface)), var(--color-surface))" }}>
        <div className="flex items-center justify-between mb-3">
          <p className="flex items-center gap-2" style={{ fontSize: 15, fontWeight: 800, color: "var(--color-warning)" }}>
            <ReceiptText size={16} /> هزینه‌های این بازه
          </p>
          <button className="tap accent-btn flex items-center gap-1" style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => setShowAddExpense(true)}>
            <Plus size={13} /> ثبت هزینه
          </button>
        </div>

        {byExpenseCategory.length > 0 && (
          <div className="flex items-center gap-4">
            <div
              style={{
                width: 74, height: 74, borderRadius: "50%", flexShrink: 0,
                background: expenseDonutGradient,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--color-surface)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
                <span className="tabular" style={{ fontSize: 10.5, fontWeight: 800, color: "var(--color-heading)" }}>{formatToman(totalExpenses)}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5" style={{ flex: 1 }}>
              {byExpenseCategory.map((c) => (
                <span key={c.category} className="flex items-center gap-1.5" style={{ fontSize: 11 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c.meta.color, display: "inline-block" }} />
                  <span className="muted">{c.meta.label}:</span>
                  <span className="tabular" style={{ fontWeight: 700, color: "var(--color-heading)" }}>{formatToman(c.amount)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {rangeExpenses.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5, textAlign: "center", padding: "8px 0" }}>هنوز هزینه‌ای برای این بازه ثبت نشده</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...rangeExpenses].sort((a, b) => b.created_at - a.created_at).map((e) => {
              const meta = EXPENSE_CATEGORY_META[e.category] || EXPENSE_CATEGORY_META.other;
              const Icon = meta.Icon;
              return (
                <div key={e.id} className="flex items-center gap-2" style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", background: `color-mix(in oklch, ${meta.color} 7%, var(--color-surface-raised))` }}>
                  <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: `color-mix(in oklch, ${meta.color} 18%, transparent)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={14} color={meta.color} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-heading)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                    <div className="muted" style={{ fontSize: 10.5 }}>{meta.label} · {jalaliLabel(parseDateKey(e.date), { short: true })}</div>
                  </div>
                  <span className="tabular" style={{ fontSize: 12, fontWeight: 700, color: "var(--color-heading)", flexShrink: 0 }}>{formatToman(e.amount)}</span>
                  <button className="tap ghost-btn" style={{ width: 26, height: 26, padding: 0, flexShrink: 0 }} onClick={() => removeExpense(e.id)}>
                    <X size={12} style={{ margin: "auto" }} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {cancelled.length > 0 && (
        <p className="muted" style={{ fontSize: 11.5, textAlign: "center" }}>
          <Coins size={11} style={{ display: "inline", marginLeft: 4, verticalAlign: -1 }} />
          {toFa(cancelled.length)} نوبت لغو‌شده/عدم‌حضور در این بازه
          {lostRevenue > 0 && <> · معادل {formatToman(lostRevenue)} خارج از محاسبهٔ درآمد</>}
        </p>
      )}

      {showAddExpense && (
        <AddExpenseModal
          onClose={() => setShowAddExpense(false)}
          onSave={(expense) => { addExpense(expense); setShowAddExpense(false); }}
        />
      )}
    </div>
  );
}

export function AddExpenseModal({ onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("supplies");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dateKey(new Date()));

  const recentDates = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const arr = [];
    for (let i = 0; i < 45; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      arr.push(d);
    }
    return arr;
  }, []);

  const canSave = title.trim().length > 0 && Number(amount) > 0;

  return (
    <Modal title="ثبت هزینهٔ جدید" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <label className="muted" style={{ fontSize: 12 }}>عنوان هزینه</label>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً خرید مواد رنگ مو"
            style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
          />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 12 }}>دسته‌بندی</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
            {Object.entries(EXPENSE_CATEGORY_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-3">
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>مبلغ (تومان)</label>
            <input
              type="number" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)}
              className="tabular" style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="muted" style={{ fontSize: 12 }}>تاریخ</label>
            <select value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", padding: "10px 14px", fontSize: 14, marginTop: 4 }}>
              {recentDates.map((d) => (
                <option key={dateKey(d)} value={dateKey(d)}>{jalaliLabel(d, { short: true })}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          disabled={!canSave}
          className="tap accent-btn w-full"
          style={{ padding: 12, fontSize: 14, marginTop: 4 }}
          onClick={() => canSave && onSave(makeSeedExpense({ title: title.trim(), category, amount: Number(amount), date }))}
        >
          <Receipt size={14} style={{ display: "inline", verticalAlign: -2, marginLeft: 6 }} />
          ثبت هزینه
        </button>
      </div>
    </Modal>
  );
}
