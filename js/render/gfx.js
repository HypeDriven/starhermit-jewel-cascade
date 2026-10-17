/**
 * gfx.js — graphics quality model: presets, per-category overrides, StarHermit
 * hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js), so the settings panel,
 * the renderer and the unit tests agree on what every setting means.
 *
 * Saved shape (settings.graphics):
 *   { preset: 'auto'|'low'|'balanced'|'high'|'ultra', render_scale: 0.5..2,
 *     adaptive: bool, show_fps: bool, <category>: 'preset'|tier }
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  particles: ['low', 'medium', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'medium', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const PARTICLE_CAP = { low: 512, medium: 1024, high: 2048 };
export const DUST_COUNT = { low: 0, medium: 90, high: 170 };
export const GLINT_COUNT = { low: 0, medium: 6, high: 14 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; gpu-level.js → window.StarHermitGpu, a classic script loaded before main.js): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Gameplay is
 * identical on every preset — only visuals change.
 *   hudBlur    frosted (CSS backdrop-filter) header, HUD, rails, overlays and thumb tray over the live 3D
 *              board — re-composited every frame the board moves, so only High/Ultra get it
 *   clearcoat  clear-coated jewels (Surface detail on): MeshPhysical clearcoat only on High/Ultra
 *   texture    procedural table/tile/brushed-metal texture size in px (Surface detail: detailed)
 *   sparks     live-particle cap at Particles "high" (medium: half, low: a quarter), scaled with the level
 *   dust       drifting dust motes at Particles "high" (medium: half), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { hudBlur: false, clearcoat: false, texture: 128, sparks: 2048, dust: 90, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { hudBlur: false, clearcoat: false, texture: 256, sparks: 2048, dust: 170, bloomRes: 0.5, aoRes: 0.5 },
  high: { hudBlur: true, clearcoat: true, texture: 512, sparks: 2048, dust: 170, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { hudBlur: true, clearcoat: true, texture: 1024, sparks: 3072, dust: 260, bloomRes: 1, aoRes: 1 },
};
const PARTICLE_SHARE = { low: 0.25, medium: 0.5, high: 1 };
export const SPARK_MAX = 6144;
export const DUST_MAX = 520;

/** A preset's concrete budget for a hardware level and Particles tier (counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level, particles = 'high') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  const share = PARTICLE_SHARE[particles] ?? 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k * share));
  b.dust = particles === 'low' ? 0 : Math.min(DUST_MAX, Math.round(b.dust * k * share));
  return b;
}

/** Resolve saved settings into concrete tiers. */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const preset = PRESETS.includes(s.preset) ? s.preset : PRESETS.includes(detected) ? detected : 'balanced';
  const row = TABLE[preset];
  const out = {
    preset,
    auto: !PRESETS.includes(s.preset),
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dprCap,
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Saved settings after choosing a preset: overrides are cleared. */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** Old `{tier, renderScale}` settings → the current shape. */
export function migrate(saved) {
  const s = { ...(saved || {}) };
  if (s.preset === undefined && s.tier !== undefined) {
    s.preset = { low: 'low', medium: 'balanced', high: 'high' }[s.tier] || 'auto';
  }
  if (s.render_scale === undefined && s.renderScale !== undefined) s.render_scale = Number(s.renderScale) || 1;
  delete s.tier;
  delete s.renderScale;
  if (s.preset === undefined) s.preset = 'auto';
  if (s.render_scale === undefined) s.render_scale = 1;
  if (s.adaptive === undefined) s.adaptive = true;
  if (s.show_fps === undefined) s.show_fps = false;
  return s;
}

const EN = {
  noShadows: 'no shadows',
  shadows: '{n}² shadows',
  ao: 'ambient occlusion',
  aoHigh: 'full ambient occlusion',
  bloom: 'bloom',
  reflections: 'reflections',
  noAA: 'no anti-aliasing',
};

/** Cost summary; `words` optionally localizes the fragments. */
export function describe(r, pixels, words) {
  const w = { ...EN, ...(words || {}) };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
