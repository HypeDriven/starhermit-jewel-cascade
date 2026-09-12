/**
 * ui.js — Jewel Cascade semantic HTML interface layer.
 *
 * Owns every DOM surface: screens and overlays, HUD, the text mirror board
 * (full no-WebGL / screen-reader path), menus, settings with remappable
 * keyboard/gamepad bindings, help cards generated from the CURRENT control
 * mappings, results, achievements, leaderboards, profile/cosmetics, toasts,
 * live-region announcements, and the Learn-mode tutorial runner.
 *
 * The Three.js canvas is never the only UI. UI state is strictly separate
 * from simulation state: this module reads session snapshots and emits
 * validated commands only through the session API.
 */

import * as rules from '../engine/rules.js';
import { SPECIAL_NAMES, SPECIAL } from '../engine/rules.js';
import * as content from '../engine/content.js';
import { ACHIEVEMENTS, MASTERY_LEVELS, masteryLevelForXp } from '../engine/achievements.js';
import { THEMES } from '../engine/themes.js';

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

const COLOR_GLYPHS = ['R', 'A', 'T', 'E', 'S', 'M', 'O']; // mirror letters
const COLOR_GLYPH_NAMES = ['ruby', 'amber', 'topaz', 'emerald', 'sapphire', 'amethyst', 'opal'];
const SPECIAL_GLYPHS = { [SPECIAL.RAY_H]: '↔', [SPECIAL.RAY_V]: '↕', [SPECIAL.BLOOM]: '✳', [SPECIAL.PRISM]: '◆' };
const INVALID_TEXT = {
  'ended': 'The round is over.',
  'out-of-bounds': 'That cell is outside the board.',
  'not-adjacent': 'Jewels must be neighbours to swap.',
  'no-jewel': 'There is no jewel there.',
  'crate-cell': 'Crates cannot be moved — match beside them.',
  'ice-locked': 'That jewel is frozen in ice. Match through it to crack it.',
  'no-match': 'That swap makes no line of three.',
  'bad-command': 'That move was not understood.',
  'duplicate': 'Already done.',
  'no-undo': 'Nothing to undo.',
  'not-active': 'Hold on — the board is settling.',
  'filtered': 'The lesson is guiding a different move.',
};

const REASON_HEADLINES = {
  'goals-complete': 'Commission complete!',
  'out-of-moves': 'Out of moves',
  resigned: 'Round resigned',
  'time-expired': 'Time expired',
};

const DEFAULT_KEYBOARD = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  confirm: 'Enter',
  confirm2: ' ',
  cancel: 'Escape',
  pause: 'p',
  hint: 'h',
  undo: 'u',
  skip: 's',
  camera: 'c',
  mute: 'm',
  help: '?',
};
const DEFAULT_GAMEPAD = {
  confirm: 0, // A / cross
  cancel: 1, // B / circle
  hint: 2, // X / square
  undo: 3, // Y / triangle
  camera: 5, // RB
  pause: 9, // start
};

const ACTION_LABELS = {
  up: 'Cursor up',
  down: 'Cursor down',
  left: 'Cursor left',
  right: 'Cursor right',
  confirm: 'Select / swap',
  confirm2: 'Select / swap (alt)',
  cancel: 'Cancel / back',
  pause: 'Pause',
  hint: 'Hint',
  undo: 'Undo',
  skip: 'Skip animation',
  camera: 'Camera preset',
  mute: 'Mute',
  help: 'Help',
};
const GAMEPAD_ACTIONS = ['confirm', 'cancel', 'hint', 'undo', 'camera', 'pause'];

const COMPONENT_LABELS = {
  match: 'Matches',
  cascade: 'Cascade bonuses',
  special: 'Specials',
  blocker: 'Blockers cleared',
  goal: 'Goal bonuses',
  leftover: 'Unused-move bonus',
};

/* ------------------------------------------------------------------ *
 *  Small DOM helpers
 * ------------------------------------------------------------------ */

function $(id) {
  return document.getElementById(id);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}
function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
function keyLabel(code) {
  if (code === ' ') return 'Space';
  if (code === '?') return '?';
  return code.replace(/^Arrow/, '');
}
function goalText(g) {
  if (g.type === 'collect') return 'Collect ' + g.n + ' ' + COLOR_GLYPH_NAMES[g.color];
  if (g.type === 'ice') return 'Break ' + g.n + ' ice';
  if (g.type === 'crates') return 'Break ' + g.n + ' crates';
  if (g.type === 'score') return 'Score ' + fmtInt(g.n);
  return g.type;
}
function goalLeftText(g) {
  if (g.done) return 'done';
  if (g.type === 'score') return fmtInt(g.left) + ' to go';
  return g.left + ' left';
}

/* ------------------------------------------------------------------ *
 *  initUI
 * ------------------------------------------------------------------ */

export function initUI(deps) {
  const { session, scene, audio, platform, analytics, settings, progress, storage, webglAvailable, applyTheme, applyGraphics } = deps;

  const ui = {};
  const srLive = $('sr-live');
  const srAlert = $('sr-alert');
  let lastAnnounce = 0;

  function announce(msg, assertive) {
    const now = performance.now();
    if (!assertive && now - lastAnnounce < 900) return;
    lastAnnounce = now;
    (assertive ? srAlert : srLive).textContent = '';
    // Reassign after a tick so screen readers notice repeated text.
    setTimeout(() => {
      (assertive ? srAlert : srLive).textContent = msg;
    }, 30);
  }

  function toast(msg, kind, silent) {
    const region = $('toast-region');
    const t = el('div', 'toast' + (kind ? ' toast-' + kind : ''), msg);
    region.appendChild(t);
    while (region.children.length > 3) region.removeChild(region.firstChild);
    if (!silent) audio.uiSound('toast');
    setTimeout(() => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 400);
    }, 2600);
  }

  /* ============ generic control feedback (hover tick / secondary click) ============ */

  let lastHoverAt = 0;
  document.addEventListener('pointerover', (e) => {
    const ctrl = e.target && e.target.closest ? e.target.closest('button, select, input, a[href]') : null;
    if (!ctrl || ctrl.disabled) return;
    const now = performance.now();
    if (now - lastHoverAt < 90) return;
    lastHoverAt = now;
    audio.uiSound('hover');
  });
  // Primary/danger buttons and nav controls carry their own sounds
  // (confirm/open/back/tab); plain secondary buttons get the glass click.
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button.btn') : null;
    if (!btn || btn.disabled || btn.classList.contains('btn-primary') || btn.hasAttribute('data-goto')) return;
    audio.uiSound('click');
  });

  /* ============ screen manager ============ */

  const screens = [...document.querySelectorAll('.screen')];
  const overlayStack = [];
  let currentScreen = 'boot';

  function sectionOf(name) {
    return screens.find((s) => s.dataset.screen === name);
  }

  function focusFirst(root) {
    const target =
      root.querySelector('[data-autofocus]') ||
      root.querySelector('button.btn-primary, h1, h2, button, [tabindex]');
    if (target) {
      if (!target.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(target.tagName)) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    }
  }

  function showScreen(name) {
    for (const s of screens) {
      if (!s.classList.contains('overlay')) s.hidden = s.dataset.screen !== name;
    }
    currentScreen = name;
    document.body.classList.toggle('in-game', name === 'game');
    const sec = sectionOf(name);
    if (sec) focusFirst(sec);
    updateInsets();
  }

  function openOverlay(name) {
    const sec = sectionOf(name);
    if (!sec || !sec.hidden) return;
    sec.hidden = false;
    overlayStack.push({ name, returnFocus: document.activeElement });
    focusFirst(sec);
  }

  function closeOverlay(name) {
    const i = overlayStack.findIndex((o) => o.name === name);
    if (i < 0) return;
    const [entry] = overlayStack.splice(i, 1);
    sectionOf(name).hidden = true;
    if (entry.returnFocus && entry.returnFocus.isConnected) {
      entry.returnFocus.focus({ preventScroll: true });
    }
  }

  function anyOverlayOpen() {
    return overlayStack.length > 0;
  }

  // Focus trap: keep Tab cycling inside the topmost overlay.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || overlayStack.length === 0) return;
    const top = sectionOf(overlayStack[overlayStack.length - 1].name);
    const focusables = [...top.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(
      (n) => !n.disabled && n.offsetParent !== null
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ============ modal utility (resume offer, cloud conflict, confirms) ============ */

  function modal({ title, body, actions }) {
    return new Promise((resolve) => {
      const root = $('modal-root');
      const wrap = el('div', 'modal-backdrop');
      const box = el('div', 'panel modal-box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const h = el('h2', null, title);
      box.appendChild(h);
      if (typeof body === 'string') box.appendChild(el('p', null, body));
      else if (body) box.appendChild(body);
      const row = el('div', 'row-end');
      const done = (value) => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        audio.uiSound('close');
        resolve(value);
      };
      for (const a of actions) {
        const b = el('button', 'btn' + (a.primary ? ' btn-primary' : ''), a.label);
        b.addEventListener('click', () => done(a.value));
        row.appendChild(b);
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(actions[actions.length - 1].value);
        }
      };
      document.addEventListener('keydown', onKey, true);
      box.appendChild(row);
      wrap.appendChild(box);
      root.appendChild(wrap);
      const firstBtn = row.querySelector('.btn-primary') || row.querySelector('button');
      if (firstBtn) firstBtn.focus();
      audio.uiSound('open');
    });
  }

  ui.offerResume = (snap, cb) => {
    let moves = '?';
    let score = '?';
    try {
      const probe = rules.deserialize(snap.stateJson);
      moves = probe.movesLeft;
      score = probe.score;
    } catch {
      /* best-effort display */
    }
    const body = el('div');
    body.appendChild(el('p', null, 'You have an interrupted round:'));
    body.appendChild(el('p', 'dim', (snap.content && snap.content.name ? snap.content.name : 'Round') + ' — score ' + fmtInt(score) + ', ' + moves + ' moves left.'));
    modal({
      title: 'Resume round?',
      body,
      actions: [
        { label: 'Resume', value: 'resume', primary: true },
        { label: 'Discard', value: 'discard' },
      ],
    }).then((v) => {
      if (v === 'resume') cb();
      else storage.clearRoundSnapshot();
    });
  };

  ui.resolveCloudConflict = (theirs, mine) => {
    const body = el('div');
    body.appendChild(el('p', null, 'Your cloud save and this device disagree. Both copies are kept; choose which one to continue with.'));
    const dl = el('dl', 'facts');
    const row = (k, a, b) => {
      const d = el('div');
      const dt = el('dt', null, k);
      const dd = el('dd', null, 'device: ' + a + ' · cloud: ' + b);
      d.appendChild(dt);
      d.appendChild(dd);
      dl.appendChild(d);
    };
    const stars = (p) => Object.values(p.journeyStars || {}).reduce((n, s) => n + s, 0);
    row('Journey stars', stars(mine), stars(theirs));
    row('Mastery XP', mine.masteryXp || 0, theirs.masteryXp || 0);
    row('Saved', (mine._savedAt || 'never').slice(0, 16), (theirs._savedAt || 'never').slice(0, 16));
    body.appendChild(dl);
    modal({
      title: 'Save conflict',
      body,
      actions: [
        { label: 'Keep device', value: 'local', primary: true },
        { label: 'Use cloud', value: 'cloud' },
      ],
    }).then((v) => {
      if (v === 'cloud') {
        // Preserve the losing snapshot locally before adopting the cloud doc.
        try {
          window.localStorage.setItem('jewelcascade.progress-backup', JSON.stringify({ at: new Date().toISOString(), doc: mine }));
        } catch {
          /* best effort */
        }
        for (const k of Object.keys(mine)) delete mine[k];
        Object.assign(mine, theirs);
        storage.saveProgress(mine);
        refreshMetaScreens();
        toast('Cloud save applied.', 'ok');
      } else {
        try {
          window.localStorage.setItem('jewelcascade.progress-backup', JSON.stringify({ at: new Date().toISOString(), doc: theirs }));
        } catch {
          /* best effort */
        }
      }
    });
  };

  ui.syncChanged = () => {
    refreshTitle();
    if (currentScreen === 'profile') refreshProfile();
  };

  ui.cloudApplied = () => {
    refreshMetaScreens();
    toast('Cloud save applied.', 'ok');
  };

  /* ============ title / chips ============ */

  // Hosted shows the platform nickname; offline/dev shows the local editable
  // display name. Never a username.
  function playerName() {
    return platform.hosted && platform.profile && platform.profile.displayName ? platform.profile.displayName : settings.player.displayName || 'Guest';
  }

  const SYNC_LABELS = { offline: 'cloud: offline', saving: 'cloud: saving…', synced: 'cloud: synced', error: 'cloud: sync error' };
  function syncLabel() {
    return SYNC_LABELS[platform.syncState] || '';
  }

  function refreshTitle() {
    const total = content.JOURNEY.length;
    const stars = Object.values(progress.journeyStars || {}).reduce((n, s) => n + s, 0);
    const nextStage = Math.min(progress.journeyUnlocked || 1, total);
    $('chip-journey-sub').textContent = 'Stage ' + nextStage + ' of ' + total + ' · ' + stars + '★';
    const level = masteryLevelForXp(progress.masteryXp || 0);
    $('chip-profile-sub').textContent = playerName() + ' · mastery ' + level + (platform.hosted ? ' · ' + syncLabel() : '');
    refreshDailyChip();
  }

  function refreshDailyChip() {
    const key = content.dayKeyFor(platform.now());
    const best = (progress.daily.best || {})[key];
    $('chip-daily-sub').textContent = (best ? 'Best ' + fmtInt(best) + ' · ' : '') + 'new board in ' + dailyCountdown();
  }

  function dailyCountdown() {
    const now = platform.now();
    const next = Date.parse(content.dayKeyFor(now) + 'T00:00:00Z') + 86400000;
    const left = Math.max(0, next - now);
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const s = Math.floor((left % 60000) / 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  setInterval(() => {
    if (currentScreen === 'title') refreshDailyChip();
  }, 1000);

  $('brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    leaveToTitle();
  });
  $('btn-play').addEventListener('click', () => {
    audio.uiSound('confirm');
    session.transition('mode-select', 'play');
  });
  $('chip-daily').addEventListener('click', () => openSetup('daily'));
  $('chip-journey').addEventListener('click', () => {
    session.transition('mode-select', 'journey-chip');
    openJourney();
  });
  $('chip-profile').addEventListener('click', () => {
    session.transition('profile-ready', 'profile-chip');
    showScreen('profile');
    refreshProfile();
  });

  for (const btn of document.querySelectorAll('[data-goto]')) {
    btn.addEventListener('click', () => {
      audio.uiSound('back');
      const to = btn.dataset.goto;
      if (to === 'title') {
        leaveToTitle();
      } else if (to === 'mode-select') {
        session.transition('mode-select', 'back');
        showScreen('mode-select');
      }
    });
  }
  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      if (nav === 'boards') {
        showScreen('boards');
        refreshBoards();
      } else if (nav === 'achievements') {
        showScreen('achievements');
        refreshAchievements();
      } else if (nav === 'help') {
        showScreen('help');
        refreshHelp();
      } else if (nav === 'settings') {
        openOverlay('settings');
      }
      audio.uiSound('open');
    });
  }

  function leaveToTitle() {
    if (session.status === 'active' || session.status === 'resolving') session.pause('leave');
    if (session.status === 'paused') session.abandon('leave');
    if (session.status !== 'title') session.transition('title', 'home');
    refreshTitle();
    showScreen('title');
  }

  /* ============ mode select + setup ============ */

  let setupMode = null;
  let setupChoice = null; // content descriptor chosen in setup

  for (const card of document.querySelectorAll('.mode-card')) {
    card.addEventListener('click', () => openSetup(card.dataset.mode));
  }

  function openSetup(mode) {
    audio.uiSound('open');
    if (mode === 'journey') {
      if (session.status === 'title') session.transition('mode-select', 'journey');
      openJourney();
      return;
    }
    if (session.status === 'title') session.transition('mode-select', mode);
    setupMode = mode;
    setupChoice = null;
    $('setup-h').textContent = 'Setup — ' + modeName(mode);
    $('setup-summary').hidden = true;
    $('setup-start').disabled = true;
    buildSetupPicker(mode);
    showScreen('setup');
  }

  function modeName(mode) {
    return { learn: 'Learn', journey: 'Journey', daily: 'Daily', practice: 'Practice', challenge: 'Challenge', score: 'Score chase' }[mode] || mode;
  }

  function buildSetupPicker(mode) {
    const host = $('setup-picker');
    host.innerHTML = '';
    const pick = (c) => {
      setupChoice = c;
      fillSetupSummary(c);
      host.querySelectorAll('.picker-item').forEach((n) => n.setAttribute('aria-pressed', 'false'));
      const btn = host.querySelector('[data-content-id="' + CSS.escape(c.id) + '"]');
      if (btn) btn.setAttribute('aria-pressed', 'true');
      $('setup-start').disabled = false;
    };

    if (mode === 'learn') {
      const list = el('ul', 'picker-list');
      for (const lesson of content.LESSONS) {
        const done = progress.tutorialsDone && progress.tutorialsDone[lesson.tutorial];
        const item = el('button', 'picker-item');
        item.dataset.contentId = lesson.id;
        item.setAttribute('aria-pressed', 'false');
        item.appendChild(el('span', null, lesson.name));
        item.appendChild(el('span', 'done-mark', done ? '✓ done' : ''));
        item.addEventListener('click', () => pick(lesson));
        const li = el('li');
        li.appendChild(item);
        list.appendChild(li);
      }
      host.appendChild(list);
      return;
    }

    if (mode === 'daily') {
      const key = content.dayKeyFor(platform.now());
      const c = content.dailyContent(key);
      const list = el('ul', 'picker-list');
      const item = el('button', 'picker-item');
      item.dataset.contentId = c.id;
      item.setAttribute('aria-pressed', 'false');
      const best = (progress.daily.best || {})[key];
      item.appendChild(el('span', null, c.name));
      item.appendChild(el('span', 'done-mark', best ? 'best ' + fmtInt(best) : ''));
      item.addEventListener('click', () => pick(c));
      const li = el('li');
      li.appendChild(item);
      list.appendChild(li);
      host.appendChild(list);
      const note = el('p', 'dim', 'One shared seed per UTC day. Ranked when connected; validated by replay. Next board in ' + dailyCountdown() + '.');
      host.appendChild(note);
      pick(c);
      return;
    }

    if (mode === 'practice') {
      const list = el('ul', 'picker-list');
      for (const d of content.PRACTICE_DIFFICULTIES) {
        const item = el('button', 'picker-item');
        item.dataset.contentId = 'practice-' + d.id;
        item.setAttribute('aria-pressed', 'false');
        item.appendChild(el('span', null, d.name));
        item.appendChild(el('span', 'dim', d.desc));
        item.addEventListener('click', () => {
          const seed = ($('practice-seed') || {}).value || '';
          pick(content.practiceContent(d.id, seed));
        });
        const li = el('li');
        li.appendChild(item);
        list.appendChild(li);
      }
      host.appendChild(list);
      const row = el('div', 'picker-row');
      const label = el('label', null, 'Seed (optional)');
      const input = el('input');
      input.type = 'text';
      input.id = 'practice-seed';
      input.placeholder = 'random';
      input.maxLength = 32;
      label.htmlFor = 'practice-seed';
      row.appendChild(label);
      row.appendChild(input);
      host.appendChild(row);
      return;
    }

    if (mode === 'challenge') {
      const list = el('ul', 'picker-list');
      for (const c of content.CHALLENGES) {
        const best = (progress.challengesDone || {})[c.id];
        const item = el('button', 'picker-item');
        item.dataset.contentId = c.id;
        item.setAttribute('aria-pressed', 'false');
        item.appendChild(el('span', null, c.name));
        item.appendChild(el('span', 'done-mark', best ? '★'.repeat(best) : ''));
        item.addEventListener('click', () => pick(c));
        const li = el('li');
        li.appendChild(item);
        list.appendChild(li);
      }
      host.appendChild(list);
      return;
    }

    if (mode === 'score') {
      const row = el('div', 'picker-row');
      const label = el('label', null, 'Seed');
      label.htmlFor = 'chase-seed';
      const input = el('input');
      input.type = 'text';
      input.id = 'chase-seed';
      input.placeholder = 'any word or phrase';
      input.maxLength = 40;
      const randBtn = el('button', 'btn btn-small', 'Random');
      randBtn.addEventListener('click', () => {
        input.value = Math.random().toString(36).slice(2, 10);
        pick(content.scoreChaseContent(input.value));
      });
      const todayBtn = el('button', 'btn btn-small', "Today's seed");
      todayBtn.addEventListener('click', () => {
        input.value = content.dayKeyFor(platform.now());
        pick(content.scoreChaseContent(input.value));
      });
      input.addEventListener('input', () => {
        if (input.value.trim()) pick(content.scoreChaseContent(input.value));
      });
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(randBtn);
      row.appendChild(todayBtn);
      host.appendChild(row);
      host.appendChild(el('p', 'dim', 'Share a seed with a friend to chase the same board. Fixed ruleset; scores are replay-validated when connected.'));
      return;
    }
  }

  function fillSetupSummary(c) {
    $('setup-summary').hidden = false;
    $('setup-name').textContent = c.name;
    $('setup-desc').textContent = c.desc;
    const blockers = [];
    if (c.ice && c.ice.length) blockers.push(c.ice.length + ' ice');
    if (c.crates && c.crates.length) blockers.push(c.crates.length + ' crates');
    $('setup-rules').textContent = c.width + '×' + c.height + ' · ' + c.colors + ' colors · ' + (c.moves > 100 ? 'unlimited' : c.moves) + ' moves' + (blockers.length ? ' · ' + blockers.join(', ') : '');
    $('setup-duration').textContent = c.timeLimitSec ? fmtTime(c.timeLimitSec * 1000) + ' timed' : '~' + Math.max(1, Math.round((Math.min(c.moves, 40) * 4) / 60)) + ' min';
    $('setup-players').textContent = '1';
    const assists = [];
    assists.push(c.assists.undo ? 'undo' : 'no undo');
    assists.push(c.assists.hints ? 'hints' : 'no hints');
    if (settings.access.timingAssist && c.timeLimitSec) assists.push('timing assist ×1.5');
    $('setup-assists').textContent = assists.join(', ');
    $('setup-ranked').textContent = c.ranked ? (!platform.online ? 'Ranked (recorded locally)' : platform.hosted ? 'Ranked (personal bests)' : 'Ranked (replay-validated)') : 'Casual';
    const goals = $('setup-goals');
    goals.innerHTML = '';
    if (c.kind === 'lesson') {
      goals.appendChild(el('li', null, 'Finish every guided step.'));
    } else {
      for (const g of c.goals) goals.appendChild(goalListItem(g));
    }
  }

  function goalListItem(g) {
    const li = el('li', g.done ? 'done' : null);
    if (g.type === 'collect') {
      const sw = el('span', 'swatch c' + g.color, COLOR_GLYPHS[g.color]);
      sw.setAttribute('aria-hidden', 'true');
      li.appendChild(sw);
    } else if (g.type === 'ice') {
      const sw = el('span', 'swatch ice', '❄');
      sw.setAttribute('aria-hidden', 'true');
      li.appendChild(sw);
    } else if (g.type === 'crates') {
      const sw = el('span', 'swatch blocker', '▣');
      sw.setAttribute('aria-hidden', 'true');
      li.appendChild(sw);
    }
    li.appendChild(el('span', null, goalText(g) + (g.done !== undefined ? ' — ' + goalLeftText(g) : '')));
    if (g.done) {
      const chk = el('span', 'goal-check', '✓');
      chk.setAttribute('aria-label', 'done');
      li.appendChild(chk);
    }
    return li;
  }

  $('setup-back').addEventListener('click', () => {
    session.transition('mode-select', 'setup-back');
    showScreen('mode-select');
  });
  $('setup-start').addEventListener('click', () => {
    if (!setupChoice) return;
    audio.uiSound('confirm');
    session.startRound(setupChoice);
  });

  /* ============ journey map ============ */

  function openJourney() {
    showScreen('journey');
    const grid = $('journey-grid');
    grid.innerHTML = '';
    const unlocked = progress.journeyUnlocked || 1;
    let totalStars = 0;
    content.JOURNEY.forEach((c, i) => {
      const n = i + 1;
      const got = (progress.journeyStars || {})[c.id] || 0;
      totalStars += got;
      const li = el('li');
      const b = el('button', 'stage-btn' + (n === unlocked ? ' current' : ''));
      b.disabled = n > unlocked;
      b.setAttribute('aria-label', 'Stage ' + n + (c.mastery ? ' (mastery)' : '') + (got ? ', ' + got + ' stars' : '') + (n > unlocked ? ', locked' : ''));
      b.appendChild(el('span', null, String(n)));
      const starSpan = el('span', 'stage-stars');
      for (let s = 1; s <= 3; s++) starSpan.appendChild(el('span', s <= got ? null : 'off', '★'));
      b.appendChild(starSpan);
      if (c.mastery) {
        const m = el('span', 'stage-mastery', '◆');
        m.setAttribute('aria-hidden', 'true');
        b.appendChild(m);
      }
      b.addEventListener('click', () => {
        setupMode = 'journey';
        setupChoice = c;
        $('setup-h').textContent = 'Setup — Journey';
        buildSetupPicker('journey');
        fillSetupSummary(c);
        $('setup-start').disabled = false;
        showScreen('setup');
      });
      li.appendChild(b);
      grid.appendChild(li);
    });
    const done = Object.keys(progress.journeyStars || {}).length;
    $('journey-progress-line').textContent = done + ' of ' + content.JOURNEY.length + ' stages complete · ' + totalStars + '★ earned · mastery stages marked ◆';
  }

  /* ============ FSM → screens ============ */

  session.on('fsm', ({ to, reason }) => {
    switch (to) {
      case 'title':
        closeAllOverlays();
        refreshTitle();
        showScreen('title');
        break;
      case 'mode-select':
        closeAllOverlays();
        showScreen('mode-select');
        break;
      case 'profile-ready':
        showScreen('profile');
        refreshProfile();
        break;
      case 'preparing':
        closeAllOverlays();
        showScreen('game');
        break;
      case 'countdown':
        showScreen('game');
        runCountdown();
        break;
      case 'tutorial':
        $('hud-state').textContent = 'Lesson';
        showScreen('game');
        startLesson();
        break;
      case 'active':
        if (reason === 'resume') {
          closeOverlay('pause');
          audio.uiSound('resume');
        }
        $('hud-state').textContent = 'Your move';
        break;
      case 'resolving':
        $('hud-state').textContent = 'Settling…';
        break;
      case 'paused':
        $('hud-state').textContent = 'Paused';
        openOverlay('pause');
        audio.uiSound('pause');
        break;
      case 'results':
        closeOverlay('pause');
        break;
      default:
        break;
    }
    updateInsets();
  });

  function closeAllOverlays() {
    while (overlayStack.length) closeOverlay(overlayStack[overlayStack.length - 1].name);
    $('tutorial-banner').hidden = true;
    $('ready-overlay').hidden = true;
  }

  /* ============ countdown ============ */

  let countdownTimers = [];
  function runCountdown() {
    const overlay = $('ready-overlay');
    const text = $('ready-text');
    const steps = ['Ready…', 'Set…', 'Go!'];
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    announce('Get ready', true);
    countdownTimers.forEach(clearTimeout);
    countdownTimers = [];
    steps.forEach((s, i) => {
      countdownTimers.push(
        setTimeout(() => {
          text.textContent = s;
          text.classList.remove('ready-pop');
          void text.offsetWidth; // restart CSS animation
          text.classList.add('ready-pop');
          audio.uiSound('tick');
          if (i === steps.length - 1) audio.uiSound('confirm');
        }, i * 620)
      );
    });
    countdownTimers.push(
      setTimeout(() => {
        overlay.hidden = true;
        session.beginPlay('countdown-complete');
        announce('Go! ' + (session.content ? session.content.name : ''), true);
      }, steps.length * 620 + 120)
    );
  }

  /* ============ HUD ============ */

  let hudGoalKey = '';
  session.on('hud', (h) => {
    $('hud-score').textContent = fmtInt(h.score);
    $('hud-moves').textContent = h.movesLeft > 100 ? '∞' : String(h.movesLeft);
    const timerWrap = $('hud-timer-wrap');
    if (h.timeLeftMs !== null && h.timeLeftMs !== undefined) {
      timerWrap.hidden = false;
      $('hud-timer').textContent = fmtTime(h.timeLeftMs);
      timerWrap.classList.toggle('warn', h.timeLeftMs < 10000);
    } else {
      timerWrap.hidden = true;
    }
    const key = h.goals.map((g) => g.left + (g.done ? 'd' : '')).join(',');
    if (key !== hudGoalKey) {
      hudGoalKey = key;
      const list = $('hud-goals');
      list.innerHTML = '';
      h.goals.forEach((g) => list.appendChild(goalListItem(g)));
      announce('Score ' + fmtInt(h.score) + '. ' + (h.movesLeft > 100 ? 'Unlimited moves.' : h.movesLeft + ' moves left.') + ' ' + h.goals.map((g) => goalText(g) + ' ' + goalLeftText(g)).join('. '));
      mirrorRender();
    }
  });

  session.on('timer', ({ leftMs }) => {
    $('hud-timer').textContent = fmtTime(leftMs);
    $('hud-timer-wrap').classList.toggle('warn', leftMs < 10000);
    audio.timerUpdate(leftMs);
    if (leftMs > 0 && leftMs <= 10500 && Math.round(leftMs / 1000) !== Math.round((leftMs + 100) / 1000)) {
      announce(Math.ceil(leftMs / 1000) + ' seconds', false);
    }
  });

  session.on('round', ({ content: c, resumed }) => {
    $('hud-round-name').textContent = c.name;
    hudGoalKey = '';
    const assists = [];
    if (c.assists.undo) assists.push('Undo allowed');
    if (!c.assists.hints) assists.push('No hints');
    if (c.ranked) assists.push('Ranked');
    $('hud-assists-line').textContent = assists.join(' · ');
    $('btn-undo').disabled = !c.assists.undo;
    $('tray-undo').disabled = !c.assists.undo;
    $('btn-hint').disabled = !c.assists.hints;
    $('tray-hint').disabled = !c.assists.hints;
    $('hud-state').textContent = resumed ? 'Resumed' : 'Get ready';
    mirrorBuild();
    if (!webglAvailable) {
      $('webgl-fallback').hidden = false;
      setMirror(true);
    }
  });

  session.on('invalid', ({ reason }) => {
    const msg = INVALID_TEXT[reason] || 'That move is not legal.';
    toast(msg, 'warn');
    announce(msg, true);
  });

  session.on('hint', () => {
    audio.uiSound('hint');
    toast('Hint: watch the two highlighted jewels.', null, true);
    announce('Hint shown on the board.', false);
  });

  session.on('undo', () => {
    audio.uiSound('undo');
    toast('Undone.', null, true);
    mirrorRender();
  });

  session.on('rules', () => {
    // The mirror reads the authoritative snapshot directly.
    mirrorRenderSoon();
  });

  /* ============ round actions ============ */

  $('btn-hint').addEventListener('click', () => session.hint());
  $('tray-hint').addEventListener('click', () => session.hint());
  $('btn-undo').addEventListener('click', () => session.undo());
  $('tray-undo').addEventListener('click', () => session.undo());
  $('btn-skip').addEventListener('click', () => session.requestSkip());
  $('btn-camera').addEventListener('click', cycleCamera);
  $('btn-pause').addEventListener('click', () => session.pause('user'));
  $('tray-pause').addEventListener('click', () => session.pause('user'));
  $('btn-resume').addEventListener('click', () => session.resume());
  $('btn-pause-settings').addEventListener('click', () => openOverlay('settings'));
  $('btn-pause-help').addEventListener('click', () => {
    refreshHelp();
    closeOverlay('pause');
    openOverlayFromGame('help');
  });
  $('btn-pause-restart').addEventListener('click', () => {
    closeOverlay('pause');
    session.restart();
  });
  $('btn-pause-leave').addEventListener('click', () => {
    closeOverlay('pause');
    session.abandon('leave');
  });
  $('btn-help-back').addEventListener('click', () => {
    if (helpFromGame) {
      helpFromGame = false;
      showScreen('game');
      openOverlay('pause');
    } else {
      leaveToTitle();
    }
  });

  let helpFromGame = false;
  function openOverlayFromGame(name) {
    helpFromGame = true;
    showScreen(name);
  }

  function cycleCamera() {
    const order = ['default', 'low', 'high'];
    const cur = order.indexOf(settings.camera.preset || 'default');
    const next = order[(cur + 1) % order.length];
    settings.camera.preset = next;
    storage.saveSettings(settings);
    if (scene) scene.setCameraPreset(next);
    toast('Camera: ' + next, null);
  }

  session.on('fsm', ({ to }) => {
    $('btn-skip').hidden = !(to === 'resolving');
  });

  /* ============ drawer tabs + thumb tray ============ */

  for (const [tabId, railId] of [
    ['tab-objective', 'rail-objective'],
    ['tab-actions', 'rail-actions'],
  ]) {
    const tab = $(tabId);
    const rail = $(railId);
    tab.addEventListener('click', () => {
      const open = rail.classList.toggle('open');
      tab.setAttribute('aria-expanded', String(open));
      audio.uiSound('tab');
      if (open) rail.querySelector('button, h2').focus({ preventScroll: true });
      updateInsets();
    });
  }

  /* ============ tutorial runner (Learn mode) ============ */

  let lesson = null; // {steps, i}
  session.on('round', ({ content: c, resumed }) => {
    lesson = null;
    session.inputFilter = null;
    if (c.tutorial && !resumed) {
      lesson = { content: c, steps: c.steps || [], i: 0 };
    }
  });

  function startLesson() {
    if (!lesson || !lesson.steps.length) return;
    // Re-entering 'tutorial' after every guided move would otherwise re-announce
    // and re-track the step the player is already on.
    if (lesson.shownStep === lesson.i) return;
    showLessonStep();
  }

  function showLessonStep() {
    lesson.shownStep = lesson.i;
    const s = lesson.steps[lesson.i];
    const banner = $('tutorial-banner');
    banner.hidden = false;
    $('tutorial-text').textContent = s.text;
    $('tutorial-step-count').textContent = 'Step ' + (lesson.i + 1) + ' of ' + lesson.steps.length;
    $('btn-lesson-end').textContent = 'End lesson';
    analytics.track('tutorial_step', { id: lesson.content.tutorial, step: lesson.i });
    announce('Lesson step ' + (lesson.i + 1) + ' of ' + lesson.steps.length + '. ' + s.text, true);
    // Input gate: guided swaps only allow the taught pair (either direction).
    if (s.require && s.require.kind === 'swap') {
      const r = s.require;
      session.inputFilter = (ax, ay, bx, by) =>
        (ax === r.ax && ay === r.ay && bx === r.bx && by === r.by) || (ax === r.bx && ay === r.by && bx === r.ax && by === r.ay);
      if (scene && s.focus && s.focus.length === 2) {
        scene.showHint({ ax: s.focus[0].x, ay: s.focus[0].y, bx: s.focus[1].x, by: s.focus[1].y });
      }
    } else {
      session.inputFilter = null;
      if (scene) scene.clearHint();
    }
    mirrorSetGuide(s);
  }

  function lessonAdvance() {
    lesson.i++;
    if (lesson.i >= lesson.steps.length) {
      endLesson(true);
      return;
    }
    showLessonStep();
  }

  function endLesson(completed) {
    if (!lesson) return;
    lesson = null;
    $('tutorial-banner').hidden = true;
    session.inputFilter = null;
    if (scene) scene.clearHint();
    mirrorSetGuide(null);
    if (completed) {
      announce('Lesson complete!', true);
      toast('Lesson complete!', 'ok');
      // Let the last move's cosmetics settle before the results overlay.
      setTimeout(() => {
        if (session.state && session.state.phase === 'ready') session.forceFinish(rules.END.GOALS);
      }, scene ? 900 : 350);
    }
  }

  $('btn-lesson-end').addEventListener('click', () => {
    if (replayState) {
      endReplay();
      return;
    }
    endLesson(false);
    session.abandon('leave-lesson');
  });

  // Advance lessons by inspecting the same event stream play produces.
  session.on('rules', ({ events }) => {
    if (!lesson) return;
    const s = lesson.steps[lesson.i];
    if (!s || !s.require) return;
    const acceptedSwap = events.some((e) => e.t === 'turn');
    let hit = false;
    switch (s.require.kind) {
      case 'swap': {
        const r = s.require;
        hit = events.some(
          (e) =>
            e.t === 'swap' &&
            ((sameCell(e.a, s, r.ax, r.ay) && sameCell(e.b, s, r.bx, r.by)) || (sameCell(e.a, s, r.bx, r.by) && sameCell(e.b, s, r.ax, r.ay)))
        );
        break;
      }
      case 'any-swap':
        hit = acceptedSwap;
        break;
      case 'create':
        hit = events.some((e) => e.t === 'create' && (!s.require.s || s.require.s.includes(e.s)));
        break;
      case 'break-ice':
        hit = events.some((e) => e.t === 'crack' && e.ice === 0);
        break;
      case 'break-crate': {
        const need = s.require.n || 1;
        const got = events.filter((e) => e.t === 'crate-break').length;
        lesson.crateCount = (lesson.crateCount || 0) + got;
        hit = lesson.crateCount >= need;
        break;
      }
      default:
        hit = acceptedSwap;
    }
    if (hit) lessonAdvance();
  });

  function sameCell(idx, state, x, y) {
    return session.state && idx === y * session.state.width + x;
  }

  /* ============ results ============ */

  session.on('results', (r) => {
    recordLocalBoardEntry(r);
    $('res-h').textContent = REASON_HEADLINES[r.reason] || 'Round over';
    $('res-stars').textContent = r.stars > 0 ? '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars) : '☆☆☆';
    $('res-stars').setAttribute('aria-label', r.stars + ' of 3 stars');
    for (let s = 0; s < r.stars; s++) {
      setTimeout(() => audio.uiSound('star'), 400 + s * 350);
    }
    $('res-score').textContent = fmtInt(r.score);
    $('res-ranked').hidden = !r.ranked;

    const tbody = $('res-breakdown-body');
    tbody.innerHTML = '';
    let anyRow = false;
    for (const k of Object.keys(COMPONENT_LABELS)) {
      const v = r.components[k] || 0;
      if (v <= 0) continue;
      anyRow = true;
      const tr = el('tr');
      const th = el('th', null, COMPONENT_LABELS[k]);
      th.scope = 'row';
      tr.appendChild(th);
      const td = el('td', null, fmtInt(v));
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    if (!anyRow) {
      const tr = el('tr');
      const td = el('td', null, 'No points scored');
      td.colSpan = 2;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    $('res-total').textContent = fmtInt(r.score);

    const goals = $('res-goals');
    goals.innerHTML = '';
    for (const g of r.goals) goals.appendChild(goalListItem(g));

    const achWrap = $('res-ach-wrap');
    const newAch = (r.progression && r.progression.newAchievements) || [];
    if (newAch.length) {
      achWrap.hidden = false;
      audio.uiSound('success');
      const ul = $('res-achievements');
      ul.innerHTML = '';
      for (const key of newAch) {
        const def = ACHIEVEMENTS.find((a) => a.key === key);
        ul.appendChild(el('li', 'ach-pill', (def ? def.name : key)));
      }
    } else {
      achWrap.hidden = true;
    }

    const mastery = r.progression && r.progression.mastery;
    if (mastery) {
      const before = masteryProgress(mastery.total - mastery.gained);
      const after = masteryProgress(mastery.total);
      $('res-mastery-fill').style.width = after.pct + '%';
      $('res-mastery-bar').setAttribute('aria-valuenow', String(Math.round(after.pct)));
      $('res-mastery-text').textContent =
        '+' + mastery.gained + ' XP · level ' + mastery.levelAfter + (mastery.levelAfter > mastery.levelBefore ? ' — level up!' : ' · ' + after.toNext + ' XP to next');
      void before;
    }
    const unlocks = $('res-unlocks');
    unlocks.innerHTML = '';
    for (const u of (r.progression && r.progression.unlocks) || []) {
      unlocks.appendChild(el('li', 'ach-pill', 'Unlocked ' + u.type + ': ' + cosmeticName(u.type, u.id)));
    }
    if (r.progression && r.progression.dailyStreak) {
      unlocks.appendChild(el('li', 'ach-pill', 'Daily streak ' + r.progression.dailyStreak + ' 🔥'));
    }

    // Comparison line: personal best + server rank when available.
    const cmp = $('res-compare');
    cmp.textContent = '…';
    fillComparison(r, cmp);

    $('res-next').textContent = nextLabel(r);
    openOverlay('results');
    announce((REASON_HEADLINES[r.reason] || 'Round over') + ' Score ' + fmtInt(r.score) + '. ' + r.stars + ' stars.', true);
    refreshTitle();
  });

  function masteryProgress(xp) {
    const level = masteryLevelForXp(xp);
    const cur = MASTERY_LEVELS[level - 1];
    const next = MASTERY_LEVELS[level];
    if (!next) return { pct: 100, toNext: 0 };
    const pct = ((xp - cur.xp) / (next.xp - cur.xp)) * 100;
    return { pct: Math.max(0, Math.min(100, pct)), toNext: next.xp - xp };
  }

  function nextLabel(r) {
    if (r.mode === 'journey' && r.won && r.contentId !== 'j40') return 'Next stage';
    if (r.mode === 'learn') return 'Next lesson';
    return 'Play again';
  }

  function fillComparison(r, cmp) {
    const boards = storage.loadBoards();
    const mine = boards.entries.filter((e) => e.contentId === r.contentId);
    const best = mine.reduce((m, e) => Math.max(m, e.score), 0);
    const isBest = r.score >= best && r.score > 0;
    let text = isBest && r.score > 0 ? 'New personal best on this board!' : 'Personal best on this board: ' + fmtInt(best) + '.';
    if (isBest && r.score > 0) audio.uiSound('record');
    cmp.textContent = text;
    if (r.ranked && platform.online && !platform.hosted) {
      platform
        .fetchBoards({ board: r.mode === 'daily' ? 'daily' : 'global', contentId: r.contentId, dayKey: r.mode === 'daily' ? r.contentId.slice(6) : undefined, limit: 50 })
        .then((res) => {
          if (!res || !res.entries) return;
          const rank = res.entries.findIndex((e) => e.roundId === r.roundId);
          if (rank >= 0) cmp.textContent = text + ' Ranked #' + (rank + 1) + ' on the ' + (res.label || 'server') + ' board.';
          else if (res.entries.length) cmp.textContent = text + ' ' + res.entries.length + ' entries on the board.';
        })
        .catch(() => {});
    }
  }

  function recordLocalBoardEntry(r) {
    try {
      const boards = storage.loadBoards();
      boards.entries.push({
        roundId: r.roundId,
        contentId: r.contentId,
        mode: r.mode,
        name: playerName(),
        score: r.score,
        won: r.won,
        moves: r.movesSpent,
        ms: r.elapsedMs,
        seed: r.replay ? r.replay.seed : null,
        assists: r.replay && r.replay.config ? (r.replay.config.assists.undo ? 'undo' : '') : '',
        at: new Date().toISOString(),
        validated: false,
      });
      if (boards.entries.length > 400) boards.entries.splice(0, boards.entries.length - 400);
      storage.saveBoards(boards);
    } catch {
      /* boards are best-effort */
    }
  }

  $('res-retry').addEventListener('click', () => {
    closeOverlay('results');
    session.restart();
  });
  $('res-replay').addEventListener('click', () => startReplay());
  $('res-menu').addEventListener('click', () => {
    closeOverlay('results');
    session.transition('mode-select', 'results-menu');
  });
  $('res-next').addEventListener('click', () => {
    const r = session._lastResults;
    closeOverlay('results');
    if (!r) {
      session.transition('mode-select', 'next');
      return;
    }
    if (r.mode === 'journey') {
      const nextStage = Math.min((session.content.stage || 1) + 1, content.JOURNEY.length);
      const next = content.JOURNEY[nextStage - 1];
      if (r.won && next) {
        session.transition('progression', 'next-stage');
        session.startRound(next);
        return;
      }
      session.transition('progression', 'journey-next');
      session.transition('mode-select', 'journey-next');
      openJourney();
      return;
    }
    if (r.mode === 'learn') {
      const idx = content.LESSONS.findIndex((l) => l.id === r.contentId);
      const next = content.LESSONS[idx + 1];
      session.transition('progression', 'next-lesson');
      if (r.won && next) {
        session.startRound(next);
      } else {
        session.transition('mode-select', 'lessons-done');
      }
      return;
    }
    session.transition('progression', 'again');
    session.startRound(session.content);
  });

  // Keep the last results around for the Next button.
  session.on('results', (r) => {
    session._lastResults = r;
  });

  /* ============ replay (spectate the recorded command log) ============ */

  let replayState = null;
  let replayTimers = [];

  function startReplay() {
    const r = session._lastResults;
    if (!r || !r.replay) return;
    if (!scene) {
      toast('Replay needs the 3D view.', 'warn');
      return;
    }
    closeOverlay('results');
    try {
      replayState = rules.createGame(r.replay.config);
    } catch {
      toast('Replay unavailable for this round.', 'warn');
      return;
    }
    scene.buildBoard(replayState);
    const banner = $('tutorial-banner');
    banner.hidden = false;
    $('tutorial-text').textContent = 'Replay of your round — ' + r.replay.commands.length + ' moves.';
    $('tutorial-step-count').textContent = '';
    $('btn-lesson-end').textContent = 'End replay';
    let i = 0;
    const step = () => {
      if (!replayState) return;
      if (i >= r.replay.commands.length || replayState.phase !== 'ready') {
        $('tutorial-text').textContent = 'Replay complete — final score ' + fmtInt(replayState.score) + '.';
        return;
      }
      const cmd = r.replay.commands[i++];
      const res = rules.applyCommand(replayState, cmd);
      if (res.events.length && scene) scene.playEvents(res.events, replayState, { fast: false });
      replayTimers.push(setTimeout(step, 1500));
    };
    replayTimers.push(setTimeout(step, 600));
  }

  function endReplay() {
    replayTimers.forEach(clearTimeout);
    replayTimers = [];
    replayState = null;
    $('tutorial-banner').hidden = true;
    // Restore the finished round's board, then back to results.
    if (session.state && scene) scene.buildBoard(session.state);
    openOverlay('results');
  }

  /* ============ text mirror board (accessibility / no-WebGL path) ============ */

  let mirrorOn = false;
  let mirrorSel = -1;
  let mirrorRenderQueued = false;

  function setMirror(on) {
    mirrorOn = !!on;
    $('mirror-panel').hidden = !mirrorOn;
    $('btn-mirror-toggle').setAttribute('aria-expanded', String(mirrorOn));
    $('tray-mirror').setAttribute('aria-expanded', String(mirrorOn));
    if (mirrorOn) mirrorBuild();
  }

  $('btn-mirror-toggle').addEventListener('click', () => setMirror(!mirrorOn));
  $('tray-mirror').addEventListener('click', () => setMirror(!mirrorOn));
  $('btn-mirror-close').addEventListener('click', () => setMirror(false));

  function mirrorBuild() {
    if (!mirrorOn && webglAvailable) return;
    const host = $('mirror-board');
    host.innerHTML = '';
    mirrorSel = -1;
    const s = session.state;
    if (!s) return;
    host.style.gridTemplateColumns = 'repeat(' + s.width + ', 1fr)';
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const i = y * s.width + x;
        const cell = s.cells[i];
        if (!cell.play) {
          const hole = el('span', 'mirror-cell mirror-hole');
          hole.setAttribute('aria-hidden', 'true');
          host.appendChild(hole);
          continue;
        }
        const b = el('button', 'mirror-cell');
        b.dataset.cell = String(i);
        b.addEventListener('click', () => mirrorTap(i));
        host.appendChild(b);
      }
    }
    mirrorRender();
  }

  function mirrorRenderSoon() {
    if (mirrorRenderQueued) return;
    mirrorRenderQueued = true;
    setTimeout(() => {
      mirrorRenderQueued = false;
      mirrorRender();
    }, 120);
  }

  function mirrorRender() {
    const host = $('mirror-board');
    const s = session.state;
    if (!s || (!mirrorOn && webglAvailable)) return;
    const cells = host.children;
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const i = y * s.width + x;
        const cell = s.cells[i];
        const node = cells[i];
        if (!node || !cell.play) continue;
        let glyph = '';
        let cls = 'mirror-cell';
        if (cell.crate > 0) {
          glyph = '▣';
          cls += ' mirror-crate mirror-crate-' + cell.crate;
        } else if (cell.j) {
          glyph = COLOR_GLYPHS[cell.j.c];
          cls += ' mirror-c' + cell.j.c;
          if (cell.j.s !== SPECIAL.NONE) {
            glyph += SPECIAL_GLYPHS[cell.j.s] || '';
            cls += ' mirror-special';
          }
          if (cell.ice > 0) cls += ' mirror-ice mirror-ice-' + cell.ice;
        }
        if (i === mirrorSel) cls += ' mirror-sel';
        node.className = cls;
        if (node.textContent !== glyph) node.textContent = glyph;
        const desc =
          'row ' + (y + 1) + ' column ' + (x + 1) + ': ' +
          (cell.crate > 0
            ? 'crate, ' + cell.crate + ' hit' + (cell.crate > 1 ? 's' : '') + ' left'
            : cell.j
              ? COLOR_GLYPH_NAMES[cell.j.c] +
                (cell.j.s !== SPECIAL.NONE ? ' ' + SPECIAL_NAMES[cell.j.s] : '') +
                (cell.ice > 0 ? ', frozen' + (cell.ice > 1 ? ' deeply' : '') : '')
              : 'empty');
        node.setAttribute('aria-label', desc + (i === mirrorSel ? ', selected' : ''));
      }
    }
    const legal = s.phase === 'ready' ? rules.legalActions(s).length : 0;
    $('mirror-summary').textContent =
      'Score ' + fmtInt(s.score) + ' · ' + (s.movesLeft > 100 ? 'unlimited moves' : s.movesLeft + ' moves left') + ' · ' + legal + ' legal swaps.';
  }

  function mirrorTap(i) {
    const s = session.state;
    if (!s || s.phase !== 'ready') return;
    if (mirrorSel < 0) {
      if (s.cells[i].j && !s.cells[i].crate && s.cells[i].ice === 0) mirrorSel = i;
      else {
        announce(INVALID_TEXT[s.cells[i].crate ? 'crate-cell' : s.cells[i].ice > 0 ? 'ice-locked' : 'no-jewel'], true);
      }
      mirrorRender();
      return;
    }
    if (mirrorSel === i) {
      mirrorSel = -1;
      mirrorRender();
      return;
    }
    const a = { x: mirrorSel % s.width, y: Math.floor(mirrorSel / s.width) };
    const b = { x: i % s.width, y: Math.floor(i / s.width) };
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) {
      session.trySwap(a.x, a.y, b.x, b.y);
      mirrorSel = -1;
    } else {
      mirrorSel = s.cells[i].j && !s.cells[i].crate && s.cells[i].ice === 0 ? i : -1;
    }
    mirrorRender();
  }

  function mirrorSetGuide(stepData) {
    const existing = $('mirror-guide');
    if (existing) existing.remove();
    if (!stepData || !mirrorOn) return;
    const host = $('mirror-panel');
    const p = el('p', 'mirror-guide-text', stepData.text);
    p.id = 'mirror-guide';
    host.insertBefore(p, $('mirror-board'));
  }

  // Arrow-key navigation inside the mirror grid.
  $('mirror-board').addEventListener('keydown', (e) => {
    const s = session.state;
    if (!s) return;
    const focused = document.activeElement;
    if (!focused || focused.dataset.cell === undefined) return;
    const i = Number(focused.dataset.cell);
    const x = i % s.width;
    const y = Math.floor(i / s.width);
    let nx = x;
    let ny = y;
    if (e.key === 'ArrowLeft') nx = Math.max(0, x - 1);
    else if (e.key === 'ArrowRight') nx = Math.min(s.width - 1, x + 1);
    else if (e.key === 'ArrowUp') ny = Math.max(0, y - 1);
    else if (e.key === 'ArrowDown') ny = Math.min(s.height - 1, y + 1);
    else return;
    e.preventDefault();
    const target = $('mirror-board').children[ny * s.width + nx];
    if (target && target.focus) target.focus();
  });

  /* ============ keyboard + gamepad input ============ */

  const keyMap = { ...DEFAULT_KEYBOARD, ...(settings.input.keyboardMap || {}) };
  const padMap = { ...DEFAULT_GAMEPAD, ...(settings.input.gamepadMap || {}) };

  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
  }

  /**
   * True when focus sits on a real control (HUD button, mirror-board cell,
   * link). Confirm keys must reach it so keyboard users can activate it;
   * stealing them would make the text mirror board unplayable by keyboard.
   */
  function isOnControl() {
    const a = document.activeElement;
    return !!(a && a !== document.body && a.matches && a.matches('button, a[href], [role="button"]'));
  }

  function bindingFor(code) {
    for (const action of Object.keys(keyMap)) {
      if (keyMap[action] === code) return action;
    }
    return null;
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || isTyping()) return;
    if (e.key === 'Escape' && overlayStack.length > 0) {
      e.preventDefault();
      const top = overlayStack[overlayStack.length - 1].name;
      if (top === 'pause') session.resume();
      else if (top === 'results') { /* results stay until an action is chosen */ }
      else closeOverlay(top);
      return;
    }
    const inGame = currentScreen === 'game';
    const action = bindingFor(e.key);
    if (action === 'help' || (e.key === '?' && e.shiftKey)) {
      e.preventDefault();
      refreshHelp();
      if (inGame) {
        session.pause('help');
        closeOverlay('pause');
        openOverlayFromGame('help');
      } else showScreen('help');
      return;
    }
    if (!inGame) return;
    if (!action) return;
    // Enter/Space belong to the focused control (mirror cells, HUD buttons).
    if ((action === 'confirm' || action === 'confirm2') && isOnControl()) return;
    e.preventDefault();
    runAction(action, e);
  });

  function runAction(action) {
    audio.unlock();
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right': {
        if (session.status !== 'active' && session.status !== 'tutorial') return;
        const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[action];
        if (scene) scene.cursorMove(d[0], d[1]);
        break;
      }
      case 'confirm':
      case 'confirm2':
        if (session.status === 'active' || session.status === 'tutorial') {
          if (scene) {
            scene.cursorShow();
            scene.cursorConfirm();
          }
        }
        break;
      case 'cancel':
        if (scene && scene.cursorCancel()) return;
        if (anyOverlayOpen()) return;
        if (session.status === 'active' || session.status === 'resolving') session.pause('cancel');
        break;
      case 'pause':
        if (session.status === 'paused') session.resume();
        else session.pause('user');
        break;
      case 'hint':
        session.hint();
        break;
      case 'undo':
        session.undo();
        break;
      case 'skip':
        session.requestSkip();
        break;
      case 'camera':
        cycleCamera();
        break;
      case 'mute':
        settings.audio.muted = !settings.audio.muted;
        storage.saveSettings(settings);
        audio.setMuted(settings.audio.muted);
        syncSettingsControls();
        toast(settings.audio.muted ? 'Muted' : 'Sound on', null);
        break;
      default:
        break;
    }
  }

  /* Gamepad: poll with edge detection + dpad/stick repeat. */
  let padState = { buttons: [], moveAt: 0 };
  setInterval(() => {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let gp = null;
    for (const p of pads) {
      if (p && p.connected) {
        gp = p;
        break;
      }
    }
    if (!gp) return;
    const now = performance.now();
    const pressed = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    for (const action of GAMEPAD_ACTIONS) {
      const btn = padMap[action];
      if (btn === undefined) continue;
      const was = padState.buttons[btn];
      const is = pressed(btn);
      if (is && !was && currentScreen === 'game') runAction(action);
      padState.buttons[btn] = is;
    }
    // D-pad + left stick → cursor with repeat.
    if (currentScreen === 'game' && (session.status === 'active' || session.status === 'tutorial') && scene) {
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      let dx = 0;
      let dy = 0;
      if (pressed(14)) dx = -1;
      else if (pressed(15)) dx = 1;
      else if (pressed(12)) dy = -1;
      else if (pressed(13)) dy = 1;
      else if (Math.abs(ax) > 0.55) dx = ax > 0 ? 1 : -1;
      else if (Math.abs(ay) > 0.55) dy = ay > 0 ? 1 : -1;
      if ((dx || dy) && now - padState.moveAt > 180) {
        padState.moveAt = now;
        scene.cursorMove(dx, dy);
      }
    }
  }, 60);

  /* ============ settings ============ */

  function syncSettingsControls() {
    $('set-master').value = Math.round(settings.audio.master * 100);
    $('set-music').value = Math.round(settings.audio.music * 100);
    $('set-effects').value = Math.round(settings.audio.effects * 100);
    $('set-ambience').value = Math.round(settings.audio.ambience * 100);
    $('set-voice').value = Math.round(settings.audio.voice * 100);
    $('set-muted').checked = !!settings.audio.muted;
    $('set-tier').value = settings.graphics.tier;
    $('set-render-scale').value = Math.round((settings.graphics.renderScale || 1) * 100);
    $('set-palette').value = settings.display.palette;
    $('set-text-size').value = settings.display.textSize;
    $('set-high-contrast').checked = !!settings.display.highContrast;
    $('set-reduced-motion').checked = !!settings.motion.reduced;
    $('set-left-handed').checked = !!settings.display.leftHanded;
    $('set-timing-assist').checked = !!settings.access.timingAssist;
    $('set-haptics').checked = !!settings.input.haptics;
    $('set-hold-drag').checked = !!settings.input.holdToDrag;
    $('set-captions').checked = !!settings.access.captions;
    $('set-camera').value = settings.camera.preset || 'default';
    const nameInput = $('set-display-name');
    nameInput.value = playerName();
    nameInput.disabled = platform.hosted; // hosted name comes from the platform profile
    $('set-telemetry').checked = !!settings.privacy.telemetryConsent;
    buildRemapLists();
  }

  function applyDisplaySettings() {
    const html = document.documentElement;
    html.classList.toggle('text-large', settings.display.textSize === 'large');
    html.classList.toggle('text-xl', settings.display.textSize === 'xl');
    html.classList.toggle('hc', !!settings.display.highContrast);
    html.classList.toggle('reduced-motion', !!settings.motion.reduced);
    html.classList.toggle('left-handed', !!settings.display.leftHanded);
    html.className = html.className.replace(/palette-\w+/g, '').trim();
    html.classList.add('palette-' + settings.display.palette);
  }

  function bindRange(id, get, set) {
    $(id).addEventListener('input', () => {
      set(Number($(id).value) / 100);
      storage.saveSettings(settings);
      audio.applyVolumes();
      audio.uiSound('scroll');
    });
  }
  bindRange('set-master', null, (v) => (settings.audio.master = v));
  bindRange('set-music', null, (v) => (settings.audio.music = v));
  bindRange('set-effects', null, (v) => (settings.audio.effects = v));
  bindRange('set-ambience', null, (v) => (settings.audio.ambience = v));
  bindRange('set-voice', null, (v) => (settings.audio.voice = v));
  $('set-muted').addEventListener('change', () => {
    settings.audio.muted = $('set-muted').checked;
    storage.saveSettings(settings);
    audio.setMuted(settings.audio.muted);
  });

  function settingsChanged(key) {
    storage.saveSettings(settings);
    analytics.track('settings_change', { key });
    audio.uiSound('saved');
  }

  // Switch-click feedback for every checkbox toggle in the settings panel.
  const settingsPanel = sectionOf('settings');
  if (settingsPanel) {
    settingsPanel.addEventListener('change', (e) => {
      if (e.target && e.target.type === 'checkbox') audio.uiSound('toggle');
    });
  }

  $('set-tier').addEventListener('change', () => {
    settings.graphics.tier = $('set-tier').value;
    settingsChanged('graphics.tier');
    applyGraphics();
  });
  $('set-render-scale').addEventListener('input', () => {
    settings.graphics.renderScale = Number($('set-render-scale').value) / 100;
    settingsChanged('graphics.renderScale');
    applyGraphics();
  });
  $('set-palette').addEventListener('change', () => {
    settings.display.palette = $('set-palette').value;
    settingsChanged('display.palette');
    applyDisplaySettings();
    applyGraphics();
  });
  $('set-text-size').addEventListener('change', () => {
    settings.display.textSize = $('set-text-size').value;
    settingsChanged('display.textSize');
    applyDisplaySettings();
  });
  $('set-high-contrast').addEventListener('change', () => {
    settings.display.highContrast = $('set-high-contrast').checked;
    settingsChanged('display.highContrast');
    applyDisplaySettings();
  });
  $('set-reduced-motion').addEventListener('change', () => {
    settings.motion.reduced = $('set-reduced-motion').checked;
    settings.motion._touched = true;
    settingsChanged('motion.reduced');
    applyDisplaySettings();
    applyGraphics();
  });
  $('set-left-handed').addEventListener('change', () => {
    settings.display.leftHanded = $('set-left-handed').checked;
    settingsChanged('display.leftHanded');
    applyDisplaySettings();
  });
  $('set-timing-assist').addEventListener('change', () => {
    settings.access.timingAssist = $('set-timing-assist').checked;
    settingsChanged('access.timingAssist');
    toast('Timing assistance applies to the next timed round.', null);
  });
  $('set-haptics').addEventListener('change', () => {
    settings.input.haptics = $('set-haptics').checked;
    settingsChanged('input.haptics');
  });
  $('set-captions').addEventListener('change', () => {
    settings.access.captions = $('set-captions').checked;
    settingsChanged('access.captions');
    audio.setCaptionsEnabled(settings.access.captions);
  });
  $('set-hold-drag').addEventListener('change', () => {
    settings.input.holdToDrag = $('set-hold-drag').checked;
    settingsChanged('input.holdToDrag');
  });
  $('set-camera').addEventListener('change', () => {
    settings.camera.preset = $('set-camera').value;
    settingsChanged('camera.preset');
    applyGraphics();
  });
  $('set-display-name').addEventListener('change', () => {
    const v = $('set-display-name').value.trim().slice(0, 24);
    settings.player.displayName = v || 'Guest';
    settingsChanged('player.displayName');
    refreshTitle();
  });
  $('set-telemetry').addEventListener('change', () => {
    analytics.setConsent($('set-telemetry').checked);
    settingsChanged('privacy.telemetryConsent');
  });
  $('btn-replay-tutorials').addEventListener('click', () => {
    progress.tutorialsDone = {};
    storage.saveProgress(progress);
    toast('Tutorials reset — they will play again from Learn.', 'ok');
  });
  $('btn-reset-binds').addEventListener('click', () => {
    for (const k of Object.keys(keyMap)) delete keyMap[k];
    Object.assign(keyMap, DEFAULT_KEYBOARD);
    for (const k of Object.keys(padMap)) delete padMap[k];
    Object.assign(padMap, DEFAULT_GAMEPAD);
    settings.input.keyboardMap = null;
    settings.input.gamepadMap = null;
    settingsChanged('input.bindings');
    buildRemapLists();
  });
  $('btn-wipe').addEventListener('click', () => {
    modal({
      title: 'Reset all data?',
      body: 'This erases every local setting, progress record, and snapshot for Jewel Cascade on this device. This cannot be undone.',
      actions: [
        { label: 'Erase everything', value: 'wipe' },
        { label: 'Cancel', value: 'cancel', primary: true },
      ],
    }).then((v) => {
      if (v === 'wipe') {
        storage.wipeAll();
        location.reload();
      }
    });
  });
  $('btn-settings-close').addEventListener('click', () => closeOverlay('settings'));

  /* ---- remapping ---- */

  let rebinding = null; // {kind: 'keyboard'|'gamepad', action}
  function buildRemapLists() {
    const kb = $('remap-keyboard');
    kb.innerHTML = '';
    for (const action of Object.keys(DEFAULT_KEYBOARD)) {
      const li = el('li', 'remap-item');
      li.appendChild(el('span', null, ACTION_LABELS[action] || action));
      const btn = el('button', 'btn btn-small', keyLabel(keyMap[action] || '—'));
      btn.addEventListener('click', () => {
        rebinding = { kind: 'keyboard', action };
        btn.textContent = 'press a key…';
        btn.classList.add('listening');
      });
      li.appendChild(btn);
      kb.appendChild(li);
    }
    const gp = $('remap-gamepad');
    gp.innerHTML = '';
    for (const action of GAMEPAD_ACTIONS) {
      const li = el('li', 'remap-item');
      li.appendChild(el('span', null, ACTION_LABELS[action] || action));
      const btn = el('button', 'btn btn-small', 'Button ' + (padMap[action] !== undefined ? padMap[action] : '—'));
      btn.addEventListener('click', () => {
        rebinding = { kind: 'gamepad', action };
        btn.textContent = 'press a button…';
        btn.classList.add('listening');
      });
      li.appendChild(btn);
      gp.appendChild(li);
    }
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!rebinding || rebinding.kind !== 'keyboard') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape') {
        keyMap[rebinding.action] = e.key;
        settings.input.keyboardMap = { ...keyMap };
        settingsChanged('input.bindings');
      }
      rebinding = null;
      buildRemapLists();
    },
    true
  );
  // Gamepad capture for rebinding.
  setInterval(() => {
    if (!rebinding || rebinding.kind !== 'gamepad' || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i] && gp.buttons[i].pressed) {
          padMap[rebinding.action] = i;
          settings.input.gamepadMap = { ...padMap };
          settingsChanged('input.bindings');
          rebinding = null;
          buildRemapLists();
          return;
        }
      }
    }
  }, 90);

  /* ============ help (cards reflect CURRENT bindings) ============ */

  function refreshHelp() {
    const host = $('help-cards');
    host.innerHTML = '';
    const cards = [
      {
        t: 'Swap & match',
        b: 'Swap two neighbouring jewels (drag, or tap one then the other). A swap only counts when it lines up three or more of a color. Keyboard: ' +
          [keyMap.up, keyMap.down, keyMap.left, keyMap.right].map(keyLabel).join('/') + ' move the cursor, ' + keyLabel(keyMap.confirm) + ' selects.',
      },
      { t: 'Moves & goals', b: 'Every accepted swap spends one move. Finish all goals before moves run out. Goals sit in the objective rail; the HUD shows moves and score.' },
      { t: 'Rays (4 in a line)', b: 'A line of four forges a ray. It fires when matched or struck and clears a whole row or column.' },
      { t: 'Blooms (L or T)', b: 'Matching around a corner grows a bloom, which clears a 3×3 patch when it fires.' },
      { t: 'Prisms (5 in a line)', b: 'Five in a line cut a prism. Swap it with a jewel to shatter every jewel of that color; swap it with another special for a bigger effect.' },
      { t: 'Ice', b: 'Frozen jewels cannot move but still match. Matching through ice cracks it; deep ice takes two hits.' },
      { t: 'Crates', b: 'Crates hold no jewel and never move. Matches next to a crate dent it; banded crates take two hits.' },
      {
        t: 'Controls',
        b: keyLabel(keyMap.hint) + ' hint · ' + keyLabel(keyMap.undo) + ' undo (practice) · ' + keyLabel(keyMap.skip) + ' skip animation · ' + keyLabel(keyMap.camera) + ' camera · ' + keyLabel(keyMap.mute) + ' mute · ' + keyLabel(keyMap.pause) + ' pause. Gamepad: A select, B cancel, X hint, Y undo, start pause. Rebind everything in Settings → Controls.',
      },
      { t: 'Stars & mastery', b: 'Finish goals for ★, beat score thresholds for ★★ and ★★★. Every round earns mastery XP toward cosmetic themes, trails, frames, and titles — looks only, never power.' },
      { t: 'Fair play', b: 'Ranked boards are replay-validated: the same seed and the same moves always produce the same score. Daily seeds never change once published.' },
    ];
    for (const c of cards) {
      const card = el('article', 'help-card');
      card.appendChild(el('h3', null, c.t));
      card.appendChild(el('p', null, c.b));
      host.appendChild(card);
    }
  }

  /* ============ achievements ============ */

  function refreshAchievements() {
    const ul = $('ach-list');
    ul.innerHTML = '';
    let owned = 0;
    for (const a of ACHIEVEMENTS) {
      const got = progress.achievements && progress.achievements[a.key];
      if (got) owned++;
      const li = el('li', 'ach-item' + (got ? ' owned' : ''));
      li.appendChild(el('span', 'ach-icon', got ? '★' : '☆'));
      const wrap = el('div');
      wrap.appendChild(el('strong', null, a.name));
      wrap.appendChild(el('p', 'dim', a.desc + (got ? ' Unlocked ' + String(got.at).slice(0, 10) + '.' : '')));
      li.appendChild(wrap);
      ul.appendChild(li);
    }
    $('ach-summary').textContent = owned + ' of ' + ACHIEVEMENTS.length + ' unlocked.';
  }

  /* ============ boards ============ */

  let boardTab = 'global';
  for (const tab of document.querySelectorAll('[data-board]')) {
    tab.addEventListener('click', () => {
      boardTab = tab.dataset.board;
      for (const t of document.querySelectorAll('[data-board]')) t.setAttribute('aria-selected', String(t === tab));
      audio.uiSound('tab');
      refreshBoards();
    });
  }

  function refreshBoards() {
    const host = $('boards-list');
    host.innerHTML = '';
    const note = el('p', 'dim', 'Loading boards…');
    host.appendChild(note);
    const dayKey = content.dayKeyFor(platform.now());
    const contentId = boardTab === 'daily' ? 'daily-' + dayKey : undefined;
    platform
      .fetchBoards({ board: boardTab, contentId, dayKey: boardTab === 'daily' ? dayKey : undefined, limit: 25 })
      .then((res) => {
        host.innerHTML = '';
        const entries = (res && res.entries) || [];
        if (!entries.length) {
          host.appendChild(el('p', 'dim', platform.online ? 'No entries yet — be the first.' : 'Offline. Personal bests:'));
        } else {
          host.appendChild(renderBoardTable(entries, !!(res && res.validated), res && res.label));
        }
        if (!platform.online) host.appendChild(renderLocalBests(boardTab));
      })
      .catch(() => {
        host.innerHTML = '';
        host.appendChild(el('p', 'dim', 'Boards unavailable right now. Personal bests:'));
        host.appendChild(renderLocalBests(boardTab));
      });
  }

  function renderBoardTable(entries, validated, label) {
    const table = el('table', 'board-table');
    const cap = el('caption', null, (label || (validated ? 'Validated' : 'Casual')) + (validated ? ' — replay-verified' : ' — casual, not replay-verified'));
    table.appendChild(cap);
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['#', 'Player', 'Score', 'Moves', 'When']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    entries.forEach((e, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(i + 1)));
      tr.appendChild(el('td', null, e.name || 'guest'));
      tr.appendChild(el('td', null, fmtInt(e.score)));
      tr.appendChild(el('td', null, String(e.moves != null ? e.moves : '—')));
      tr.appendChild(el('td', null, String(e.at || '').slice(0, 10)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderLocalBests(board) {
    const boards = storage.loadBoards();
    let entries = boards.entries.slice();
    if (board === 'daily') entries = entries.filter((e) => e.mode === 'daily');
    else if (board === 'friends') entries = entries.filter((e) => e.name === playerName());
    entries = entries.sort((a, b) => b.score - a.score).slice(0, 15);
    if (!entries.length) return el('p', 'dim', 'No local results yet.');
    return renderBoardTable(entries, false, 'Local bests (casual)');
  }

  /* ============ profile + cosmetics ============ */

  const COSMETIC_NAMES = {
    'ember-dusk': 'Ember Dusk',
    'moonlit-forge': 'Moonlit Forge',
    'verdant-atelier': 'Verdant Atelier',
    'frostbound-loft': 'Frostbound Loft',
    'royal-velvet': 'Royal Velvet',
    none: 'None',
    spark: 'Sparks',
    comet: 'Comet embers',
    standard: 'Standard',
    brass: 'Brass',
    filigree: 'Filigree',
    apprentice: 'Apprentice',
    'cascade-master': 'Cascade Master',
  };
  function cosmeticName(type, id) {
    return COSMETIC_NAMES[id] || id;
  }

  function refreshProfile() {
    const name = playerName();
    $('prof-name').textContent = name;
    $('prof-avatar').textContent = name.slice(0, 1).toUpperCase();
    $('prof-title-line').textContent = cosmeticName('title', settings.cosmetics.title);
    const syncEl = $('prof-sync');
    if (platform.hosted) {
      syncEl.hidden = false;
      syncEl.textContent = syncLabel();
    } else {
      syncEl.hidden = true;
      syncEl.textContent = '';
    }
    const xp = progress.masteryXp || 0;
    const level = masteryLevelForXp(xp);
    const mp = masteryProgress(xp);
    $('prof-mastery-fill').style.width = mp.pct + '%';
    $('prof-mastery-bar').setAttribute('aria-valuenow', String(Math.round(mp.pct)));
    $('prof-mastery-text').textContent = 'Level ' + level + ' · ' + xp + ' XP' + (mp.toNext ? ' · ' + mp.toNext + ' to next' : ' · max level');

    const stats = $('prof-stats');
    stats.innerHTML = '';
    const c = progress.career || {};
    const rows = [
      ['Rounds completed', c.roundsCompleted || 0],
      ['Rounds won', c.roundsWon || 0],
      ['Current win streak', c.winStreak || 0],
      ['Best win streak', c.bestWinStreak || 0],
      ['Total score', fmtInt(c.totalScore || 0)],
      ['Daily streak', (progress.daily && progress.daily.streak) || 0],
    ];
    for (const [k, v] of rows) {
      const div = el('div');
      div.appendChild(el('dt', null, k));
      div.appendChild(el('dd', null, String(v)));
      stats.appendChild(div);
    }

    fillCosmeticSelect('cos-theme', 'themes', THEMES.map((t) => t.id), settings.cosmetics.theme, (v) => {
      settings.cosmetics.theme = v;
      storage.saveSettings(settings);
      applyTheme();
    });
    fillCosmeticSelect('cos-trail', 'trails', ['none', 'spark', 'comet'], settings.cosmetics.trail, (v) => {
      settings.cosmetics.trail = v;
      storage.saveSettings(settings);
      if (scene) scene.setTrail(v);
    });
    fillCosmeticSelect('cos-frame', 'frames', ['standard', 'brass', 'filigree'], settings.cosmetics.frame, (v) => {
      settings.cosmetics.frame = v;
      storage.saveSettings(settings);
      if (scene) scene.setFrame(v);
    });
    fillCosmeticSelect('cos-title', 'titles', ['apprentice', 'cascade-master'], settings.cosmetics.title, (v) => {
      settings.cosmetics.title = v;
      storage.saveSettings(settings);
      $('prof-title-line').textContent = cosmeticName('title', v);
    });
  }

  function fillCosmeticSelect(id, bucket, all, current, onChange) {
    const sel = $(id);
    sel.innerHTML = '';
    const unlocked = (progress.cosmeticsUnlocked && progress.cosmeticsUnlocked[bucket]) || [];
    for (const opt of all) {
      const o = el('option', null, cosmeticName(bucket, opt) + (unlocked.includes(opt) ? '' : ' (locked)'));
      o.value = opt;
      o.disabled = !unlocked.includes(opt);
      if (opt === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => onChange(sel.value);
  }

  function refreshMetaScreens() {
    refreshTitle();
    if (currentScreen === 'profile') refreshProfile();
    if (currentScreen === 'achievements') refreshAchievements();
  }

  /* ============ captions ============ */

  audio.setCaptionsEnabled(!!settings.access.captions);
  audio.onCaption = (text) => {
    if (!settings.access.captions) return;
    const region = $('toast-region');
    const t = el('div', 'toast toast-caption', text);
    region.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  };

  /* ============ layout: shared insets with the 3D scene ============ */

  function updateInsets() {
    if (!scene) return;
    const wide = window.innerWidth >= 1024;
    const leftRail = $('rail-objective');
    const rightRail = $('rail-actions');
    const status = $('hud-status-bar');
    const tray = $('thumb-tray');
    const insets = { left: 0, right: 0, top: 0, bottom: 0 };
    if (currentScreen === 'game') {
      if (wide) {
        insets.left = leftRail.offsetWidth + 16;
        insets.right = rightRail.offsetWidth + 16;
      }
      insets.top = status.offsetHeight + 8;
      if (!wide && window.innerHeight > window.innerWidth) {
        insets.bottom = tray.offsetHeight + 8;
      }
    }
    scene.setViewportInsets(insets);
  }

  ui.onResize = () => {
    updateInsets();
    if (mirrorOn) mirrorRender();
  };

  /* ============ no-scene settlement (text-board-only path) ============ */
  // With WebGL the renderer calls session.settled() when cosmetics finish.
  // Without it, the rules snapshot is already final — settle on a short beat.
  if (!scene) {
    session.on('rules', ({ fast }) => {
      setTimeout(() => session.settled(), fast ? 60 : 320);
    });
  }

  /* ============ boot wiring ============ */

  applyDisplaySettings();
  syncSettingsControls();
  refreshTitle();
  if (!webglAvailable) {
    document.body.classList.add('no-webgl');
  }

  // Apply persisted cosmetics to the scene.
  if (scene) {
    scene.setFrame(settings.cosmetics.frame);
    scene.setTrail(settings.cosmetics.trail);
  }

  return ui;
}
