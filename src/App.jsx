import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Sparkles, PawPrint, Sun, Moon, Loader2, AlertTriangle, CalendarPlus, LayoutDashboard, ShieldCheck, ShoppingBag } from "lucide-react";
import { SUPABASE_ENABLED } from "./lib/supabase";
import { getSalonName, isPetSalon } from "./lib/tenant";
import { bootstrap, subscribeAppointments, fetchStaffData, createPublicBooking, fetchPublicSlots, subscribeSlotChanges, broadcastSlotChange, insertOne, updateOne, deleteOne, fetchSmsTemplates, fetchAutomationSettings, fetchDepositTerms, joinWaitlist, DEFAULT_AUTOMATION } from "./lib/api";
import { signOut as authSignOut, restoreSession } from "./lib/auth";
import { sendSms, scheduleReminder, renderTemplate } from "./lib/sms";
import { jalaliLabel, formatClock, dateKey, parseDateKey } from "./lib/format";
import { TOKENS_CSS } from "./styles/tokens";
import { BookingFlow } from "./booking/BookingFlow";
import { FALLBACK_SMS_TEMPLATES, GENDER_TYPE_LABEL, KNOWN_CUSTOMER, SALON_GENDER_TYPE, SEED_PET_SERVICES, SEED_PET_STYLISTS, SEED_SERVICES, SEED_STYLISTS, SEED_WORKING_HOURS, STAFF_PHONE, makeSeedBooking, makeSeedExpense, persistApproved, persistSalonHours, persistServices, persistStaffHours, persistTimeOff, usePersistedState } from "./app/shared";
import { Toast } from "./components/ui";
import { fetchShop } from "./lib/shop";
import { requestPetTransport } from "./lib/petcare";
import { applyBookingCoupon } from "./lib/business";
import { applyOffpeak, applyUpsell, setBookingSource, currentSource, captureSource } from "./lib/growth";
import { applyStylistPrice, fetchStylistPrices } from "./lib/contracts";

// Loaded on demand: a customer booking a slot never downloads the panel.
const LoginScreen = lazy(() => import("./components/LoginScreen").then((m) => ({ default: m.LoginScreen })));
const PanelView = lazy(() => import("./panel/PanelView").then((m) => ({ default: m.PanelView })));
const TrackView = lazy(() => import("./track/TrackView").then((m) => ({ default: m.TrackView })));
const ShopView = lazy(() => import("./shop/ShopView").then((m) => ({ default: m.ShopView })));

captureSource(); // v2.53: ?src=instagram on the link the client came from

/* ============================================================
   Main App
   ============================================================ */
export default function App() {
  // Remembers the visitor's own choice; on a first visit, follows the
  // device's light/dark setting instead of always starting light.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("salon:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* storage blocked — fall through */ }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    try { localStorage.setItem("salon:theme", theme); } catch { /* ignore */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#1c1714" : "#c2703a");
    // Match the page behind the app (overscroll, short pages) to the theme.
    document.documentElement.style.colorScheme = theme;
    document.body.style.background = theme === "dark" ? "#0f0b08" : "#f5f2ee";
  }, [theme]);
  // ?tab=shop (e.g. from a visit report's product picks) opens that tab
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get("tab") === "shop" ? "shop" : "book")); // book | shop | track | panel
  // Phone carried over from a just-finished booking, so "پیگیری نوبت" opens
  // the dashboard with the number already filled in.
  const [trackPhone, setTrackPhone] = useState("");
  function switchTab(id) {
    setTab(id);
    setActiveSection(null);
    window.scrollTo({ top: 0 });
  }
  const [toast, setToast] = useState("");
  const [panelAuthed, setPanelAuthed] = useState(false);
  const [currentStylistId, setCurrentStylistId] = useState(null); // null = salon owner/manager
  // NEW: the authenticated role, resolved from public.users.role at login.
  // The RBAC model itself is untouched — owner/manager/stylist, same as before.
  const [currentRole, setCurrentRole] = useState(null); // 'owner' | 'manager' | 'stylist' | null
  // Which section (زنانه/مردانه) the customer has committed to inside the current
  // booking flow — used to make the header reflect just that section instead of
  // always advertising "both" once they're actually inside one of them.
  const [activeSection, setActiveSection] = useState(null);
  // Kept only as the offline/demo fallback credential. When Supabase is
  // configured, auth is real and this is never consulted.
  const [ownerAccount, setOwnerAccount] = useState({ phone: STAFF_PHONE, password: "1234" });

  // ---- backend status -------------------------------------------------------
  const [dataReady, setDataReady] = useState(false);
  const [backendNote, setBackendNote] = useState("");

  // ---- collections wired to Postgres (setter contract unchanged) ------------
  // v2.44: the demo seeds match the salon type (real salons load their own data).
  const petSalon = isPetSalon();
  const [services, setServices, servicesCtl] = usePersistedState(petSalon ? SEED_PET_SERVICES : SEED_SERVICES, persistServices);
  const [stylists, setStylists] = useState(petSalon ? SEED_PET_STYLISTS : SEED_STYLISTS);
  const [workingHours, setWorkingHours, hoursCtl] = usePersistedState(SEED_WORKING_HOURS, persistSalonHours);
  const [staffWorkingHours, setStaffWorkingHours, staffHoursCtl] = usePersistedState({}, persistStaffHours);
  const [timeOff, setTimeOff, timeOffCtl] = usePersistedState([], persistTimeOff);
  // A day only accepts new customer bookings once the stylist has explicitly opened it —
  // by day, by week, or by month (all of which just add date keys to this same flat set).
  const [approvedDates, setApprovedDates, approvedCtl] = usePersistedState(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const arr = [];
    for (let i = 0; i < DEFAULT_AUTOMATION.booking_window_days; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      arr.push(dateKey(d));
    }
    return arr;
  }, persistApproved);

  const [bookings, setBookings] = useState(() => {
    const t = new Date();
    if (petSalon) {
      return [
        makeSeedBooking({
          customer_name: "الهام رضایی", customer_phone: "09351112233", customer_gender: "dog", pet_name: "پاپی", pet_size: "large",
          service_id: "pd3", staff_id: "st1", staff_name: "سمیرا نادری", date: dateKey(t), start_min: 10 * 60, end_min: 11 * 60 + 30,
          status: "confirmed", original_price: 1800000, final_price: 1800000,
        }),
        makeSeedBooking({
          customer_name: "سارا محمدی", customer_phone: KNOWN_CUSTOMER.phone, customer_gender: "cat", pet_name: "ملوس", pet_size: "small",
          service_id: "pc3", staff_id: "st1", staff_name: "سمیرا نادری", date: dateKey(t), start_min: 13 * 60, end_min: 14 * 60,
          status: "completed", original_price: 800000, final_price: 1150000,
          extra_charges: [{ label: "گره‌زدایی (هر نیم ساعت) × ۱", amount: 350000 }],
        }),
        makeSeedBooking({
          customer_name: "آرش نوری", customer_phone: "09190002233", customer_gender: "dog", pet_name: "راکی", pet_size: "medium",
          service_id: "pd4", staff_id: "st2", staff_name: "کاوه رحیمی", date: dateKey(t), start_min: 15 * 60, end_min: 16 * 60 + 15,
          status: "pending", original_price: 900000, final_price: 900000,
        }),
      ];
    }
    return [
      makeSeedBooking({
        customer_name: "الهام رضایی", customer_phone: "09351112233", customer_gender: "female",
        service_id: "f2", date: dateKey(t), start_min: 11 * 60, end_min: 13 * 60,
        status: "confirmed", original_price: 950000, final_price: 950000,
      }),
      makeSeedBooking({
        customer_name: "نگار احمدی", customer_phone: "09121112233", customer_gender: "female",
        service_id: "f7", date: dateKey(t), start_min: 14 * 60, end_min: 14 * 60 + 45,
        status: "pending", original_price: 350000, final_price: 350000,
      }),
      makeSeedBooking({
        customer_name: "سارا محمدی", customer_phone: KNOWN_CUSTOMER.phone, customer_gender: "female",
        service_id: "f1", date: dateKey(t), start_min: 9 * 60, end_min: 9 * 60 + 45,
        status: "completed", original_price: 250000, final_price: 250000,
      }),
      makeSeedBooking({
        customer_name: "کیان تهرانی", customer_phone: "09190001122", customer_gender: "male",
        service_id: "m2", date: dateKey(t), start_min: 16 * 60, end_min: 16 * 60 + 20,
        status: "no_show", original_price: 120000, final_price: 120000,
      }),
      makeSeedBooking({
        customer_name: "آرش نوری", customer_phone: "09190002233", customer_gender: "male",
        service_id: "m1", date: dateKey(t), start_min: 17 * 60, end_min: 17 * 60 + 30,
        status: "confirmed", original_price: 180000, final_price: 160000, discount_type: "fixed", discount_value: 20000, discount_reason: "تخفیف افتتاحیه",
      }),
    ];
  });

  const [expenses, setExpenses] = useState(() => {
    const t = new Date();
    const daysAgo = (n) => {
      const d = new Date(t);
      d.setDate(d.getDate() - n);
      return dateKey(d);
    };
    return [
      makeSeedExpense({ title: "اجارهٔ ماهانهٔ سالن", category: "rent", amount: 45000000, date: daysAgo(5) }),
      makeSeedExpense({ title: "خرید مواد رنگ مو و مراقبتی", category: "supplies", amount: 3200000, date: daysAgo(2) }),
      makeSeedExpense({ title: "حقوق دستیار سالن", category: "salary", amount: 12000000, date: daysAgo(1) }),
      makeSeedExpense({ title: "تبلیغات اینستاگرام", category: "marketing", amount: 1500000, date: daysAgo(3) }),
      makeSeedExpense({ title: "قبض برق و آب", category: "utilities", amount: 950000, date: daysAgo(6) }),
    ];
  });

  // Waitlist: when a customer's desired day is fully booked, they can leave their
  // phone number instead — staff see the list per-day and reach out if a slot opens up.
  const [waitlist, setWaitlist] = useState([]);

  // SMS templates, loaded from public.sms_templates (falls back to the constants).
  const [smsTemplates, setSmsTemplates] = useState([]);

  // v2.28 per-salon automation switches (auto-confirm, rolling booking
  // window, morning digests). Demo mode runs with the defaults.
  // the demo pet salon shows the v2.46 quote flow (real salons load their setting)
  const [automation, setAutomation] = useState(() => (!SUPABASE_ENABLED && isPetSalon() ? { ...DEFAULT_AUTOMATION, pet_quote_mode: "all" } : DEFAULT_AUTOMATION));
  // v2.37 online deposit terms ({enabled, percent, min_price}); off in demo.
  const [depositTerms, setDepositTerms] = useState({ enabled: false, percent: 0, min_price: 0 });
  // v2.48: the shop tab shows only when the salon switched its shop on.
  const [shopEnabled, setShopEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchShop().then((s) => { if (!cancelled) setShopEnabled(!!s?.enabled); });
    return () => { cancelled = true; };
  }, []);
  const automationRef = useRef(automation);
  useEffect(() => { automationRef.current = automation; }, [automation]);

  /* --------------------------------------------------------------- live refs */
  // Read-your-writes without stale closures, and without touching child props.
  const bookingsRef = useRef(bookings);
  const stylistsRef = useRef(stylists);
  const servicesRef = useRef(services);
  const templatesRef = useRef(smsTemplates);
  useEffect(() => { bookingsRef.current = bookings; }, [bookings]);
  useEffect(() => { stylistsRef.current = stylists; }, [stylists]);
  useEffect(() => { servicesRef.current = services; }, [services]);
  useEffect(() => { templatesRef.current = smsTemplates; }, [smsTemplates]);

  /* Fonts are bundled with the app (imported in main.jsx, served from this
     origin and cached by the service worker) — no third-party font CDN. */

  /* ------------------------------------------------------------- BOOTSTRAP */
  // One parallel load of every table, then arm the write path. Until this
  // resolves the app shows its seed data, so first paint is never blank.
  useEffect(() => {
    let cancelled = false;

    function armAll() {
      servicesCtl.arm(true); hoursCtl.arm(true); staffHoursCtl.arm(true);
      timeOffCtl.arm(true); approvedCtl.arm(true);
    }

    (async () => {
      if (!SUPABASE_ENABLED) {
        setBackendNote("حالت دمو — دیتابیس متصل نیست، داده‌ها ذخیره نمی‌شوند");
        armAll();
        setDataReady(true);
        return;
      }

      const [session, data, templates, automationSettings, deposit] = await Promise.all([
        restoreSession(),
        bootstrap(),
        fetchSmsTemplates(),
        fetchAutomationSettings(),
        fetchDepositTerms(),
      ]);
      if (cancelled) return;

      if (!data) {
        setBackendNote("اتصال به دیتابیس برقرار نشد — نمایش داده‌های نمونه");
        armAll();
        setDataReady(true);
        return;
      }

      if (data.services.length) servicesCtl.hydrate(data.services);
      if (data.stylists.length) setStylists(data.stylists);
      if (data.workingHours) hoursCtl.hydrate(data.workingHours);
      staffHoursCtl.hydrate(data.staffWorkingHours || {});
      timeOffCtl.hydrate(data.timeOff || []);
      if (data.approvedDates.length) approvedCtl.hydrate(data.approvedDates);
      setBookings(data.bookings || []);
      setExpenses(data.expenses || []);
      setWaitlist(data.waitlist || []);
      setSmsTemplates(templates || []);
      setAutomation(automationSettings);
      setDepositTerms(deposit);

      if (session) {
        setPanelAuthed(true);
        setCurrentRole(session.role);
        setCurrentStylistId(session.stylistId ?? null);
        // bootstrap() only loaded the public data (safe for the anonymous
        // booking flow) — staff need the real dataset, RLS-scoped to their role.
        loadStaffData(() => cancelled);
      }

      armAll();
      setDataReady(true);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------------------- REALTIME */
  // Another device books → this calendar updates without a refresh.
  useEffect(() => {
    if (!SUPABASE_ENABLED) return;
    return subscribeAppointments(({ type, row, oldId }) => {
      setBookings((prev) => {
        if (type === "DELETE") return prev.filter((b) => b.id !== oldId);
        if (!row) return prev;
        return prev.some((b) => b.id === row.id)
          ? prev.map((b) => (b.id === row.id ? row : b))
          : [...prev, row];
      });
    });
  }, []);

  // v2.18 — anonymous visitors lost live updates when appointments' RLS was
  // scoped to staff only (v2.16); postgres_changes above now delivers
  // nothing to them. This broadcast-based signal replaces it: no row
  // content crosses the wire, just a ping to re-fetch the PII-free slots
  // view. Scoped to !panelAuthed only — a staff session already has full
  // row updates above, and merging slot-only data into it would strip
  // customer fields from what's already loaded.
  useEffect(() => {
    if (!SUPABASE_ENABLED || panelAuthed) return;
    return subscribeSlotChanges(async () => {
      // An empty list is a real answer (e.g. the last upcoming booking was
      // cancelled); only a failed fetch keeps the current slots.
      const slots = await fetchPublicSlots();
      if (slots) setBookings(slots);
    });
  }, [panelAuthed]);

  // Any failed save to the server (see failWrite in lib/api.js) — the screen
  // already shows the change, so say plainly that it didn't stick.
  useEffect(() => {
    const onSaveError = () => notify("ذخیره روی سرور ناموفق بود — اتصال را بررسی کنید و دوباره امتحان کنید");
    window.addEventListener("salon:save-error", onSaveError);
    return () => window.removeEventListener("salon:save-error", onSaveError);
  }, []);

  // Full staff dataset after a restored session or a fresh login.
  async function loadStaffData(isCancelled = () => false) {
    const d = await fetchStaffData();
    if (!d || isCancelled()) return;
    if (d.bookings) setBookings(d.bookings);
    if (d.stylists && d.stylists.length) setStylists(d.stylists);
    if (d.expenses) setExpenses(d.expenses);
    if (d.waitlist) setWaitlist(d.waitlist);
  }

  function notify(msg) {
    setToast(msg);
  }

  /* ============================================================
     SMS dispatch — centralised here on purpose. Every booking
     mutation in the app already funnels through addBooking /
     updateBooking, so wiring SMS at this one point covers the
     customer flow, the staff panel and the tracking tab at once.
     ============================================================ */
  function templateBody(kind) {
    const row = (templatesRef.current || []).find((t) => t.kind === kind && t.is_default)
      || (templatesRef.current || []).find((t) => t.kind === kind);
    return (row && row.body) || FALLBACK_SMS_TEMPLATES[kind] || "";
  }

  function bookingSmsVars(b) {
    const svc = (servicesRef.current || []).find((s) => s.id === b.service_id);
    return {
      name: b.customer_name || "مشتری",
      service: svc ? svc.name : "خدمت",
      date: jalaliLabel(parseDateKey(b.date), { withWeekday: false }),
      time: formatClock(b.start_min),
      stylist: b.staff_name || "بدون آرایشگر مشخص",
      code: b.tracking_code || "",
      pet: b.pet_name || (b.customer_gender === "cat" ? "گربهٔ شما" : b.customer_gender === "dog" ? "سگ شما" : ""), // v2.44
      link: `${window.location.origin}/feedback/${b.id}`,
    };
  }

  async function sendBookingSms(booking, kind) {
    if (!/^09\d{9}$/.test(booking.customer_phone || "")) return;
    const body = renderTemplate(templateBody(kind), bookingSmsVars(booking));
    if (!body.trim()) return;
    await sendSms({ to: booking.customer_phone, body, kind, appointmentId: booking.id });
  }

  // v2.31: the confirmation, the stylist's "new booking" SMS and the
  // reminder are queued by the database itself for every booking path (see
  // supabase/migrations/v2.31_server_owned_booking_sms.sql) — the browser no
  // longer sends or schedules them.

  // v2.18 — a second, softer nudge 24h after the first feedback request,
  // in case the customer missed it or hasn't gotten to it yet. Cancelled
  // automatically if they submit before it fires (see FeedbackPage.jsx,
  // which calls cancelScheduledReminders on successful submit) — this
  // reuses the exact same queue/cancel mechanism as booking reminders, no
  // new infrastructure.
  async function queueFeedbackFollowup(booking) {
    if (!SUPABASE_ENABLED) return;
    if (!/^09\d{9}$/.test(booking.customer_phone || "")) return;
    await scheduleReminder({
      to: booking.customer_phone,
      body: renderTemplate(templateBody("feedback_followup"), bookingSmsVars(booking)),
      appointmentId: booking.id,
      scheduledFor: new Date(Date.now() + 24 * 3600000).toISOString(),
      kind: "feedback_followup",
    });
  }

  /* ------------------------------------------------------------- mutations */
  async function addBooking(params, onInserted) {
    const finalStaff = stylists.find((s) => s.id === params.staffId) || null;
    // Mirrors the server's auto-confirm trigger (v2.28) so the local copy
    // matches what was actually stored.
    const newBookingStatus = automationRef.current.auto_confirm_bookings ? "confirmed" : "pending";
    let booking;

    if (SUPABASE_ENABLED) {
      const res = await createPublicBooking({
        serviceId: params.serviceId, staffId: params.staffId, date: params.date, startMin: params.startMin,
        customerName: params.customerName, customerPhone: params.customerPhone, customerGender: params.customerGender,
        referralCode: params.referralCode, pet: params.pet || null,
      });
      if (!res.ok) { notify(res.error || "ثبت نوبت روی سرور ناموفق بود"); return null; }
      booking = makeSeedBooking({
        id: res.id,
        customer_name: params.customerName, customer_phone: params.customerPhone, customer_gender: params.customerGender,
        service_id: params.serviceId, staff_id: params.staffId, staff_name: res.staff_name || (finalStaff ? finalStaff.name : ""),
        date: params.date, start_min: params.startMin, end_min: params.endMin, buffer_minutes: params.bufferMinutes,
        // v2.37: the server reports what it actually stored (confirmed /
        // pending / awaiting_payment when an online deposit applies).
        status: res.status || newBookingStatus, deposit_amount: res.deposit_amount ?? null,
        original_price: res.original_price, final_price: res.final_price,
        tracking_code: res.tracking_code, sms_sent_confirmation: true,
        pet_name: params.pet?.name?.trim() || null, pet_size: params.pet?.size || null,
        extra_charges: Array.isArray(res.extra_charges) ? res.extra_charges : [], // v2.45
      });
    } else {
      // Demo mode has no real backend to validate price/slot against —
      // build the booking client-side, matching this app's established
      // demo-mode pattern elsewhere (e.g. lookupPhone's KNOWN_CUSTOMER path).
      booking = makeSeedBooking({
        customer_name: params.customerName, customer_phone: params.customerPhone, customer_gender: params.customerGender,
        service_id: params.serviceId, staff_id: params.staffId, staff_name: finalStaff ? finalStaff.name : "",
        date: params.date, start_min: params.startMin, end_min: params.endMin, buffer_minutes: params.bufferMinutes,
        status: newBookingStatus, original_price: params.originalPrice, discount_type: params.discountType,
        discount_value: params.discountValue, discount_reason: params.discountReason, final_price: params.finalPrice,
        sms_sent_confirmation: true,
        pet_name: params.pet?.name?.trim() || null, pet_size: params.pet?.size || null,
        extra_charges: params.extraCharges || [],
      });
    }

    // v2.49: pick-up & drop-off, attached right after the booking exists
    if (params.transportAddress) {
      const t = await requestPetTransport(booking.id, params.customerPhone, params.transportAddress);
      if (t?.ok) {
        const fee = Number(t.fee) || 0;
        booking = { ...booking, transport_address: params.transportAddress, transport_fee: fee,
          extra_charges: fee ? [...(booking.extra_charges || []), { label: "سرویس رفت‌وبرگشت", amount: fee }] : booking.extra_charges,
          final_price: booking.final_price != null && fee ? booking.final_price + fee : booking.final_price };
      } else {
        notify(t?.error || "ثبت سرویس رفت‌وبرگشت ناموفق بود — با سالن هماهنگ کنید");
      }
    }

    // v2.55: an independent stylist's own price comes first
    if (booking.final_price != null && booking.staff_id) {
      const sp = await applyStylistPrice(booking.id, params.customerPhone, booking, await fetchStylistPrices());
      if (sp?.ok) booking = { ...booking, original_price: Number(sp.price), final_price: Number(sp.final_price) };
    }
    // v2.53: quiet-hour discount (before the add-on and the code, so neither is discounted twice)
    if (booking.final_price != null) {
      const o = await applyOffpeak(booking.id, params.customerPhone, booking);
      if (o?.ok) booking = { ...booking, offpeak_discount: Number(o.discount) || 0, final_price: o.final_price != null ? Number(o.final_price) : booking.final_price - (Number(o.discount) || 0) };
    }
    // v2.53: the add-on the client ticked on the booking page
    if (params.upsellOffer) {
      const u = await applyUpsell(booking.id, params.customerPhone, params.upsellOffer);
      if (u?.ok) {
        const amt = Number(u.amount) || 0;
        booking = { ...booking, upsell_offer_id: params.upsellOffer.id, end_min: booking.end_min + (Number(u.extra_minutes) || 0),
          extra_charges: [...(booking.extra_charges || []), { label: u.label, amount: amt }],
          final_price: booking.final_price != null ? booking.final_price + amt : booking.final_price };
      } else {
        notify(u?.error || "افزودنی اضافه نشد — در سالن هماهنگ کنید");
      }
    }

    // v2.50: a discount code, applied by the server to the fresh booking
    if (params.couponCode && booking.final_price != null) {
      // the pick-up & drop-off fee is not discounted
      const base = Math.max(0, booking.final_price - (booking.transport_fee || 0));
      const c = await applyBookingCoupon(booking.id, params.customerPhone, params.couponCode, base);
      if (c?.ok) {
        const disc = Number(c.discount) || 0;
        booking = { ...booking, coupon_code: params.couponCode.toUpperCase(), coupon_discount: disc,
          final_price: c.final_price != null ? Number(c.final_price) : Math.max(0, booking.final_price - disc) };
      } else {
        notify(c?.error || "کد تخفیف اعمال نشد");
      }
    }

    // v2.53: where this client came from (Instagram link, QR card, …)
    const src = currentSource();
    if (src) { setBookingSource(booking.id, params.customerPhone, src); booking = { ...booking, source: src }; }

    setBookings((prev) => [...prev, booking]);

    // Everything below is a side effect of an already-successful booking —
    // none of it may ever block the customer from seeing their
    // confirmation. If the SMS Edge Function isn't deployed (or any other
    // transient failure happens here), the booking is still real and
    // already in the database; only notify about it, never let it
    // propagate and stall the UI on a booking that actually succeeded.
    try {
      broadcastSlotChange();
    } catch (err) {
      console.error("[salon] slot-change broadcast failed:", err);
    }
    if (onInserted) {
      try {
        await onInserted();
      } catch (err) {
        console.error("[salon] post-booking callback failed:", err);
      }
    }
    return booking;
  }

  function updateBooking(id, patch, logMsg, opts = {}) {
    const before = (bookingsRef.current || []).find((b) => b.id === id);
    const after = before ? { ...before, ...patch } : null;

    setBookings((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    if (logMsg) notify(logMsg);
    // the server already saved this change (e.g. an RPC did it) — only mirror it here
    if (opts.localOnly) return;

    (async () => {
      const err = await updateOne("appointments", id, patch);
      if (err) { notify("ذخیره‌ی تغییر روی سرور ناموفق بود"); return; }
      if (!after || !patch.status || patch.status === before.status) return;

      // Reminders are (re)queued / dropped by the database on these status
      // changes (v2.31); only the customer-facing notice is sent from here.
      if (patch.status === "cancelled") {
        await sendBookingSms(after, "cancellation");
        broadcastSlotChange();
      } else if (patch.status === "rescheduled") {
        await sendBookingSms(after, "reschedule");
        broadcastSlotChange();
      } else if (patch.status === "reschedule_proposed") {
        // The actual date/start_min haven't moved yet — only the pending_*
        // fields carry the proposed new time, so swap those in just for
        // building this one message (bookingSmsVars reads .date/.start_min).
        await sendBookingSms({ ...after, date: after.pending_date, start_min: after.pending_start_min }, "reschedule_proposed");
      } else if (patch.status === "confirmed") {
        await sendBookingSms(after, "confirmation");
      } else if (patch.status === "completed") {
        await sendBookingSms(after, "feedback_request");
        await queueFeedbackFollowup(after);
      }
    })();
  }

  function addExpense(e) {
    setExpenses((prev) => [...prev, e]);
    insertOne("expenses", e);
    notify("هزینه ثبت شد");
  }

  function removeExpense(id) {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    deleteOne("expenses", id);
    notify("هزینه حذف شد");
  }

  // v2.41: the public page joins through join_waitlist() (validated and
  // de-duplicated server-side); visitors can't read the list, so the local
  // copy only remembers this visitor's own entries for "already joined".
  async function addWaitlistEntry(entry) {
    if (SUPABASE_ENABLED) {
      const res = await joinWaitlist({
        date: entry.date, serviceId: entry.service_id, staffId: entry.staff_id,
        name: entry.customer_name || "مشتری", phone: entry.customer_phone, gender: entry.customer_gender,
      });
      if (!res?.ok) return res;
    }
    setWaitlist((prev) => [...prev, entry]);
    return { ok: true };
  }

  function removeWaitlistEntry(id) {
    setWaitlist((prev) => prev.filter((w) => w.id !== id));
    deleteOne("waitlist", id);
  }

  function addStylist(s) {
    setStylists((prev) => [...prev, s]);
    insertOne("stylists", s);
    notify("آرایشگر اضافه شد");
  }

  function updateStylist(id, patch) {
    setStylists((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    updateOne("stylists", id, patch);
  }

  function removeStylist(id) {
    setStylists((prev) => prev.filter((s) => s.id !== id));
    deleteOne("stylists", id);
    notify("آرایشگر حذف شد");
  }

  // Offline fallback only — real registration happens in OwnerAuthPanel via Supabase Auth.
  function registerOwner(phone, password) {
    setOwnerAccount({ phone, password });
    notify("ثبت‌نام مدیر سالن با موفقیت انجام شد");
  }

  async function handleLogout() {
    await authSignOut();
    // Full reload, not just clearing auth state — bootstrap() loads
    // bookings/customers/etc. into React state, and that state must not
    // persist into a different account's session in the same tab.
    window.location.reload();
  }

  const tabs = [
    { id: "book", label: "نوبت‌دهی", Icon: CalendarPlus, color: "var(--color-tab-book)", grad: "var(--grad-tab-book)" },
    ...(shopEnabled ? [{ id: "shop", label: "فروشگاه", Icon: ShoppingBag, color: "var(--color-tab-shop)", grad: "var(--grad-tab-shop)" }] : []),
    { id: "track", label: "داشبورد من", Icon: LayoutDashboard, color: "var(--color-tab-dash)", grad: "var(--grad-tab-dash)" },
    { id: "panel", label: "پنل مدیریت", Icon: ShieldCheck, color: "var(--color-tab-panel)", grad: "var(--grad-tab-panel)" },
  ];

  return (
    <div className="salon-app" data-theme={theme} style={{ minHeight: "100dvh", paddingBottom: 24 }}>
      <style>{TOKENS_CSS}</style>

      {/* Header — sticky, blurred; tabs live here at the top */}
      <header className="header-blur safe-top" style={{ position: "sticky", top: 0, zIndex: 70, borderBottom: "1px solid var(--color-border)" }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "12px 16px" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                style={{
                  width: 34, height: 34, borderRadius: "var(--radius-md)",
                  background: "var(--grad-brand)", display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "var(--shadow-glow-accent)",
                }}
              >
                {petSalon ? <PawPrint size={17} color="white" /> : <Sparkles size={17} color="white" />}
              </div>
              <div>
                <h1 style={{ fontSize: 15, lineHeight: 1.45 }}>{getSalonName()}</h1>
                <p className="muted" style={{ fontSize: 10.5 }}>
                  رزرو آنلاین نوبت · {tab === "book" && activeSection ? GENDER_TYPE_LABEL[activeSection] : petSalon ? "آرایشگاه سگ و گربه" : GENDER_TYPE_LABEL[SALON_GENDER_TYPE]}
                </p>
              </div>
            </div>
            <button
              className="tap ghost-btn"
              style={{ width: 38, height: 38, padding: 0 }}
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              aria-label="تغییر پوسته"
            >
              {theme === "light" ? <Moon size={16} style={{ margin: "auto" }} /> : <Sun size={16} style={{ margin: "auto" }} />}
            </button>
          </div>

          {/* Tabs — one segmented bar; each tab keeps its own color identity */}
          <div className="main-tabs mt-3" role="tablist" aria-label="ناوبری اصلی">
            {tabs.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => switchTab(t.id)}
                  className="tap main-tab"
                  style={{ "--tab-color": t.color, "--tab-grad": t.grad }}
                >
                  <t.Icon size={17} strokeWidth={active ? 2.4 : 2.1} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: "0 auto", padding: "16px" }}>
        {/* Backend status — only shown when something is off, never in the happy path */}
        {backendNote && (
          <div
            className="fade-in flex items-center gap-1.5 mb-3"
            role="status"
            style={{ padding: "5px 12px", borderRadius: "var(--radius-full)", width: "fit-content", maxWidth: "100%", marginInline: "auto", background: "color-mix(in oklch, var(--color-warning) 12%, var(--color-surface))", border: "1px solid color-mix(in oklch, var(--color-warning) 35%, transparent)" }}
          >
            <AlertTriangle size={12} color="var(--color-warning)" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: 11, color: "var(--color-body)" }}>{backendNote}</p>
          </div>
        )}

        {!dataReady && (
          <div className="card fade-in flex items-center justify-center gap-2" style={{ padding: 28 }}>
            <Loader2 size={16} className="salon-spin" color="var(--color-accent-500)" />
            <p className="muted" style={{ fontSize: 12.5 }}>در حال بارگذاری اطلاعات سالن…</p>
          </div>
        )}

        {dataReady && tab === "book" && (
          <BookingFlow services={services} stylists={stylists} bookings={bookings} workingHours={workingHours} staffWorkingHours={staffWorkingHours} timeOff={timeOff} approvedDates={approvedDates} addBooking={addBooking} waitlist={waitlist} addWaitlistEntry={addWaitlistEntry} notify={notify} onSectionChange={setActiveSection} onTrack={(phone) => { setTrackPhone(phone); switchTab("track"); }} automation={automation} depositTerms={depositTerms} />
        )}
        <Suspense fallback={<div className="flex justify-center" style={{ padding: 40 }}><Loader2 size={18} className="salon-spin" color="var(--color-accent-500)" /></div>}>
        {dataReady && tab === "shop" && (
          <ShopView notify={notify} onTrack={(phone) => { setTrackPhone(phone); switchTab("track"); }} />
        )}
        {dataReady && tab === "track" && (
          <TrackView bookings={bookings} services={services} stylists={stylists} workingHours={workingHours} staffWorkingHours={staffWorkingHours} timeOff={timeOff} approvedDates={approvedDates} updateBooking={updateBooking} notify={notify} initialPhone={trackPhone} />
        )}
        {dataReady && tab === "panel" && !panelAuthed && (
          <LoginScreen
            stylists={stylists}
            addStylist={addStylist}
            ownerAccount={ownerAccount}
            registerOwner={registerOwner}
            notify={notify}
            onSuccess={({ role, stylistId }) => {
              setPanelAuthed(true);
              setCurrentRole(role);
              setCurrentStylistId(stylistId ?? null);
              loadStaffData();
            }}
          />
        )}
        {dataReady && tab === "panel" && panelAuthed && (
          <PanelView
            bookings={bookings}
            services={services}
            setServices={setServices}
            stylists={stylists}
            addStylist={addStylist}
            updateStylist={updateStylist}
            removeStylist={removeStylist}
            currentStylistId={currentStylistId}
            currentRole={currentRole}
            smsTemplates={smsTemplates}
            workingHours={workingHours}
            setWorkingHours={setWorkingHours}
            staffWorkingHours={staffWorkingHours}
            setStaffWorkingHours={setStaffWorkingHours}
            timeOff={timeOff}
            setTimeOff={setTimeOff}
            approvedDates={approvedDates}
            setApprovedDates={setApprovedDates}
            updateBooking={updateBooking}
            expenses={expenses}
            addExpense={addExpense}
            removeExpense={removeExpense}
            waitlist={waitlist}
            removeWaitlistEntry={removeWaitlistEntry}
            automation={automation}
            onReminderHoursSaved={(h) => {
              setAutomation((a) => ({ ...a, reminder_hours_before: h }));
              // the server applied it to every stylist; mirror that locally
              if (h > 0) setStylists((prev) => prev.map((s) => ({ ...s, reminder_hours_before: h })));
            }}
            onAutomationChange={(next, approvedDates) => {
              setAutomation(next);
              if (approvedDates) approvedCtl.hydrate(approvedDates);
            }}
            notify={notify}
            onShopEnabledChange={setShopEnabled}
            onLogout={handleLogout}
          />
        )}
        </Suspense>
      </main>

      <Toast message={toast} onDone={() => setToast("")} />
    </div>
  );
}
