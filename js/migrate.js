/**
 * migrate.js — carrying the browser build's account data over to the engine
 * client (pure; native/platform.ts calls it, tests/platform.test.mjs covers it).
 *
 * - The browser build's cloud save (the JS SDK's saveJSON under game:<slug>)
 *   held the progress document itself as JSON: parseForeign() reads it back.
 * - Its settings were mirrored into the account's settings KV one key per
 *   top-level field (patchSettings), plus the language helper's ui.language
 *   and the options panel's audio.options: settingsFromLegacy() keeps the
 *   game's own options among them (palette, left-handed layout, timing
 *   assistance, captions, hold to drag, camera preset, cosmetics, mute, the
 *   guest's name); volumes, graphics, language, reduced motion, high contrast,
 *   text size and haptics are the runtime's Options now and are dropped.
 */

export const LEGACY_KEYS = [
  'version', 'audio', 'graphics', 'motion', 'display', 'input', 'access', 'privacy', 'camera', 'player', 'cosmetics',
  'ui.language', 'audio.options',
];

/** The progress document from the old cloud slot's text, or null. */
export function parseForeign(text) {
  let doc;
  try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  // A progress document has these; anything else is not ours.
  if (!('journeyStars' in doc) && !('masteryXp' in doc) && !('career' in doc)) return null;
  return doc;
}

const KEEP = {
  audio: ['muted'],
  display: ['palette', 'leftHanded'],
  input: ['holdToDrag'],
  access: ['timingAssist', 'captions'],
  camera: ['preset'],
  player: ['displayName'],
  cosmetics: ['theme', 'trail', 'frame', 'title'],
};
const TYPES = { muted: 'boolean', palette: 'string', leftHanded: 'boolean', holdToDrag: 'boolean', timingAssist: 'boolean', captions: 'boolean', preset: 'string', displayName: 'string', theme: 'string', trail: 'string', frame: 'string', title: 'string' };

/** Settings from the defaults with the old account values (key → value) the engine client keeps. */
export function settingsFromLegacy(defaults, legacy) {
  const out = JSON.parse(JSON.stringify(defaults));
  for (const [sect, fields] of Object.entries(KEEP)) {
    const v = legacy && legacy[sect];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const f of fields) {
      if (typeof v[f] !== TYPES[f]) continue;
      if (TYPES[f] === 'string' && (!v[f] || v[f].length > 64)) continue;
      out[sect] = { ...(out[sect] || {}), [f]: v[f] };
    }
  }
  return out;
}
