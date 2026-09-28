/**
 * gfx-panel.js — the Settings panel's Graphics section: quality preset,
 * render scale, one override per effect, adaptive resolution, frame-rate
 * readout and a live cost summary. Changes apply immediately (scene.setGraphics)
 * and persist with the other settings (settings.graphics).
 */

import { CATEGORIES, PRESETS, presetTier, resolve, choosePreset } from '../render/gfx.js';
import { GFX_STRINGS, pickLocale } from './gfx-i18n.js';

export function initGraphicsPanel({ settings, storage, scene, applyGraphics, onChange }) {
  const grid = document.getElementById('gfx-grid');
  if (!grid) return { sync() {} };
  let locale = 'en-US';
  try {
    locale = pickLocale(navigator.language);
  } catch {
    /* default */
  }
  const L = GFX_STRINGS[locale];
  const group = document.getElementById('set-gfx-group');
  group.lang = locale;
  document.getElementById('gfx-title').textContent = L.title;

  const el = (tag, attrs = {}, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const row = (id, label, control) => {
    grid.append(el('label', { for: id }, label), control);
  };

  const preset = el('select', { id: 'gfx-preset', 'data-gfx': 'preset' });
  row('gfx-preset', L.quality, preset);

  const scaleWrap = el('div', { class: 'gfx-scale' });
  const scale = el('input', { type: 'range', id: 'gfx-scale', min: '50', max: '200', step: '5', 'data-gfx': 'render_scale' });
  const scaleOut = el('output', { id: 'gfx-scale-val', for: 'gfx-scale' });
  scaleWrap.append(scale, scaleOut);
  row('gfx-scale', L.renderScale, scaleWrap);

  const catSelects = {};
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = el('select', { id: `gfx-${cat}`, 'data-gfx': cat });
    sel.append(el('option', { value: 'preset' }, ''));
    for (const t of tiers) sel.append(el('option', { value: t }, L.tiers[t] || t));
    catSelects[cat] = sel;
    row(sel.id, L.cats[cat], sel);
  }

  const adaptive = el('input', { type: 'checkbox', id: 'gfx-adaptive', 'data-gfx': 'adaptive' });
  row('gfx-adaptive', L.adaptive, adaptive);
  const showFps = el('input', { type: 'checkbox', id: 'gfx-show-fps', 'data-gfx': 'show_fps' });
  row('gfx-show-fps', L.showFps, showFps);

  const summary = document.getElementById('gfx-summary');
  const note = document.getElementById('gfx-post-note');
  note.textContent = L.postNote;

  const detected = () => (scene ? scene.detected : 'balanced');

  function refreshSummary() {
    if (!scene) {
      summary.textContent = '';
      return;
    }
    const info = scene.graphicsInfo(L.words);
    summary.textContent = `${info.gpu} · ${info.summary}`;
    summary.dataset.preset = info.resolved.preset;
    note.hidden = !info.postFailed;
  }

  function sync() {
    const g = settings.graphics;
    preset.replaceChildren(
      el('option', { value: 'auto' }, L.auto.replace('{tier}', L.presets[detected()])),
      ...PRESETS.map((p) => el('option', { value: p }, L.presets[p]))
    );
    preset.value = PRESETS.includes(g.preset) ? g.preset : 'auto';
    const pct = Math.round((Number(g.render_scale) || 1) * 100);
    scale.value = String(pct);
    scaleOut.textContent = `${pct}%`;
    const tierOf = resolve(g, detected()).preset;
    for (const [cat, sel] of Object.entries(catSelects)) {
      const own = presetTier(tierOf, cat);
      sel.options[0].textContent = L.fromPreset.replace('{tier}', L.tiers[own] || own);
      sel.value = CATEGORIES[cat].includes(g[cat]) ? g[cat] : 'preset';
    }
    adaptive.checked = g.adaptive !== false;
    showFps.checked = !!g.show_fps;
    refreshSummary();
  }

  function commit(key) {
    applyGraphics();
    if (onChange) onChange('graphics.' + key);
    else storage.saveSettings(settings);
    sync();
  }

  preset.addEventListener('change', () => {
    // Choosing a preset clears per-effect overrides.
    settings.graphics = choosePreset(settings.graphics, preset.value);
    commit('preset');
  });
  scale.addEventListener('input', () => {
    settings.graphics.render_scale = Number(scale.value) / 100;
    scaleOut.textContent = `${scale.value}%`;
    applyGraphics();
    refreshSummary();
  });
  scale.addEventListener('change', () => commit('render_scale'));
  for (const [cat, sel] of Object.entries(catSelects)) {
    sel.addEventListener('change', () => {
      if (sel.value === 'preset') delete settings.graphics[cat];
      else settings.graphics[cat] = sel.value;
      commit(cat);
    });
  }
  adaptive.addEventListener('change', () => {
    settings.graphics.adaptive = adaptive.checked;
    commit('adaptive');
  });
  showFps.addEventListener('change', () => {
    settings.graphics.show_fps = showFps.checked;
    commit('show_fps');
  });

  // Keep the summary (pixels, adaptive scale, post status) current while visible.
  setInterval(() => {
    if (group.open && group.offsetParent !== null) refreshSummary();
  }, 1000);

  sync();
  return { sync, refreshSummary };
}
