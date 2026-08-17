/**
 * rules.js — Jewel Cascade deterministic match-3 rules engine.
 *
 * Pure, dependency-free (except rng.js), DOM-free, timer-free.
 * The same (contentVersion, seed, ordered commands) always produces the same
 * state hashes and event streams, in the browser, in Node tests, and inside
 * the authoritative server script.
 *
 * Board model
 * -----------
 * Flat array of cells, index = y * width + x, y = 0 at the TOP.
 * Cell: { play, j, ice, crate }
 *   play  — false for holes (no jewel, no spawn, not a target)
 *   j     — null or { c: colorIndex, s: SPECIAL.* }
 *   ice   — 0..2; ice>0 locks the jewel (cannot swap). A match or blast hit
 *           on the cell removes one ice layer; the jewel is only removed when
 *           the hit leaves ice at 0.
 *   crate — 0..2 hit points. Crates hold no jewel, never move, and are
 *           damaged by matches/blasts on orthogonally adjacent cells.
 *
 * Moves
 * -----
 * A swap of two adjacent jewels is legal when it produces at least one match
 * or involves a prism. A no-match swap is rejected (jewels swap back), costs
 * no move, and counts as an invalid action for tie-breaks. Every accepted,
 * matched swap spends exactly one move, then resolves matches → damage →
 * gravity → spawns → cascades deterministically.
 *
 * Specials
 * --------
 *   RAY_H / RAY_V — created by a 4-run; clears its row / column when fired.
 *   BLOOM         — created by an L/T intersection; clears a 3×3 area.
 *   PRISM         — created by a 5+ run; swapped with a jewel it clears that
 *                   color; with a ray/bloom it turns that color into those
 *                   specials and fires them; with a prism it clears the board.
 * Specials carry a color and take part in ordinary color matches; a special
 * removed by anything fires its effect (chain reactions allowed, FIFO order).
 */

import { Rng, fnv1a, stableStringify, stateHash } from './rng.js';

export const RULES_VERSION = 1;

export const COLOR_NAMES = [
  'ruby',
  'amber',
  'topaz',
  'emerald',
  'sapphire',
  'amethyst',
  'opal',
];

export const SPECIAL = { NONE: 0, RAY_H: 1, RAY_V: 2, BLOOM: 3, PRISM: 4 };
export const SPECIAL_NAMES = ['', 'ray-h', 'ray-v', 'bloom', 'prism'];

export const INVALID = {
  ENDED: 'ended',
  OUT_OF_BOUNDS: 'out-of-bounds',
  NOT_ADJACENT: 'not-adjacent',
  NO_JEWEL: 'no-jewel',
  CRATE: 'crate-cell',
  ICE_LOCKED: 'ice-locked',
  NO_MATCH: 'no-match',
  BAD_COMMAND: 'bad-command',
  DUPLICATE: 'duplicate',
  NO_UNDO: 'no-undo',
};

export const END = {
  GOALS: 'goals-complete',
  MOVES: 'out-of-moves',
  RESIGNED: 'resigned',
  TIME: 'time-expired',
};

/** Integer score constants. Presentation formats; rules store integers. */
export const SCORE = {
  PER_JEWEL: 10, // every removed jewel
  GROUP_BASE: 50, // per matched group
  GROUP_EXTRA: 20, // per jewel in a group beyond 3
  CASCADE_STEP: 30, // × (cascadeIndex-1) × groups this step
  MAKE_RAY: 80,
  MAKE_BLOOM: 120,
  MAKE_PRISM: 200,
  DETONATE: 60, // per fired special
  CRATE_HIT: 40,
  CRATE_BREAK: 100,
  ICE_BREAK: 60, // per layer removed
  GOAL_DONE: 300,
  LEFTOVER_MOVE: 120,
};

const MAX_CASCADE_STEPS = 64; // safety bound; never reached in valid play
const MAX_SPAWN_ATTEMPTS = 200;
const MAX_SHUFFLE_ATTEMPTS = 120;
const SEEN_LIMIT = 64; // idempotency ring size
const HISTORY_LIMIT = 60;

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

export function idx(state, x, y) {
  return y * state.width + x;
}
export function xy(state, i) {
  return { x: i % state.width, y: Math.floor(i / state.width) };
}
export function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function cellKey(x, y) {
  return x + ',' + y;
}

/** Deep clone of the rules-relevant state (history/seen excluded). */
export function cloneState(state) {
  const copy = {
    ...state,
    cells: state.cells.map((c) => ({
      play: c.play,
      j: c.j ? { c: c.j.c, s: c.j.s } : null,
      ice: c.ice,
      crate: c.crate,
    })),
    components: { ...state.components },
    goals: state.goals.map((g) => ({ ...g })),
    stats: { ...state.stats, made: { ...state.stats.made } },
    assists: { ...state.assists },
  };
  copy.history = [];
  copy.seen = state.seen.slice();
  return copy;
}

/** Canonical serializable snapshot (drops undo history + idempotency ring).
 *  elapsedMs is wall-clock metadata, not simulation state: it is excluded so
 *  replayed command logs reproduce the hash exactly (the authoritative clock
 *  is validated separately by plausibility checks). */
export function snapshotForHash(state) {
  const { history, seen, elapsedMs, ...rest } = state;
  return rest;
}

export function serialize(state) {
  return stableStringify(state);
}

export function hashState(state) {
  return stateHash(snapshotForHash(state));
}

/**
 * State migrations, keyed by from-version. Version 1 is current; the registry
 * exists so future versions can migrate old snapshots/saves deterministically.
 */
export const MIGRATIONS = {
  1: (s) => s,
};

export function deserialize(json) {
  let state = typeof json === 'string' ? JSON.parse(json) : json;
  let guard = 0;
  while (state.version !== RULES_VERSION) {
    const mig = MIGRATIONS[state.version];
    if (!mig || guard++ > 16) throw new Error('unsupported state version ' + state.version);
    state = mig(state);
  }
  if (!Array.isArray(state.history)) state.history = [];
  if (!Array.isArray(state.seen)) state.seen = [];
  return state;
}

/* ------------------------------------------------------------------ *
 *  Board generation
 * ------------------------------------------------------------------ */

function wouldRun(board, width, height, x, y, c) {
  // Check the two jewels left and the two above for an immediate run.
  if (x >= 2) {
    const a = board[y * width + x - 1];
    const b = board[y * width + x - 2];
    if (a !== null && b !== null && a === c && b === c) return true;
  }
  if (y >= 2) {
    const a = board[(y - 1) * width + x];
    const b = board[(y - 2) * width + x];
    if (a !== null && b !== null && a === c && b === c) return true;
  }
  return false;
}

/**
 * Deterministic no-match fallback pattern + one guaranteed legal move.
 * Used only if random generation exhausts its attempt budget.
 */
function fallbackColors(width, height, play, colors) {
  const board = new Array(width * height).fill(null);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!play[y * width + x]) continue;
      board[y * width + x] = (x + y * 2) % colors;
    }
  }
  // Guarantee a legal move: pattern A ? A in a row with A above the middle.
  outer: for (let y = 1; y < height; y++) {
    for (let x = 0; x + 2 < width; x++) {
      const i0 = y * width + x;
      const i1 = y * width + x + 1;
      const i2 = y * width + x + 2;
      const up = (y - 1) * width + x + 1;
      if (!(play[i0] && play[i1] && play[i2] && play[up])) continue;
      for (let a = 0; a < colors; a++) {
        const b = (a + 1) % colors;
        board[i0] = a;
        board[i1] = b;
        board[i2] = a;
        board[up] = a;
        if (!anyMatchOnColors(board, width, height, play)) break outer;
      }
    }
  }
  return board;
}

function anyMatchOnColors(board, width, height, play) {
  const has = (i) => play[i] && board[i] !== null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!has(i)) continue;
      const c = board[i];
      if (x + 2 < width && has(i + 1) && has(i + 2) && board[i + 1] === c && board[i + 2] === c)
        return true;
      if (
        y + 2 < height &&
        has(i + width) &&
        has(i + 2 * width) &&
        board[i + width] === c &&
        board[i + 2 * width] === c
      )
        return true;
    }
  }
  return false;
}

/**
 * Parse an authored ASCII layout.
 *   '#'  hole          '.'  playable, random jewel
 *   '0'-'6' fixed jewel color
 *   'c'  crate hp1 (random jewel neighbours)   'C' crate hp2
 *   'i'  playable, random jewel under ice 1    'I' ice 2
 * Returns { play, fixed, crates, ice } as flat arrays/maps.
 */
export function parseAscii(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const play = new Array(width * height).fill(false);
  const fixed = new Array(width * height).fill(null);
  const crates = [];
  const ice = [];
  for (let y = 0; y < height; y++) {
    if (rows[y].length !== width) throw new Error('ragged ascii board row ' + y);
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const i = y * width + x;
      if (ch === '#') continue;
      play[i] = true;
      if (ch >= '0' && ch <= '6') fixed[i] = Number(ch);
      else if (ch === 'c') crates.push({ x, y, hp: 1 });
      else if (ch === 'C') crates.push({ x, y, hp: 2 });
      else if (ch === 'i') ice.push({ x, y, level: 1 });
      else if (ch === 'I') ice.push({ x, y, level: 2 });
      else if (ch !== '.') throw new Error('bad ascii cell "' + ch + '"');
    }
  }
  return { width, height, play, fixed, crates, ice };
}

/* ------------------------------------------------------------------ *
 *  Game creation
 * ------------------------------------------------------------------ */

/**
 * config: {
 *   contentId, contentVersion, seed (uint32 or string),
 *   width, height, colors (3..7), moves,
 *   goals: [{type:'collect',color,n}|{type:'crates',n}|{type:'ice',n}|{type:'score',n}],
 *   layout?: ascii rows (string[]) OR play array,
 *   fixed?: flat array of color indexes or null,
 *   crates?: [{x,y,hp}], ice?: [{x,y,level}],
 *   assists?: {undo?:bool, hints?:bool}, ranked?: bool,
 *   timeLimitMs?: number|null (meta; enforced by session via tick/forceEnd)
 * }
 */
export function createGame(config) {
  const seed = typeof config.seed === 'string' ? fnv1a(config.seed) : config.seed >>> 0;
  let width = config.width;
  let height = config.height;
  let play;
  let fixed = null;
  let crates = config.crates ? config.crates.slice() : [];
  let ice = config.ice ? config.ice.slice() : [];

  if (config.layout) {
    const parsed = parseAscii(config.layout);
    width = parsed.width;
    height = parsed.height;
    play = parsed.play;
    fixed = parsed.fixed;
    crates = crates.concat(parsed.crates);
    ice = ice.concat(parsed.ice);
  } else if (config.play) {
    play = config.play.slice();
  } else {
    play = new Array(width * height).fill(true);
  }

  const colors = config.colors;
  const rng = new Rng(seed);

  // Generate jewel colors: no initial matches, at least one legal move.
  let colorsBoard = null;
  let attempts = 0;
  for (; attempts < MAX_SPAWN_ATTEMPTS; attempts++) {
    const board = new Array(width * height).fill(null);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!play[i]) continue;
        if (fixed && fixed[i] !== null && fixed[i] < colors) {
          board[i] = fixed[i];
          continue;
        }
        const banned = new Set();
        for (let c = 0; c < colors; c++) {
          if (wouldRun(board, width, height, x, y, c)) banned.add(c);
        }
        let c;
        if (banned.size >= colors) c = rng.int(colors);
        else {
          do {
            c = rng.int(colors);
          } while (banned.has(c));
        }
        board[i] = c;
      }
    }
    colorsBoard = board;
    const probe = buildStateSkeleton(config, width, height, play, board, crates, ice, seed, rng);
    if (legalActions(probe).length > 0) break;
  }
  if (attempts >= MAX_SPAWN_ATTEMPTS) {
    colorsBoard = fallbackColors(width, height, play, colors);
  }

  const state = buildStateSkeleton(config, width, height, play, colorsBoard, crates, ice, seed, rng);
  return state;
}

function buildStateSkeleton(config, width, height, play, colorsBoard, crates, ice, seed, rng) {
  const cells = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    cells[i] = {
      play: !!play[i],
      j: play[i] && colorsBoard[i] !== null ? { c: colorsBoard[i], s: SPECIAL.NONE } : null,
      ice: 0,
      crate: 0,
    };
  }
  for (const cr of crates) {
    const i = idx({ width }, cr.x, cr.y);
    if (cells[i]) {
      cells[i].crate = cr.hp;
      cells[i].j = null;
    }
  }
  for (const ic of ice) {
    const i = idx({ width }, ic.x, ic.y);
    if (cells[i] && cells[i].j) cells[i].ice = ic.level;
  }
  return {
    version: RULES_VERSION,
    contentId: config.contentId || 'ad-hoc',
    contentVersion: config.contentVersion || 1,
    seed,
    rng: rng.getState(),
    width,
    height,
    colors: config.colors,
    cells,
    movesLeft: config.moves,
    movesSpent: 0,
    score: 0,
    components: { match: 0, cascade: 0, special: 0, blocker: 0, goal: 0, leftover: 0 },
    goals: (config.goals || []).map((g) => ({ ...g, left: g.n, done: false })),
    turn: 0,
    phase: 'ready',
    reason: null,
    stats: {
      swaps: 0,
      invalid: 0,
      cascadesMax: 0,
      shuffles: 0,
      made: { ray: 0, bloom: 0, prism: 0 },
      detonated: 0,
    },
    elapsedMs: 0,
    assists: { undo: !!(config.assists && config.assists.undo), hints: config.assists ? config.assists.hints !== false : true },
    ranked: !!config.ranked,
    timeLimitMs: config.timeLimitMs || null,
    history: [],
    seen: [],
  };
}

/* ------------------------------------------------------------------ *
 *  Match finding
 * ------------------------------------------------------------------ */

/** All runs of 3+ same-color jewels. Returns [{cells:[idx], color, dir}]. */
export function findMatches(state) {
  const { width, height, cells } = state;
  const groups = [];
  const colorAt = (i) => {
    const cell = cells[i];
    return cell.play && cell.j && !cell.crate ? cell.j.c : -1;
  };
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const i = y * width + x;
      const c = colorAt(i);
      if (c < 0) {
        x++;
        continue;
      }
      let len = 1;
      while (x + len < width && colorAt(i + len) === c) len++;
      if (len >= 3) {
        const list = [];
        for (let k = 0; k < len; k++) list.push(i + k);
        groups.push({ cells: list, color: c, dir: 'h' });
      }
      x += len;
    }
  }
  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      const i = y * width + x;
      const c = colorAt(i);
      if (c < 0) {
        y++;
        continue;
      }
      let len = 1;
      while (y + len < height && colorAt(i + len * width) === c) len++;
      if (len >= 3) {
        const list = [];
        for (let k = 0; k < len; k++) list.push(i + k * width);
        groups.push({ cells: list, color: c, dir: 'v' });
      }
      y += len;
    }
  }
  return groups;
}

/** Early-exit "would this board produce any match" used by legality probes. */
function hasAnyMatch(state) {
  return findMatches(state).length > 0;
}

/* ------------------------------------------------------------------ *
 *  Legal actions
 * ------------------------------------------------------------------ */

function swappable(state, i) {
  const cell = state.cells[i];
  return !!(cell && cell.play && cell.j && !cell.crate && cell.ice === 0);
}

/**
 * checkSwap — full legality report with a machine-readable reason.
 * Does not test for "produces a match" (that is what probes are for);
 * a structurally valid swap that yields no match is reported ok:true and is
 * rejected later as INVALID.NO_MATCH by applyCommand.
 */
export function checkSwap(state, ax, ay, bx, by) {
  if (state.phase !== 'ready') return { ok: false, reason: INVALID.ENDED };
  if (!inBounds(state, ax, ay) || !inBounds(state, bx, by))
    return { ok: false, reason: INVALID.OUT_OF_BOUNDS };
  const dist = Math.abs(ax - bx) + Math.abs(ay - by);
  if (dist !== 1) return { ok: false, reason: INVALID.NOT_ADJACENT };
  const a = idx(state, ax, ay);
  const b = idx(state, bx, by);
  const ca = state.cells[a];
  const cb = state.cells[b];
  if (ca.crate || cb.crate) return { ok: false, reason: INVALID.CRATE };
  if (!ca.play || !cb.play || !ca.j || !cb.j) return { ok: false, reason: INVALID.NO_JEWEL };
  if (ca.ice > 0 || cb.ice > 0) return { ok: false, reason: INVALID.ICE_LOCKED };
  return { ok: true, a, b };
}

function swapJewels(state, a, b) {
  const t = state.cells[a].j;
  state.cells[a].j = state.cells[b].j;
  state.cells[b].j = t;
}

/**
 * legalActions — every currently legal swap, in deterministic scan order.
 * This is the single API used by play, hints, tutorials, and validators.
 */
export function legalActions(state) {
  if (state.phase !== 'ready') return [];
  const { width, height } = state;
  const actions = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = y * width + x;
      if (!swappable(state, a)) continue;
      const dirs = [
        [1, 0],
        [0, 1],
      ];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(state, nx, ny)) continue;
        const b = ny * width + nx;
        if (!swappable(state, b)) continue;
        const ja = state.cells[a].j;
        const jb = state.cells[b].j;
        if (ja.s === SPECIAL.PRISM || jb.s === SPECIAL.PRISM) {
          actions.push({ ax: x, ay: y, bx: nx, by: ny, prism: true });
          continue;
        }
        if (ja.c === jb.c) continue; // swapping identical colors can never match
        swapJewels(state, a, b);
        const ok = hasAnyMatch(state);
        swapJewels(state, a, b);
        if (ok) actions.push({ ax: x, ay: y, bx: nx, by: ny, prism: false });
      }
    }
  }
  return actions;
}

/* ------------------------------------------------------------------ *
 *  Command validation & idempotency
 * ------------------------------------------------------------------ */

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return false;
  if (typeof cmd.id !== 'string' || cmd.id.length === 0 || cmd.id.length > 64) return false;
  if (cmd.type !== 'swap' && cmd.type !== 'resign' && cmd.type !== 'timeout') return false;
  if (cmd.type === 'swap') {
    return isInt(cmd.ax) && isInt(cmd.ay) && isInt(cmd.bx) && isInt(cmd.by);
  }
  return true;
}

function seenContains(state, id) {
  return state.seen.indexOf(id) !== -1;
}

function seenPush(state, id) {
  state.seen.push(id);
  if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT);
}

/* ------------------------------------------------------------------ *
 *  Scoring / goals helpers
 * ------------------------------------------------------------------ */

function addScore(state, component, points) {
  state.components[component] += points;
  state.score += points;
}

function goalProgress(state, type, color, amount, events) {
  for (let gi = 0; gi < state.goals.length; gi++) {
    const g = state.goals[gi];
    if (g.done || g.type !== type) continue;
    if (type === 'collect' && g.color !== color) continue;
    g.left = Math.max(0, g.left - amount);
    if (g.left === 0) {
      g.done = true;
      addScore(state, 'goal', SCORE.GOAL_DONE);
    }
    events.push({ t: 'goal', i: gi, left: g.left, done: g.done });
  }
}

function refreshScoreGoal(state, events) {
  for (let gi = 0; gi < state.goals.length; gi++) {
    const g = state.goals[gi];
    if (g.type !== 'score') continue;
    const left = Math.max(0, g.n - state.score);
    if (!g.done && left === 0) {
      g.done = true;
      addScore(state, 'goal', SCORE.GOAL_DONE);
    }
    if (g.left !== left || events.some((e) => e.t === 'goal' && e.i === gi)) {
      g.left = left;
      events.push({ t: 'goal', i: gi, left, done: g.done });
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Resolution
 * ------------------------------------------------------------------ */

function rng(state) {
  const r = new Rng(0);
  r.setState(state.rng);
  return r;
}
function commitRng(state, r) {
  state.rng = r.getState();
}

/** Apply one hit (match or blast) to a cell. Returns 'removed'|'iced'|'crate'|null. */
function hitCell(state, i, events, cause, removedSet) {
  const cell = state.cells[i];
  if (!cell.play) return null;
  if (cell.crate > 0) {
    cell.crate -= 1;
    addScore(state, 'blocker', SCORE.CRATE_HIT);
    events.push({ t: 'damage', idx: i, hp: cell.crate });
    if (cell.crate === 0) {
      events.push({ t: 'crate-break', idx: i });
      addScore(state, 'blocker', SCORE.CRATE_BREAK);
      goalProgress(state, 'crates', null, 1, events);
    }
    return 'crate';
  }
  if (!cell.j) return null;
  if (cell.ice > 0) {
    cell.ice -= 1;
    addScore(state, 'blocker', SCORE.ICE_BREAK);
    events.push({ t: 'crack', idx: i, ice: cell.ice });
    if (cell.ice === 0) goalProgress(state, 'ice', null, 1, events);
    if (cell.ice > 0) return 'iced';
    // ice reached 0 on this hit: the jewel is removed by the same hit
  }
  if (removedSet.has(i)) return null;
  removedSet.add(i);
  return 'removed';
}

/** Fire one special's effect; returns the list of hit indexes (deduped). */
function specialTargets(state, i, s) {
  const { width, height } = state;
  const { x, y } = xy(state, i);
  const targets = [];
  if (s === SPECIAL.RAY_H) {
    for (let cx = 0; cx < width; cx++) targets.push(y * width + cx);
  } else if (s === SPECIAL.RAY_V) {
    for (let cy = 0; cy < height; cy++) targets.push(cy * width + x);
  } else if (s === SPECIAL.BLOOM) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(state, nx, ny)) targets.push(ny * width + nx);
      }
    }
  }
  return targets;
}

/**
 * Remove the jewels in removedSet, fire chained specials, apply crate splash
 * damage, and score. `cause` feeds events. Returns nothing; mutates state.
 */
function applyRemovals(state, removedSet, events, cause, cascadeIndex, creations) {
  const queue = [];
  for (const i of removedSet) {
    const cell = state.cells[i];
    if (cell.j && cell.j.s !== SPECIAL.NONE) queue.push(i);
  }
  // Removals already announced+scored as 'effect' (chained blasts); the final
  // loop must still physically clear them but must not double-count.
  const effectSet = new Set();
  // Splash damage to crates adjacent to matched removals (once per crate per step).
  if (cause === 'match') {
    const damaged = new Set();
    for (const i of removedSet) {
      const { x, y } = xy(state, i);
      const nbs = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of nbs) {
        if (!inBounds(state, nx, ny)) continue;
        const ni = ny * state.width + nx;
        const cell = state.cells[ni];
        if (cell.play && cell.crate > 0 && !damaged.has(ni)) {
          damaged.add(ni);
          hitCell(state, ni, events, 'splash', new Set());
        }
      }
    }
  }
  // Fire queued specials; their hits may queue more specials (FIFO chains).
  const fired = new Set();
  while (queue.length > 0) {
    const i = queue.shift();
    if (fired.has(i)) continue;
    fired.add(i);
    const cell = state.cells[i];
    if (!cell.j) continue;
    const s = cell.j.s;
    if (s === SPECIAL.NONE) continue;
    state.stats.detonated++;
    addScore(state, 'special', SCORE.DETONATE);
    let targets;
    if (s === SPECIAL.PRISM) {
      targets = [];
      const color = cell.j.c;
      for (let k = 0; k < state.cells.length; k++) {
        if (state.cells[k].j && state.cells[k].j.c === color && k !== i) targets.push(k);
      }
    } else {
      targets = specialTargets(state, i, s);
    }
    events.push({ t: 'blast', idx: i, s, hits: targets.slice() });
    const chainedRemoved = new Set();
    for (const ti of targets) {
      const res = hitCell(state, ti, events, 'blast', chainedRemoved);
      if (res === 'removed') {
        const tcell = state.cells[ti];
        if (tcell.j && tcell.j.s !== SPECIAL.NONE && !fired.has(ti)) queue.push(ti);
      }
    }
    for (const ti of chainedRemoved) {
      if (!removedSet.has(ti)) {
        removedSet.add(ti);
        effectSet.add(ti);
        addScore(state, 'special', SCORE.PER_JEWEL);
        const tj = state.cells[ti].j;
        if (tj) goalProgress(state, 'collect', tj.c, 1, events);
        events.push({ t: 'remove', idx: ti, c: tj ? tj.c : -1, s: tj ? tj.s : 0, cause: 'effect', cascade: cascadeIndex });
      }
    }
  }
  // Physical removal (creation cells keep their jewel; it transforms instead).
  for (const i of removedSet) {
    if (creations && creations.has(i)) continue;
    const cell = state.cells[i];
    if (cell.j) {
      if (cause === 'match' && !effectSet.has(i)) {
        addScore(state, 'match', SCORE.PER_JEWEL);
        goalProgress(state, 'collect', cell.j.c, 1, events);
        events.push({ t: 'remove', idx: i, c: cell.j.c, s: cell.j.s, cause: 'match', cascade: cascadeIndex });
      }
      cell.j = null;
    }
  }
}

/**
 * Choose special creations for a set of match groups.
 * Returns Map idx -> special kind. Deterministic.
 */
function planCreations(state, groups, swapIdxs) {
  const creations = new Map();
  const inGroups = new Map(); // idx -> groups containing it
  groups.forEach((g, gi) => {
    for (const i of g.cells) {
      if (!inGroups.has(i)) inGroups.set(i, []);
      inGroups.get(i).push(gi);
    }
  });
  const usedGroups = new Set();
  // 1) Intersections (L/T shapes) -> BLOOM at the shared cell.
  const intersections = [...inGroups.entries()]
    .filter(([, gs]) => {
      if (gs.length < 2) return false;
      const dirs = new Set(gs.map((gi) => groups[gi].dir));
      return dirs.size > 1;
    })
    .map(([i]) => i)
    .sort((a, b) => a - b);
  for (const i of intersections) {
    creations.set(i, SPECIAL.BLOOM);
    for (const gi of inGroups.get(i)) usedGroups.add(gi);
  }
  // 2) Straight 5+ -> PRISM; 3) straight 4 -> RAY along the run.
  groups.forEach((g, gi) => {
    if (usedGroups.has(gi)) return;
    if (g.cells.length >= 5) {
      creations.set(pickCreationCell(g, swapIdxs), SPECIAL.PRISM);
    } else if (g.cells.length === 4) {
      creations.set(pickCreationCell(g, swapIdxs), g.dir === 'h' ? SPECIAL.RAY_H : SPECIAL.RAY_V);
    }
  });
  return creations;
}

function pickCreationCell(g, swapIdxs) {
  if (swapIdxs) {
    // Prefer the cell the player swapped into, then the other swap cell.
    if (g.cells.includes(swapIdxs.b)) return swapIdxs.b;
    if (g.cells.includes(swapIdxs.a)) return swapIdxs.a;
  }
  return g.cells[Math.floor((g.cells.length - 1) / 2)];
}

/**
 * Full resolve loop after a board change (matched swap, prism swap, shuffle
 * is guaranteed quiet). Mutates state; appends events.
 */
function resolveBoard(state, events, swapIdxs) {
  let cascade = 0;
  let first = true;
  while (cascade < MAX_CASCADE_STEPS) {
    const groups = findMatches(state);
    if (groups.length === 0) break;
    cascade++;
    const creations = first ? planCreations(state, groups, swapIdxs) : planCreations(state, groups, null);
    first = false;
    events.push({
      t: 'match',
      cascade,
      groups: groups.map((g) => ({ cells: g.cells.slice(), color: g.color, dir: g.dir })),
    });
    // Group scoring.
    for (const g of groups) {
      addScore(state, 'match', SCORE.GROUP_BASE + SCORE.GROUP_EXTRA * Math.max(0, g.cells.length - 3));
    }
    if (cascade > 1) addScore(state, 'cascade', SCORE.CASCADE_STEP * (cascade - 1) * groups.length);
    state.stats.cascadesMax = Math.max(state.stats.cascadesMax, cascade);
    // Collect removals through the ice rules.
    const removedSet = new Set();
    for (const g of groups) {
      for (const i of g.cells) {
        hitCell(state, i, events, 'match', removedSet);
      }
    }
    applyRemovals(state, removedSet, events, 'match', cascade, creations);
    // Apply creations (surviving jewel transforms, keeps its color).
    for (const [i, s] of creations) {
      const cell = state.cells[i];
      if (cell.j && cell.ice === 0) {
        cell.j = { c: cell.j.c, s };
        const kind = s === SPECIAL.PRISM ? 'prism' : s === SPECIAL.BLOOM ? 'bloom' : 'ray';
        state.stats.made[kind]++;
        addScore(state, 'special', s === SPECIAL.PRISM ? SCORE.MAKE_PRISM : s === SPECIAL.BLOOM ? SCORE.MAKE_BLOOM : SCORE.MAKE_RAY);
        events.push({ t: 'create', idx: i, c: cell.j.c, s });
      }
    }
    applyGravityAndSpawn(state, events);
  }
}

/** Gravity within crate/hole/ice-delimited column segments; materialize spawns. */
function applyGravityAndSpawn(state, events) {
  const { width, height, cells } = state;
  const r = rng(state);
  // A cell is a gravity wall when it is a hole, a crate, or holds an
  // ice-locked jewel (locked jewels never move until their ice breaks).
  const isWall = (c) => !c.play || c.crate > 0 || (c.j && c.ice > 0);
  for (let x = 0; x < width; x++) {
    let y = height - 1;
    while (y >= 0) {
      while (y >= 0 && isWall(cells[y * width + x])) y--;
      if (y < 0) break;
      let segBottom = y;
      let segTop = y;
      while (segTop - 1 >= 0 && !isWall(cells[(segTop - 1) * width + x])) segTop--;
      // Compact jewels downward inside [segTop..segBottom].
      let write = segBottom;
      for (let ry = segBottom; ry >= segTop; ry--) {
        const i = ry * width + x;
        if (cells[i].j) {
          if (write !== ry) {
            const wi = write * width + x;
            cells[wi].j = cells[i].j;
            cells[i].j = null;
            events.push({ t: 'fall', from: i, to: wi });
          }
          write--;
        }
      }
      // Fill the rest of the segment with fresh jewels.
      for (let ry = write; ry >= segTop; ry--) {
        const i = ry * width + x;
        const c = r.int(state.colors);
        cells[i].j = { c, s: SPECIAL.NONE };
        events.push({ t: 'spawn', idx: i, c, s: SPECIAL.NONE, materialize: ry !== segTop });
      }
      y = segTop - 1;
    }
  }
  commitRng(state, r);
}

/** Prism involved swap: always legal, always spends the move. */
function resolvePrismSwap(state, events, a, b) {
  const ca = state.cells[a];
  const cb = state.cells[b];
  const prismIdx = ca.j.s === SPECIAL.PRISM ? a : b;
  const otherIdx = prismIdx === a ? b : a;
  const prism = state.cells[prismIdx].j;
  const other = state.cells[otherIdx].j;
  events.push({ t: 'swap', a, b });
  let targets = [];
  let mode = 'color';
  if (other.s === SPECIAL.PRISM) {
    mode = 'prism';
    for (let i = 0; i < state.cells.length; i++) {
      if (state.cells[i].play && state.cells[i].j && !state.cells[i].crate) targets.push(i);
    }
    events.push({ t: 'prism-swap', idx: prismIdx, other: otherIdx, mode, color: -1 });
  } else if (other.s === SPECIAL.RAY_H || other.s === SPECIAL.RAY_V || other.s === SPECIAL.BLOOM) {
    mode = 'special';
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      if (cell.play && cell.j && !cell.crate && cell.j.c === other.c && i !== prismIdx && i !== otherIdx) {
        cell.j = { c: cell.j.c, s: other.s };
        targets.push(i);
      }
    }
    events.push({ t: 'prism-swap', idx: prismIdx, other: otherIdx, mode, color: other.c, s: other.s });
  } else {
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      if (cell.play && cell.j && !cell.crate && cell.j.c === other.c) targets.push(i);
    }
    events.push({ t: 'prism-swap', idx: prismIdx, other: otherIdx, mode, color: other.c });
  }
  // The prism itself fires; the other jewel is consumed.
  state.stats.detonated++;
  addScore(state, 'special', SCORE.DETONATE);
  const removedSet = new Set([prismIdx, otherIdx]);
  events.push({ t: 'remove', idx: prismIdx, c: prism.c, s: SPECIAL.PRISM, cause: 'prism', cascade: 0 });
  events.push({ t: 'remove', idx: otherIdx, c: other.c, s: other.s, cause: 'prism', cascade: 0 });
  goalProgress(state, 'collect', other.c, 1, events);
  state.cells[prismIdx].j = null;
  state.cells[otherIdx].j = null;
  for (const i of targets) {
    const res = hitCell(state, i, events, 'prism', removedSet);
    if (res === 'removed' && !removedSet.has(i)) removedSet.add(i);
  }
  applyRemovals(state, removedSet, events, 'effect', 0, null);
  applyGravityAndSpawn(state, events);
  resolveBoard(state, events, null);
}

/* ------------------------------------------------------------------ *
 *  End-of-turn: goals, terminal states, shuffle
 * ------------------------------------------------------------------ */

function allGoalsDone(state) {
  return state.goals.every((g) => g.done);
}

function endGame(state, events, reason) {
  state.phase = 'ended';
  state.reason = reason;
  if (reason === END.GOALS && state.movesLeft > 0) {
    const bonus = state.movesLeft * SCORE.LEFTOVER_MOVE;
    addScore(state, 'leftover', bonus);
    state.movesLeft = 0;
  }
  refreshScoreGoal(state, events);
  events.push({ t: 'end', reason, score: state.score });
}

/** Deterministic redeal when no legal swap exists. Never costs a move. */
function shuffleBoard(state, events) {
  const movable = [];
  for (let i = 0; i < state.cells.length; i++) {
    const cell = state.cells[i];
    if (cell.play && cell.j && !cell.crate && cell.ice === 0) movable.push(i);
  }
  if (movable.length < 3) return; // nothing meaningful to shuffle
  const r = rng(state);
  const jewels = movable.map((i) => state.cells[i].j);
  let attempts = 0;
  for (; attempts < MAX_SHUFFLE_ATTEMPTS; attempts++) {
    r.shuffle(jewels);
    movable.forEach((cellIdx, k) => {
      state.cells[cellIdx].j = jewels[k];
    });
    if (findMatches(state).length === 0 && legalActions(state).length > 0) break;
  }
  if (attempts >= MAX_SHUFFLE_ATTEMPTS) {
    // Guaranteed construction: no-match pattern + forced move, preserving
    // nothing (validity beats conservation only as a last resort).
    const play = state.cells.map((c) => c.play);
    const colors = fallbackColors(state.width, state.height, play, state.colors);
    movable.forEach((cellIdx) => {
      state.cells[cellIdx].j = { c: colors[cellIdx], s: SPECIAL.NONE };
    });
  }
  commitRng(state, r);
  state.stats.shuffles++;
  events.push({ t: 'shuffle', cells: movable.slice() });
}

/* ------------------------------------------------------------------ *
 *  Public command API
 * ------------------------------------------------------------------ */

function pushHistory(state) {
  if (!state.assists.undo) return;
  const snap = cloneState(state);
  snap.history = [];
  snap.seen = [];
  state.history.push(snap);
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
}

/**
 * applyCommand — the ONLY way play mutates rules state.
 * cmd: {id, type:'swap', ax,ay,bx,by} | {id, type:'resign'}
 * Returns {state, events, accepted, reason?}. Never throws on bad input.
 */
export function applyCommand(state, cmd) {
  const events = [];
  if (!validateCommand(cmd)) {
    return { state, events, accepted: false, reason: INVALID.BAD_COMMAND };
  }
  if (seenContains(state, cmd.id)) {
    return { state, events, accepted: false, reason: INVALID.DUPLICATE };
  }
  if (state.phase !== 'ready') {
    return { state, events, accepted: false, reason: INVALID.ENDED };
  }
  seenPush(state, cmd.id);

  if (cmd.type === 'resign') {
    endGame(state, events, END.RESIGNED);
    return { state, events, accepted: true };
  }
  if (cmd.type === 'timeout') {
    endGame(state, events, END.TIME);
    return { state, events, accepted: true };
  }

  const check = checkSwap(state, cmd.ax, cmd.ay, cmd.bx, cmd.by);
  if (!check.ok) {
    state.stats.invalid++;
    events.push({ t: 'reject', a: cmd, reason: check.reason });
    return { state, events, accepted: false, reason: check.reason };
  }
  const { a, b } = check;
  const ja = state.cells[a].j;
  const jb = state.cells[b].j;
  const prismSwap = ja.s === SPECIAL.PRISM || jb.s === SPECIAL.PRISM;

  if (!prismSwap) {
    swapJewels(state, a, b);
    if (!hasAnyMatch(state)) {
      swapJewels(state, a, b);
      state.stats.invalid++;
      events.push({ t: 'swap', a, b });
      events.push({ t: 'swap-back', a, b, reason: INVALID.NO_MATCH });
      return { state, events, accepted: false, reason: INVALID.NO_MATCH };
    }
    // Committed: snapshot for undo BEFORE spending the move.
    swapJewels(state, a, b); // undo the probe; resolution below re-swaps
  }

  pushHistory(state);
  state.turn++;
  state.movesLeft--;
  state.movesSpent++;
  state.stats.swaps++;

  if (prismSwap) {
    resolvePrismSwap(state, events, a, b);
  } else {
    swapJewels(state, a, b);
    events.push({ t: 'swap', a, b });
    resolveBoard(state, events, { a, b });
  }

  refreshScoreGoal(state, events);
  if (allGoalsDone(state)) {
    endGame(state, events, END.GOALS);
  } else if (state.movesLeft <= 0) {
    endGame(state, events, END.MOVES);
  } else if (legalActions(state).length === 0) {
    shuffleBoard(state, events);
  }

  events.push({ t: 'turn', turn: state.turn, movesLeft: state.movesLeft });
  return { state, events, accepted: true };
}

/** Advance the authoritative elapsed clock (quantized by the caller). */
export function tickTime(state, ms) {
  if (state.phase !== 'ready') return state;
  state.elapsedMs = Math.max(0, Math.floor(state.elapsedMs + ms));
  return state;
}

/** End the game from outside the swap flow (timer expiry, give-up). */
export function forceEnd(state, reason) {
  const events = [];
  const wasReady = state.phase === 'ready';
  if (wasReady) endGame(state, events, reason);
  return { state, events, accepted: wasReady };
}

/**
 * undo — practice only. Restores the snapshot taken before the last accepted
 * swap. Score, goals, moves, and rng all revert; the idempotency ring is kept
 * so replayed command ids stay unique.
 */
export function undo(state) {
  if (!state.assists.undo || state.history.length === 0 || state.phase !== 'ready') {
    return { state, events: [{ t: 'reject', reason: INVALID.NO_UNDO }], accepted: false, reason: INVALID.NO_UNDO };
  }
  const snap = state.history.pop();
  const seen = state.seen;
  const history = state.history;
  for (const k of Object.keys(snap)) state[k] = snap[k];
  state.seen = seen;
  state.history = history;
  return { state, events: [{ t: 'undo' }], accepted: true };
}

/**
 * suggestMove — deterministic hint. Scores every legal swap by actually
 * resolving it on a throwaway clone; prefers score, then cascades, then a
 * stable coordinate tie-break. Hints call the same legality API as play.
 */
export function suggestMove(state) {
  const actions = legalActions(state);
  if (actions.length === 0) return null;
  let best = null;
  let bestKey = null;
  for (const act of actions) {
    const probe = cloneState(state);
    probe.assists.undo = false;
    const before = probe.score;
    const res = applyCommand(probe, {
      id: 'hint-' + act.ax + '-' + act.ay + '-' + act.bx + '-' + act.by,
      type: 'swap',
      ax: act.ax,
      ay: act.ay,
      bx: act.bx,
      by: act.by,
    });
    const gain = res.accepted ? probe.score - before : -1;
    const key = [
      gain,
      probe.stats.cascadesMax,
      -act.ay,
      -act.ax,
      -act.by,
      -act.bx,
    ];
    if (!bestKey || compareKey(key, bestKey) > 0) {
      bestKey = key;
      best = act;
    }
  }
  return best;
}

function compareKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 *  Replay / validation helpers
 * ------------------------------------------------------------------ */

/**
 * Replay an ordered command log from a fresh game. Returns the final state,
 * per-turn hashes, and every rejected command (should be empty in a valid log).
 */
export function replayLog(config, commands) {
  let state = createGame(config);
  const hashes = [hashState(state)];
  const rejected = [];
  for (const cmd of commands) {
    const res = applyCommand(state, cmd);
    if (!res.accepted) rejected.push({ id: cmd.id, reason: res.reason });
    hashes.push(hashState(state));
  }
  return { state, hashes, rejected };
}

/**
 * starRating — 1 star for completion, 2/3 from authored score thresholds.
 */
export function starRating(state, stars) {
  if (state.reason !== END.GOALS) return 0;
  let n = 1;
  if (stars && state.score >= stars.s2) n = 2;
  if (stars && state.score >= stars.s3) n = 3;
  return n;
}

/** Tie-break ordering for leaderboards (lower rank array wins). */
export function tieBreakKey(state, sessionId) {
  return [
    state.reason === END.GOALS ? 0 : 1, // primary objective completion
    state.stats.invalid, // fewer invalid actions
    state.elapsedMs, // lower authoritative elapsed time
    String(sessionId), // stable session identifier
  ];
}
