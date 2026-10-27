// The look of the menus, HUD and dialogs: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects, text
// fields, dialogs, scroll bars) take. The browser build's html.hc palette is a
// token set here, applied while the runtime's high-contrast option is on; the
// theme accents (.theme-* classes) follow the chosen workshop theme.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const INK = {
  bg: "#241a3a", bg2: "#2d2148", panel: "#31254e", panel2: "#3a2c5a", line: "#4a3a68", ink: "#f4ecdf", dim: "#cfc2b8",
  muted: "#a89bc0", accent: "#ffb36b", accent2: "#ffd28a", gold: "#ffc857", danger: "#ff7b7b", ok: "#7bd88f", focus: "#ffe6b0",
};
export const INK_HC = { ...INK, bg: "#100a20", bg2: "#191130", panel: "#1e1536", panel2: "#271c46", line: "#8f7fc0", ink: "#ffffff", dim: "#efe8ff", muted: "#cfc2e8", focus: "#ffffff" };
type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  bg: INK_HC.bg, "bg-2": INK_HC.bg2, panel: INK_HC.panel, "panel-2": INK_HC.panel2, "panel-line": INK_HC.line, ink: INK_HC.ink,
  "ink-dim": INK_HC.dim, muted: INK_HC.muted, focus: INK_HC.focus,
};
/** The workshop themes' accents (css .theme-*). */
const THEME_ACCENTS: Record<string, [string, string]> = {
  "ember-dusk": ["#ffb36b", "#ffd28a"], "moonlit-forge": ["#9fc6ff", "#c4d9ff"], "verdant-atelier": ["#b8e986", "#dcf5b8"],
  "frostbound-loft": ["#bfe8ff", "#e0f4ff"], "royal-velvet": ["#ffd28a", "#ffe3b3"],
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 9,
    text: INK.ink, muted: INK.muted, panel: INK.panel, control: INK.panel2, hovered: INK.panel2,
    pressed: INK.bg2, field: INK.bg2, accent: INK.accent, focus: INK.focus, outline: INK.line,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$bg-2", border: { width: 1, color: "$panel-line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "$bg-2", border: { width: 1, color: "$panel-line" }, radius: 9, minHeight: 44 },
    textField: { text: { color: "$ink" }, background: "$bg-2", border: { width: 1, color: "$panel-line" }, radius: 9, minHeight: 44 },
    dialog: {
      background: { type: "linear", stops: ["$panel-2", "$panel"] }, border: { width: 1, color: "$panel-line" }, radius: 14, padding: 20,
      parts: { backdrop: { background: "#0e081ab8" } },
    },
    scrollArea: { parts: { bar: { background: "$muted", radius: 4 } } },
    tooltip: { background: "$bg-2", text: { color: "$ink" }, radius: 6, padding: 6 },
  });
}

let key = "";
/** The high-contrast tokens while the runtime's option is on; the theme's accent. */
export function applyTokens(highContrast: boolean, themeId: string): void {
  const k = `${highContrast}:${themeId}`;
  if (k === key) return;
  key = k;
  const [accent, accent2] = THEME_ACCENTS[themeId] ?? THEME_ACCENTS["ember-dusk"]!;
  ui.setTokens({ ...base, accent, "accent-2": accent2, ...(highContrast ? HIGH_CONTRAST : {}) });
}
export function ink(highContrast: boolean): typeof INK { return highContrast ? INK_HC : INK; }
