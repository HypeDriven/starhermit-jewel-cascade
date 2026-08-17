/**
 * session.js — Jewel Cascade session controller (the game state machine).
 *
 * Owns exactly one rules-engine state per round and is the only path through
 * which UI/render/audio mutate it (validated commands with unique ids).
 *
 * State model (spec §2):
 *   boot → title → profile-ready → mode-select → preparing
 *        → tutorial|countdown → active ⇄ paused → resolving
 *        → results → progression
 * `resolving` re-enters `active` once cosmetics settle. Every transition has
 * one owner (this module) and an explicit reason string.
 *
 * Emitted events (UI/render/audio subscribe):
 *   fsm      {from, to, reason}
 *   round    {content, config, resumed}          board (re)built — render listens
 *   rules    {events, state, fast}               deterministic event stream
 *   hud      {score, components, movesLeft, goals, turn, timeLeftMs}
 *   invalid  {reason, ax, ay, bx, by}            rejected swap feedback
 *   hint     {ax, ay, bx, by}
 *   undo     {state}
 *   timer    {leftMs, totalMs}
 *   results  result payload (see buildResults)
 *   toast    {msg, kind}
 */

import * as rules from './engine/rules.js';
import { fnv1a, hex32 } from './engine/rng.js';
import { recordRound, evaluateAchievements, masteryXpForRound, masteryLevelForXp, MASTERY_LEVELS } from './engine/achievements.js';
import * as storage from './storage.js';

export const FSM = [
  'boot',
  'title',
  'profile-ready',
  'mode-select',
  'preparing',
  'tutorial',
  'countdown',
  'active',
  'paused',
  'resolving',
  'results',
  'progression',
];

const ALLOWED = {
  boot: ['title'],
  title: ['profile-ready', 'mode-select', 'preparing'], // preparing: snapshot resume
  'profile-ready': ['mode-select', 'preparing', 'title'],
  'mode-select': ['preparing', 'title'],
  preparing: ['countdown', 'tutorial', 'mode-select', 'title'],
  tutorial: ['active', 'mode-select', 'title', 'results', 'resolving'],
  countdown: ['active', 'mode-select'],
  active: ['resolving', 'paused', 'results', 'title'],
  paused: ['active', 'results', 'title', 'mode-select', 'preparing'], // preparing: restart
  resolving: ['active', 'results', 'paused', 'tutorial'],
  results: ['progression', 'preparing', 'mode-select', 'title'],
  progression: ['mode-select', 'preparing', 'title'],
};

const TICK_QUANTUM_MS = 100; // authoritative clock quantum
const TIMED_ASSIST_FACTOR = 1.5; // accessibility timing assistance

let commandCounter = 0;

export class GameSession {
  constructor({ settings, progress, platform, analytics } = {}) {
    this.settings = settings;
    this.progress = progress;
    this.platform = platform || null;
    this.analytics = analytics || null;
    this.status = 'boot';
    this.listeners = new Map();
    this.content = null; // content descriptor (see engine/content.js)
    this.config = null; // engine config derived from content
    this.state = null; // live rules state
    this.mode = null; // 'learn'|'journey'|'daily'|'practice'|'challenge'|'score'
    this.commands = []; // ordered accepted command log (replay envelope)
    this.roundId = null;
    this.timeLeftMs = null;
    this.timeTotalMs = null;
    this._tickCarry = 0;
    this._lastHudKey = '';
    this._skipRequested = false;
  }

  /* ---------------- emitter ---------------- */

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
    return () => this.off(event, cb);
  }
  off(event, cb) {
    const list = this.listeners.get(event);
    if (list) {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    }
  }
  emit(event, payload) {
    const list = this.listeners.get(event);
    if (list) for (const cb of list.slice()) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[session listener]', event, err);
      }
    }
  }

  /* ---------------- state machine ---------------- */

  transition(to, reason) {
    const from = this.status;
    if (from === to) return true;
    const allowed = ALLOWED[from] || [];
    if (!allowed.includes(to)) {
      console.warn('[session] blocked transition', from, '→', to, '(' + reason + ')');
      return false;
    }
    this.status = to;
    this.emit('fsm', { from, to, reason });
    return true;
  }

  /* ---------------- round lifecycle ---------------- */

  /**
   * Start a round from a content descriptor. The descriptor carries the
   * versioned content fields; toEngineConfig() maps them to engine config.
   */
  startRound(content, { resumed = false, resumedState = null, resumedCommands = null } = {}) {
    this.content = content;
    this.config = content.toEngineConfig();
    this.mode = content.mode;
    this.commands = resumedCommands ? resumedCommands.slice() : [];
    this.roundId = resumed && this._roundIdKept
      ? this._roundIdKept
      : 'r-' + Date.now().toString(36) + '-' + hex32(fnv1a(String(Math.random())));
    this._roundIdKept = this.roundId;

    this.transition('preparing', resumed ? 'resume-round' : 'start-round');

    if (resumedState) {
      this.state = rules.deserialize(resumedState);
    } else {
      this.state = rules.createGame(this.config);
    }

    // Timed challenge clock (timing assistance widens the window, never rules).
    this.timeTotalMs = null;
    this.timeLeftMs = null;
    if (content.timeLimitSec) {
      const assist = this.settings && this.settings.access.timingAssist ? TIMED_ASSIST_FACTOR : 1;
      this.timeTotalMs = Math.round(content.timeLimitSec * 1000 * assist);
      this.timeLeftMs = resumedState ? Math.max(0, this.timeTotalMs - this.state.elapsedMs) : this.timeTotalMs;
    }
    this._tickCarry = 0;

    this.emit('round', { content, config: this.config, resumed });
    if (this.analytics) this.analytics.track('start', { mode: this.mode, id: content.id });

    if (content.tutorial && !resumed) {
      this.transition('tutorial', 'lesson-required');
    } else {
      this.transition('countdown', 'round-prepared');
    }
    this.emitHud(true);
  }

  /** Countdown finished (or lesson finished) → play begins. */
  beginPlay(reason = 'countdown-complete') {
    if (this.status === 'tutorial' || this.status === 'countdown') {
      this.transition('active', reason);
      this.saveSnapshot();
    }
  }

  /**
   * The only play input. Gate: status must be active. One command id per
   * deliberate action prevents accidental double commits.
   */
  trySwap(ax, ay, bx, by) {
    if (!this.state || (this.status !== 'active' && this.status !== 'tutorial')) {
      return { accepted: false, reason: 'not-active' };
    }
    // Optional UI-installed gate (Learn lessons restrict input to the
    // currently taught action). The engine still validates everything.
    if (this.inputFilter && !this.inputFilter(ax, ay, bx, by)) {
      return { accepted: false, reason: 'filtered' };
    }
    const cmd = { id: this.roundId + '-c' + commandCounter++, type: 'swap', ax, ay, bx, by };
    const res = rules.applyCommand(this.state, cmd);
    if (!res.accepted) {
      if (res.reason !== rules.INVALID.DUPLICATE) {
        this.emit('invalid', { reason: res.reason, ax, ay, bx, by });
        if (res.events.length) this.emit('rules', { events: res.events, state: this.state, fast: true });
      }
      return res;
    }
    this.commands.push(cmd);
    this.transition('resolving', 'swap-accepted');
    this._skipRequested = false;
    this.emit('rules', { events: res.events, state: this.state, fast: false });
    this.emitHud();
    this.saveSnapshot();
    return res;
  }

  /**
   * The renderer calls this when every event from the last rules emission has
   * settled into the exact deterministic end state (instantly when skipping).
   */
  settled() {
    if (this.status !== 'resolving') return;
    if (this.state.phase === 'ended') {
      this.finishRound(this.state.reason);
    } else {
      // Lessons return to the tutorial state between guided moves.
      const backTo = this.content && this.content.tutorial ? 'tutorial' : 'active';
      this.transition(backTo, 'resolution-settled');
    }
    this.emitHud(true);
  }

  /** Player asked to skip/fast-forward: cosmetics jump to the end state. */
  requestSkip() {
    this._skipRequested = true;
    this.emit('skip');
  }

  get skipRequested() {
    return this._skipRequested;
  }

  hint() {
    if (!this.state || this.status !== 'active' || !this.state.assists.hints) return null;
    const mv = rules.suggestMove(this.state);
    if (mv) this.emit('hint', mv);
    return mv;
  }

  undo() {
    if (!this.state || (this.status !== 'active' && this.status !== 'paused')) return false;
    const res = rules.undo(this.state);
    if (res.accepted) {
      this.emit('undo', { state: this.state });
      this.emitHud(true);
      this.saveSnapshot();
    } else {
      this.emit('invalid', { reason: res.reason });
    }
    return res.accepted;
  }

  pause(reason = 'user') {
    if (this.status === 'active' || this.status === 'resolving') {
      this.transition('paused', reason);
      this.saveSnapshot();
      return true;
    }
    return false;
  }

  resume() {
    if (this.status === 'paused') {
      this.transition('active', 'resume');
      // The round may have ended while paused (settle timers keep running):
      // deliver its results now instead of stranding the player.
      if (this.state && this.state.phase === 'ended') {
        this.finishRound(this.state.reason);
      } else {
        this.emitHud(true);
      }
      return true;
    }
    return false;
  }

  resign() {
    if (!this.state || this.state.phase !== 'ready') return false;
    const res = rules.applyCommand(this.state, {
      id: this.roundId + '-resign-' + commandCounter++,
      type: 'resign',
    });
    if (res.accepted) {
      this.commands.push({ id: 'resign', type: 'resign' });
      this.finishRound(this.state.reason);
      return true;
    }
    return false;
  }

  /**
   * forceFinish — used by Learn lessons (all steps performed) and by the
   * authoritative clock for timed content. Rules engine stays the authority.
   */
  forceFinish(reason = rules.END.GOALS) {
    if (!this.state || this.state.phase !== 'ready') return false;
    const res = rules.forceEnd(this.state, reason);
    if (res.accepted) {
      this.finishRound(this.state.reason);
      return true;
    }
    return false;
  }

  /** Abandon without results (leave to menu). */
  abandon(reason = 'leave') {
    if (this.state && this.state.phase === 'ready' && this.movesSpent() > 0) {
      this.saveSnapshot(); // resumable later
    } else {
      storage.clearRoundSnapshot();
    }
    this._roundIdKept = null;
    this.transition('mode-select', reason);
  }

  movesSpent() {
    return this.state ? this.state.movesSpent : 0;
  }

  restart() {
    if (!this.content) return;
    storage.clearRoundSnapshot();
    this._roundIdKept = null;
    if (this.analytics) this.analytics.track('retry', { mode: this.mode, id: this.content.id });
    this.startRound(this.content);
  }

  /* ---------------- timers ---------------- */

  /** Called by the main loop with a real dt in ms; quantized internally. */
  tick(dtMs) {
    if (!this.state || this.state.phase !== 'ready') return;
    if (this.status !== 'active' && this.status !== 'resolving') return;
    this._tickCarry += dtMs;
    const quanta = Math.floor(this._tickCarry / TICK_QUANTUM_MS);
    if (quanta <= 0) return;
    const ms = quanta * TICK_QUANTUM_MS;
    this._tickCarry -= ms;
    rules.tickTime(this.state, ms);
    if (this.timeLeftMs !== null) {
      this.timeLeftMs = Math.max(0, this.timeTotalMs - this.state.elapsedMs);
      this.emit('timer', { leftMs: this.timeLeftMs, totalMs: this.timeTotalMs });
      if (this.timeLeftMs <= 0) {
        // Logged as a command so the replay envelope reproduces the ending.
        const cmd = { id: this.roundId + '-timeout-' + commandCounter++, type: 'timeout' };
        const res = rules.applyCommand(this.state, cmd);
        if (res.accepted) {
          this.commands.push(cmd);
          this.finishRound(rules.END.TIME);
        }
      }
    }
  }

  /* ---------------- results & progression ---------------- */

  buildResults() {
    const s = this.state;
    const won = s.reason === rules.END.GOALS;
    const stars = rules.starRating(s, this.content.stars);
    const replay = {
      schema: 1,
      contentId: this.content.id,
      contentVersion: this.content.version,
      seed: this.config.seed,
      config: this.config,
      commands: this.commands,
      finalHash: rules.hashState(s),
      score: s.score,
    };
    return {
      roundId: this.roundId,
      mode: this.mode,
      contentId: this.content.id,
      contentName: this.content.name,
      won,
      reason: s.reason,
      score: s.score,
      components: { ...s.components },
      stars,
      goals: s.goals.map((g) => ({ ...g })),
      stats: JSON.parse(JSON.stringify(s.stats)),
      movesSpent: s.movesSpent,
      movesTotal: this.config.moves,
      elapsedMs: s.elapsedMs,
      tieKey: rules.tieBreakKey(s, this.roundId),
      ranked: !!this.content.ranked,
      replay,
      timeLimitSec: this.content.timeLimitSec || null,
    };
  }

  finishRound(reason) {
    const results = this.buildResults();
    const out = this.recordProgression(results);
    results.progression = out;
    storage.clearRoundSnapshot();
    this._roundIdKept = null;
    this.transition('results', reason);
    this.emit('results', results);
    if (this.analytics) {
      this.analytics.track('round_end', {
        mode: results.mode,
        id: results.contentId,
        won: results.won,
        score: results.score,
        moves: results.movesSpent,
        ms: results.elapsedMs,
      });
    }
    if (this.platform && results.ranked) {
      this.platform.submitScore(results).catch(() => {});
    }
  }

  /** Fold results into persisted progression; returns a summary for UI. */
  recordProgression(results) {
    const p = this.progress;
    if (!p) return {};
    const summary = { stars: results.stars, firstClear: false, newAchievements: [], mastery: null, unlocks: [], dailyStreak: null };

    // Journey stars + unlock next stage.
    if (this.mode === 'journey' && results.won) {
      const prev = p.journeyStars[this.content.id] || 0;
      if (prev === 0) summary.firstClear = true;
      if (results.stars > prev) p.journeyStars[this.content.id] = results.stars;
      const stageNum = this.content.stage || 0;
      if (stageNum >= p.journeyUnlocked) p.journeyUnlocked = Math.min(40, stageNum + 1);
    }
    if (this.mode === 'challenge' && results.won) {
      const prev = p.challengesDone[this.content.id] || 0;
      if (results.stars > prev) p.challengesDone[this.content.id] = results.stars;
    }
    if (this.mode === 'learn' && results.won && this.content.tutorial) {
      p.tutorialsDone[this.content.tutorial] = true;
    }

    // Career counters + achievements (idempotent per roundId).
    recordRound(p, {
      roundId: results.roundId,
      won: results.won,
      score: results.score,
      stats: results.stats,
    });
    const earned = evaluateAchievements(p);
    for (const key of earned) {
      p.achievements[key] = { at: new Date().toISOString() };
      summary.newAchievements.push(key);
    }

    // Mastery XP + cosmetic unlocks (never affect rules).
    const xpGain = masteryXpForRound(results, summary.firstClear);
    const beforeLevel = masteryLevelForXp(p.masteryXp);
    p.masteryXp += xpGain;
    const afterLevel = masteryLevelForXp(p.masteryXp);
    summary.mastery = { gained: xpGain, total: p.masteryXp, levelBefore: beforeLevel, levelAfter: afterLevel };
    for (const m of MASTERY_LEVELS) {
      if (m.level > beforeLevel && m.level <= afterLevel && m.reward) {
        const r = m.reward;
        const bucket = r.type === 'theme' ? 'themes' : r.type === 'trail' ? 'trails' : r.type === 'frame' ? 'frames' : 'titles';
        if (!p.cosmeticsUnlocked[bucket].includes(r.id)) {
          p.cosmeticsUnlocked[bucket].push(r.id);
          summary.unlocks.push(r);
        }
      }
    }

    // Daily streak (UTC day granularity, provided by platform-adjusted clock).
    if (this.mode === 'daily' && this.content.dayKey) {
      const today = this.content.dayKey;
      if (p.daily.lastPlayed !== today) {
        const yesterday = dayKeyOffset(today, -1);
        p.daily.streak = p.daily.lastPlayed === yesterday ? p.daily.streak + 1 : 1;
        p.daily.lastPlayed = today;
      }
      if (results.score > (p.daily.best[today] || 0)) p.daily.best[today] = results.score;
      summary.dailyStreak = p.daily.streak;
    }
    if (this.mode === 'practice') p.practice.plays++;

    storage.saveProgress(p);
    return summary;
  }

  /* ---------------- snapshots ---------------- */

  saveSnapshot() {
    if (!this.state || this.state.phase !== 'ready') return;
    storage.saveRoundSnapshot({
      savedAt: Date.now(),
      content: this.content.toJSON ? this.content.toJSON() : this.content,
      config: this.config,
      stateJson: rules.serialize(this.state),
      commands: this.commands,
      roundId: this.roundId,
    });
  }

  emitHud(force) {
    if (!this.state) return;
    const s = this.state;
    const key = [s.score, s.movesLeft, s.turn, s.goals.map((g) => g.left + (g.done ? 'd' : '')).join(','), this.timeLeftMs].join('|');
    if (!force && key === this._lastHudKey) return;
    this._lastHudKey = key;
    this.emit('hud', {
      score: s.score,
      components: { ...s.components },
      movesLeft: s.movesLeft,
      goals: s.goals.map((g) => ({ ...g })),
      turn: s.turn,
      timeLeftMs: this.timeLeftMs,
      timeTotalMs: this.timeTotalMs,
      phase: s.phase,
      reason: s.reason,
    });
  }
}

/** UTC day key arithmetic, e.g. dayKeyOffset('2026-08-16', -1). */
export function dayKeyOffset(dayKey, delta) {
  const d = new Date(dayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
