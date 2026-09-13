// ============================================================================
//  Auth — phone + password on the surface, Supabase Auth underneath.
//  The three roles (owner / manager / stylist) are unchanged; they live in
//  public.users.role and are also enforced by RLS in Postgres.
// ============================================================================
import { supabase, SUPABASE_ENABLED, phoneToEmail } from "./supabase";

const OWNER_BOOTSTRAP_PHONE = import.meta.env.VITE_OWNER_PHONE || "09120000000";

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
    return { ok: false, error: "حساب شما غیرفعال شده — با مدیر سالن تماس بگیرید" };
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
 * Owner self-registration — only allowed while no owner exists (single-tenant,
 * same rule the app already enforced in OwnerAuthPanel).
 */
export async function registerOwner(phone, password) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "OFFLINE" };

  const { count } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .in("role", ["owner", "manager"]);
  if (count && count > 0) {
    return { ok: false, error: "برای این سالن قبلاً یک مدیر ثبت‌نام کرده — وارد شوید" };
  }

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
  if (profileError) return { ok: false, error: "ساخت پروفایل ناموفق بود" };

  return { ok: true, role: "owner", stylistId: null };
}

/**
 * Stylist self-registration: creates the auth user, the stylists row, and the
 * users row that ties them together with role='stylist'.
 */
export async function registerStylist({ phone, password, name, gender, stylistId }) {
  if (!SUPABASE_ENABLED) return { ok: false, error: "OFFLINE" };

  const { data: existing } = await supabase
    .from("stylists")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (existing) return { ok: false, error: "این شماره قبلاً ثبت شده — وارد شوید" };

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
  if (stylistError) return { ok: false, error: "ساخت پروفایل آرایشگر ناموفق بود" };

  await supabase.from("users").insert({
    id: userId,
    phone,
    full_name: name,
    role: "stylist",
    stylist_id: stylistId,
    active: true,
  });

  return { ok: true, role: "stylist", stylistId };
}

function translateAuthError(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("already registered") || m.includes("already been registered"))
    return "این شماره قبلاً ثبت شده — وارد شوید";
  if (m.includes("password")) return "رمز عبور باید حداقل ۶ کاراکتر باشد";
  if (m.includes("rate limit")) return "تعداد تلاش‌ها زیاد بود — کمی بعد دوباره امتحان کنید";
  return "ثبت‌نام ناموفق بود — دوباره تلاش کنید";
}
