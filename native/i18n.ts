// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: English source strings as the keys, the nine
// StarHermit locales; en-GB, es-ES and fr-CA carry only their differences, the
// chain reads the rest) in the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred language
// or the device's). The runtime's Options replaced the game's own Language
// setting (sh-language.js) and the DOM re-labelling of js/i18n.js: every string
// is drawn through T() each frame, so a change shows on the next frame without
// touching the round. The account lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
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
