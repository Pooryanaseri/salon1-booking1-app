/* v2.61 — VIP customers (pet and beauty salons). The manager marks them;
   they never pay an online deposit (server: hold_for_deposit) and see a
   VIP label on the booking page and in «داشبورد من». */
import { supabase, SUPABASE_ENABLED } from "./supabase";

const DEMO_KEY = "salon-demo-vip";
function demoList() {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) || "[]"); } catch { return []; }
}

/** Staff: phones of this salon's VIP customers. */
export async function fetchVipPhones() {
  if (!SUPABASE_ENABLED) return demoList();
  const { data, error } = await supabase.rpc("vip_phones");
  if (error) { if (!/vip_phones|function/i.test(error.message || "")) console.error("[vip] vip_phones:", error.message); return []; }
  return Array.isArray(data) ? data : [];
}

/** Manager: mark / unmark. → {ok, error?} */
export async function setCustomerVip(phone, vip) {
  if (!SUPABASE_ENABLED) {
    const list = demoList().filter((p) => p !== phone);
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(vip ? [...list, phone] : list)); } catch { /* private mode */ }
    return { ok: true };
  }
  const { data, error } = await supabase.rpc("set_customer_vip", { p_phone: phone, p_vip: !!vip });
  if (error) { console.error("[vip] set_customer_vip:", error.message); return { ok: false, error: "ذخیره ناموفق بود" }; }
  return data || { ok: false, error: "ذخیره ناموفق بود" };
}

/** The customer's own phone: VIP or not (yes/no only). */
export async function isVipCustomer(phone) {
  if (!/^09\d{9}$/.test(phone || "")) return false;
  if (!SUPABASE_ENABLED) return demoList().includes(phone);
  const { data, error } = await supabase.rpc("is_vip_customer", { p_phone: phone });
  if (error) return false;
  return data === true;
}
