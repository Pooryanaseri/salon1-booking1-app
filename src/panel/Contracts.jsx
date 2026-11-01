import { useEffect, useState } from "react";
import { Armchair, ChevronLeft, ChevronRight, Loader2, Pencil, Printer, Trash2, Plus } from "lucide-react";
import { Modal } from "../components/ui";
import { formatToman, toFa, digitsOnly, MONTHS_FA, gregorianToJalali } from "../lib/format";
import {
  CONTRACT_KINDS, COLLECTORS, LEDGER_KINDS, contractLabel, ledgerLabel, monthKey, shiftMonth, contractOn,
  fetchContracts, saveContract, fetchStatement, addLedgerEntry, deleteLedgerEntry, fetchContractIncome,
} from "../lib/contracts";

/* ============================================================
   v2.54 — independent stylists in the panel.
   ============================================================ */
const input = { width: "100%", padding: "10px 12px", fontSize: 14, marginTop: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-body)" };
const money = (v, on) => ({ dir: "ltr", inputMode: "numeric", className: "tabular", value: v === "" || v == null ? "" : toFa(Number(v).toLocaleString("en-US")),
  onChange: (e) => on(digitsOnly(e.target.value, 11)), style: { ...input, textAlign: "left" } });
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const { jy, jm } = gregorianToJalali(y, m, 15);
  return `${MONTHS_FA[jm - 1]} ${toFa(jy)}`;
}
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/* ------------------------------------------------------- manager card ---- */
export function ContractsCard({ stylists, bookings, notify }) {
  const [contracts, setContracts] = useState(null);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchContracts().then((c) => setContracts(c || [])); }, [tick]);
  if (!contracts) return null;
  const active = stylists.filter((s) => s.active !== false);
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="contracts">
      <p className="flex items-center gap-1.5 mb-1" style={{ fontSize: 14, fontWeight: 800 }}><Armchair size={15} color="var(--color-accent-500)" /> قرارداد آرایشگرها و تسویه</p>
      <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8, marginBottom: 6 }}>
        برای آرایشگری که صندلی اجاره می‌کند یا درصدی کار می‌کند، قرارداد تعیین کنید؛ صورت‌حساب ماهانه و مانده (چه کسی به چه کسی بدهکار است) خودکار حساب می‌شود.
      </p>
      {active.map((s) => {
        const c = contractOn(contracts, s.id, todayIso());
        const kind = c?.kind || "employee";
        return (
          <div key={s.id} className="flex items-center gap-2" style={{ padding: "8px 0", borderTop: "1px dashed var(--color-border)" }} data-contract={s.name}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name}</p>
              <p className="muted tabular" style={{ fontSize: 11.5 }}>
                {contractLabel(kind)}
                {c && ["rent", "hybrid"].includes(kind) && ` · اجاره ${formatToman(c.rent_amount)}`}
                {c && ["share", "hybrid"].includes(kind) && ` · ${toFa(Number(c.service_share_pct))}٪ سهم سالن`}
                {c && kind !== "employee" && ` · ${c.collector === "salon" ? "پول دست سالن" : "پول دست آرایشگر"}`}
              </p>
            </div>
            {kind !== "employee" && (
              <button className="tap ghost-btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setViewing(s)}>صورت‌حساب</button>
            )}
            <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label={`قرارداد ${s.name}`}
              onClick={() => setEditing({ stylist: s, c: c ? { ...c } : { kind: "rent", collector: "salon", rent_amount: "", service_share_pct: "", rent_due_day: 1 } })}>
              <Pencil size={13} style={{ margin: "auto" }} />
            </button>
          </div>
        );
      })}
      {editing && (
        <Modal title={`قرارداد ${editing.stylist.name}`} onClose={() => setEditing(null)}>
          <ContractForm stylist={editing.stylist} initial={editing.c} onDone={(msg) => { setEditing(null); notify(msg); setTick((t) => t + 1); }} />
        </Modal>
      )}
      {viewing && <StatementModal stylist={viewing} bookings={bookings} isManager notify={notify} onClose={() => setViewing(null)} />}
    </div>
  );
}

function ContractForm({ stylist, initial, onDone }) {
  const [c, setC] = useState({ ...initial, effective_from: monthKey() });
  const [err, setErr] = useState("");
  const set = (k) => (v) => setC((x) => ({ ...x, [k]: v }));
  const rentOn = ["rent", "hybrid"].includes(c.kind);
  const shareOn = ["share", "hybrid"].includes(c.kind);
  async function save() {
    const r = await saveContract({ ...c, stylist_id: stylist.id });
    if (!r.ok) { setErr(r.error); return; }
    onDone("قرارداد ذخیره شد");
  }
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="نوع قرارداد" className="flex flex-col gap-1.5">
        {CONTRACT_KINDS.map(([k, label, hint]) => (
          <label key={k} className="flex items-start gap-2" style={{ fontSize: 13.5, padding: "6px 8px", borderRadius: "var(--radius-md)", border: `1px solid ${c.kind === k ? "var(--color-accent-500)" : "var(--color-border)"}` }}>
            <input type="radio" name="kind" checked={c.kind === k} onChange={() => set("kind")(k)} style={{ marginTop: 5 }} />
            <span><b>{label}</b><span className="muted" style={{ display: "block", fontSize: 11.5 }}>{hint}</span></span>
          </label>
        ))}
      </div>
      {(rentOn || shareOn) && (
        <div className="flex gap-2">
          {rentOn && <label className="muted" style={{ fontSize: 12, flex: 2 }}>اجارهٔ ماهانه (تومان)<input {...money(c.rent_amount, set("rent_amount"))} /></label>}
          {rentOn && <label className="muted" style={{ fontSize: 12, flex: 1 }}>روز سررسید<input dir="ltr" inputMode="numeric" value={toFa(c.rent_due_day)} onChange={(e) => set("rent_due_day")(digitsOnly(e.target.value, 2))} style={{ ...input, textAlign: "left" }} /></label>}
          {shareOn && <label className="muted" style={{ fontSize: 12, flex: 1 }}>سهم سالن ٪<input dir="ltr" inputMode="decimal" value={toFa(c.service_share_pct)} onChange={(e) => set("service_share_pct")(e.target.value.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[^0-9.]/g, "").slice(0, 5))} style={{ ...input, textAlign: "left" }} /></label>}
        </div>
      )}
      {c.kind !== "employee" && (
        <div role="radiogroup" aria-label="دریافت پول" className="flex flex-col gap-1.5">
          <span className="muted" style={{ fontSize: 12 }}>پول مشتری دست کیست؟</span>
          {COLLECTORS.map(([k, label, hint]) => (
            <label key={k} className="flex items-start gap-2" style={{ fontSize: 13.5 }}>
              <input type="radio" name="collector" checked={c.collector === k} onChange={() => set("collector")(k)} style={{ marginTop: 5 }} />
              <span><b>{label}</b><span className="muted" style={{ display: "block", fontSize: 11.5 }}>{hint}</span></span>
            </label>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
        از ابتدای {monthLabel(c.effective_from)} اعمال می‌شود؛ ماه‌های قبل با قرارداد قبلی حساب می‌مانند. یادآوری اجاره در روز سررسید برای آرایشگر پیامک می‌شود.
      </p>
      {err && <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12.5 }}>{err}</p>}
      <button className="tap accent-btn w-full" style={{ padding: 12 }} onClick={save}>ذخیره</button>
    </div>
  );
}

/* ---------------------------------------------------- the statement ---- */
function StatementBody({ s }) {
  const row = (label, value, opts = {}) => (
    <div className="flex justify-between gap-2 tabular" style={{ fontSize: 13, padding: "5px 0", borderTop: "1px dashed var(--color-border)", fontWeight: opts.bold ? 800 : 400, color: opts.color }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
  const owes = s.balance < 0;
  return (
    <div className="statement-print">
      <p className="muted" style={{ fontSize: 12 }}>
        {contractLabel(s.kind)}{s.service_share_pct > 0 ? ` · ${toFa(s.service_share_pct)}٪ سهم سالن` : ""}{s.rent > 0 ? ` · اجاره ${formatToman(s.rent)}` : ""} · {s.collector === "salon" ? "پول دست سالن" : "پول دست آرایشگر"}
      </p>
      {row(`کار انجام‌شده (${toFa(s.visits)} نوبت)`, formatToman(s.gross), { bold: true })}
      {s.gift > 0 && row("— از آن با کارت هدیهٔ سالن", formatToman(s.gift))}
      {s.pkg > 0 && row("— از آن با بستهٔ پیش‌پرداخت سالن", formatToman(s.pkg))}
      {s.online > 0 && row("— بیعانهٔ آنلاین (به حساب سالن)", formatToman(s.online))}
      {row("دریافتی سالن از این کارها", formatToman(s.held_by_salon))}
      {row("دریافتی خود آرایشگر", formatToman(s.held_by_stylist))}
      {s.salon_share > 0 && row(`سهم سالن (${toFa(s.service_share_pct)}٪)`, "− " + formatToman(s.salon_share))}
      {s.rent > 0 && row("اجارهٔ صندلی", "− " + formatToman(s.rent))}
      {s.charges > 0 && row("بدهی‌های ثبت‌شده", "− " + formatToman(s.charges))}
      {s.credits > 0 && row("طلب‌های ثبت‌شده", "+ " + formatToman(s.credits))}
      {row("درآمد خالص آرایشگر این ماه", formatToman(s.stylist_net), { bold: true })}
      {s.paid_to_stylist > 0 && row("پرداخت‌شده به آرایشگر", formatToman(s.paid_to_stylist))}
      {s.paid_to_salon > 0 && row("پرداخت‌شده به سالن", formatToman(s.paid_to_salon))}
      <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: "var(--radius-md)", fontWeight: 800, fontSize: 14,
        background: s.balance === 0 ? "color-mix(in oklch, var(--color-success) 12%, var(--color-surface))" : owes ? "color-mix(in oklch, var(--color-warning) 14%, var(--color-surface))" : "color-mix(in oklch, var(--color-info) 12%, var(--color-surface))" }}
        data-balance={s.balance}>
        {s.balance === 0 ? "تسویه است ✓" : owes ? `آرایشگر ${formatToman(-s.balance)} به سالن بدهکار است` : `سالن ${formatToman(s.balance)} به آرایشگر بدهکار است`}
      </div>
    </div>
  );
}

export function StatementModal({ stylist, bookings, isManager, notify, onClose }) {
  const [month, setMonth] = useState(monthKey());
  const [s, setS] = useState(null);
  const [tick, setTick] = useState(0);
  const [entry, setEntry] = useState({ kind: "charge", amount: "", label: "" });
  useEffect(() => { setS(null); fetchStatement(stylist.id, month, { bookings }).then((r) => setS(r || { ok: false })); }, [stylist.id, month, bookings, tick]);
  async function add() {
    const r = await addLedgerEntry(stylist.id, month, entry.kind, entry.amount, entry.label);
    notify(r.ok ? "ثبت شد" : r.error);
    if (r.ok) { setEntry({ kind: "charge", amount: "", label: "" }); setTick((t) => t + 1); }
  }
  async function settle() {
    if (!s || !s.balance) return;
    const kind = s.balance > 0 ? "paid_to_stylist" : "paid_to_salon";
    const r = await addLedgerEntry(stylist.id, month, kind, Math.abs(s.balance), "تسویهٔ ماه");
    notify(r.ok ? "تسویه ثبت شد" : r.error);
    setTick((t) => t + 1);
  }
  return (
    <Modal title={`صورت‌حساب ${stylist.name}`} onClose={onClose}>
      <div className="flex items-center justify-between mb-2">
        <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label="ماه قبل" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronRight size={15} style={{ margin: "auto" }} /></button>
        <b style={{ fontSize: 14 }}>{monthLabel(month)}</b>
        <button className="tap ghost-btn" style={{ width: 34, height: 34, padding: 0 }} aria-label="ماه بعد" disabled={month >= monthKey()} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronLeft size={15} style={{ margin: "auto" }} /></button>
      </div>
      {!s ? <div className="flex justify-center" style={{ padding: 16 }}><Loader2 size={16} className="salon-spin" /></div>
        : !s.ok ? <p className="muted" style={{ fontSize: 13 }}>{s.error || "در دسترس نیست"}</p>
        : s.kind === "employee" ? <p className="muted" style={{ fontSize: 13 }}>در این ماه قرارداد «کارمند» برقرار بوده؛ حساب آن در «پورسانت کارکنان» است.</p>
        : (
          <>
            <StatementBody s={s} />
            {(s.ledger || []).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>ثبت‌های این ماه</p>
                {s.ledger.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 tabular" style={{ fontSize: 12.5, padding: "4px 0" }}>
                    <span style={{ flex: 1 }}>{ledgerLabel(l.kind)}{l.label ? ` — ${l.label}` : ""}</span>
                    <span>{formatToman(l.amount)}</span>
                    {isManager && <button className="tap" aria-label="حذف" style={{ color: "var(--color-danger)" }} onClick={async () => { if (window.confirm("حذف شود؟")) { await deleteLedgerEntry(l.id); setTick((t) => t + 1); } }}><Trash2 size={13} /></button>}
                  </div>
                ))}
              </div>
            )}
            {isManager && (
              <div className="card" style={{ padding: 10, marginTop: 12, background: "var(--color-surface-raised)" }}>
                <select value={entry.kind} onChange={(e) => setEntry((x) => ({ ...x, kind: e.target.value }))} style={{ ...input, marginTop: 0 }} aria-label="نوع ثبت">
                  {LEDGER_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                  <input {...money(entry.amount, (v) => setEntry((x) => ({ ...x, amount: v })))} placeholder="مبلغ" aria-label="مبلغ" style={{ ...input, marginTop: 0, textAlign: "left", flex: 1 }} />
                  <input value={entry.label} maxLength={120} placeholder="شرح" aria-label="شرح" onChange={(e) => setEntry((x) => ({ ...x, label: e.target.value }))} style={{ ...input, marginTop: 0, flex: 1 }} />
                </div>
                <button className="tap ghost-btn w-full flex items-center justify-center gap-1" style={{ padding: 9, marginTop: 6 }} disabled={!(Number(entry.amount) > 0)} onClick={add}><Plus size={13} /> ثبت</button>
              </div>
            )}
            <div className="flex gap-2" style={{ marginTop: 10 }}>
              {isManager && s.balance !== 0 && (
                <button className="tap accent-btn flex-1" style={{ padding: 11 }} onClick={settle}>
                  ثبت تسویه ({formatToman(Math.abs(s.balance))})
                </button>
              )}
              <button className="tap ghost-btn flex items-center gap-1" style={{ padding: "11px 14px" }} onClick={() => window.print()}><Printer size={14} /> چاپ</button>
            </div>
          </>
        )}
    </Modal>
  );
}

/* --------------------------------------------- the stylist's own view ---- */
export function MyStatementCard({ stylist, bookings, notify }) {
  const [s, setS] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (stylist) fetchStatement(stylist.id, monthKey(), { bookings }).then(setS); }, [stylist, bookings]);
  if (!stylist || !s?.ok || s.kind === "employee") return null;
  return (
    <div className="card mb-4" style={{ padding: 14 }} data-card="my-statement">
      <p className="flex items-center gap-1.5 mb-1" style={{ fontSize: 14, fontWeight: 800 }}><Armchair size={15} color="var(--color-accent-500)" /> حساب من با سالن — {monthLabel(s.month)}</p>
      <p className="tabular" style={{ fontSize: 13 }}>درآمد خالص این ماه: <b>{formatToman(s.stylist_net)}</b> <span className="muted">({toFa(s.visits)} نوبت)</span></p>
      <p className="tabular" style={{ fontSize: 13, marginTop: 2, fontWeight: 700, color: s.balance < 0 ? "var(--color-warning)" : "var(--color-success)" }}>
        {s.balance === 0 ? "تسویه است" : s.balance < 0 ? `بدهی شما به سالن: ${formatToman(-s.balance)}` : `طلب شما از سالن: ${formatToman(s.balance)}`}
      </p>
      <button className="tap muted" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setOpen(true)}>جزئیات صورت‌حساب</button>
      {open && <StatementModal stylist={stylist} bookings={bookings} isManager={false} notify={notify} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Accounting: totals of independent stylists over the last `days` days. */
export function useContractIncome(days, bookings, enabled) {
  const [r, setR] = useState(null);
  useEffect(() => {
    if (!enabled) { setR(null); return undefined; }
    let alive = true;
    const to = new Date(); const from = new Date(); from.setDate(from.getDate() - (days - 1));
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    fetchContractIncome(iso(from), iso(to), { bookings }).then((res) => {
      if (!alive || !res?.ok) return;
      const rows = res.rows || [];
      setR({ rows: rows.length, gross: rows.reduce((t, x) => t + Number(x.gross || 0), 0),
        share: rows.reduce((t, x) => t + Number(x.share || 0), 0), rent: rows.reduce((t, x) => t + Number(x.rent || 0), 0) });
    });
    return () => { alive = false; };
  }, [days, bookings, enabled]);
  return r;
}
