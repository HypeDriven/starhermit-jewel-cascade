/**
 * main.js — Jewel Cascade bootstrap and module wiring.
 *
 * Boot order: capability detection → storage → platform/time sync → session →
 * scene/audio/ui → resume offer. This module owns the cross-module wiring so
 * each subsystem stays independent: session (rules authority) ⇄ scene (render)
 * ⇄ ui (DOM) ⇄ audio; platform (host) and analytics hang off the session.
 */

import * as storage from './storage.js';
import { GameSession } from './session.js';
import { themeById, JEWEL_PALETTES } from './engine/themes.js';
import * as rules from './engine/rules.js';

/* Modules under parallel construction — imported statically per the
 * published contracts. */
import { reviveContent } from './engine/content.js';
import { JewelScene } from './render/scene.js';
import { initUI } from './ui/ui.js';
import { AudioEngine } from './audio.js';
import { Platform } from './platform.js';
import { Analytics } from './analytics.js';

const errors = [];
window.addEventListener('error', (e) => {
  errors.push(String(e.message || e.error));
  if (window.__jc && window.__jc.analytics) window.__jc.analytics.track('error', { kind: 'window' });
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push('rejection: ' + String(e.reason));
});

function detectWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function pickAutoTier() {
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile && (cores <= 4 || dpr > 2.5)) return 'low';
  if (mobile) return 'medium';
  if (cores >= 8 && dpr >= 1.5) return 'high';
  return cores >= 4 ? 'high' : 'medium';
}

async function boot() {
  const webglAvailable = detectWebGL();
  const settings = storage.loadSettings();
  const progress = storage.loadProgress();
  if (!progress._savedAt) progress._savedAt = new Date().toISOString();

  // Honor OS reduced-motion until the player overrides it.
  if (settings.motion.reduced === false && !settings.motion._touched) {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) settings.motion.reduced = true;
    } catch {
      /* non-fatal */
    }
  }

  const platform = new Platform();
  const analytics = new Analytics({ platform, settings });
  try {
    await platform.init({ analytics });
  } catch (err) {
    console.warn('[boot] platform init failed, continuing offline', err);
  }
  if (platform.hosted) platform.syncTime().catch(() => {});

  const session = new GameSession({ settings, progress, platform, analytics });

  /* ---------------- render ---------------- */
  const canvas = document.getElementById('game-canvas');
  let scene = null;
  if (webglAvailable && canvas) {
    try {
      scene = new JewelScene(canvas, { settings });
    } catch (err) {
      console.error('[boot] scene creation failed', err);
      scene = null;
    }
  }

  /* ---------------- audio ---------------- */
  const audio = new AudioEngine({ settings });
  const unlockAudio = () => {
    audio.unlock();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  /* ---------------- theme / display application ---------------- */
  function applyTheme() {
    const theme = themeById(settings.cosmetics.theme);
    if (scene) scene.setTheme(theme);
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.dataset.theme = theme.id;
    if (audio.setAmbience) audio.setAmbience(theme.ambience);
  }
  function applyGraphics() {
    if (!scene) return;
    const tier = settings.graphics.tier === 'auto' ? pickAutoTier() : settings.graphics.tier;
    scene.setQualityTier(tier);
    scene.setRenderScale(settings.graphics.renderScale || 1);
    scene.setReducedMotion(!!settings.motion.reduced);
    scene.setCameraPreset(settings.camera.preset || 'default');
    const palette = JEWEL_PALETTES[settings.display.palette] || JEWEL_PALETTES.default;
    scene.setPalette(palette);
  }
  applyTheme();
  applyGraphics();

  /* ---------------- session ⇄ scene/audio wiring ---------------- */
  if (scene) {
    scene.onSwap = (ax, ay, bx, by) => session.trySwap(ax, ay, bx, by);
    scene.onSettled = () => session.settled();
  }
  session.on('round', ({ resumed }) => {
    if (scene) scene.buildBoard(session.state);
    if (!resumed) analytics.track('start', { mode: session.mode, id: session.content && session.content.id });
    platform.startActivity();
  });
  session.on('rules', ({ events, state, fast }) => {
    if (audio) audio.handleRulesEvents(events, state);
    if (scene) scene.playEvents(events, state, { fast: !!fast });
    // Adaptive music intensity follows cascades.
    const maxCascade = events.reduce((m, e) => (e.t === 'match' ? Math.max(m, e.cascade || 1) : m), 1);
    if (audio && audio.setScene) audio.setScene(Math.min(1, (maxCascade - 1) / 2));
  });
  session.on('undo', ({ state }) => {
    if (scene) scene.syncToState(state);
  });
  session.on('hint', (mv) => {
    if (scene) {
      scene.showHint(mv);
      setTimeout(() => scene && scene.clearHint(), 2600);
    }
  });
  session.on('skip', () => {
    if (scene) scene.skipSettle();
  });
  session.on('invalid', ({ reason, ax, ay }) => {
    if (scene && typeof ax === 'number' && session.state) {
      scene.flashInvalid(rules.idx(session.state, ax, ay), reason);
    }
    if (audio) audio.uiSound('error');
  });
  session.on('fsm', ({ to }) => {
    if (!scene) return;
    if (to === 'paused') scene.setPaused(true);
    if (to === 'active' || to === 'resolving' || to === 'countdown') scene.setPaused(false);
  });
  session.on('results', (r) => {
    if (audio) audio.uiSound(r.won ? 'win' : 'lose');
    platform.endActivity();
  });

  /* ---------------- ui ---------------- */
  const ui = initUI({
    session,
    scene,
    audio,
    platform,
    analytics,
    settings,
    progress,
    storage,
    webglAvailable,
    applyTheme,
    applyGraphics,
  });

  /* ---------------- clock, visibility, resize ---------------- */
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    session.tick(dt);
  }, 100);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Backgrounding pauses solo simulation; decorative motion stops.
      if (session.status === 'active' || session.status === 'resolving') session.pause('hidden');
      if (scene) scene.setHidden(true);
      if (audio && audio.suspend) audio.suspend();
      session.saveSnapshot();
    } else {
      if (scene) scene.setHidden(false);
      if (audio && audio.resume) audio.resume();
      lastTick = performance.now();
    }
  });

  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (scene) scene.resize();
      if (ui && ui.onResize) ui.onResize();
    });
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (scene) scene.resize();
    }, 250);
  });

  /* ---------------- adaptive render scale (auto governor) ---------------- */
  if (scene) {
    let lowSince = 0;
    let highSince = 0;
    setInterval(() => {
      if (settings.graphics.tier !== 'auto') return;
      const stats = scene.getStats ? scene.getStats() : null;
      if (!stats || !stats.fps) return;
      const now = performance.now();
      if (stats.fps < 45) {
        lowSince = lowSince || now;
        highSince = 0;
        if (now - lowSince > 2000 && settings.graphics.renderScale > 0.55) {
          settings.graphics.renderScale = Math.max(0.55, +(settings.graphics.renderScale - 0.15).toFixed(2));
          scene.setRenderScale(settings.graphics.renderScale);
          lowSince = 0;
        }
      } else if (stats.fps > 58) {
        highSince = highSince || now;
        lowSince = 0;
        if (now - highSince > 10000 && settings.graphics.renderScale < 1) {
          settings.graphics.renderScale = Math.min(1, +(settings.graphics.renderScale + 0.15).toFixed(2));
          scene.setRenderScale(settings.graphics.renderScale);
          highSince = 0;
        }
      } else {
        lowSince = 0;
        highSince = 0;
      }
    }, 1000);
  }

  /* ---------------- presence + cloud save ---------------- */
  setInterval(() => {
    if (session.status === 'active' || session.status === 'resolving') {
      platform.presencePing({ status: 'playing', mode: session.mode });
    }
  }, 30000);
  function pushCloud() {
    if (!platform.hosted || !platform.cloudSave) return;
    progress._savedAt = new Date().toISOString();
    platform.cloudSave(progress).then((res) => {
      if (res && res.conflict && ui && ui.resolveCloudConflict) {
        ui.resolveCloudConflict(res.theirs, progress);
      }
    }).catch(() => {});
  }
  setInterval(pushCloud, 60000);
  window.addEventListener('pagehide', () => {
    platform.endActivity();
    session.saveSnapshot();
    pushCloud();
  });
  if (platform.hosted && platform.cloudLoad) {
    platform.cloudLoad().then((remote) => {
      if (!remote || !remote.doc) return;
      const localNewer = (progress._savedAt || '') >= (remote.doc._savedAt || '');
      if (localNewer) return;
      if (ui && ui.resolveCloudConflict) ui.resolveCloudConflict(remote.doc, progress);
    }).catch(() => {});
  }

  /* ---------------- resume offer ---------------- */
  const snap = storage.loadRoundSnapshot();
  if (snap && snap.stateJson && ui && ui.offerResume) {
    try {
      const probe = rules.deserialize(snap.stateJson);
      if (probe.phase === 'ready') {
        ui.offerResume(snap, () => {
          session._roundIdKept = snap.roundId;
          session.startRound(reviveContent(snap.content), {
            resumed: true,
            resumedState: snap.stateJson,
            resumedCommands: snap.commands,
          });
          session.beginPlay('resumed');
        });
      }
    } catch (err) {
      console.warn('[boot] discarding unreadable snapshot', err);
      storage.clearRoundSnapshot();
    }
  }

  session.transition('title', 'boot-complete');
  window.__jc = { session, scene, ui, audio, platform, analytics, settings, progress, storage, rules, errors };
  console.log('[jewel-cascade] booted, webgl:', webglAvailable, 'hosted:', platform.hosted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => console.error('[boot]', e)));
} else {
  boot().catch((e) => console.error('[boot]', e));
}
