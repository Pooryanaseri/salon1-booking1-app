// All app styling: CSS variables (light/dark), primitives and the small set of
// utility classes the JSX uses. Injected once by App as a <style> tag.
/* ============================================================
   Design tokens (from spec) — applied via CSS variables
   ============================================================ */
export const TOKENS_CSS = `
.salon-app {
  /* v2.57 "rose-gold" palette: pearl background, rose accent, berry depth */
  --color-bg: oklch(97.4% 0.007 30);
  --color-surface: oklch(100% 0 0);
  --color-surface-raised: oklch(96% 0.009 25);
  --color-border: oklch(90% 0.012 20);
  --color-muted: oklch(57% 0.016 15);
  --color-body: oklch(28% 0.018 10);
  --color-heading: oklch(18% 0.02 355);

  --color-accent-50: oklch(97.5% 0.016 25);
  --color-accent-100: oklch(94% 0.035 20);
  --color-accent-300: oklch(81% 0.09 20);
  --color-accent-500: oklch(63% 0.17 12);
  --color-accent-700: oklch(48% 0.16 5);
  --color-accent-900: oklch(30% 0.10 355);
  --color-gold: oklch(76% 0.11 70);

  --color-success: oklch(62% 0.17 150);
  --color-warning: oklch(74% 0.18 78);
  --color-danger: oklch(56% 0.22 22);
  --color-info: oklch(60% 0.17 250);

  /* Section tints — women's (rose) / men's (teal) so each area feels distinct */
  --color-female-500: oklch(64% 0.19 6);
  --color-female-100: oklch(93% 0.04 10);
  --color-male-500: oklch(54% 0.13 235);
  --color-male-100: oklch(92% 0.025 225);
  /* v2.44 pet salons — dogs (warm amber) / cats (violet) / both (green) */
  --color-dog-500: oklch(60% 0.15 60);
  --color-dog-100: oklch(93% 0.045 70);
  --color-cat-500: oklch(56% 0.17 300);
  --color-cat-100: oklch(93% 0.035 300);
  --color-pet-500: oklch(58% 0.14 160);
  --color-pet-100: oklch(93% 0.04 160);

  /* Brand + status gradients — the "reporting" surfaces (hero cards, KPI tiles,
     chart fills) lean on these instead of flat fills for a richer, more premium look. */
  --grad-brand: linear-gradient(135deg, oklch(75% 0.11 45) 0%, oklch(63% 0.17 12) 48%, oklch(47% 0.16 350) 100%);
  --grad-brand-soft: linear-gradient(135deg, oklch(96% 0.03 40), oklch(93% 0.04 10));
  --grad-success: linear-gradient(135deg, oklch(68% 0.16 155), oklch(56% 0.15 168));
  --grad-info: linear-gradient(135deg, oklch(66% 0.15 245), oklch(54% 0.19 268));
  --grad-danger: linear-gradient(135deg, oklch(64% 0.21 25), oklch(50% 0.22 8));
  --grad-warning: linear-gradient(135deg, oklch(78% 0.16 82), oklch(66% 0.19 55));
  --grad-female: linear-gradient(135deg, oklch(70% 0.16 10), oklch(58% 0.19 350));
  --grad-male: linear-gradient(135deg, oklch(60% 0.12 230), oklch(46% 0.13 250));

  /* Per-tab identity colors — each of the 3 top-level tabs gets its own hue
     instead of one flat accent + gray-for-everything-else scheme. */
  --color-tab-book: var(--color-accent-500);
  --color-tab-dash: oklch(58% 0.15 200);
  --color-tab-panel: oklch(50% 0.16 320);
  --grad-tab-book: var(--grad-brand);
  --grad-tab-dash: linear-gradient(135deg, oklch(66% 0.13 195), oklch(52% 0.15 215));
  --grad-tab-panel: linear-gradient(135deg, oklch(58% 0.14 310), oklch(42% 0.15 330));
  --color-tab-shop: oklch(56% 0.15 150);
  --grad-tab-shop: linear-gradient(135deg, oklch(64% 0.14 145), oklch(50% 0.15 160));
  --color-tab-services: oklch(58% 0.18 20);

  --shadow-sm: 0 1px 2px oklch(25% 0.03 10 / 0.04), 0 10px 24px -16px oklch(35% 0.08 10 / 0.28);
  --shadow-md: 0 8px 20px -6px oklch(25% 0.04 10 / 0.16), 0 2px 6px -2px oklch(25% 0.03 10 / 0.07);
  --shadow-lg: 0 20px 40px -12px oklch(25% 0.05 10 / 0.24), 0 4px 12px -4px oklch(25% 0.03 10 / 0.10);
  --shadow-glow-accent: 0 10px 26px -8px oklch(58% 0.17 10 / 0.55);
  --shadow-glow-success: 0 8px 24px -6px oklch(62% 0.17 150 / 0.4);
  --shadow-glow-danger: 0 8px 24px -6px oklch(56% 0.22 22 / 0.4);
  --shadow-glow-info: 0 8px 24px -6px oklch(60% 0.17 250 / 0.4);

  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --space-10: 40px; --space-12: 48px; --space-16: 64px;

  --radius-sm: 8px; --radius-md: 13px; --radius-lg: 20px; --radius-xl: 26px; --radius-full: 9999px;

  --font-sans: 'Vazirmatn Variable', 'Vazirmatn', system-ui, sans-serif;
  --font-display: 'Estedad Variable', 'Vazirmatn Variable', 'Vazirmatn', system-ui, sans-serif;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem;
  --text-lg: 1.125rem; --text-xl: 1.25rem; --text-2xl: 1.5rem; --text-3xl: 1.875rem;
  --leading-tight: 1.35; --leading-normal: 1.6; --leading-relaxed: 1.75;

  --duration-fast: 120ms; --duration-base: 200ms; --ease-standard: cubic-bezier(.4,0,.2,1);

  /* soft warm glows behind everything, so pages never look flat */
  --bg-glow-1: color-mix(in oklch, var(--color-accent-300) 30%, transparent);
  --bg-glow-2: color-mix(in oklch, var(--color-gold) 16%, transparent);
  background:
    radial-gradient(1100px 520px at 110% -8%, var(--bg-glow-1), transparent 62%),
    radial-gradient(800px 480px at -20% 18%, var(--bg-glow-2), transparent 60%),
    var(--color-bg);
  background-attachment: fixed;
  color: var(--color-body);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  direction: rtl;
  min-height: 100%;
}
.salon-app[data-theme="dark"] {
  --color-bg: oklch(14% 0.014 350);
  --color-surface: oklch(18.5% 0.016 350);
  --color-surface-raised: oklch(22.5% 0.018 350);
  --color-border: oklch(30% 0.02 350);
  --color-muted: oklch(62% 0.016 10);
  --color-body: oklch(89% 0.012 20);
  --color-heading: oklch(97% 0.008 20);
  --color-accent-500: oklch(72% 0.14 15);
  --color-accent-700: oklch(80% 0.11 18);
  /* Light tints used as backgrounds (e.g. the status banner) — without dark
     versions they stayed near-white under light text and were unreadable. */
  --color-accent-50: oklch(23% 0.035 10);
  --color-accent-100: oklch(30% 0.05 10);
  --color-female-100: oklch(27% 0.05 10);
  --color-male-100: oklch(25% 0.035 225);
  --color-dog-100: oklch(28% 0.05 65);
  --color-cat-100: oklch(27% 0.05 300);
  --color-pet-100: oklch(27% 0.045 160);
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.3), 0 8px 20px -14px oklch(0% 0 0 / 0.6);
  --bg-glow-1: color-mix(in oklch, var(--color-accent-500) 12%, transparent);
  --bg-glow-2: color-mix(in oklch, var(--color-tab-panel) 12%, transparent);
  --shadow-md: 0 6px 16px -4px oklch(0% 0 0 / 0.45);
  --shadow-lg: 0 16px 32px -8px oklch(0% 0 0 / 0.55);
}
.salon-app * { font-family: var(--font-sans); box-sizing: border-box; }
/* Button reset — without it, any button that doesn't set its own border/
   background (e.g. the "بازگشت" links) shows the browser's default gray box.
   :where() keeps specificity at zero so every class/inline style still wins. */
.salon-app :where(button) { background: none; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; }
.salon-app :where(button):disabled { cursor: not-allowed; }
.salon-app :where(button, a, [role="tab"]):focus-visible { outline: 2px solid var(--color-accent-500); outline-offset: 2px; }
/* iOS Safari zooms the whole page into any input under 16px on focus and
   never zooms back out — keep form fields at 16px on phones. */
@media (max-width: 640px) {
  .salon-app input, .salon-app select, .salon-app textarea { font-size: 16px !important; }
}
.salon-app .tabular { font-variant-numeric: tabular-nums; }
/* Primary action stays reachable at the bottom of long steps (time grid,
   forms) instead of sitting below the fold. */
.salon-app .sticky-cta {
  position: sticky; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); z-index: 20;
}
.salon-app ::selection { background: color-mix(in oklch, var(--color-accent-500) 30%, transparent); }
.salon-app .card {
  background: var(--color-surface);
  border: 1px solid color-mix(in oklch, var(--color-border) 65%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: box-shadow var(--duration-base) var(--ease-standard), transform var(--duration-base) var(--ease-standard);
}
.salon-app .card-glass {
  border-radius: var(--radius-xl);
  color: white;
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
  border: 1px solid oklch(100% 0 0 / 0.14);
}
.salon-app .card-glass::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(120% 90% at 8% -10%, oklch(100% 0 0 / 0.22), transparent 55%),
              radial-gradient(90% 70% at 100% 120%, oklch(0% 0 0 / 0.18), transparent 60%);
}
.salon-app .surface-raised { background: var(--color-surface-raised); }
.salon-app .tap {
  min-height: 44px;
  transition: transform var(--duration-fast) var(--ease-standard), background var(--duration-base) var(--ease-standard), opacity var(--duration-base) var(--ease-standard), border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard);
}
.salon-app .tap:active { transform: scale(0.97); }
.salon-app .accent-btn {
  background: var(--grad-brand);
  color: white;
  border-radius: var(--radius-md);
  font-weight: 800;
  box-shadow: var(--shadow-glow-accent), inset 0 1px 0 oklch(100% 0 0 / 0.28);
  text-shadow: 0 1px 1px oklch(30% 0.1 40 / 0.25);
}
.salon-app .accent-btn:hover { filter: brightness(1.06); }
.salon-app .accent-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.salon-app .ghost-btn {
  background: color-mix(in oklch, var(--color-surface) 70%, transparent);
  border: 1px solid var(--color-border);
  color: var(--color-body);
  border-radius: var(--radius-md);
}
.salon-app .ghost-btn:hover { border-color: var(--color-accent-500); color: var(--color-accent-700); }
.salon-app h1 { color: var(--color-heading); font-weight: 800; letter-spacing: 0; }
.salon-app h2 { color: var(--color-heading); font-weight: 700; letter-spacing: 0; line-height: 1.5; }
/* headings, card titles and big numbers get the display face (Estedad);
   body text stays Vazirmatn. Inline-styled titles use font-weight 800. */
.salon-app h1, .salon-app h2, .salon-app h3, .salon-app .font-display,
.salon-app [style*="font-weight: 800"], .salon-app .accent-btn { font-family: var(--font-display); }
.salon-app h1, .salon-app h2 { letter-spacing: -0.01em; }
.salon-app h3 { color: var(--color-heading); font-weight: 700; }
.salon-app h4 { color: var(--color-heading); font-weight: 600; }
.salon-app .muted { color: var(--color-muted); }
.salon-app .badge { border-radius: var(--radius-full); font-weight: 700; font-size: var(--text-xs); padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px; }
@media (prefers-reduced-motion: reduce) {
  .salon-app * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
.salon-app input, .salon-app select, .salon-app textarea {
  background: var(--color-surface);
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-heading);
  font-family: var(--font-sans);
  transition: border-color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard);
}
.salon-app input::placeholder, .salon-app textarea::placeholder { color: color-mix(in oklch, var(--color-muted) 75%, transparent); }
.salon-app input:focus, .salon-app select:focus, .salon-app textarea:focus {
  outline: none;
  border-color: var(--color-accent-500);
  box-shadow: 0 0 0 4px color-mix(in oklch, var(--color-accent-500) 20%, transparent);
}
.salon-app .fade-in { animation: salonFadeIn 260ms var(--ease-standard); }
@keyframes salonFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.salon-app .sheet-up { animation: salonSheetUp 320ms cubic-bezier(.2,.9,.3,1); }
@keyframes salonSheetUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
.salon-app .backdrop-in { animation: salonBackdropIn 200ms var(--ease-standard); }
@keyframes salonBackdropIn { from { opacity: 0; } to { opacity: 1; } }
.salon-app .scrollbar-none::-webkit-scrollbar { display: none; }
.salon-app .switch { width: 40px; height: 24px; border-radius: var(--radius-full); position: relative; transition: background var(--duration-fast) var(--ease-standard); flex-shrink: 0; }
.salon-app .salon-spin { animation: salonSpin 900ms linear infinite; }
@keyframes salonSpin { to { transform: rotate(360deg); } }
/* .tap's 44px min-height (a touch-target rule for normal buttons) was
   stretching the 24px switch into a tall oval. */
.salon-app .switch.tap { min-height: 0; }
.salon-app .switch-knob { width: 18px; height: 18px; border-radius: 50%; background: white; position: absolute; top: 3px; transition: transform var(--duration-fast) var(--ease-standard); }

/* ---- Mobile-native shell: bottom tab bar + bottom sheets ---- */
.salon-app .safe-top { padding-top: env(safe-area-inset-top, 0px); }
.salon-app .safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
.salon-app .bottom-nav {
  position: fixed; bottom: 0; inset-inline: 0; z-index: 80;
  display: flex; justify-content: space-around;
  background: color-mix(in oklch, var(--color-surface) 92%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--color-border);
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
  box-shadow: 0 -8px 24px -12px oklch(20% 0.02 60 / 0.18);
}
.salon-app .bottom-nav-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 6px 4px; border-radius: var(--radius-md); min-height: 52px;
  color: var(--color-muted); position: relative;
  transition: color var(--duration-base) var(--ease-standard);
}
.salon-app .bottom-nav-item.active { color: var(--color-accent-700); }
.salon-app .bottom-nav-icon-wrap {
  width: 34px; height: 26px; border-radius: var(--radius-full);
  display: flex; align-items: center; justify-content: center;
  transition: background var(--duration-base) var(--ease-standard), transform var(--duration-fast) var(--ease-standard);
}
.salon-app .bottom-nav-item.active .bottom-nav-icon-wrap {
  background: color-mix(in oklch, var(--color-accent-500) 16%, transparent);
}
.salon-app .bottom-nav-item:active .bottom-nav-icon-wrap { transform: scale(0.88); }
.salon-app .header-blur {
  background: color-mix(in oklch, var(--color-surface) 80%, transparent);
  backdrop-filter: saturate(1.4) blur(16px); -webkit-backdrop-filter: saturate(1.4) blur(16px);
  box-shadow: 0 10px 30px -24px oklch(30% 0.05 50 / 0.5);
}
/* top-level navigation: one segmented bar, icon over label, fits 3–4 tabs on any phone */
.salon-app .main-tabs {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 4px;
  border-radius: calc(var(--radius-md) + 4px);
  background: color-mix(in oklch, var(--color-surface-raised) 85%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-border) 70%, transparent);
}
.salon-app .main-tab {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-height: 50px; padding: 6px 2px; border-radius: var(--radius-md);
  font-size: 11.5px; font-weight: 700; white-space: nowrap; min-width: 0; color: var(--tab-color);
  transition: background var(--duration-base) var(--ease-standard), color var(--duration-base) var(--ease-standard), box-shadow var(--duration-base) var(--ease-standard);
}
.salon-app .main-tab[aria-selected="true"] {
  background: var(--tab-grad); color: white; font-weight: 800;
  box-shadow: 0 6px 16px -6px color-mix(in oklch, var(--tab-color) 70%, transparent), inset 0 1px 0 oklch(100% 0 0 / 0.25);
}
.salon-app .main-tab:not([aria-selected="true"]):hover { background: color-mix(in oklch, var(--tab-color) 10%, transparent); }
/* inactive tabs: quiet text, the hue lives only in the icon */
.salon-app .main-tab:not([aria-selected="true"]) { color: var(--color-body); font-weight: 600; }
.salon-app .main-tab:not([aria-selected="true"]) svg { color: var(--tab-color); }
/* booking welcome card */
.salon-app .hero {
  position: relative; overflow: hidden; color: white; border-radius: var(--radius-xl);
  padding: 20px 18px; background: var(--grad-brand); box-shadow: var(--shadow-glow-accent);
}
.salon-app .hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(90% 80% at 0% 0%, oklch(100% 0 0 / 0.22), transparent 60%),
              radial-gradient(60% 70% at 100% 100%, oklch(0% 0 0 / 0.16), transparent 70%);
}
.salon-app .hero::after {
  content: ""; position: absolute; width: 220px; height: 220px; inset-inline-start: -70px; bottom: -110px; pointer-events: none;
  border-radius: 50%; border: 26px solid oklch(100% 0 0 / 0.08); box-shadow: 0 0 0 30px oklch(100% 0 0 / 0.04);
}
.salon-app .hero > * { position: relative; }
.salon-app .hero-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: var(--radius-full);
  font-size: 11.5px; font-weight: 700; background: oklch(100% 0 0 / 0.18); border: 1px solid oklch(100% 0 0 / 0.22);
}
/* choice cards (booking sections) */
.salon-app .choice-card { position: relative; overflow: hidden; }
.salon-app .choice-card::after {
  content: ""; position: absolute; inset-block: 14px; inset-inline-start: 0; width: 4px;
  border-start-end-radius: 4px; border-end-end-radius: 4px; background: var(--choice-color);
}
@media (hover: hover) {
  .salon-app .choice-card:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); border-color: color-mix(in oklch, var(--choice-color) 45%, var(--color-border)); }
}
/* thin, quiet scrollbars */
.salon-app * { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--color-muted) 40%, transparent) transparent; }
.salon-app .sheet-handle {
  width: 36px; height: 4px; border-radius: var(--radius-full);
  background: var(--color-border); margin: 0 auto 10px;
}

/* ----------------------------------------------------------------------
   Layout utilities — this file has NO Tailwind installed and generates NO
   separate CSS file (everything ships as this one injected <style> tag).
   Every className like "flex items-center gap-2 mb-3" used throughout the
   app assumes Tailwind-equivalent rules exist; without them these classes
   were pure no-ops, so this block is what actually makes 186+ flex/grid
   layouts across the whole app render as intended. Values match the sizes
   actually used in the codebase (checked programmatically), not a generic
   Tailwind scale.
   ---------------------------------------------------------------------- */
.salon-app .flex { display: flex; }
.salon-app .grid { display: grid; }
.salon-app .flex-1 { flex: 1 1 0%; }
.salon-app .flex-col { flex-direction: column; }
.salon-app .flex-wrap { flex-wrap: wrap; }
.salon-app .items-center { align-items: center; }
.salon-app .items-end { align-items: flex-end; }
.salon-app .items-start { align-items: flex-start; }
.salon-app .justify-between { justify-content: space-between; }
.salon-app .justify-center { justify-content: center; }
.salon-app .w-full { width: 100%; }
.salon-app .mx-auto { margin-left: auto; margin-right: auto; }

.salon-app .gap-0\\.5 { gap: 2px; }
.salon-app .gap-1 { gap: 4px; }
.salon-app .gap-1\\.5 { gap: 6px; }
.salon-app .gap-2 { gap: 8px; }
.salon-app .gap-2\\.5 { gap: 10px; }
.salon-app .gap-3 { gap: 12px; }
.salon-app .gap-4 { gap: 16px; }
.salon-app .gap-x-3 { column-gap: 12px; }
.salon-app .gap-y-1\\.5 { row-gap: 6px; }

.salon-app .mb-1 { margin-bottom: 4px; }
.salon-app .mb-2 { margin-bottom: 8px; }
.salon-app .mb-2\\.5 { margin-bottom: 10px; }
.salon-app .mb-3 { margin-bottom: 12px; }
.salon-app .mb-4 { margin-bottom: 16px; }
.salon-app .mb-6 { margin-bottom: 24px; }

.salon-app .mt-1 { margin-top: 4px; }
.salon-app .mt-1\\.5 { margin-top: 6px; }
.salon-app .mt-2 { margin-top: 8px; }
.salon-app .mt-3 { margin-top: 12px; }
.salon-app .mt-4 { margin-top: 16px; }
.salon-app .mt-5 { margin-top: 20px; }
`;
