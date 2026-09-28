// Unit tests for the graphics quality model (js/render/gfx.js). Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, describe, choosePreset, migrate, CATEGORIES, PRESETS } from '../js/render/gfx.js';
import { GFX_STRINGS, pickLocale } from '../js/ui/gfx-i18n.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('mobile caps Auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto follows detection, explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'low renders without a post chain');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
});

test('resolve: overrides apply, invalid overrides fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true);
});

test('resolve: render scale clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({}).adaptive, true);
  assert.equal(resolve({}).showFps, false);
});

test('choosing a preset clears overrides', () => {
  const s = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true }, 'ultra');
  assert.equal(s.preset, 'ultra');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(s[cat], undefined);
  assert.equal(s.render_scale, 1.5);
  assert.equal(s.show_fps, true);
});

test('every preset defines every category with a legal tier', () => {
  for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
});

test('old {tier, renderScale} settings migrate', () => {
  assert.deepEqual(migrate({ tier: 'medium', renderScale: 0.75 }), { preset: 'balanced', render_scale: 0.75, adaptive: true, show_fps: false });
  assert.equal(migrate({ tier: 'auto' }).preset, 'auto');
});

test('describe summarises cost', () => {
  const s = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(s, /1024² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('graphics strings exist in every required locale', () => {
  const need = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const ref = GFX_STRINGS['en-US'];
  for (const loc of need) {
    const L = GFX_STRINGS[loc];
    assert.ok(L, loc);
    for (const k of Object.keys(ref)) assert.ok(L[k], `${loc}.${k}`);
    for (const group of ['presets', 'cats', 'tiers', 'words']) for (const k of Object.keys(ref[group])) assert.ok(L[group][k], `${loc}.${group}.${k}`);
  }
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
