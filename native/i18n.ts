// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: English source strings as the keys, the nine
// StarHermit locales; en-GB, es-ES and fr-CA carry only their differences, the
// chain reads the rest) in the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred language
// or the device's). The runtime's Options replaced the game's own Language
// setting (sh-language.js) and the DOM re-labelling of js/i18n.js: every string
// is drawn through T() each frame, so a change shows on the next frame without
// touching the round. The account lines are the engine's `starhermit.*` keys.
import {files, preferences, strings} from "starhermit:engine";

// Locale tables are split per language. Only the player's fallback chain is
// parsed and kept (en-US first, so it remains the default). Other locales stay
// in the package until the language changes.
const __stringLocales = new Set<string>();
let __stringsBusy = false;
let __stringsWatching = false;
function loadGameStrings(dir: string): void {
  if (__stringsBusy) return;
  __stringsBusy = true;
  try {
    let tag = "en";
    try {
      const language = preferences().language;
      if (language) tag = language;
    } catch { /* preferences are not ready while the module is still loading */ }
    const want = stringLocalesFor(tag);
    const ordered = [...want.filter((locale) => locale === "en-US"), ...want.filter((locale) => locale !== "en-US")];
    const batch: { [locale: string]: unknown } = {};
    for (const locale of ordered) {
      if (__stringLocales.has(locale)) continue;
      const path = `${dir}/${locale}.json`;
      if (!files.exists(path)) continue;
      const table = files.readJson(path);
      if (!table || typeof table !== "object" || Array.isArray(table)) continue;
      batch[locale] = table;
    }
    const added = Object.keys(batch);
    if (added.length) {
      strings.load(batch);
      for (const locale of added) __stringLocales.add(locale);
    }
  } finally {
    __stringsBusy = false;
  }
  if (!__stringsWatching) {
    __stringsWatching = true;
    strings.onChange(() => loadGameStrings(dir));
  }
}
function stringLocalesFor(tag: string): string[] {
  const out: string[] = [];
  const add = (locale: string): void => { if (locale && !out.includes(locale)) out.push(locale); };
  const bits = tag.replace(/_/g, "-").split("-").filter(Boolean);
  const language = (bits[0] || "en").toLowerCase();
  const regionBit = bits.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part));
  const region = regionBit ? (/^\d{3}$/.test(regionBit) ? regionBit : regionBit.toUpperCase()) : "";
  add(region ? `${language}-${region}` : language);
  if (bits.length > 2) {
    add(bits.map((part, index) => index === 0 ? language : (/^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : part)).join("-"));
  }
  if (language === "en" && region && region !== "US" && region !== "CA") add("en-001");
  if (language === "en" && region && region !== "US") add("en-GB");
  if (language === "es" && region !== "ES") add("es-419");
  if (language === "es") add("es-ES");
  if (language === "fr") add("fr-FR");
  if (language === "fr" && region === "CA") add("fr-CA");
  if (language === "de") add("de-DE");
  if (language === "pt" && region !== "BR") add("pt-PT");
  if (language === "pt") add("pt-BR");
  if (language === "it") add("it-IT");
  if (language === "nl") add("nl-NL");
  if (language === "ja") add("ja-JP");
  if (language === "zh") {
    const traditional = region === "HK" || region === "TW" || region === "MO";
    add(traditional ? "zh-HK" : "zh-CN");
    if (!traditional) add("zh-SG");
  }
  if (language === "yue") add("yue-HK");
  if (language === "ru") add("ru-FI");
  add(language);
  add("en-US");
  return out;
}
import * as ui from "starhermit:ui";

loadGameStrings("assets/l10n/strings");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. Text with no entry passes through. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key);
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, n: string) => (Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : m)) : k;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
export type AccountKey = "signIn" | "invite" | "inviteCopied" | "inviteLink" | "signedOut" | "leaderboardPosting" | "leaderboardRank" | "leaderboardPosted" | "leaderboardNotPosted";
/** An account or leaderboard line (the engine's `starhermit.*` strings) in the player's language. */
export function account(key: AccountKey, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
/** A whole number in the active locale's grouping (js/ui/ui.js fmtInt). */
export function fmtInt(n: number): string {
  try { return Math.round(n).toLocaleString(strings.locale); } catch { return String(Math.round(n)); }
}
