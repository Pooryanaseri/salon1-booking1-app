/* v2.68 — consultation requests in beauty salons. The questions, their
   answers and one readable line of them (mirrors consult_details_text()). */
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { demoQuotes } from "./api";

export const CONSULT_QUESTIONS = {
  hair_length: { label: "طول مو", options: [["short", "کوتاه"], ["medium", "متوسط"], ["long", "بلند"], ["very_long", "خیلی بلند"]] },
  hair_texture: { label: "جنس مو", options: [["straight", "صاف"], ["wavy", "موج‌دار"], ["curly", "فر"]] },
  hair_condition: { label: "وضعیت مو", options: [["healthy", "سالم"], ["dry", "خشک"], ["damaged", "آسیب‌دیده"], ["very_damaged", "خیلی آسیب‌دیده"]] },
  last_color: { label: "آخرین رنگ یا دکلره", options: [["none", "نداشته‌ام"], ["lt3", "کمتر از ۳ ماه پیش"], ["3to6", "۳ تا ۶ ماه پیش"], ["gt6", "بیش از ۶ ماه پیش"]] },
  skin: { label: "نوع پوست", options: [["normal", "معمولی"], ["oily", "چرب"], ["dry", "خشک"], ["sensitive", "حساس"]] },
};
// which questions each section sees, and which of them must be answered
export const CONSULT_FIELDS = {
  female: { ask: ["hair_length", "hair_texture", "hair_condition", "last_color"], required: ["hair_length", "hair_condition", "last_color"] },
  male: { ask: ["hair_length", "hair_texture", "skin", "last_color"], required: ["hair_length"] },
};
export const EMPTY_CONSULT = { hair_length: "", hair_texture: "", hair_condition: "", last_color: "", skin: "", treatments: "", allergy: "", goal: "" };

/** Pure: the first unanswered required question (its label), or "". */
export function consultMissing(gender, d) {
  const f = CONSULT_FIELDS[gender] || CONSULT_FIELDS.female;
  const key = f.required.find((k) => !d?.[k]);
  return key ? CONSULT_QUESTIONS[key].label : "";
}

/** Pure: only the questions this section asks, trimmed — what the server stores. */
export function consultPayload(gender, d) {
  const f = CONSULT_FIELDS[gender] || CONSULT_FIELDS.female;
  const out = {};
  for (const k of f.ask) if (d?.[k]) out[k] = d[k];
  for (const k of ["treatments", "allergy", "goal"]) if ((d?.[k] || "").trim()) out[k] = d[k].trim();
  return out;
}

const answer = (key, v) => (CONSULT_QUESTIONS[key]?.options.find(([o]) => o === v) || [])[1] || "";
/** Pure: «موی بلند، فر، آسیب‌دیده · رنگ/دکلره کمتر از ۳ ماه پیش · …» */
export function consultDetailsLine(d) {
  if (!d) return "";
  const hair = [d.hair_length && `موی ${answer("hair_length", d.hair_length)}`, answer("hair_texture", d.hair_texture), answer("hair_condition", d.hair_condition)].filter(Boolean).join("، ");
  const color = d.last_color === "none" ? "بدون رنگ قبلی" : d.last_color ? `رنگ/دکلره ${answer("last_color", d.last_color)}` : "";
  return [hair, color, d.skin && `پوست ${answer("skin", d.skin)}`,
    d.treatments && `خدمات قبلی: ${d.treatments}`, d.allergy && `حساسیت: ${d.allergy}`, d.goal && `نتیجهٔ دلخواه: ${d.goal}`]
    .filter(Boolean).join(" · ");
}

/** Customer: ask for a consultation → {ok, id} | {ok:false, error} */
export async function requestConsultation({ name, phone, gender, serviceIds, servicesLabel, details, note, preferredTime }) {
  if (!SUPABASE_ENABLED) {
    const id = `demo-c-${Math.random().toString(36).slice(2, 10)}`;
    demoQuotes.unshift({
      id, kind: "consult", customer_phone: phone, customer_name: name || "مشتری", customer_gender: gender, details,
      pet_name: null, pet_species: null, service_ids: serviceIds, services_label: servicesLabel, customer_note: note || "",
      preferred_time: preferredTime || "", status: "pending", created_at: new Date().toISOString(),
    });
    return { ok: true, demo: true, id };
  }
  const { data, error } = await supabase.rpc("request_consultation", {
    p_customer_name: name || "", p_customer_phone: phone, p_gender: gender, p_service_ids: serviceIds,
    p_details: details || {}, p_note: note || "", p_preferred_time: preferredTime || "",
  });
  if (error) { console.error("[consult] request_consultation:", error.message); return { ok: false, error: "ثبت درخواست ناموفق بود" }; }
  return data;
}
