/**
 * storage.js — versioned, checksummed local persistence for Jewel Cascade.
 *
 * Documents: settings, progress, round snapshot, local leaderboards.
 * Each document is stored as { v, sum, data } where sum is an FNV-1a checksum
 * of the stable-stringified data; corrupt or absent documents fall back to
 * defaults. Migrations are keyed by from-version, mirroring the rules engine.
 * No credentials or tokens are ever written here.
 */

import { fnv1a, stableStringify } from './engine/rng.js';
import { migrate as migrateGraphics } from './render/gfx.js';

const PREFIX = 'jewelcascade.';
export const SETTINGS_VERSION = 1;
export const PROGRESS_VERSION = 1;
export const SNAPSHOT_VERSION = 1;
export const BOARDS_VERSION = 1;

/* ------------------------------------------------------------------ *
 *  Defaults
 * ------------------------------------------------------------------ */

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    audio: { master: 0.8, music: 0.65, effects: 0.9, ambience: 0.55, voice: 0.8, muted: false },
    // preset: auto | low | balanced | high | ultra; per-category overrides as in render/gfx.js
    graphics: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
    motion: { reduced: false }, // follows prefers-reduced-motion until changed
    display: {
      highContrast: false,
      palette: 'default', // default | deuter | protan | tritan | contrast
      textSize: 'normal', // normal | large | xl
      leftHanded: false,
    },
    input: {
      holdToDrag: true,
      haptics: true,
      keyboardMap: null, // null = defaults; see ui/controls.js
      gamepadMap: null,
    },
    access: { timingAssist: false, tutorialReplay: false },
    privacy: { telemetryConsent: false },
    camera: { preset: 'default' }, // default | low | high
    player: { displayName: 'Guest', avatar: null },
    cosmetics: { theme: 'ember-dusk', trail: 'none', frame: 'standard', title: 'apprentice' },
  };
}

export function defaultProgress() {
  return {
    version: PROGRESS_VERSION,
    journeyStars: {}, // contentId -> 0..3
    journeyUnlocked: 1, // highest unlocked journey stage number
    tutorialsDone: {}, // tutorialId -> true
    challengesDone: {}, // challengeId -> best stars
    achievements: {}, // key -> {at: iso}
    masteryXp: 0,
    career: {
      roundsCompleted: 0,
      roundsWon: 0,
      winStreak: 0,
      bestWinStreak: 0,
      specialsMade: { ray: false, bloom: false, prism: false },
      totalScore: 0,
    },
    seenRounds: [],
    daily: { lastPlayed: null, streak: 0, best: {} }, // best: dateKey -> score
    practice: { plays: 0 },
    cosmeticsUnlocked: { themes: ['ember-dusk'], trails: ['none'], frames: ['standard'], titles: ['apprentice'] },
  };
}

/* ------------------------------------------------------------------ *
 *  Migrations (registries exist so future versions upgrade in place)
 * ------------------------------------------------------------------ */

export const SETTINGS_MIGRATIONS = { 1: (d) => d };
export const PROGRESS_MIGRATIONS = { 1: (d) => d };
export const SNAPSHOT_MIGRATIONS = { 1: (d) => d };
export const BOARDS_MIGRATIONS = { 1: (d) => d };

/* ------------------------------------------------------------------ *
 *  Store plumbing
 * ------------------------------------------------------------------ */

function safeStorage() {
  try {
    const t = '__jc_probe__';
    window.localStorage.setItem(t, '1');
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch {
    // Private mode / file:// restrictions: fall back to an in-memory store so
    // play continues and account state survives the session. Exposes key() and
    // length like real Storage so key iteration (e.g. wipeAll) works.
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    };
  }
}

const store = typeof window !== 'undefined' ? safeStorage() : new (function () {})();

function wrap(data, version) {
  return { v: version, sum: fnv1a(stableStringify(data)), data };
}

function unwrap(raw, migrations, currentVersion, makeDefault) {
  if (!raw) return makeDefault();
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || doc.data === undefined) return makeDefault();
    if (doc.sum !== fnv1a(stableStringify(doc.data))) return makeDefault();
    let data = doc.data;
    let guard = 0;
    while ((data.version || 1) !== currentVersion) {
      const mig = migrations[data.version || 1];
      if (!mig || guard++ > 16) return makeDefault();
      data = mig(data);
    }
    return data;
  } catch {
    return makeDefault();
  }
}

function read(key, migrations, currentVersion, makeDefault) {
  return unwrap(store.getItem(PREFIX + key), migrations, currentVersion, makeDefault);
}

function write(key, data, version) {
  try {
    store.setItem(PREFIX + key, JSON.stringify(wrap(data, version)));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

export function loadSettings() {
  const s = read('settings', SETTINGS_MIGRATIONS, SETTINGS_VERSION, defaultSettings);
  // Merge over defaults so new fields added by updates appear automatically.
  const d = defaultSettings();
  return {
    ...d,
    ...s,
    audio: { ...d.audio, ...(s.audio || {}) },
    graphics: { ...d.graphics, ...migrateGraphics(s.graphics || {}) },
    motion: { ...d.motion, ...(s.motion || {}) },
    display: { ...d.display, ...(s.display || {}) },
    input: { ...d.input, ...(s.input || {}) },
    access: { ...d.access, ...(s.access || {}) },
    privacy: { ...d.privacy, ...(s.privacy || {}) },
    camera: { ...d.camera, ...(s.camera || {}) },
    player: { ...d.player, ...(s.player || {}) },
    cosmetics: { ...d.cosmetics, ...(s.cosmetics || {}) },
  };
}

export function saveSettings(settings) {
  settings.version = SETTINGS_VERSION;
  return write('settings', settings, SETTINGS_VERSION);
}

export function loadProgress() {
  const p = read('progress', PROGRESS_MIGRATIONS, PROGRESS_VERSION, defaultProgress);
  const d = defaultProgress();
  return {
    ...d,
    ...p,
    career: { ...d.career, ...(p.career || {}), specialsMade: { ...d.career.specialsMade, ...((p.career || {}).specialsMade || {}) } },
    daily: { ...d.daily, ...(p.daily || {}) },
    practice: { ...d.practice, ...(p.practice || {}) },
    cosmeticsUnlocked: { ...d.cosmeticsUnlocked, ...(p.cosmeticsUnlocked || {}) },
  };
}

// `_savedAt` stamps every real progress write; the signed-in start-up compare
// uses it, so adopting a cloud doc passes touch=false to keep the remote stamp.
export function saveProgress(progress, touch = true) {
  progress.version = PROGRESS_VERSION;
  if (touch) progress._savedAt = new Date().toISOString();
  return write('progress', progress, PROGRESS_VERSION);
}

/** Last safe round snapshot for resume; cleared when a round ends. */
export function loadRoundSnapshot() {
  return read('snapshot', SNAPSHOT_MIGRATIONS, SNAPSHOT_VERSION, () => null);
}

export function saveRoundSnapshot(snap) {
  snap.version = SNAPSHOT_VERSION;
  return write('snapshot', snap, SNAPSHOT_VERSION);
}

export function clearRoundSnapshot() {
  try {
    store.removeItem(PREFIX + 'snapshot');
  } catch {
    /* non-fatal */
  }
}

export function loadBoards() {
  return read('boards', BOARDS_MIGRATIONS, BOARDS_VERSION, () => ({ version: BOARDS_VERSION, entries: [] }));
}

export function saveBoards(boards) {
  boards.version = BOARDS_VERSION;
  return write('boards', boards, BOARDS_VERSION);
}

/** Wipe only Jewel Cascade keys (used by "reset all data" in settings). */
export function wipeAll() {
  const keys = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  for (const k of keys) store.removeItem(k);
}
