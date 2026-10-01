// ============================================================================
//  Edge Function: weekly-reconciliation
//  Run once a week, Friday evening (the Iranian weekend/day off), via
//  pg_cron or any external scheduler hitting this URL.
//
//  Per active salon:
//   - unresolved pending_verification appointments exist -> mint a
//     reconciliation token (72h) and SMS the owner/managers a magic link
//     to the reconciliation page.
//   - queue is clean -> SMS a short weekly revenue summary instead (built
//     strictly from 'completed' appointments — see isRevenueEligible on
//     the frontend for the same rule applied consistently everywhere).
//   - each active stylist with any unreviewed appointments of their own
//     gets a separate, informational SMS (count only, no reconciliation
//     link — that stays manager-only, matching this app's existing RBAC
//     everywhere else; a stylist resolves their own via the per-booking
//     menu already in the app).
//
//  Deploy:  supabase functions deploy weekly-reconciliation --no-verify-jwt
//  Schedule: a weekly cron trigger (Friday ~18:00 salon-local time) —
//  see DEPLOY.md. Protected the same way as cron-reminders: an optional
//  shared-secret header, since the scheduler has no user session.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendOne } from "../_shared/providers.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const INTERNAL_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET");
// Reuses the existing ALLOWED_ORIGIN secret (already set to the deployed
// frontend's URL for CORS) as the base for the magic link — no new secret
// to configure for this feature.
const APP_BASE_URL = (Deno.env.get("ALLOWED_ORIGIN") ?? "").replace(/\/$/, "");

const FA_DIGITS = ["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"];
const toFa = (s: string | number) => String(s).replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
function formatToman(n: number) {
  return toFa(Math.round(n).toLocaleString("en-US")) + " تومان";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (INTERNAL_SECRET) {
    const internal = req.headers.get("x-internal-secret");
    if (internal !== INTERNAL_SECRET) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  } else {
    console.warn("[weekly-reconciliation] INTERNAL_FUNCTION_SECRET is not set — this endpoint is unauthenticated.");
  }
  if (!APP_BASE_URL) {
    console.warn("[weekly-reconciliation] ALLOWED_ORIGIN is not set — magic links will be relative paths, not full URLs.");
  }

  const { data: salons, error: salonsError } = await admin
    .from("salons").select("id, slug, name").eq("active", true);
  if (salonsError) {
    console.error("[weekly-reconciliation] failed to load salons:", salonsError.message);
    return json({ ok: false, error: "could not load salons" }, 500);
  }

  const report = { salons: 0, reconciliationSent: 0, summarySent: 0, stylistsNotified: 0, failed: 0 };

  for (const salon of salons ?? []) {
    report.salons++;
    try {
      const { count: pendingCount } = await admin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("salon_id", salon.id)
        .eq("status", "pending_verification");

      const { data: managers } = await admin
        .from("users").select("phone")
        .eq("salon_id", salon.id)
        .in("role", ["owner", "manager"])
        .eq("active", true);

      const recipients = (managers ?? []).map((m) => m.phone).filter(Boolean);
      if (!recipients.length) {
        console.warn(`[weekly-reconciliation] salon ${salon.slug}: no active manager/owner phone on file — skipped`);
        continue;
      }

      let body: string;
      if ((pendingCount ?? 0) > 0) {
        const { data: tokenRes, error: tokenErr } = await admin.rpc("create_reconciliation_token", { p_salon_id: salon.id });
        if (tokenErr || !tokenRes?.ok) {
          console.error(`[weekly-reconciliation] salon ${salon.slug}: token creation failed:`, tokenErr?.message ?? tokenRes?.error);
          report.failed++;
          continue;
        }
        const url = `${APP_BASE_URL}/${salon.slug}/reconcile?token=${tokenRes.token}`;
        body = `${salon.name}: ${toFa(pendingCount)} نوبت منتظر تایید دارید. با یک لمس تایید کنید:\n${url}\n(اعتبار لینک: ۷۲ ساعت)`;
      } else {
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const { data: completedRows } = await admin
          .from("appointments")
          .select("final_price")
          .eq("salon_id", salon.id)
          .eq("status", "completed")
          .gte("date", weekAgo);
        const revenue = (completedRows ?? []).reduce((s, r) => s + (r.final_price || 0), 0);
        const visitCount = (completedRows ?? []).length;
        body = `${salon.name}: گزارش هفتگی — ${toFa(visitCount)} نوبت تکمیل‌شده، ${formatToman(revenue)} درآمد. همه‌چیز تاییدشده، کاری لازم نیست. 👍`;
      }

      for (const phone of recipients) {
        const r = await sendOne(phone, body);
        await admin.from("sms_messages").insert({
          salon_id: salon.id, to_phone: phone, body,
          kind: (pendingCount ?? 0) > 0 ? "reconciliation_prompt" : "weekly_summary",
          status: r.ok ? "sent" : "failed",
          provider: r.provider, provider_msg_id: r.providerMsgId ?? null,
          error: r.ok ? null : r.error, cost: r.cost ?? null,
          sent_at: r.ok ? new Date().toISOString() : null,
        });
        if (r.ok) (pendingCount ?? 0) > 0 ? report.reconciliationSent++ : report.summarySent++;
        else report.failed++;
      }

      // Stylists get an informational heads-up about their OWN unreviewed
      // appointments — not the reconciliation link itself (that's a
      // salon-wide batch-approve capability, manager-only, matching the
      // existing RBAC model everywhere else in this app). A stylist
      // resolves their own via the per-booking "انجام شد"/"عدم حضور"
      // menu already in the app.
      const { data: stylists } = await admin
        .from("users").select("phone, stylist_id")
        .eq("salon_id", salon.id).eq("role", "stylist").eq("active", true)
        .not("stylist_id", "is", null);

      for (const stylist of stylists ?? []) {
        if (!stylist.phone) continue;
        const { count: myPendingCount } = await admin
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("salon_id", salon.id)
          .eq("staff_id", stylist.stylist_id)
          .eq("status", "pending_verification");
        if (!myPendingCount) continue;

        const stylistBody = `${salon.name}: ${toFa(myPendingCount)} نوبت از شما منتظر تایید نهایی‌ست — برای بررسی وارد اپ شوید.`;
        const r = await sendOne(stylist.phone, stylistBody);
        await admin.from("sms_messages").insert({
          salon_id: salon.id, to_phone: stylist.phone, body: stylistBody,
          kind: "reconciliation_prompt",
          status: r.ok ? "sent" : "failed",
          provider: r.provider, provider_msg_id: r.providerMsgId ?? null,
          error: r.ok ? null : r.error, cost: r.cost ?? null,
          sent_at: r.ok ? new Date().toISOString() : null,
        });
        if (r.ok) report.stylistsNotified++; else report.failed++;
      }
    } catch (err) {
      console.error(`[weekly-reconciliation] salon ${salon.slug} failed:`, err);
      report.failed++;
    }
  }

  return json({ ok: true, ...report });
});
