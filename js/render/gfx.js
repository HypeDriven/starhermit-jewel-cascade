/**
 * gfx.js — graphics quality model: presets, per-category overrides, GPU
 * detection and a cost summary. Pure (no three.js), so the settings panel,
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

/** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
export function detectPreset(gpu, { mobile = false } = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  // Touch / mobile devices never auto-select above Balanced.
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/** Resolve saved settings into concrete tiers. */
export function resolve(saved, detected) {
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
