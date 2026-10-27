// Localization: the browser build's tables (js/strings.js, English source
// strings as the keys; js/account-strings.js for the StarHermit account lines)
// in the nine StarHermit locales — en-GB, es-ES and fr-CA carry only their
// differences from en-US, es-419 and fr-FR — in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's own Language setting (sh-language.js)
// and the DOM re-labelling of js/i18n.js: every string is drawn through T()
// each frame, so a change shows on the next frame without touching the round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import "../js/strings.js";
import { SH_ALL as SH_JS } from "../js/account-strings.js";

export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };
const TABLES = ((globalThis as unknown as { JC_STRINGS?: Record<string, Record<string, string>> }).JC_STRINGS) ?? {};
export interface AccountStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string;
  lbPosting: string; lbRank: string; lbPosted: string; lbNotPosted: string;
}
const SH_ALL = SH_JS as unknown as Record<string, AccountStrings>;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const [lang = "", region = ""] = s.toLowerCase().split("-");
  if (lang === "en") return ["gb", "uk", "ie", "au", "nz", "za", "in"].includes(region) ? "en-GB" : "en-US";
  if (lang === "es") return region === "es" ? "es-ES" : "es-419";
  if (lang === "fr") return region === "ca" ? "fr-CA" : "fr-FR";
  return ({ de: "de-DE", pt: "pt-BR", it: "it-IT" } as Record<string, string>)[lang] ?? "en-US";
}

let locale = "en-US";
export type Vars = Record<string, string | number>;
function lookup(key: string): string {
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const t = TABLES[l];
    if (t && has(t, key)) return t[key]!;
  }
  return key;
}
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  let s = lookup(String(key));
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (has(vars, k) ? String(vars[k]) : m));
  return s;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The account strings (sign-in, invite, toasts, leaderboard line) in the game language. */
export function account(): AccountStrings { return SH_ALL[locale] ?? SH_ALL["en-US"]!; }
/** A whole number in the active locale's grouping (js/ui/ui.js fmtInt). */
export function fmtInt(n: number): string {
  try { return Math.round(n).toLocaleString(locale); } catch { return String(Math.round(n)); }
}

function apply(tag: string): void {
  locale = pickLocale(tag);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => { if (pickLocale(p.language) !== locale) apply(p.language); });
export function currentLocale(): string { return locale; }
