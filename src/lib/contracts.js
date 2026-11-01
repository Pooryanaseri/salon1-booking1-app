/* ============================================================
   v2.54 — independent stylists: chair rental / revenue share.
   The server computes statements (stylist_statement); demo mode
   and the unit tests use the same arithmetic in computeStatement.
   ============================================================ */
import { supabase, SUPABASE_ENABLED, getCurrentSalonId } from "./supabase";

const log = (where, e) => console.error(`[contracts] ${where}:`, e?.message || e);
const missing = (e, name) => new RegExp(name, "i").test(e?.message || "");

export const CONTRACT_KINDS = [
  ["employee", "کارمند (پورسانت)", "درآمد مال سالن است؛ سالن پورسانت می‌دهد"],
  ["rent", "اجارهٔ صندلی", "اجارهٔ ثابت ماهانه؛ بقیهٔ درآمد مال آرایشگر"],
  ["share", "درصدی", "درصدی از هر خدمت سهم سالن"],
  ["hybrid", "ترکیبی", "اجارهٔ کمتر + درصد کمتر"],
];
export const COLLECTORS = [
  ["salon", "سالن دریافت می‌کند", "پول در صندوق/درگاه سالن؛ سهم آرایشگر در تسویه پرداخت می‌شود"],
  ["stylist", "آرایشگر خودش دریافت می‌کند", "کارتخوان/کارت شخصی؛ آرایشگر سهم سالن و اجاره را می‌پردازد"],
];
export const LEDGER_KINDS = [
  ["charge", "بدهی آرایشگر (مواد مصرفی، …)"],
  ["credit", "طلب آرایشگر (اصلاحیه، …)"],
  ["paid_to_salon", "آرایشگر به سالن پرداخت کرد"],
  ["paid_to_stylist", "سالن به آرایشگر پرداخت کرد"],
];
export const contractLabel = (k) => (CONTRACT_KINDS.find(([x]) => x === k) || CONTRACT_KINDS[0])[1];
export const ledgerLabel = (k) => (LEDGER_KINDS.find(([x]) => x === k) || [k, k])[1];

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
export function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}
const dayKey = (k) => { const [y, m, d] = String(k).split("-").map(Number); return y * 10000 + m * 100 + (d || 1); };

/** The contract in force on a day ("YYYY-MM-DD") — latest effective_from wins. */
export function contractOn(contracts, stylistId, day) {
  return contracts.filter((c) => c.stylist_id === stylistId && dayKey(c.effective_from) <= dayKey(day))
    .sort((a, b) => dayKey(b.effective_from) - dayKey(a.effective_from))[0] || null;
}

/** Pure mirror of stylist_statement(): bookings use unpadded "YYYY-M-D" dates. */
export function computeStatement({ contract, bookings, ledger = [], month, stylistId, packagesById = {} }) {
  if (!contract || contract.kind === "employee") return { ok: true, kind: "employee", month, stylist_id: stylistId };
  const [y, m] = month.split("-").map(Number);
  const done = bookings.filter((b) => b.staff_id === stylistId && b.status === "completed" && (() => {
    const [by, bm] = String(b.date).split("-").map(Number); return by === y && bm === m;
  })());
  let gross = 0, online = 0, gift = 0, pkg = 0;
  for (const b of done) {
    const p = b.package_purchase_id ? packagesById[b.package_purchase_id] : null;
    const pv = p ? Math.round(p.price_paid / (p.sessions_total || 1)) : 0;
    gross += (b.final_price || 0) - (b.transport_fee || 0) + (b.gift_card_amount || 0) + pv;
    online += b.deposit_paid_at ? b.deposit_amount || 0 : 0;
    gift += b.gift_card_amount || 0;
    pkg += pv;
  }
  const share = Math.round((gross * Number(contract.service_share_pct || 0)) / 100);
  const rent = ["rent", "hybrid"].includes(contract.kind) ? Number(contract.rent_amount || 0) : 0;
  const held = contract.collector === "salon" ? gross : online + gift + pkg;
  const sum = (k) => ledger.filter((l) => l.kind === k && l.month === month).reduce((t, l) => t + Number(l.amount), 0);
  const charges = sum("charge"), credits = sum("credit"), toSalon = sum("paid_to_salon"), toStylist = sum("paid_to_stylist");
  return {
    ok: true, stylist_id: stylistId, month, kind: contract.kind, collector: contract.collector,
    service_share_pct: Number(contract.service_share_pct || 0), rent_amount: Number(contract.rent_amount || 0),
    visits: done.length, gross, online, gift, pkg, held_by_salon: held, held_by_stylist: gross - held,
    salon_share: share, rent, charges, credits, paid_to_salon: toSalon, paid_to_stylist: toStylist,
    stylist_net: gross - share - rent - charges + credits,
    balance: held - share - rent - charges + credits - toStylist + toSalon,
    ledger: ledger.filter((l) => l.month === month && l.stylist_id === stylistId),
  };
}

/* ------------------------------------------------------------- demo ---- */
const demo = { contracts: [], ledger: [] };
const rid = () => Math.random().toString(36).slice(2, 10);

/* --------------------------------------------------------- contracts ---- */
export async function fetchContracts() {
  if (!SUPABASE_ENABLED) return demo.contracts.map((c) => ({ ...c }));
  const { data, error } = await supabase.from("stylist_contracts").select("*").order("effective_from", { ascending: false });
  if (error) { if (!missing(error, "stylist_contracts")) log("contracts", error); return null; }
  return data || [];
}
export async function saveContract(c) {
  const row = {
    stylist_id: c.stylist_id, kind: c.kind, collector: c.kind === "employee" ? "salon" : c.collector,
    rent_amount: ["rent", "hybrid"].includes(c.kind) ? Math.max(0, Math.round(Number(c.rent_amount) || 0)) : 0,
    service_share_pct: ["share", "hybrid"].includes(c.kind) ? Math.min(100, Math.max(0, Number(c.service_share_pct) || 0)) : 0,
    rent_due_day: Math.min(28, Math.max(1, Number(c.rent_due_day) || 1)),
    effective_from: c.effective_from || monthKey(), note: (c.note || "").trim().slice(0, 300),
  };
  if (["rent", "hybrid"].includes(row.kind) && row.rent_amount < 1000) return { ok: false, error: "مبلغ اجاره را وارد کنید" };
  if (["share", "hybrid"].includes(row.kind) && !(row.service_share_pct > 0)) return { ok: false, error: "درصد سهم سالن را وارد کنید" };
  if (!SUPABASE_ENABLED) {
    demo.contracts = demo.contracts.filter((x) => !(x.stylist_id === row.stylist_id && x.effective_from === row.effective_from));
    demo.contracts.push({ id: `demo-ct-${rid()}`, ...row });
    return { ok: true };
  }
  const { error } = await supabase.from("stylist_contracts").upsert({ ...row, salon_id: getCurrentSalonId() }, { onConflict: "stylist_id,effective_from" });
  if (error) { log("contracts.save", error); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return { ok: true };
}

/* ------------------------------------------------------ statements ---- */
export async function fetchStatement(stylistId, month, { bookings = [] } = {}) {
  if (!SUPABASE_ENABLED) {
    const [y, m] = month.split("-").map(Number);
    const last = `${y}-${String(m).padStart(2, "0")}-${new Date(y, m, 0).getDate()}`;
    return computeStatement({ contract: contractOn(demo.contracts, stylistId, last), bookings, ledger: demo.ledger, month, stylistId });
  }
  const { data, error } = await supabase.rpc("stylist_statement", { p_stylist: stylistId, p_month: month });
  if (error) { if (!missing(error, "stylist_statement")) log("stylist_statement", error); return null; }
  return data;
}
export async function addLedgerEntry(stylistId, month, kind, amount, label) {
  const row = { stylist_id: stylistId, month, kind, amount: Math.round(Number(amount) || 0), label: (label || "").trim().slice(0, 120) };
  if (!(row.amount > 0)) return { ok: false, error: "مبلغ را وارد کنید" };
  if (!SUPABASE_ENABLED) { demo.ledger.push({ id: `demo-lg-${rid()}`, created_at: new Date().toISOString(), ...row }); return { ok: true }; }
  const { error } = await supabase.from("stylist_ledger").insert({ ...row, salon_id: getCurrentSalonId() });
  if (error) { log("ledger.add", error); return { ok: false, error: "ثبت ناموفق بود" }; }
  return { ok: true };
}
export async function deleteLedgerEntry(id) {
  if (!SUPABASE_ENABLED) { demo.ledger = demo.ledger.filter((l) => l.id !== id); return { ok: true }; }
  const { error } = await supabase.from("stylist_ledger").delete().eq("id", id);
  return error ? { ok: false, error: "حذف ناموفق بود" } : { ok: true };
}

/** Accounting: salon income from independent stylists in a date range (ISO dates). */
export async function fetchContractIncome(from, to, { bookings = [] } = {}) {
  if (!SUPABASE_ENABLED) {
    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    const fromK = dayKey(from), toK = dayKey(to);
    const ids = [...new Set(demo.contracts.map((c) => c.stylist_id))];
    const rows = [];
    for (const id of ids) {
      const c = contractOn(demo.contracts, id, to);
      if (!c || c.kind === "employee") continue;
      const done = bookings.filter((b) => b.staff_id === id && b.status === "completed" && dayKey(b.date) >= fromK && dayKey(b.date) <= toK);
      const gross = done.reduce((t, b) => t + (b.final_price || 0) - (b.transport_fee || 0) + (b.gift_card_amount || 0), 0);
      rows.push({ id, kind: c.kind, collector: c.collector, gross, share: Math.round((gross * Number(c.service_share_pct || 0)) / 100),
        rent: ["rent", "hybrid"].includes(c.kind) ? Math.round(Number(c.rent_amount) * (days / 30)) : 0 });
    }
    return { ok: true, rows };
  }
  const { data, error } = await supabase.rpc("contract_income", { p_from: from, p_to: to });
  if (error) { if (!missing(error, "contract_income")) log("contract_income", error); return null; }
  return data;
}
