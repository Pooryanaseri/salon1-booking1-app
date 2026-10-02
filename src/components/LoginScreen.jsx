import { useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import { SUPABASE_ENABLED } from "../lib/supabase";
import { signIn, registerOwner as authRegisterOwner, registerStylist as authRegisterStylist } from "../lib/auth";
import { toFa, normalizeMobile } from "../lib/format";
import { SECTION_META, STAFF_PHONE, makeSeedStylist } from "../app/shared";

/* ============================================================
   Login screen (staff — phone + OTP, demo only)
   ============================================================ */
export function LoginScreen({ stylists, addStylist, ownerAccount, registerOwner, notify, onSuccess }) {
  const [mode, setMode] = useState("stylist"); // "stylist" | "owner"

  return (
    <div className="fade-in" style={{ paddingTop: 24, textAlign: "center" }}>
      <div
        style={{
          width: 56, height: 56, borderRadius: "50%", background: "var(--color-accent-100)",
          display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
        }}
      >
        <Lock size={24} color="var(--color-accent-700)" />
      </div>
      <h2 style={{ fontSize: 18 }}>ورود پرسنل سالن</h2>

      <div className="flex gap-1 mx-auto mt-4 mb-2" style={{ width: "fit-content", background: "var(--color-surface-raised)", padding: 3, borderRadius: "var(--radius-md)" }}>
        {[{ v: "stylist", l: "ورود آرایشگر" }, { v: "owner", l: "ورود مدیر سالن" }].map((o) => (
          <button
            key={o.v}
            onClick={() => setMode(o.v)}
            className="tap"
            style={{
              padding: "6px 12px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 700,
              background: mode === o.v ? "var(--color-surface)" : "transparent",
              color: mode === o.v ? "var(--color-heading)" : "var(--color-muted)",
            }}
          >
            {o.l}
          </button>
        ))}
      </div>

      {mode === "owner" ? (
        <OwnerAuthPanel ownerAccount={ownerAccount} registerOwner={registerOwner} notify={notify} onSuccess={(role) => onSuccess({ role: role || "owner", stylistId: null })} />
      ) : (
        <StylistAuthPanel stylists={stylists} addStylist={addStylist} notify={notify} onSuccess={(id) => onSuccess({ role: "stylist", stylistId: id })} />
      )}
    </div>
  );
}

// Username IS the phone number, plus a password — same model as stylists. Only one
// manager account exists per salon (single-tenant demo), so registration is only
// offered while no account has been created yet.
export function OwnerAuthPanel({ ownerAccount, registerOwner, notify, onSuccess }) {
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const phoneValid = /^09\d{9}$/.test(phone);

  // Real auth against Supabase. When Supabase isn't configured we fall back to
  // the original in-memory credential check so the demo still works offline.
  async function handleLogin() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await signIn(phone, password, "owner");
      setBusy(false);
      if (!res.ok) { setError(res.error || "ورود ناموفق بود"); return; }
      if (res.role === "stylist") { setError("این حساب آرایشگر است — از تب «ورود آرایشگر» وارد شوید"); return; }
      onSuccess(res.role);
      return;
    }
    setBusy(false);
    if (!ownerAccount || ownerAccount.phone !== phone || ownerAccount.password !== password) {
      setError("شماره موبایل یا رمز عبور اشتباه است");
      return;
    }
    onSuccess("owner");
  }

  async function handleRegister() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await authRegisterOwner(phone, password);
      setBusy(false);
      if (!res.ok) { setError(res.error || "ثبت‌نام ناموفق بود"); return; }
      notify("ثبت‌نام مدیر سالن با موفقیت انجام شد");
      onSuccess(res.role);
      return;
    }
    setBusy(false);
    if (ownerAccount) { setError("برای این سالن قبلاً یک مدیر ثبت‌نام کرده — وارد شوید"); return; }
    registerOwner(phone, password);
    onSuccess("owner");
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 16 }}>
        {authMode === "login" ? "با شماره موبایل و رمز عبور خود وارد شوید" : "برای ساخت حساب مدیریتی سالن ثبت‌نام کنید"}
      </p>

      <div className="flex flex-col gap-3">
        <input
          dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone}
          onChange={(e) => { setPhone(normalizeMobile(e.target.value)); setError(""); }}
          placeholder="09xxxxxxxxx (نام کاربری)" className="tabular" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
        <input
          type="password" value={password}
          autoComplete={authMode === "login" ? "current-password" : "new-password"}
          aria-label="رمز عبور"
          enterKeyHint="go"
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || busy || !phoneValid || password.trim().length < 4) return;
            (authMode === "login" ? handleLogin : handleRegister)();
          }}
          placeholder="رمز عبور" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
      </div>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <button
        disabled={busy || !phoneValid || password.trim().length < 4}
        onClick={authMode === "login" ? handleLogin : handleRegister}
        className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
        style={{ padding: 13 }}
      >
        {busy && <Loader2 size={14} className="salon-spin" />}
        {authMode === "login" ? "ورود" : "ثبت‌نام و ورود"}
      </button>

      <button
        className="muted mt-3"
        style={{ fontSize: 12.5 }}
        onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}
      >
        {authMode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "قبلاً ثبت‌نام کرده‌اید؟ وارد شوید"}
      </button>

      {authMode === "login" && !SUPABASE_ENABLED && (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
          برای دمو از شماره <span className="tabular" dir="ltr">{toFa(STAFF_PHONE)}</span> و رمز <span className="tabular">{toFa("1234")}</span> استفاده کنید
        </p>
      )}
    </div>
  );
}

export function StylistAuthPanel({ stylists, addStylist, notify, onSuccess }) {
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  // Registration fields
  const [name, setName] = useState("");
  const [gender, setGender] = useState("female");

  const [busy, setBusy] = useState(false);
  const phoneValid = /^09\d{9}$/.test(phone);

  async function handleLogin() {
    setBusy(true); setError("");
    if (SUPABASE_ENABLED) {
      const res = await signIn(phone, password, "stylist");
      setBusy(false);
      if (!res.ok) { setError(res.error || "ورود ناموفق بود"); return; }
      if (res.role !== "stylist") { setError("این حساب مدیر است — از تب «ورود مدیر سالن» وارد شوید"); return; }
      onSuccess(res.stylistId);
      return;
    }
    setBusy(false);
    const match = stylists.find((s) => s.phone === phone && s.password === password);
    if (!match) { setError("شماره موبایل یا رمز عبور اشتباه است"); return; }
    if (!match.active) { setError("حساب شما غیرفعال شده — با مدیر سالن تماس بگیرید"); return; }
    onSuccess(match.id);
  }

  async function handleRegister() {
    setBusy(true); setError("");
    const s = makeSeedStylist({ name: name.trim(), gender, phone, password, active: true });

    if (SUPABASE_ENABLED) {
      const res = await authRegisterStylist({ phone, password, name: name.trim(), gender, stylistId: s.id });
      setBusy(false);
      if (res.pending) { notify(res.error); setAuthMode("login"); setPassword(""); return; }
      if (!res.ok) { setError(res.error || "ثبت‌نام ناموفق بود"); return; }
      notify("ثبت‌نام با موفقیت انجام شد");
      onSuccess(res.stylistId);
      return;
    }
    setBusy(false);
    if (stylists.some((x) => x.phone === phone)) { setError("این شماره قبلاً ثبت شده — وارد شوید"); return; }
    addStylist(s);
    notify("ثبت‌نام با موفقیت انجام شد");
    onSuccess(s.id);
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 16 }}>
        {authMode === "login" ? "با شماره موبایل و رمز عبور خود وارد شوید" : "برای ساخت پنل شخصی خودتان ثبت‌نام کنید"}
      </p>

      {authMode === "register" && (
        <div className="flex flex-col gap-3 fade-in" style={{ marginBottom: 12 }}>
          <div>
            <label className="muted" style={{ fontSize: 12 }}>بخش</label>
            <div className="flex gap-2 mt-1">
              {["female", "male"].map((g) => {
                const meta = SECTION_META[g];
                const Icon = meta.Icon;
                return (
                  <button
                    key={g}
                    onClick={() => setGender(g)}
                    className="tap flex-1 flex items-center justify-center gap-1.5"
                    style={{
                      padding: 10, borderRadius: "var(--radius-md)", fontSize: 13, fontWeight: 700,
                      border: `1px solid ${gender === g ? meta.color : "var(--color-border)"}`,
                      background: gender === g ? meta.tint : "var(--color-surface)",
                      color: gender === g ? meta.color : "var(--color-body)",
                    }}
                  >
                    <Icon size={14} /> {meta.short}
                  </button>
                );
              })}
            </div>
          </div>
          <input
            value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
            placeholder="نام و نام‌خانوادگی" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "right" }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <input
          dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone}
          onChange={(e) => { setPhone(normalizeMobile(e.target.value)); setError(""); }}
          placeholder="09xxxxxxxxx" className="tabular" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
        <input
          type="password" value={password}
          autoComplete={authMode === "login" ? "current-password" : "new-password"}
          aria-label="رمز عبور"
          enterKeyHint="go"
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || busy || !phoneValid || password.trim().length < 4 || (authMode === "register" && !name.trim())) return;
            (authMode === "login" ? handleLogin : handleRegister)();
          }}
          placeholder="رمز عبور" style={{ width: "100%", padding: "12px 14px", fontSize: 14, textAlign: "center" }}
        />
      </div>

      {error && <p style={{ color: "var(--color-danger)", fontSize: 12.5, marginTop: 8 }}>{error}</p>}

      <button
        disabled={busy || !phoneValid || password.trim().length < 4 || (authMode === "register" && !name.trim())}
        onClick={authMode === "login" ? handleLogin : handleRegister}
        className="tap accent-btn w-full mt-4 flex items-center justify-center gap-1.5"
        style={{ padding: 13 }}
      >
        {busy && <Loader2 size={14} className="salon-spin" />}
        {authMode === "login" ? "ورود" : "ثبت‌نام و ورود"}
      </button>

      <button
        className="muted mt-3"
        style={{ fontSize: 12.5 }}
        onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); }}
      >
        {authMode === "login" ? "حساب ندارید؟ ثبت‌نام کنید" : "قبلاً ثبت‌نام کرده‌اید؟ وارد شوید"}
      </button>
    </div>
  );
}
