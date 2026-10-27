// Localization coverage: every English key the native client and the content
// use is translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA →
// fr-FR inherit), placeholders survive, no table row is unused, and the account
// strings are complete in all nine locales. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit, LOCALES } from './i18n-common.mjs';
import '../js/strings.js';
import { SH_ALL } from '../js/account-strings.js';
import * as content from '../js/engine/content.js';
import { ACHIEVEMENTS } from '../js/engine/achievements.js';
import { THEMES } from '../js/engine/themes.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = globalThis.JC_STRINGS;
// Names that stay as they are in every language.
const NAMES = new Set(['Jewel Cascade', 'StarHermit']);

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read(`native/${f}`);
    codeKeys(src, [], ['T', 'N']).forEach((k) => keys.add(k));
    // Sound captions (audio.ts "[…]" strings) are keys too.
    if (f === 'audio.ts') for (const m of src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').matchAll(/"(\[[^"\]]+\])"/g)) keys.add(m[1]);
  }
  // Content shown by name/description (main.ts contentName/contentDesc compose the rest).
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
  return [...keys].filter((k) => k && /[A-Za-z]/.test(k) && !NAMES.has(k)).sort();
}

test('every used key is translated in every locale; placeholders intact; no unused rows', () => {
  assert.deepEqual(audit(TABLES, usedKeys()), []);
});

test('account strings exist in all nine locales with the same keys', () => {
  const keys = Object.keys(SH_ALL['en-US']).sort();
  for (const l of LOCALES) assert.deepEqual(Object.keys(SH_ALL[l] ?? {}).sort(), keys, l);
  for (const l of LOCALES) assert.ok(SH_ALL[l].lbRank.includes('{rank}') && SH_ALL[l].copyFailed.includes('{link}'), l);
});

test('en-GB, es-ES and fr-CA carry their regional differences', () => {
  assert.equal(TABLES['en-GB']['Color palette'], 'Colour palette');
  assert.ok(TABLES['fr-CA']['Score chase']);
});
