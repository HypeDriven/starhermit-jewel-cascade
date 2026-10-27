// The platform data paths that cannot be live-tested signed out: the browser
// build's cloud save read back (js/migrate.js parseForeign) and merged into a
// device's progress (js/storage.js mergeProgress, as on a save conflict), its
// account settings carried over (settingsFromLegacy), and the documents on an
// injected backend (storage.setBackend, as native/platform.ts installs one).
// Run: node --test tests/platform.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForeign, settingsFromLegacy, LEGACY_KEYS } from '../js/migrate.js';
import * as storage from '../js/storage.js';

function memBackend() {
  const mem = new Map();
  return {
    mem,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
}

test('the old cloud slot: a progress document reads back; anything else is ignored', () => {
  const p = storage.defaultProgress();
  p.journeyStars = { j1: 3 };
  p.masteryXp = 120;
  assert.deepEqual(parseForeign(JSON.stringify(p)).journeyStars, { j1: 3 });
  assert.equal(parseForeign('not json'), null);
  assert.equal(parseForeign('[1,2]'), null);
  assert.equal(parseForeign(JSON.stringify({ schemaVersion: 1, other: true })), null);
  assert.equal(parseForeign(null), null);
});

test('merging the old cloud progress into a device keeps the best of both', () => {
  const local = storage.defaultProgress();
  local.journeyStars = { j1: 2, j2: 1 };
  local.journeyUnlocked = 3;
  local.masteryXp = 50;
  local.achievements = { first_completion: { at: '2026-09-02T00:00:00Z' } };
  local._savedAt = '2026-09-02T00:00:00Z';
  const remote = storage.defaultProgress();
  remote.journeyStars = { j1: 3, j5: 1 };
  remote.journeyUnlocked = 6;
  remote.masteryXp = 40;
  remote.achievements = { first_completion: { at: '2026-09-01T00:00:00Z' }, streak_5: { at: '2026-09-03T00:00:00Z' } };
  remote.cosmeticsUnlocked.themes.push('moonlit-forge');
  remote.daily = { lastPlayed: '2026-09-03', streak: 4, best: { '2026-09-03': 3100 } };
  remote._savedAt = '2026-09-03T00:00:00Z';
  const m = storage.mergeProgress(local, parseForeign(JSON.stringify(remote)));
  assert.deepEqual(m.journeyStars, { j1: 3, j2: 1, j5: 1 });
  assert.equal(m.journeyUnlocked, 6);
  assert.equal(m.masteryXp, 50);
  assert.equal(m.achievements.first_completion.at, '2026-09-01T00:00:00Z');
  assert.ok(m.achievements.streak_5);
  assert.ok(m.cosmeticsUnlocked.themes.includes('moonlit-forge'));
  assert.equal(m.daily.streak, 4);
  assert.equal(m.daily.best['2026-09-03'], 3100);
  assert.equal(m._savedAt, '2026-09-03T00:00:00Z');
});

test('the old account settings: the game options carry over, the runtime-owned ones do not', () => {
  const d = storage.defaultSettings();
  const s = settingsFromLegacy(d, {
    audio: { master: 0.2, muted: true },
    graphics: { preset: 'ultra' },
    display: { palette: 'deuter', leftHanded: true, highContrast: true, textSize: 'xl' },
    input: { holdToDrag: false, haptics: false },
    access: { timingAssist: true, captions: true },
    camera: { preset: 'high' },
    player: { displayName: 'Opal Fan' },
    cosmetics: { theme: 'moonlit-forge', trail: 'spark', frame: 'brass', title: 'apprentice' },
    'ui.language': 'de-DE',
  });
  assert.equal(s.audio.muted, true);
  assert.equal(s.audio.master, d.audio.master);
  assert.equal(s.display.palette, 'deuter');
  assert.equal(s.display.leftHanded, true);
  assert.equal(s.display.highContrast, false);
  assert.equal(s.input.holdToDrag, false);
  assert.equal(s.access.timingAssist, true);
  assert.equal(s.access.captions, true);
  assert.equal(s.camera.preset, 'high');
  assert.equal(s.player.displayName, 'Opal Fan');
  assert.equal(s.cosmetics.theme, 'moonlit-forge');
  assert.equal('graphics' in s, false);
  // Wrong types are ignored.
  assert.equal(settingsFromLegacy(d, { display: { palette: 7 } }).display.palette, 'default');
  for (const k of ['audio', 'display', 'cosmetics', 'ui.language', 'audio.options']) assert.ok(LEGACY_KEYS.includes(k));
});

test('the documents live on an injected backend, checksummed as before', () => {
  const b = memBackend();
  storage.setBackend(b);
  const p = storage.loadProgress();
  p.masteryXp = 77;
  storage.saveProgress(p);
  const raw = JSON.parse(b.mem.get('jewelcascade.progress'));
  assert.equal(raw.data.masteryXp, 77);
  assert.equal(typeof raw.sum, 'number');
  assert.equal(storage.loadProgress().masteryXp, 77);
  // A tampered document falls back to the defaults.
  raw.data.masteryXp = 9999;
  b.mem.set('jewelcascade.progress', JSON.stringify(raw));
  assert.equal(storage.loadProgress().masteryXp, 0);
  const s = storage.loadSettings();
  s.display.palette = 'tritan';
  storage.saveSettings(s);
  assert.equal(storage.loadSettings().display.palette, 'tritan');
  storage.wipeAll();
  assert.equal(b.length, 0);
});
