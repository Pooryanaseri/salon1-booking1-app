import { useEffect, useRef } from "react";
import { X, MessageSquareText, Lock, Info } from "lucide-react";
import { gregorianToJalali, jalaliDayNum, MONTHS_FA, WEEKDAYS_FA_SHORT, toFa, jalaliLabel, formatClock, dateKey } from "../lib/format";
import { SECTION_META, STATUS_META } from "../app/shared";

/* ============================================================
   Small shared UI atoms
   ============================================================ */
export function Badge({ status }) {
  const meta = STATUS_META[status] || { label: status || "—", bg: "var(--color-muted)", fg: "white", Icon: Info, strike: false };
  const Icon = meta.Icon;
  return (
    <span className="badge" style={{ background: meta.bg, color: meta.fg }}>
      <Icon size={13} /> {meta.label}
    </span>
  );
}

export function GenderBadge({ gender }) {
  const meta = SECTION_META[gender];
  if (!meta) return null;
  const Icon = meta.Icon;
  return (
    <span className="badge" style={{ background: meta.tint, color: meta.color }}>
      <Icon size={12} /> {meta.short}
    </span>
  );
}

export function Switch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="switch tap"
      style={{ background: checked ? "var(--color-accent-500)" : "var(--color-border)", border: "none", padding: 0 }}
      aria-pressed={checked}
    >
      <span className="switch-knob" style={{ transform: checked ? "translateX(-19px)" : "translateX(-3px)", right: 0 }} />
    </button>
  );
}

export function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fade-in tap"
      style={{
        position: "fixed", bottom: "calc(20px + env(safe-area-inset-bottom, 0px))", left: "50%", transform: "translateX(-50%)",
        background: "var(--color-heading)", color: "var(--color-bg)",
        padding: "10px 18px", borderRadius: "var(--radius-md)", fontSize: 14,
        display: "flex", alignItems: "center", gap: 8, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        maxWidth: "92vw",
      }}
    >
      <MessageSquareText size={16} />
      {message}
    </div>
  );
}

export function Modal({ title, onClose, children, danger, wide }) {
  // Esc closes, and the page behind stops scrolling while the sheet is open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      className="backdrop-in"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 90 }}
      onClick={onClose}
    >
      <div
        className="card sheet-up safe-bottom"
        style={{
          width: "100%", maxWidth: wide ? 520 : 480, margin: "0 auto 0",
          borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          borderTopLeftRadius: "var(--radius-xl)", borderTopRightRadius: "var(--radius-xl)",
          padding: "10px 20px 20px", maxHeight: "88vh", overflowY: "auto",
          boxShadow: "0 -16px 40px -12px oklch(20% 0.02 60 / 0.28)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontSize: 17, color: danger ? "var(--color-danger)" : undefined }}>{title}</h3>
          <button className="tap ghost-btn" style={{ width: 36, height: 36, padding: 0 }} onClick={onClose} aria-label="بستن">
            <X size={18} style={{ margin: "auto" }} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Row({ label, value, bold, strike }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "6px 0", fontSize: 13.5 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: bold ? 800 : 600, color: "var(--color-heading)", fontSize: bold ? 15 : 13.5, textDecoration: strike ? "line-through" : "none", opacity: strike ? 0.6 : 1 }}>
        {value}
      </span>
    </div>
  );
}

// A consistent, colorful page header for panel tabs — icon badge + title +
// one-line description. Each tab passes its own color so the whole panel
// doesn't read as one flat gray surface; the color also visually matches
// that tab's icon in the sub-nav below, so the two reinforce each other.
export function PanelSectionHeader({ Icon, title, subtitle, color }) {
  return (
    <div
      className="flex items-center gap-3 mb-4"
      style={{ padding: "14px 16px", borderRadius: "var(--radius-lg)", background: `linear-gradient(135deg, color-mix(in oklch, ${color} 12%, var(--color-surface)), var(--color-surface))`, border: `1px solid color-mix(in oklch, ${color} 18%, var(--color-border))` }}
    >
      <div
        style={{
          width: 40, height: 40, borderRadius: "var(--radius-md)", flexShrink: 0,
          background: color, display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 4px 14px -4px color-mix(in oklch, ${color} 60%, transparent)`,
        }}
      >
        <Icon size={19} color="white" />
      </div>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 16.5, color: "var(--color-heading)" }}>{title}</h2>
        {subtitle && <p className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.6 }}>{subtitle}</p>}
      </div>
    </div>
  );
}

// Horizontal, RTL-aware day timeline. Renders a soft pill-shaped track with hour ticks,
// shadowed rounded blocks for booked ranges, a tinted dashed outline for the range the
// customer is about to pick, and a live "now" marker — so busy vs. free reads at a glance.
export function DayTimeline({ startMin, endMin, blocks, selectedRange, compact }) {
  const trackHeight = compact ? 40 : 46;
  const tickAreaHeight = compact ? 20 : 22;
  const trackTop = tickAreaHeight + 4;
  const rowHeight = trackTop + trackHeight + 6;
  const totalMin = Math.max(1, endMin - startMin);
  const pct = (min) => `${(min / totalMin) * 100}%`;
  const minBlockPx = compact ? 34 : 40;

  const firstHour = Math.ceil(startMin / 60);
  const lastHour = Math.floor(endMin / 60);
  const totalHours = lastHour - firstHour;
  // Thin out hour labels on wide ranges so they never overlap on a narrow screen —
  // the whole day always fits in view, so density has to adapt instead of scrolling.
  const hourStep = totalHours > 9 ? 3 : totalHours > 5 ? 2 : 1;
  const hourMarks = [];
  for (let h = firstHour; h <= lastHour; h += hourStep) hourMarks.push(h);
  if (hourMarks[hourMarks.length - 1] !== lastHour) hourMarks.push(lastHour);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const showNow = nowMin >= startMin && nowMin <= endMin;

  return (
    <div className="surface-raised" style={{ borderRadius: "var(--radius-lg)", padding: "10px 10px 14px" }}>
      <div style={{ position: "relative", width: "100%", height: rowHeight }}>
        {/* baseline pill track */}
        <div style={{ position: "absolute", right: 0, left: 0, top: trackTop, height: trackHeight, background: "var(--color-bg)", borderRadius: "var(--radius-full)", border: "1px solid var(--color-border)" }} />

        {/* hour ticks */}
        {hourMarks.map((h) => (
          <div key={h} style={{ position: "absolute", right: pct(h * 60 - startMin), top: 0, transform: "translateX(50%)", textAlign: "center" }}>
            <div style={{ width: 1, height: 8, background: "var(--color-border)", margin: "0 auto" }} />
            <span className="muted tabular" style={{ fontSize: compact ? 9 : 10, whiteSpace: "nowrap", display: "block", marginTop: 1 }}>{formatClock(h * 60)}</span>
          </div>
        ))}

        {/* booked blocks — span the whole day, sized generously so they're unmistakable even for short bookings */}
        {blocks.map((b, i) => {
          const spanFrac = (Math.min(b.end, endMin) - Math.max(b.start, startMin)) / totalMin;
          const roomy = spanFrac * 100 > 14; // wide enough to fit the "رزرو شده" label
          return (
            <div
              key={i}
              title={b.title}
              style={{
                position: "absolute",
                right: pct(Math.max(0, b.start - startMin)),
                width: `max(${pct(Math.min(b.end, endMin) - Math.max(b.start, startMin))}, ${minBlockPx}px)`,
                top: trackTop + 1, height: trackHeight - 2,
                background: b.color, borderRadius: "var(--radius-full)",
                border: "2px solid var(--color-surface)",
                boxShadow: "0 3px 10px -1px rgba(0,0,0,.35)",
                display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                fontSize: compact ? 10.5 : 11.5, color: b.textColor || "white", fontWeight: 800, whiteSpace: "nowrap", padding: "0 8px",
              }}
            >
              {roomy ? b.label : <Lock size={compact ? 13 : 15} />}
            </div>
          );
        })}

        {/* selected range highlight */}
        {selectedRange && (
          <div
            className="fade-in"
            style={{
              position: "absolute",
              right: pct(Math.max(0, selectedRange.start - startMin)),
              width: `max(${pct(selectedRange.end - selectedRange.start)}, ${minBlockPx}px)`,
              top: trackTop - 3, height: trackHeight + 6,
              border: "2px dashed var(--color-accent-500)", borderRadius: "var(--radius-full)",
              background: "color-mix(in oklch, var(--color-accent-500) 16%, transparent)",
            }}
          />
        )}

        {/* live "now" marker */}
        {showNow && (
          <div style={{ position: "absolute", right: pct(nowMin - startMin), top: trackTop - 5, height: trackHeight + 10, width: 2, background: "var(--color-danger)", borderRadius: 1, transform: "translateX(50%)" }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-danger)", position: "absolute", top: -4, right: -2.5, boxShadow: "0 0 0 2px var(--color-surface-raised)" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// Horizontal, RTL-aware date picker. Each day is a soft rounded card that lifts with a
// tinted shadow when selected, dims and labels itself "تعطیل" when the salon is closed
// that day, and shows a small dot under today's date when it isn't the active selection.
export function DateStrip({ days, selectedDate, onSelect, isClosedFn, reasonFn, isFullFn, accentColor = "var(--color-accent-500)", compact }) {
  const todayKey = dateKey(new Date());
  const size = compact ? 50 : 60;
  const selectedKey = dateKey(selectedDate);
  const stripRef = useRef(null);
  // Keep the selected day in view — e.g. after jumping to the nearest open
  // day, which may be well off-screen to the left.
  useEffect(() => {
    const el = stripRef.current?.querySelector(`[data-day="${selectedKey}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selectedKey]);
  return (
    <div ref={stripRef} className="flex gap-2 scrollbar-none" style={{ overflowX: "auto", padding: "4px 2px 8px" }}>
      {days.map((d, i) => {
        const key = dateKey(d);
        const closed = isClosedFn(d);
        const full = !closed && !!isFullFn?.(d);
        const reason = reasonFn ? reasonFn(d) : null;
        const active = key === selectedKey;
        const isToday = key === todayKey;
        const { jd, jm } = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
        // Month name on the first card and wherever a new Jalali month starts,
        // so "۲" after "۳۰" doesn't read as going backwards.
        const showMonth = i === 0 || jd === 1;
        return (
          <button
            key={key}
            data-day={key}
            disabled={closed}
            onClick={() => onSelect(d)}
            aria-pressed={active}
            aria-label={`${jalaliLabel(d)}${closed ? " — تعطیل" : full ? " — پر" : ""}`}
            className="tap"
            style={{
              minWidth: size, width: size, flexShrink: 0, textAlign: "center",
              padding: compact ? "8px 2px 7px" : "10px 2px 9px",
              borderRadius: "var(--radius-lg)",
              border: `1px solid ${active ? accentColor : "var(--color-border)"}`,
              background: active ? accentColor : "var(--color-surface)",
              color: active ? "white" : closed ? "var(--color-muted)" : "var(--color-heading)",
              opacity: closed ? 0.5 : full && !active ? 0.6 : 1,
              boxShadow: active ? `0 8px 16px -6px color-mix(in oklch, ${accentColor} 60%, transparent)` : "none",
              transform: active ? "translateY(-2px)" : "none",
            }}
          >
            <div style={{ fontSize: compact ? 9.5 : 10.5, fontWeight: 700, opacity: active ? 0.9 : 0.7, letterSpacing: 0.3 }}>
              {isToday ? "امروز" : WEEKDAYS_FA_SHORT[d.getDay()]}
            </div>
            {closed ? (
              <div style={{ fontSize: compact ? 9 : 9.5, fontWeight: 700, marginTop: 5 }}>{reason === "notApproved" ? "به‌زودی" : "تعطیل"}</div>
            ) : (
              <div className="tabular" style={{ fontSize: compact ? 14 : 16, fontWeight: 800, marginTop: 3 }}>{toFa(jalaliDayNum(d))}</div>
            )}
            {!closed && (full || showMonth) && (
              <div style={{ fontSize: compact ? 8.5 : 9, fontWeight: 700, marginTop: 1, opacity: 0.85, whiteSpace: "nowrap" }}>
                {full ? "پر" : MONTHS_FA[jm - 1]}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function StatCard({ label, value, icon: Icon, tone = "default", color, trend }) {
  const toneColor = tone === "success" ? "var(--color-success)" : tone === "danger" ? "var(--color-danger)" : "var(--color-heading)";
  const iconColor = color || (tone !== "default" ? toneColor : "var(--color-accent-700)");
  const iconGrad =
    tone === "success" ? "var(--grad-success)" :
    tone === "danger" ? "var(--grad-danger)" :
    color === "var(--color-info)" ? "var(--grad-info)" :
    color === "var(--color-warning)" ? "var(--grad-warning)" :
    "var(--grad-brand)";
  return (
    <div className="card" style={{ flex: 1, padding: "12px 12px 10px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, color-mix(in oklch, ${iconColor} 9%, transparent), transparent 65%)`, pointerEvents: "none" }} />
      <div className="flex items-center justify-between" style={{ position: "relative" }}>
        {Icon && (
          <div style={{ width: 30, height: 30, borderRadius: "var(--radius-md)", background: iconGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 10px -2px color-mix(in oklch, ${iconColor} 55%, transparent)` }}>
            <Icon size={15} color="white" />
          </div>
        )}
        {trend && (
          <div className="tabular" style={{ fontSize: 10, fontWeight: 800, color: toneColor, whiteSpace: "nowrap", background: `color-mix(in oklch, ${toneColor} 14%, transparent)`, padding: "2px 7px", borderRadius: "var(--radius-full)" }}>
            {trend}
          </div>
        )}
      </div>
      <div className="tabular" style={{ fontSize: 19, fontWeight: 800, color: toneColor, marginTop: 8, position: "relative", letterSpacing: "-0.01em" }}>{value}</div>
      <div className="muted" style={{ fontSize: 11, marginTop: 1, position: "relative" }}>{label}</div>
    </div>
  );
}

export function MenuItem({ label, onClick, danger, positive }) {
  return (
    <button onClick={onClick} className="tap w-full" style={{ padding: "9px 12px", textAlign: "right", fontSize: 13, borderRadius: "var(--radius-sm)", color: danger ? "var(--color-danger)" : positive ? "var(--color-success)" : "var(--color-body)" }}>
      {label}
    </button>
  );
}
