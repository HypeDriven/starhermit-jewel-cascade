// Unit tests for the graphics quality model (js/render/gfx.js). Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPreset, detectLevel, presetForLevel, resolve, presetTier, describe, choosePreset, migrate, CATEGORIES, PRESETS, LEVELS, BUDGETS, budgetFor } from '../js/render/gfx.js';
import { GFX_STRINGS, pickLocale } from '../js/ui/gfx-i18n.js';
// js/render/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way.
new Function('window', readFileSync(new URL('../js/render/gpu-level.js', import.meta.url), 'utf8'))(globalThis);

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['hudBlur', 'clearcoat', 'texture', 'sparks', 'dust', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].hudBlur), [false, false, true, true], 'backdrop blur only on High/Ultra');
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].clearcoat), [false, false, true, true]);
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, { ...BUDGETS.high }, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget, 'manual Ultra on a weak GPU keeps the Ultra floor budget');
  assert.ok(budgetFor('high', 14).dust > budgetFor('high', 10).dust, 'counts scale up within the preset');
  assert.equal(budgetFor('low', 0, 'low').dust, 0, 'Particles low has no dust');
  assert.ok(budgetFor('balanced', 4, 'medium').sparks < budgetFor('balanced', 4, 'high').sparks);
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
