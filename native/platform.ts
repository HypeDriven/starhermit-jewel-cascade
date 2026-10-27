// The game's data and the StarHermit platform, on the runtime's modules. The
// browser build's versioned, checksummed documents (js/storage.js) keep their
// code; native/platform.ts gives them a backend (storage.setBackend):
// - progress (journey stars, unlocks, lessons, achievements, mastery XP,
//   career counters, daily bests, cosmetics unlocked) is the game's save
//   (starhermit:storage `saves`): on the device and, signed in, in the
//   player's cloud slot. Two devices' copies merge on a conflict
//   (storage.mergeProgress: the best of each, as the browser build's
//   saveconflict merge). The slot the browser build wrote (the JS SDK's
//   saveJSON of the progress document under game:<slug>) shows as foreign: it
//   is merged in and replaced once;
// - the game's own options (palette, left-handed layout, timing assistance,
//   captions, hold to drag, camera preset, cosmetics, mute, the guest's
//   display name) are one synced game setting (`prefs`); the browser build's
//   account settings (its settings object mirrored key by key, plus
//   ui.language and the options panel's audio.options) are migrated once and
//   removed. Volumes, graphics, language, reduced motion, high contrast, text
//   size, vibration and key bindings are the runtime's Options;
// - the resume snapshot and the local boards stay on the device (storage KV);
// - the player (signed in or a guest) and their avatar, the invite link, the
//   platform's clock for the Daily, the leaderboard reads for the Boards
//   screen, and posting a finished ranked round's score through
//   score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  avatar as fetchAvatar, connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as gameSettings, storage as device } from "starhermit:storage";
import type { ImageBitmap } from "starhermit:canvas";
import { Rng, Store, type Backend, type Progress, type Settings } from "./game.ts";
import * as MigrateJs from "../js/migrate.js";

const Migrate = MigrateJs as unknown as {
  LEGACY_KEYS: string[];
  parseForeign(text: string | null): Record<string, unknown> | null;
  settingsFromLegacy(defaults: Settings, legacy: Record<string, unknown>): Settings;
};

const PREFIX = "jewelcascade.";
const PROGRESS_KEY = PREFIX + "progress";
const SETTINGS_KEY = PREFIX + "settings";
const PREFS = "prefs";

// -- the documents' backend ------------------------------------------------------------------
/** js/storage.js wraps every document as { v, sum, data }; the save holds just the data. */
function wrap(data: unknown): string {
  return JSON.stringify({ v: 1, sum: Rng.fnv1a(Rng.stableStringify(data)), data });
}
function unwrapData(text: string): unknown {
  try { const d = JSON.parse(text) as { data?: unknown }; return d && typeof d === "object" ? d.data : null; } catch { return null; }
}
let lastSavedAt = 0;
const backend: Backend = {
  getItem(key) {
    if (key === PROGRESS_KEY) {
      const cur = saves.load();
      return cur && cur.data && typeof cur.data === "object" ? wrap(cur.data) : null;
    }
    if (key === SETTINGS_KEY) {
      try { const v = gameSettings.get(PREFS); return v === undefined ? null : wrap(v); } catch { return null; }
    }
    try { return device.getText(key); } catch { return null; }
  },
  setItem(key, value) {
    if (key === PROGRESS_KEY) {
      const data = unwrapData(value);
      if (data && typeof data === "object") {
        try { saves.save(data as JsonValue, { schema: 1 }); lastSavedAt = saves.load()?.savedAt ?? lastSavedAt; }
        catch (e) { console.warn(`save: ${String(e)}`); }
      }
      return;
    }
    if (key === SETTINGS_KEY) {
      const data = unwrapData(value);
      try { if (data && typeof data === "object") gameSettings.set(PREFS, data as JsonValue); } catch (e) { console.warn(`settings: ${String(e)}`); }
      return;
    }
    try { device.set(key, value); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key) {
    if (key === PROGRESS_KEY) { saves.save(Store.defaultProgress() as unknown as JsonValue, { schema: 1 }); return; }
    if (key === SETTINGS_KEY) { try { gameSettings.delete(PREFS); } catch { /* gone */ } return; }
    try { device.remove(key); } catch { /* gone */ }
  },
  key(i) { return keys()[i] ?? null; },
  get length() { return keys().length; },
};
function keys(): string[] {
  let list: string[] = [];
  try { list = device.keys(); } catch { /* none */ }
  return [PROGRESS_KEY, SETTINGS_KEY, ...list.filter((k) => k !== PROGRESS_KEY && k !== SETTINGS_KEY)];
}
Store.setBackend(backend);

// -- the live documents ------------------------------------------------------------------------
/** The live settings and progress objects (the session and the screens mutate them in place). */
export const settings: Settings = Store.defaultSettings();
export const progress: Progress = Store.defaultProgress();
function replaceProgress(next: Progress): void {
  const p = progress as unknown as Record<string, unknown>;
  for (const k of Object.keys(p)) delete p[k];
  Object.assign(p, next);
}
function replaceSettings(next: Settings): void {
  const s = settings as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, next);
}
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }
const settingsListeners = new Set<() => void>();
/** fn() after the game's options changed (here, from the account, or migrated). */
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }

/** Saves the progress document (device at once, the account debounced by the runtime). */
export function saveProgress(touch = true): void { Store.saveProgress(progress, touch); }
/** Saves the game's options (synced with the account). */
export function saveSettings(): void { Store.saveSettings(settings); settingsChanged(); }

/** Merges another copy into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  if (!other || typeof other !== "object") return false;
  const before = JSON.stringify(progress);
  const next = Store.mergeProgress(JSON.parse(before) as Progress, JSON.parse(JSON.stringify(other)));
  if (JSON.stringify(next) === before) return false;
  replaceProgress(next);
  saveProgress(false);
  return true;
}
saves.onConflict((local, remote) => {
  const base = (local?.data && typeof local.data === "object" ? JSON.parse(JSON.stringify(local.data)) : Store.defaultProgress()) as Progress;
  return { merged: Store.mergeProgress(base, remote.data) as unknown as JsonValue };
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): take it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud save (the progress document as JSON): merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Migrate.parseForeign(old.text);
  const changed = doc ? adopt(doc) : false;
  try { saves.save(progress as unknown as JsonValue, { schema: 1, replaceForeign: true }); } catch (e) { console.warn(`save: ${String(e)}`); }
  if (changed) merged();
}

/** For the profile line: local (a guest) | syncing | saving | synced | offline. */
export function syncState(): "local" | "syncing" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign") return "syncing";
  if (st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// -- the browser build's account settings ------------------------------------------------------
// It mirrored its whole settings object into the account's settings KV
// (patchSettings: one key per top-level field), plus the language helper's
// ui.language and the shared options panel's audio.options. The game's own
// options among them carry over (unless this device has options already),
// then all of them are removed.
function importLegacy(): void {
  const keys = gameSettings.legacyKeys();
  if (!keys || !keys.length) return;
  let had = false;
  try { had = gameSettings.get(PREFS) !== undefined; } catch { had = true; }
  if (!had) {
    const old: Record<string, unknown> = {};
    for (const k of keys) if (Migrate.LEGACY_KEYS.includes(k)) old[k] = gameSettings.legacy(k);
    replaceSettings(Migrate.settingsFromLegacy(Store.defaultSettings(), old));
    Store.saveSettings(settings);
  }
  for (const k of keys) if (Migrate.LEGACY_KEYS.includes(k)) gameSettings.removeLegacy(k);
  if (!had) settingsChanged();
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  lastSavedAt = saves.load()?.savedAt ?? 0;
  replaceProgress(Store.loadProgress());
  replaceSettings(Store.loadSettings());
  gameSettings.onChange((key) => {
    if (key !== PREFS) return;
    replaceSettings(Store.loadSettings());
    settingsChanged();
  });
  gameSettings.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

/** Erases every setting, progress record, snapshot and local board (Settings › Reset all data). */
export function wipeAll(): void {
  Store.wipeAll();
  replaceProgress(Store.loadProgress());
  replaceSettings(Store.loadSettings());
  settingsChanged();
}

// -- the player, the avatar and the clock ------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
let avatarImage: ImageBitmap | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
/** The signed-in player's avatar once loaded, else null. */
export function avatarBitmap(): ImageBitmap | null { return player() ? avatarImage : null; }
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
function refreshPlayer(): void {
  invite = null;
  avatarImage = null;
  board = undefined;
  const me = player();
  for (const fn of playerListeners) fn();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  fetchAvatar(me.userId).then((b) => { if (player()?.userId === me.userId) avatarImage = b; }, () => undefined);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// -- leaderboards --------------------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardLine { rank: number; name: string; score: number; at: number | null; me: boolean }
/** The game's board, top 25 (Friends: the player's friends, signed in only); null when there is none or it cannot be read. */
export async function readBoard(friends: boolean): Promise<BoardLine[] | null> {
  try {
    if (friends && !player()) return null;
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 25, ...(friends ? { friendsOnly: true } : {}) });
    const meId = player()?.userId;
    return r.items.slice(0, 25).map((e, i) => ({
      rank: e.rank ?? i + 1, name: e.displayName || e.username, score: e.score ?? 0,
      at: typeof e.submittedAt === "number" ? e.submittedAt : null, me: !!meId && e.userId === meId,
    }));
  } catch { return null; }
}

/** Signed in only: post a finished ranked round's score through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
