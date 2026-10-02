// All app styling: CSS variables (light/dark), primitives and the small set of
// utility classes the JSX uses. Injected once by App as a <style> tag.
/* ============================================================
   Design tokens (from spec) — applied via CSS variables
   ============================================================ */
export const TOKENS_CSS = `
.salon-app {
  --color-bg: oklch(96% 0.008 70);
  --color-surface: oklch(100% 0 0);
  --color-surface-raised: oklch(95% 0.010 65);
  --color-border: oklch(88% 0.012 65);
  --color-muted: oklch(60% 0.014 60);
  --color-body: oklch(26% 0.016 60);
  --color-heading: oklch(15% 0.014 55);

  --color-accent-50: oklch(97% 0.035 75);
  --color-accent-100: oklch(93% 0.07 75);
  --color-accent-300: oklch(82% 0.14 72);
  --color-accent-500: oklch(69% 0.20 62);
  --color-accent-700: oklch(50% 0.18 48);
  --color-accent-900: oklch(30% 0.12 42);

  --color-success: oklch(62% 0.17 150);
  --color-warning: oklch(74% 0.18 78);
  --color-danger: oklch(56% 0.22 22);
  --color-info: oklch(60% 0.17 250);

  /* Section tints — women's (rose) / men's (teal) so each area feels distinct */
  --color-female-500: oklch(64% 0.19 6);
  --color-female-100: oklch(93% 0.04 10);
  --color-male-500: oklch(54% 0.13 235);
  --color-male-100: oklch(92% 0.025 225);

  /* Brand + status gradients — the "reporting" surfaces (hero cards, KPI tiles,
     chart fills) lean on these instead of flat fills for a richer, more premium look. */
  --grad-brand: linear-gradient(135deg, oklch(72% 0.18 75) 0%, oklch(62% 0.21 40) 55%, oklch(56% 0.20 22) 100%);
  --grad-brand-soft: linear-gradient(135deg, oklch(95% 0.05 75), oklch(92% 0.05 45));
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
  --color-tab-panel: oklch(52% 0.19 300);
  --grad-tab-book: var(--grad-brand);
  --grad-tab-dash: linear-gradient(135deg, oklch(66% 0.13 195), oklch(52% 0.15 215));
  --grad-tab-panel: linear-gradient(135deg, oklch(60% 0.17 295), oklch(46% 0.20 310));
  --color-tab-services: oklch(58% 0.18 20);

  --shadow-sm: 0 1px 2px oklch(20% 0.02 60 / 0.06), 0 1px 1px oklch(20% 0.02 60 / 0.04);
  --shadow-md: 0 6px 16px -4px oklch(20% 0.02 60 / 0.14), 0 2px 6px -2px oklch(20% 0.02 60 / 0.08);
  --shadow-lg: 0 16px 32px -8px oklch(20% 0.02 60 / 0.20), 0 4px 12px -4px oklch(20% 0.02 60 / 0.10);
  --shadow-glow-accent: 0 8px 24px -6px oklch(69% 0.20 62 / 0.45);
  --shadow-glow-success: 0 8px 24px -6px oklch(62% 0.17 150 / 0.4);
  --shadow-glow-danger: 0 8px 24px -6px oklch(56% 0.22 22 / 0.4);
  --shadow-glow-info: 0 8px 24px -6px oklch(60% 0.17 250 / 0.4);

  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --space-10: 40px; --space-12: 48px; --space-16: 64px;

  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 18px; --radius-xl: 24px; --radius-full: 9999px;

  --font-sans: 'Vazirmatn', system-ui, sans-serif;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem;
  --text-lg: 1.125rem; --text-xl: 1.25rem; --text-2xl: 1.5rem; --text-3xl: 1.875rem;
  --leading-tight: 1.35; --leading-normal: 1.6; --leading-relaxed: 1.75;

  --duration-fast: 120ms; --duration-base: 200ms; --ease-standard: cubic-bezier(.4,0,.2,1);

  background: var(--color-bg);
  color: var(--color-body);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  direction: rtl;
  min-height: 100%;
}
.salon-app[data-theme="dark"] {
  --color-bg: oklch(13% 0.014 55);
  --color-surface: oklch(17% 0.016 55);
  --color-surface-raised: oklch(21% 0.018 55);
  --color-border: oklch(29% 0.018 55);
  --color-muted: oklch(56% 0.014 55);
  --color-body: oklch(88% 0.012 60);
  --color-heading: oklch(96% 0.008 60);
  --color-accent-500: oklch(73% 0.18 68);
  /* Light tints used as backgrounds (e.g. the status banner) — without dark
     versions they stayed near-white under light text and were unreadable. */
  --color-accent-50: oklch(22% 0.04 65);
  --color-accent-100: oklch(30% 0.06 65);
  --color-female-100: oklch(27% 0.05 10);
  --color-male-100: oklch(25% 0.035 225);
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.3);
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
.salon-app .card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
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
  font-weight: 700;
  box-shadow: var(--shadow-glow-accent);
}
.salon-app .accent-btn:hover { filter: brightness(1.06); }
.salon-app .accent-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.salon-app .ghost-btn {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-body);
  border-radius: var(--radius-md);
}
.salon-app .ghost-btn:hover { border-color: var(--color-accent-500); }
.salon-app h1 { color: var(--color-heading); font-weight: 800; letter-spacing: -0.01em; }
.salon-app h2 { color: var(--color-heading); font-weight: 800; letter-spacing: -0.005em; }
.salon-app h3 { color: var(--color-heading); font-weight: 700; }
.salon-app h4 { color: var(--color-heading); font-weight: 600; }
.salon-app .muted { color: var(--color-muted); }
.salon-app .badge { border-radius: var(--radius-full); font-weight: 700; font-size: var(--text-xs); padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px; }
@media (prefers-reduced-motion: reduce) {
  .salon-app * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
.salon-app input, .salon-app select, .salon-app textarea {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-heading);
  font-family: var(--font-sans);
}
.salon-app input:focus, .salon-app select:focus, .salon-app textarea:focus {
  outline: 2px solid var(--color-accent-500);
  outline-offset: 1px;
  border-color: var(--color-accent-500);
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
  background: color-mix(in oklch, var(--color-surface) 88%, transparent);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
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
