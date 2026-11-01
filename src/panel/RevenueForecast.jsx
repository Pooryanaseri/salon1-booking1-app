import { useMemo } from "react";
import { TrendingUp, TrendingDown, Target } from "lucide-react";
import { gregorianToJalali, MONTHS_FA, toFa, formatToman, parseDateKey } from "../lib/format";

// Revenue forecast — the one piece of BI_MATURITY_SKILL's 5-step method that's
// actually implemented (see the note rendered above it). Pure client-side
// least-squares trend over completed months already in `bookings`; no new
// data collection, no external model — matches the "high value / low
// difficulty" cell the assessment landed on.
export function forecastNextMonthRevenue(bookings) {
  const priced = bookings.filter((b) => b.status === "completed" && b.final_price != null);
  if (priced.length === 0) return { ready: false, reason: "no-data" };

  const byMonth = new Map(); // key: jy*12+jm -> revenue total
  for (const b of priced) {
    const d = parseDateKey(b.date);
    const { jy, jm } = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const key = jy * 12 + jm;
    byMonth.set(key, (byMonth.get(key) || 0) + b.final_price);
  }

  const today = new Date();
  const { jy: curJy, jm: curJm } = gregorianToJalali(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const curKey = curJy * 12 + curJm;

  // Only fully-elapsed months count as history — this month is still in progress.
  const months = Array.from(byMonth.keys()).filter((k) => k < curKey).sort((a, b) => a - b);
  if (months.length < 3) return { ready: false, reason: "not-enough-months", monthsSoFar: months.length };

  const series = months.map((k, i) => ({ x: i, key: k, y: byMonth.get(k) }));
  const n = series.length;
  const sumX = series.reduce((s, p) => s + p.x, 0);
  const sumY = series.reduce((s, p) => s + p.y, 0);
  const sumXY = series.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = series.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  const residuals = series.map((p) => p.y - (slope * p.x + intercept));
  const variance = residuals.reduce((s, r) => s + r * r, 0) / n;
  const stdev = Math.sqrt(variance);

  const nextX = n; // one step past the last historical month
  const point = Math.max(0, slope * nextX + intercept);
  const targetKey = months[months.length - 1] + 1;
  const targetJy = Math.floor((targetKey - 1) / 12);
  const targetJm = ((targetKey - 1) % 12) + 1;

  return {
    ready: true,
    point,
    low: Math.max(0, point - stdev),
    high: point + stdev,
    trend: slope >= 0 ? "up" : "down",
    history: series.map((p) => ({ jy: Math.floor((p.key - 1) / 12), jm: ((p.key - 1) % 12) + 1, revenue: p.y })),
    targetJy, targetJm,
  };
}

/** Revenue forecast card — shown at the top of «هوش تجاری». */
export function RevenueForecastCard({ bookings }) {
  const forecast = useMemo(() => forecastNextMonthRevenue(bookings), [bookings]);
  const histMax = forecast.ready ? Math.max(...forecast.history.map((h) => h.revenue), forecast.point) : 1;

  return (
    <div data-card="revenue-forecast">
      {/* The actual forecast */}
      <div className="card card-glass mb-4" style={{ padding: 18, background: "var(--grad-info)" }}>
        <div style={{ position: "absolute", top: -30, left: -20, width: 130, height: 130, borderRadius: "50%", background: "oklch(100% 0 0 / 0.10)", pointerEvents: "none" }} />
        <div className="flex items-center gap-2" style={{ position: "relative" }}>
          <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: "oklch(100% 0 0 / 0.20)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Target size={16} />
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.92 }}>پیش‌بینی درآمد ماه بعد</span>
        </div>

        {!forecast.ready ? (
          <div style={{ position: "relative", marginTop: 12 }}>
            <p style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.95 }}>
              {forecast.reason === "no-data"
                ? "هنوز نوبت تکمیل‌شده‌ای ثبت نشده — با چند نوبت واقعی، پیش‌بینی درآمد ماه بعد فعال می‌شود."
                : `فعلاً ${toFa(forecast.monthsSoFar || 0)} ماه کامل داده هست؛ برای پیش‌بینی معتبر دست‌کم ۳ ماه کامل لازم است.`}
            </p>
          </div>
        ) : (
          <>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 800, marginTop: 10, position: "relative", letterSpacing: "-0.02em" }}>
              {formatToman(forecast.point)}
            </div>
            <div className="flex items-center gap-1.5 mt-1" style={{ position: "relative", fontSize: 11.5, opacity: 0.9 }}>
              {forecast.trend === "up" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              برآورد {MONTHS_FA[forecast.targetJm - 1]} {toFa(forecast.targetJy)} — بازهٔ محتمل {formatToman(forecast.low)} تا {formatToman(forecast.high)}
            </div>

            <div className="flex items-end gap-2 mt-4" style={{ position: "relative", height: 70 }}>
              {forecast.history.map((h, i) => (
                <div key={i} className="flex flex-col items-center" style={{ flex: 1 }}>
                  <div style={{ width: "100%", maxWidth: 22, height: Math.max(4, (h.revenue / histMax) * 54), borderRadius: 4, background: "oklch(100% 0 0 / 0.55)" }} />
                  <span className="tabular" style={{ fontSize: 8.5, marginTop: 4, opacity: 0.85 }}>{MONTHS_FA[h.jm - 1].slice(0, 3)}</span>
                </div>
              ))}
              <div className="flex flex-col items-center" style={{ flex: 1 }}>
                <div style={{ width: "100%", maxWidth: 22, height: Math.max(4, (forecast.point / histMax) * 54), borderRadius: 4, border: "2px dashed white", background: "transparent" }} />
                <span className="tabular" style={{ fontSize: 8.5, marginTop: 4, fontWeight: 700 }}>برآورد</span>
              </div>
            </div>
            <p style={{ fontSize: 9.5, marginTop: 8, opacity: 0.75, position: "relative", lineHeight: 1.6 }}>
              روش: رگرسیون خطی سادهٔ حداقل مربعات روی {toFa(forecast.history.length)} ماه کاملِ گذشته — قابل بازبینی، بدون جعبهٔ سیاه.
            </p>
          </>
        )}
      </div>

    </div>
  );
}
