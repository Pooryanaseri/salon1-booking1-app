// ============================================================================
//  Auth — phone + password on the surface, Supabase Auth underneath.
//  The three roles (owner / manager / stylist) are unchanged; they live in
//  public.users.role and are also enforced by RLS in Postgres.
// ============================================================================
import { supabase, SUPABASE_ENABLED, phoneToEmail } from "./supabase";

const OWNER_BOOTSTRAP_PHONE = import.meta.env.VITE_OWNER_PHONE || "09120000000";
const PENDING_APPROVAL_MSG = "ثبت‌نام انجام شد — بعد از تایید مدیر سالن می‌توانید وارد شوید (به مدیر پیامک رفت)";

/**
 * @param {string} phone
 * @param {string} password
 * @param {"owner"|"stylist"|null} roleHint — which login form this came
 *   from. Used only for self-healing (see below); never changes what
 *   credentials are checked.
 * @returns {{ok:boolean, error?:string, role?:string, stylistId?:string|null, user?:object}}
 */
export async function signIn(phone, password, roleHint = null) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "OFFLINE" };

  const { data, error } = await supabase.auth.signInWithPassword({
    email: phoneToEmail(phone),
    password,
  });
  if (error) return { ok: false, error: translateSignInError(error.message) };

  let profile = await loadProfile(data.user.id);
  if (!profile) {
    // Self-heal: the Auth user exists (we just signed in successfully) but
    // their public.users profile row is missing. The most common cause —
    // this app's phone-based accounts use a synthetic @salon.local email
    // that can never actually receive a confirmation link, so if the
    // Supabase project has "Confirm email" turned on, registerOwner /
    // registerStylist's profile INSERT silently failed at signup time: RLS
    // requires `id = auth.uid()`, but there was no session yet to satisfy
    // that until email confirmation happened. Now that a session genuinely
    // exists, retry the same profile creation those functions would have
    // done, so a person stuck in this state can just log in again instead
    // of needing manual SQL.
    profile = await repairMissingProfile(data.user.id, phone, roleHint);
    if (!profile) {
      await supabase.auth.signOut();
      return { ok: false, error: "حساب شما پیدا نشد — با مدیر سالن تماس بگیرید" };
    }
  }
  if (!profile.active) {
    await supabase.auth.signOut();
    return { ok: false, error: profile.role === "stylist" ? PENDING_APPROVAL_MSG : "حساب شما غیرفعال شده — با مدیر سالن تماس بگیرید" };
  }
  return { ok: true, role: profile.role, stylistId: profile.stylist_id, user: profile };
}

async function repairMissingProfile(userId, phone, roleHint) {
  if (roleHint === "owner") {
    const role = phone === OWNER_BOOTSTRAP_PHONE ? "owner" : "manager";
    const { error } = await supabase.from("users").insert({ id: userId, phone, role, full_name: "مدیر سالن", active: true });
    if (error) return null;
    return loadProfile(userId);
  }
  if (roleHint === "stylist") {
    const { data: stylist } = await supabase.from("stylists").select("id, name").eq("phone", phone).maybeSingle();
    if (!stylist) return null;
    const { error } = await supabase.from("users").insert({
      id: userId, phone, full_name: stylist.name, role: "stylist", stylist_id: stylist.id, active: true,
    });
    if (error) return null;
    return loadProfile(userId);
  }
  return null;
}

function translateSignInError(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("email not confirmed")) {
    return "حساب هنوز تایید نشده — در تنظیمات Supabase (Authentication → Providers → Email) گزینهٔ «Confirm email» را خاموش کنید، چون این حساب‌ها ایمیل واقعی ندارند";
  }
  if (m.includes("invalid login credentials")) return "شماره موبایل یا رمز عبور اشتباه است";
  return "شماره موبایل یا رمز عبور اشتباه است";
}

export async function loadProfile(userId) {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase
    .from("users")
    .select("id, phone, full_name, role, stylist_id, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return data;
}

/** Restore an existing session on page load (so a refresh keeps you logged in). */
export async function restoreSession() {
  if (!SUPABASE_ENABLED) return null;
  const { data } = await supabase.auth.getSession();
  if (!data?.session?.user) return null;
  const profile = await loadProfile(data.session.user.id);
  if (!profile?.active) return null;
  return { role: profile.role, stylistId: profile.stylist_id, user: profile };
}

export async function signOut() {
  if (!SUPABASE_ENABLED) return;
  await supabase.auth.signOut();
}

/** The raw Supabase auth user (id/email/etc), not the app profile — use
 *  loadProfile(user.id) or restoreSession() if you need role/stylistId too. */
export async function getCurrentUser() {
  if (!SUPABASE_ENABLED) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data?.user || null;
}

export async function getSession() {
  if (!SUPABASE_ENABLED) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

/** Subscribe to auth state changes (sign-in, sign-out, token refresh).
 *  Returns an unsubscribe function — call it in a useEffect cleanup. */
export function onAuthStateChange(callback) {
  if (!SUPABASE_ENABLED) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => data?.subscription?.unsubscribe();
}

/**
 * Owner self-registration — only while the salon has no manager, and (v2.41)
 * only with the phone the platform admin bound to the salon. Checked before
 * the auth account is created so a wrong number leaves nothing behind.
 */
export async function registerOwner(phone, password) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "OFFLINE" };

  const { data: allowed, error: checkError } = await supabase.rpc("can_register_manager", { p_phone: phone });
  if (checkError) return { ok: false, error: "بررسی ثبت‌نام ناموفق بود — دوباره تلاش کنید" };
  if (!allowed?.ok) return { ok: false, error: allowed?.error || "ثبت‌نام مجاز نیست" };

  const { data, error } = await supabase.auth.signUp({
    email: phoneToEmail(phone),
    password,
  });
  if (error) return { ok: false, error: translateAuthError(error.message) };

  const userId = data.user?.id;
  if (!userId) return { ok: false, error: "ثبت‌نام ناموفق بود — دوباره تلاش کنید" };

  if (!data.session) {
    // signUp succeeded at the Auth level but there's no active session yet —
    // Supabase's "Confirm email" setting is on. These accounts use a
    // synthetic @salon.local address that can never receive a real
    // confirmation link, so profile creation (which needs `auth.uid()` to
    // satisfy RLS) can't proceed. This isn't a dead end though — signIn()
    // below will self-heal the missing profile the moment login succeeds.
    return {
      ok: false,
      error: "تنظیمات Supabase نیاز به تایید ایمیل دارد — در Authentication → Providers → Email گزینهٔ «Confirm email» را خاموش کنید، سپس دوباره وارد شوید (نیازی به ثبت‌نام مجدد نیست)",
    };
  }

  const { error: profileError } = await supabase.from("users").insert({
    id: userId,
    phone,
    role: phone === OWNER_BOOTSTRAP_PHONE ? "owner" : "manager",
    full_name: "مدیر سالن",
    active: true,
  });
  if (profileError) {
    return { ok: false, error: profileError.code === "42501" ? profileError.message : "ساخت پروفایل ناموفق بود" };
  }

  return { ok: true, role: "owner", stylistId: null };
}

/**
 * Stylist self-registration: creates the auth user, the stylists row, and the
 * users row that ties them together with role='stylist'.
 */
export async function registerStylist({ phone, password, name, gender, stylistId }) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "OFFLINE" };

  // Sign up FIRST: an anonymous visitor can't read stylists' phone numbers
  // (v2.32), and the normal case is a stylist the manager already added
  // from the panel — that profile must be linked, not rejected as
  // "already registered" (which left them with no way to get an account).
  const { data, error } = await supabase.auth.signUp({
    email: phoneToEmail(phone),
    password,
  });
  if (error) return { ok: false, error: translateAuthError(error.message) };

  const userId = data.user?.id;
  if (!userId) return { ok: false, error: "ثبت‌نام ناموفق بود — دوباره تلاش کنید" };

  if (!data.session) {
    return {
      ok: false,
      error: "تنظیمات Supabase نیاز به تایید ایمیل دارد — در Authentication → Providers → Email گزینهٔ «Confirm email» را خاموش کنید، سپس دوباره وارد شوید (نیازی به ثبت‌نام مجدد نیست)",
    };
  }

  // Now signed in: is there already a stylist profile with this number?
  const { data: existing } = await supabase
    .from("stylists")
    .select("id, name")
    .eq("phone", phone)
    .maybeSingle();

  let linkedId = existing?.id;
  let displayName = existing?.name || name;
  if (!existing) {
    // SECURITY: no `password` field here — the stylists table doesn't store one
    // (dropped in the earlier security pass). Real credentials live only in
    // Supabase Auth via the signUp() call above.
    const { error: stylistError } = await supabase.from("stylists").insert({
      id: stylistId,
      name,
      gender,
      phone,
      active: true,
      reminder_hours_before: 3,
    });
    if (stylistError) {
      await supabase.auth.signOut();
      return { ok: false, error: "ساخت پروفایل آرایشگر ناموفق بود" };
    }
    linkedId = stylistId;
    displayName = name;
  }

  // The database checks this link (v2.33): same salon, same phone, and not
  // already tied to another account.
  const { error: userError } = await supabase.from("users").insert({
    id: userId,
    phone,
    full_name: displayName,
    role: "stylist",
    stylist_id: linkedId,
    active: true,
  });
  if (userError) {
    await supabase.auth.signOut();
    return { ok: false, error: "این شماره قبلاً به حساب دیگری وصل شده — وارد شوید یا با مدیر سالن تماس بگیرید" };
  }

  // v2.35: a self-registered stylist waits for the manager's approval.
  const profile = await loadProfile(userId);
  if (profile && !profile.active) {
    await supabase.auth.signOut();
    return { ok: false, pending: true, error: PENDING_APPROVAL_MSG };
  }

  return { ok: true, role: "stylist", stylistId: linkedId };
}

function translateAuthError(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("already registered") || m.includes("already been registered"))
    return "این شماره قبلاً ثبت شده — وارد شوید";
  if (m.includes("password")) return "رمز عبور باید حداقل ۶ کاراکتر باشد";
  if (m.includes("rate limit")) return "تعداد تلاش‌ها زیاد بود — کمی بعد دوباره امتحان کنید";
  return "ثبت‌نام ناموفق بود — دوباره تلاش کنید";
}

/* ------------------------------------------------ v2.41: platform admin -- */
/** Sign in on /admin. Platform admins usually have no salon profile, so this
 *  skips signIn()'s profile handling and only checks platform_admins. */
export async function signInPlatformAdmin(phone, password) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { error } = await supabase.auth.signInWithPassword({ email: phoneToEmail(phone), password });
  if (error) return { ok: false, error: "شماره یا رمز عبور اشتباه است" };
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) {
    await supabase.auth.signOut();
    return { ok: false, error: "این حساب مدیر کل نیست", notAdmin: true };
  }
  return { ok: true };
}

/** Creates the login for a would-be platform admin; access is granted
 *  separately with one SQL line (see INSTALL.md) — never from the browser. */
export async function registerPlatformAdmin(phone, password) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "دمو — دیتابیس متصل نیست" };
  const { error } = await supabase.auth.signUp({ email: phoneToEmail(phone), password });
  if (error) return { ok: false, error: translateAuthError(error.message) };
  await supabase.auth.signOut();
  return { ok: true, email: phoneToEmail(phone) };
}
