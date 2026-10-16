// Localization coverage: every English key the code, content and markup use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codeKeys, htmlKeys, audit, loadTables, bootI18n } from './i18n-common.mjs';
import * as content from '../js/engine/content.js';
import { ACHIEVEMENTS } from '../js/engine/achievements.js';
import { THEMES } from '../js/engine/themes.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = loadTables(ROOT, 'js/strings.js', 'JC_STRINGS');
// Names that stay as they are in every language.
const NAMES = new Set(['Jewel Cascade', 'StarHermit']);

export function usedKeys() {
  const keys = new Set();
  for (const f of ['js/ui/ui.js', 'js/main.js', 'js/platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  htmlKeys(read('index.html')).forEach((k) => keys.add(k));
  // Content shown by name/description (ui.js contentName/contentDesc compose the rest).
  for (const l of content.LESSONS) {
    keys.add(l.name); keys.add(l.desc);
    for (const s of l.steps || []) keys.add(s.text);
  }
  for (const s of content.JOURNEY) { keys.add(/^Stage \d+ — (.+)$/.exec(s.name)[1]); keys.add(s.desc); }
  keys.add(content.dailyContent('2026-01-01').desc);
  for (const d of content.PRACTICE_DIFFICULTIES) { keys.add(d.name); keys.add(d.desc); }
  for (const c of content.CHALLENGES) { keys.add(c.name); keys.add(c.desc); }
  keys.add(content.scoreChaseContent('x').name);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const t of THEMES) keys.add(t.name);
  const cos = /const COSMETIC_NAMES = \{([\s\S]*?)\};/.exec(read('js/ui/ui.js'))[1];
  for (const m of cos.matchAll(/:\s*'([^']+)'/g)) keys.add(m[1]);
  // Sound captions (audio.js) are keys; the rising chime is composed in ui.js.
  for (const m of read('js/audio.js').matchAll(/'(\[[a-z ]+\])'/g)) keys.add(m[1]);
  return [...keys].filter((k) => k && /[A-Za-z]/.test(k) && !NAMES.has(k) && !/^\[chime rising x$/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(TABLES, usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'JCI18N' });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Settings'), 'Einstellungen');
  const msg = I18N.L('Stage {n} of {total} · {stars}★', { n: 2, total: 40, stars: 5 });
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.match(msg(), /^Étape 2 sur 40/);
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
});
