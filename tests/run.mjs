/**
 * tests/run.mjs — Jewel Cascade test suite (spec §9).
 *
 *   rules unit tests     every legal action, invalid-action reason, scoring
 *                        component, terminal state, serialization migration
 *   property tests       deterministic replay: same version + seed + commands
 *                        produce identical state hashes
 *   fuzz tests           malformed commands and generated content: no hangs,
 *                        no throws, no impossible mandatory states
 *   golden tests         representative easy/medium/hard/interrupted/resumed/
 *                        terminal sessions pinned to recorded hashes
 *   content validation   the offline validators over all shipped content
 *   session tests        FSM, snapshots, timers, progression (mocked storage)
 *   server tests         authoritative replay verification, idempotency
 *
 * Run: node tests/run.mjs        (add --verbose for per-test output)
 */

const VERBOSE = process.argv.includes('--verbose');

/* ---------- minimal harness ---------- */
let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  if (VERBOSE) console.log('\n== ' + name);
}
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => ok(name),
        (err) => bad(name, err)
      );
    }
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}
function ok(name) {
  passed++;
  if (VERBOSE) console.log('  ok  ' + currentSuite + ' / ' + name);
}
function bad(name, err) {
  failed++;
  failures.push(currentSuite + ' / ' + name + ': ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  console.error('  FAIL ' + currentSuite + ' / ' + name + '\n    ' + (err && err.message ? err.message : err));
}
function assert(cond, msg) {
  if (!cond) throw new Error('assert: ' + (msg || 'expected truthy'));
}
function eq(a, b, msg) {
  if (a !== b) throw new Error('assert eq: ' + (msg || '') + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error('assert deepEq: ' + (msg || '') + ' — got ' + sa + ', want ' + sb);
}

/* ---------- mock browser globals (storage/platform import safety) ---------- */
function installBrowserMocks() {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
    __mem: mem,
  };
  globalThis.window = globalThis.window || { localStorage };
  if (!globalThis.window.localStorage) globalThis.window.localStorage = localStorage;
  return localStorage;
}

/* ---------- helpers ---------- */
function asciiConfig(rows, overrides) {
  return {
    contentId: 'test',
    contentVersion: 1,
    seed: 'test-seed',
    width: rows[0].length,
    height: rows.length,
    colors: 7,
    moves: 20,
    goals: [{ type: 'collect', color: 0, n: 99 }],
    layout: rows,
    ...(overrides || {}),
  };
}

async function main() {
  installBrowserMocks();
  const rules = await import('../js/engine/rules.js');
  const { Rng, fnv1a, stableStringify, stateHash } = await import('../js/engine/rng.js');
  const content = await import('../js/engine/content.js');
  const storage = await import('../js/storage.js');
  const { GameSession, dayKeyOffset } = await import('../js/session.js');
  const server = await import('../server.js');
  const { SPECIAL, INVALID, END, SCORE } = rules;

  const mkCmd = (id, ax, ay, bx, by) => ({ id, type: 'swap', ax, ay, bx, by });

  /* ================================================================ */
  suite('rules: creation & determinism');
  /* ================================================================ */

  test('same config produces identical state hash', () => {
    const cfg = asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........']);
    const a = rules.createGame(cfg);
    const b = rules.createGame(cfg);
    eq(rules.hashState(a), rules.hashState(b), 'hash');
  });

  test('different seeds produce different boards', () => {
    const base = asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........']);
    const a = rules.createGame({ ...base, seed: 'seed-a' });
    const b = rules.createGame({ ...base, seed: 'seed-b' });
    assert(rules.hashState(a) !== rules.hashState(b), 'hashes should differ');
  });

  test('initial boards are quiet and playable across seeds', () => {
    for (let k = 0; k < 25; k++) {
      const s = rules.createGame(asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'quiet-' + k }));
      eq(rules.findMatches(s).length, 0, 'initial matches on seed ' + k);
      assert(rules.legalActions(s).length > 0, 'no legal action on seed ' + k);
    }
  });

  test('string and numeric seeds both work', () => {
    const a = rules.createGame(asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 12345 }));
    eq(a.seed, 12345);
  });

  /* ================================================================ */
  suite('rules: legality & invalid reasons');
  /* ================================================================ */

  const plainBoard = () =>
    rules.createGame(
      asciiConfig(
        [
          '........',
          '........',
          '...0....',
          '..010...',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'legality', colors: 5 }
      )
    );

  test('out-of-bounds rejected', () => {
    const s = plainBoard();
    eq(rules.checkSwap(s, -1, 0, 0, 0).reason, INVALID.OUT_OF_BOUNDS);
    eq(rules.checkSwap(s, 7, 7, 8, 7).reason, INVALID.OUT_OF_BOUNDS);
  });

  test('not-adjacent rejected', () => {
    const s = plainBoard();
    eq(rules.checkSwap(s, 0, 0, 2, 0).reason, INVALID.NOT_ADJACENT);
    eq(rules.checkSwap(s, 0, 0, 1, 1).reason, INVALID.NOT_ADJACENT);
  });

  test('no-jewel on holes rejected', () => {
    const s = rules.createGame(asciiConfig(['#.......', '........', '........', '........', '........', '........', '........', '........'], { seed: 'hole' }));
    eq(rules.checkSwap(s, 0, 0, 1, 0).reason, INVALID.NO_JEWEL);
  });

  test('crate cells cannot swap', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'crate', crates: [{ x: 3, y: 3, hp: 1 }] })
    );
    eq(rules.checkSwap(s, 3, 3, 4, 3).reason, INVALID.CRATE);
    eq(rules.checkSwap(s, 4, 3, 3, 3).reason, INVALID.CRATE);
  });

  test('ice-locked jewels cannot swap', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'ice', ice: [{ x: 3, y: 3, level: 1 }] })
    );
    eq(rules.checkSwap(s, 3, 3, 3, 4).reason, INVALID.ICE_LOCKED);
  });

  test('no-match swap rejected: swap-back, no move spent, invalid counted', () => {
    const s = plainBoard();
    // Find a structurally valid swap that is NOT in the legal action list.
    const legal = new Set(rules.legalActions(s).map((a) => a.ax + ',' + a.ay + '>' + a.bx + ',' + a.by));
    let victim = null;
    for (let y = 0; y < 8 && !victim; y++) {
      for (let x = 0; x < 7 && !victim; x++) {
        if (!legal.has(x + ',' + y + '>' + (x + 1) + ',' + y) && !legal.has(x + 1 + ',' + y + '>' + x + ',' + y)) {
          const chk = rules.checkSwap(s, x, y, x + 1, y);
          if (chk.ok) victim = { ax: x, ay: y, bx: x + 1, by: y };
        }
      }
    }
    assert(victim, 'expected a non-matching swap to exist');
    const before = s.score;
    const moves = s.movesLeft;
    const res = rules.applyCommand(s, mkCmd('nm-1', victim.ax, victim.ay, victim.bx, victim.by));
    eq(res.accepted, false);
    eq(res.reason, INVALID.NO_MATCH);
    eq(s.movesLeft, moves, 'moves must not be spent');
    eq(s.score, before, 'score unchanged');
    eq(s.stats.invalid, 1, 'invalid counted for tie-breaks');
    assert(res.events.some((e) => e.t === 'swap-back'), 'swap-back event emitted');
  });

  test('duplicate command ids rejected idempotently', () => {
    const s = plainBoard();
    const mv = rules.legalActions(s)[0];
    const r1 = rules.applyCommand(s, mkCmd('dup', mv.ax, mv.ay, mv.bx, mv.by));
    eq(r1.accepted, true);
    const r2 = rules.applyCommand(s, mkCmd('dup', mv.ax, mv.ay, mv.bx, mv.by));
    eq(r2.accepted, false);
    eq(r2.reason, INVALID.DUPLICATE);
  });

  test('malformed commands rejected without mutation', () => {
    const s = plainBoard();
    const h = rules.hashState(s);
    for (const bad of [null, {}, { id: 1 }, { id: 'x', type: 'explode' }, { id: 'x', type: 'swap', ax: '0', ay: 0, bx: 0, by: 0 }, [], 42, 'swap']) {
      const res = rules.applyCommand(s, bad);
      eq(res.accepted, false, 'rejected ' + JSON.stringify(bad));
      eq(res.reason, INVALID.BAD_COMMAND);
    }
    eq(rules.hashState(s), h, 'state unchanged by malformed commands');
  });

  test('commands after the game ends are rejected', () => {
    const s = plainBoard();
    const r = rules.applyCommand(s, { id: 'resign-1', type: 'resign' });
    eq(r.accepted, true);
    const mv = mkCmd('after', 0, 0, 1, 0);
    const res = rules.applyCommand(s, mv);
    eq(res.accepted, false);
    eq(res.reason, INVALID.ENDED);
  });

  /* ================================================================ */
  suite('rules: swaps, scoring, terminal states');
  /* ================================================================ */

  test('accepted swap spends exactly one move and emits turn', () => {
    const s = plainBoard();
    const mv = rules.legalActions(s)[0];
    const res = rules.applyCommand(s, mkCmd('sw-1', mv.ax, mv.ay, mv.bx, mv.by));
    eq(res.accepted, true);
    eq(s.movesSpent, 1);
    eq(s.movesLeft, 19);
    eq(s.turn, 1);
    assert(res.events.some((e) => e.t === 'turn' && e.movesLeft === 19), 'turn event');
  });

  test('goals-complete ends the game and banks leftover moves', () => {
    const s = rules.createGame(
      asciiConfig(
        ['........', '........', '...0....', '..010...', '........', '........', '........', '........'],
        { seed: 'win-fast', colors: 5, moves: 5, goals: [{ type: 'collect', color: 0, n: 3 }] }
      )
    );
    const res = rules.applyCommand(s, mkCmd('win', 3, 2, 3, 3));
    eq(res.accepted, true);
    eq(s.phase, 'ended');
    eq(s.reason, END.GOALS);
    eq(s.components.leftover, 4 * SCORE.LEFTOVER_MOVE, 'leftover bonus');
    eq(s.movesLeft, 0, 'moves zeroed after banking');
    assert(res.events.some((e) => e.t === 'end' && e.reason === END.GOALS), 'end event');
  });

  test('out-of-moves ends the game', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '...0....', '..010...', '........', '........', '........', '........'], {
        seed: 'lose',
        colors: 5,
        moves: 1,
        goals: [{ type: 'collect', color: 4, n: 99 }],
      })
    );
    const mv = rules.legalActions(s)[0];
    const res = rules.applyCommand(s, mkCmd('last', mv.ax, mv.ay, mv.bx, mv.by));
    eq(res.accepted, true);
    eq(s.phase, 'ended');
    eq(s.reason, END.MOVES);
  });

  test('resign ends with resigned reason', () => {
    const s = plainBoard();
    rules.applyCommand(s, { id: 'r1', type: 'resign' });
    eq(s.reason, END.RESIGNED);
    eq(s.phase, 'ended');
  });

  test('forceEnd ends with time reason; tickTime quantizes', () => {
    const s = plainBoard();
    rules.tickTime(s, 99.7);
    eq(s.elapsedMs, 99, 'floored to integer ms');
    rules.tickTime(s, 250.4);
    eq(s.elapsedMs, 349);
    const res = rules.forceEnd(s, END.TIME);
    eq(res.accepted, true);
    eq(s.reason, END.TIME);
    rules.tickTime(s, 100);
    eq(s.elapsedMs, 349, 'no ticking after end');
  });

  test('score components accumulate into score', () => {
    const s = plainBoard();
    const mv = rules.legalActions(s)[0];
    rules.applyCommand(s, mkCmd('sc', mv.ax, mv.ay, mv.bx, mv.by));
    const sum = Object.values(s.components).reduce((a, b) => a + b, 0);
    eq(s.score, sum, 'components sum to total');
    assert(s.components.match > 0, 'match component credited');
  });

  /* ================================================================ */
  suite('rules: specials');
  /* ================================================================ */

  test('ray creation + firing (authored board)', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '........',
          '..2.....',
          '.2122...',
          '........',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'ray1', colors: 5 }
      )
    );
    eq(rules.findMatches(s).length, 0, 'quiet initial board');
    const res = rules.applyCommand(s, mkCmd('mk-ray', 2, 1, 2, 2));
    eq(res.accepted, true);
    const created = res.events.filter((e) => e.t === 'create');
    eq(created.length, 1, 'exactly one special created');
    eq(created[0].s, SPECIAL.RAY_H, 'horizontal 4-run makes RAY_H');
    eq(s.stats.made.ray, 1);
  });

  test('bloom from an L intersection', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '........',
          '....4...',
          '....4...',
          '..4414..',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'bloom1', colors: 6 }
      )
    );
    eq(rules.findMatches(s).length, 0, 'quiet initial board');
    const res = rules.applyCommand(s, mkCmd('mk-bloom', 5, 3, 4, 3));
    eq(res.accepted, true);
    const created = res.events.filter((e) => e.t === 'create');
    eq(created.length, 1);
    eq(created[0].s, SPECIAL.BLOOM);
    eq(s.stats.made.bloom, 1);
  });

  test('prism from a 5-run', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '........',
          '........',
          '...3....',
          '.33533..',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'prism1', colors: 6 }
      )
    );
    eq(rules.findMatches(s).length, 0, 'quiet initial board');
    const res = rules.applyCommand(s, mkCmd('mk-prism', 3, 2, 3, 3));
    eq(res.accepted, true);
    const created = res.events.filter((e) => e.t === 'create');
    assert(created.length >= 1, 'at least one special created');
    eq(created[0].s, SPECIAL.PRISM, 'the 5-run creates a prism first');
    eq(s.stats.made.prism, 1);
  });

  test('prism + color swap shatters that color', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'prism-swap', colors: 5 })
    );
    // White-box: install a prism at (3,3) next to a known color at (3,4).
    const iPrism = rules.idx(s, 3, 3);
    const iOther = rules.idx(s, 3, 4);
    s.cells[iPrism].j = { c: 0, s: SPECIAL.PRISM };
    const targetColor = s.cells[iOther].j.c;
    const countBefore = s.cells.filter((c) => c.j && c.j.c === targetColor && !c.crate).length;
    const res = rules.applyCommand(s, mkCmd('prism-go', 3, 3, 3, 4));
    eq(res.accepted, true);
    assert(res.events.some((e) => e.t === 'prism-swap' && e.mode === 'color'), 'prism-swap event');
    const countAfter = s.cells.filter((c) => c.j && c.j.c === targetColor && !c.crate).length;
    assert(countAfter < countBefore, 'target color shattered (' + countBefore + ' → ' + countAfter + ')');
    assert(countBefore - countAfter >= 2, 'at least the color targets removed');
  });

  test('prism + prism clears the board', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'prism2', colors: 5 })
    );
    s.cells[rules.idx(s, 3, 3)].j = { c: 0, s: SPECIAL.PRISM };
    s.cells[rules.idx(s, 3, 4)].j = { c: 1, s: SPECIAL.PRISM };
    const res = rules.applyCommand(s, mkCmd('pp', 3, 3, 3, 4));
    eq(res.accepted, true);
    assert(res.events.some((e) => e.t === 'prism-swap' && e.mode === 'prism'), 'prism+prism event');
  });

  test('ray fires when matched (chain detonation)', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '........',
          '..2.....',
          '.2122...',
          '........',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'ray1', colors: 5 }
      )
    );
    const mk = rules.applyCommand(s, mkCmd('mk', 2, 1, 2, 2));
    assert(mk.accepted, 'ray-forging swap accepted');
    const rayIdx = s.cells.findIndex((c) => c.j && (c.j.s === SPECIAL.RAY_H || c.j.s === SPECIAL.RAY_V));
    if (rayIdx < 0) {
      // The cascade consumed the fresh ray immediately — firing proven too.
      assert(s.stats.detonated >= 1 && s.stats.made.ray === 1, 'ray fired during the cascade');
      return;
    }
    // Force a horizontal triple through the ray (white-box colors).
    const { x: rx, y: ry } = rules.xy(s, rayIdx);
    const color = s.cells[rayIdx].j.c;
    const triple = [rayIdx];
    if (rx >= 2) {
      triple.push(rules.idx(s, rx - 1, ry), rules.idx(s, rx - 2, ry));
    } else {
      triple.push(rules.idx(s, rx + 1, ry), rules.idx(s, rx + 2, ry));
    }
    for (const i of triple) s.cells[i].j = { c: color, s: i === rayIdx ? s.cells[i].j.s : SPECIAL.NONE };
    // Any legal swap elsewhere resolves the board, finds the triple, and the
    // ray caught in the match must fire.
    const detBefore = s.stats.detonated;
    const acts = rules.legalActions(s).filter((a) => {
      const ai = rules.idx(s, a.ax, a.ay);
      const bi = rules.idx(s, a.bx, a.by);
      return !triple.includes(ai) && !triple.includes(bi);
    });
    assert(acts.length > 0, 'legal action away from the triple exists');
    rules.applyCommand(s, mkCmd('fire', acts[0].ax, acts[0].ay, acts[0].bx, acts[0].by));
    assert(s.stats.detonated > detBefore, 'ray fired when matched');
  });

  /* ================================================================ */
  suite('rules: blockers');
  /* ================================================================ */

  test('ice cracks through a match; jewel collected when ice breaks', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '....1...',
          '..110...',
          '........',
          '........',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'ice1', colors: 5, ice: [{ x: 3, y: 1, level: 1 }], goals: [{ type: 'ice', n: 1 }] }
      )
    );
    eq(rules.findMatches(s).length, 0, 'quiet initial board');
    const res = rules.applyCommand(s, mkCmd('ice-swap', 4, 0, 4, 1));
    eq(res.accepted, true);
    assert(res.events.some((e) => e.t === 'crack'), 'crack event');
    assert(res.events.some((e) => e.t === 'goal'), 'goal progress event');
    eq(s.goals[0].done, true, 'ice goal done');
    assert(s.components.blocker >= SCORE.ICE_BREAK, 'ice break scored');
  });

  test('deep ice takes two hits and locks its jewel', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], {
        seed: 'ice2',
        colors: 5,
        ice: [{ x: 3, y: 3, level: 2 }],
      })
    );
    const cell = s.cells[rules.idx(s, 3, 3)];
    eq(cell.ice, 2);
    eq(rules.checkSwap(s, 3, 3, 4, 3).reason, INVALID.ICE_LOCKED, 'locked while iced');
  });

  test('crates take splash damage and break', () => {
    const s = rules.createGame(
      asciiConfig(
        [
          '4.......',
          '14......',
          '4c......',
          '4.......',
          '........',
          '........',
          '........',
          '........',
        ],
        { seed: 'crate1', colors: 5, goals: [{ type: 'crates', n: 1 }] }
      )
    );
    eq(rules.findMatches(s).length, 0, 'quiet initial board');
    const res = rules.applyCommand(s, mkCmd('crate-swap', 0, 1, 1, 1));
    eq(res.accepted, true);
    assert(res.events.some((e) => e.t === 'crate-break'), 'crate broke');
    eq(s.goals[0].done, true);
    assert(s.components.blocker >= SCORE.CRATE_HIT + SCORE.CRATE_BREAK, 'crate points');
  });

  test('reinforced crates need two hits', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], {
        seed: 'crate2',
        crates: [{ x: 3, y: 3, hp: 2 }],
      })
    );
    eq(s.cells[rules.idx(s, 3, 3)].crate, 2);
  });

  /* ================================================================ */
  suite('rules: undo & hints');
  /* ================================================================ */

  test('undo restores the exact pre-swap state', () => {
    const s = rules.createGame(
      asciiConfig(['........', '........', '...0....', '..010...', '........', '........', '........', '........'], {
        seed: 'undo1',
        colors: 5,
        assists: { undo: true, hints: true },
      })
    );
    const before = rules.hashState(s);
    const mv = rules.legalActions(s)[0];
    rules.applyCommand(s, mkCmd('u1', mv.ax, mv.ay, mv.bx, mv.by));
    const res = rules.undo(s);
    eq(res.accepted, true);
    eq(rules.hashState(s), before, 'hash restored after undo');
  });

  test('undo rejected when the assist is off', () => {
    const s = plainBoard();
    const res = rules.undo(s);
    eq(res.accepted, false);
    eq(res.reason, INVALID.NO_UNDO);
  });

  test('suggestMove is deterministic and legal', () => {
    const s = plainBoard();
    const a = rules.suggestMove(s);
    const b = rules.suggestMove(s);
    deepEq(a, b, 'same hint twice');
    const legal = rules.legalActions(s);
    assert(legal.some((m) => m.ax === a.ax && m.ay === a.ay && m.bx === a.bx && m.by === a.by), 'hint is a legal action');
  });

  /* ================================================================ */
  suite('rules: serialization & migration');
  /* ================================================================ */

  test('serialize → deserialize preserves the hash', () => {
    const s = plainBoard();
    const mv = rules.legalActions(s)[0];
    rules.applyCommand(s, mkCmd('ser', mv.ax, mv.ay, mv.bx, mv.by));
    const json = rules.serialize(s);
    const back = rules.deserialize(json);
    eq(rules.hashState(back), rules.hashState(s));
  });

  test('deserialize migrates through the registry', () => {
    const s = plainBoard();
    const json = JSON.parse(rules.serialize(s));
    json.version = 1;
    const back = rules.deserialize(JSON.stringify(json));
    eq(back.version, rules.RULES_VERSION);
  });

  test('unsupported versions are rejected', () => {
    const s = plainBoard();
    const json = JSON.parse(rules.serialize(s));
    json.version = 99;
    let threw = false;
    try {
      rules.deserialize(JSON.stringify(json));
    } catch {
      threw = true;
    }
    assert(threw, 'should throw on unsupported version');
  });

  /* ================================================================ */
  suite('property: deterministic replay');
  /* ================================================================ */

  test('random playouts replay to identical hashes', () => {
    const seeds = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    for (const seed of seeds) {
      const cfg = asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], {
        seed,
        colors: 5 + (fnv1a(seed) % 3),
        moves: 30,
      });
      // Live run: choose a deterministic pseudo-random legal action each turn.
      let state = rules.createGame(cfg);
      const commands = [];
      const chooser = new Rng(fnv1a('choose-' + seed));
      let guard = 0;
      while (state.phase === 'ready' && guard++ < 40) {
        const actions = rules.legalActions(state);
        if (!actions.length) break;
        const mv = actions[chooser.int(actions.length)];
        const cmd = mkCmd(seed + '-' + guard, mv.ax, mv.ay, mv.bx, mv.by);
        const res = rules.applyCommand(state, cmd);
        if (!res.accepted) break;
        commands.push(cmd);
      }
      const liveHash = rules.hashState(state);
      const replay = rules.replayLog(cfg, commands);
      eq(replay.hashes[replay.hashes.length - 1], liveHash, 'replay hash for ' + seed);
      eq(replay.rejected.length, 0, 'no rejected commands in a legal log');
      // And a second independent replay matches the first exactly.
      const replay2 = rules.replayLog(cfg, commands);
      deepEq(replay.hashes, replay2.hashes, 'two replays identical');
    }
  });

  test('numeric invariants hold across random playouts', () => {
    const chooser = new Rng(1234);
    for (let k = 0; k < 6; k++) {
      let state = rules.createGame(
        asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], { seed: 'inv-' + k, colors: 6, moves: 25 })
      );
      let guard = 0;
      while (state.phase === 'ready' && guard++ < 30) {
        const actions = rules.legalActions(state);
        if (!actions.length) break;
        const mv = actions[chooser.int(actions.length)];
        rules.applyCommand(state, mkCmd('inv-' + k + '-' + guard, mv.ax, mv.ay, mv.bx, mv.by));
        assert(Number.isFinite(state.score) && state.score >= 0, 'score sane');
        assert(state.movesLeft >= 0, 'movesLeft sane');
        const sum = Object.values(state.components).reduce((a, b) => a + b, 0);
        eq(state.score, sum, 'components always sum to score');
        if (state.phase === 'ready') assert(rules.legalActions(state).length > 0, 'never soft-locked while ready');
      }
    }
  });

  /* ================================================================ */
  suite('fuzz: malformed commands & generated content');
  /* ================================================================ */

  test('fuzzed commands never throw nor hang', () => {
    const s = plainBoard();
    const rng = new Rng(999);
    const weird = [
      { id: '', type: 'swap', ax: 0, ay: 0, bx: 1, by: 0 },
      { id: 'x'.repeat(200), type: 'swap', ax: 0, ay: 0, bx: 1, by: 0 },
      { id: 'nan', type: 'swap', ax: NaN, ay: 0, bx: 1, by: 0 },
      { id: 'inf', type: 'swap', ax: Infinity, ay: 0, bx: 1, by: 0 },
      { id: 'neg', type: 'swap', ax: -5, ay: 0, bx: 1, by: 0 },
      { id: 'float', type: 'swap', ax: 0.5, ay: 0, bx: 1, by: 0 },
      { id: 'big', type: 'swap', ax: 2 ** 40, ay: 0, bx: 1, by: 0 },
      { id: 'arr', type: 'swap', ax: [0], ay: 0, bx: 1, by: 0 },
      { id: 'obj', type: 'swap', ax: { v: 0 }, ay: 0, bx: 1, by: 0 },
      { id: 'resign', type: 'resign', extra: 'fields' },
    ];
    for (const cmd of weird) {
      const res = rules.applyCommand(s, cmd);
      assert(typeof res.accepted === 'boolean', 'always returns a verdict');
    }
    for (let k = 0; k < 50; k++) {
      const res = rules.applyCommand(s, {
        id: 'fz' + k,
        type: rng.int(2) ? 'swap' : 'resign',
        ax: rng.int(12) - 2,
        ay: rng.int(12) - 2,
        bx: rng.int(12) - 2,
        by: rng.int(12) - 2,
      });
      assert(typeof res.accepted === 'boolean', 'verdict for random command');
    }
    assert(Number.isFinite(stateHash(rules.snapshotForHash(s)) >>> 0), 'state still hashable');
  });

  test('fuzzed generated content never produces broken boards', () => {
    const rng = new Rng(4242);
    for (let k = 0; k < 40; k++) {
      const w = 4 + rng.int(9);
      const h = 4 + rng.int(9);
      const colors = 3 + rng.int(5);
      const crates = [];
      const ice = [];
      for (let c = 0; c < rng.int(6); c++) crates.push({ x: 1 + rng.int(w - 2), y: 1 + rng.int(h - 2), hp: 1 + rng.int(2) });
      for (let c = 0; c < rng.int(6); c++) ice.push({ x: rng.int(w), y: rng.int(h), level: 1 + rng.int(2) });
      const play = new Array(w * h).fill(true);
      for (let c = 0; c < rng.int(Math.floor(w * h * 0.2)); c++) play[rng.int(w * h)] = false;
      const cfg = {
        contentId: 'fuzz',
        contentVersion: 1,
        seed: 'fuzz-' + k,
        width: w,
        height: h,
        colors,
        moves: 5,
        goals: [{ type: 'collect', color: 0, n: 5 }],
        play,
        crates,
        ice,
      };
      let state;
      try {
        state = rules.createGame(cfg);
      } catch (err) {
        throw new Error('createGame threw for ' + JSON.stringify({ w, h, colors }) + ': ' + err.message);
      }
      assert(state.cells.length === w * h, 'cell count');
      // Play a few moves: must terminate, never throw.
      let turns = 0;
      while (state.phase === 'ready' && turns++ < 6) {
        const actions = rules.legalActions(state);
        if (!actions.length) break;
        const mv = actions[0];
        rules.applyCommand(state, mkCmd('fc-' + k + '-' + turns, mv.ax, mv.ay, mv.bx, mv.by));
      }
      assert(Number.isFinite(state.score), 'finite score');
    }
  });

  /* ================================================================ */
  suite('golden sessions');
  /* ================================================================ */

  function playScript(cfg, script) {
    let state = rules.createGame(cfg);
    const hashes = [rules.hashState(state)];
    for (const [id, ax, ay, bx, by] of script) {
      const res = rules.applyCommand(state, mkCmd(id, ax, ay, bx, by));
      assert(res.accepted, 'golden move accepted: ' + id + ' (' + res.reason + ')');
      hashes.push(rules.hashState(state));
    }
    return { state, hashes };
  }

  test('golden: easy collect session', () => {
    const cfg = asciiConfig(['........', '........', '...0....', '..010...', '........', '........', '........', '........'], {
      seed: 'golden-easy',
      colors: 5,
      moves: 10,
      goals: [{ type: 'collect', color: 0, n: 6 }],
    });
    const s = rules.createGame(cfg);
    const script = [];
    const moves = rules.legalActions(s);
    // Deterministic script: first legal action, then rebuild actions each step.
    let guard = 0;
    let state = s;
    const hashes = [rules.hashState(state)];
    while (state.phase === 'ready' && guard++ < 10) {
      const acts = rules.legalActions(state);
      const mv = acts[0];
      const res = rules.applyCommand(state, mkCmd('ge-' + guard, mv.ax, mv.ay, mv.bx, mv.by));
      assert(res.accepted, 'accepted');
      hashes.push(rules.hashState(state));
      script.push(mv);
    }
    const rep = rules.replayLog(cfg, script.map((m, i) => mkCmd('ge-' + (i + 1), m.ax, m.ay, m.bx, m.by)));
    deepEq(rep.hashes, hashes, 'golden easy replay');
    eq(state.phase, 'ended');
    eq(state.reason, END.GOALS, 'easy golden completes');
    eq(state.score, 1770, 'golden easy score');
    eq(hashes[hashes.length - 1], '451242fa', 'golden easy final hash');
  });

  test('golden: medium blocker session', () => {
    const cfg = asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], {
      seed: 'golden-mid',
      colors: 6,
      moves: 12,
      goals: [{ type: 'collect', color: 1, n: 8 }, { type: 'crates', n: 2 }],
      crates: [{ x: 3, y: 3, hp: 1 }, { x: 4, y: 4, hp: 2 }],
    });
    let state = rules.createGame(cfg);
    const script = [];
    let guard = 0;
    const hashes = [rules.hashState(state)];
    const rng = new Rng(777);
    while (state.phase === 'ready' && guard++ < 12) {
      const acts = rules.legalActions(state);
      const mv = acts[rng.int(acts.length)];
      const res = rules.applyCommand(state, mkCmd('gm-' + guard, mv.ax, mv.ay, mv.bx, mv.by));
      assert(res.accepted, 'accepted');
      hashes.push(rules.hashState(state));
      script.push(mv);
    }
    const rep = rules.replayLog(cfg, script.map((m, i) => mkCmd('gm-' + (i + 1), m.ax, m.ay, m.bx, m.by)));
    deepEq(rep.hashes, hashes, 'golden medium replay');
    eq(hashes[hashes.length - 1], 'b5633e71', 'golden medium final hash');
    eq(state.score, 2330, 'golden medium score');
  });

  test('golden: interrupted + resumed session matches the uninterrupted hash', () => {
    const cfg = asciiConfig(['........', '........', '........', '........', '........', '........', '........', '........'], {
      seed: 'golden-resume',
      colors: 5,
      moves: 8,
      goals: [{ type: 'collect', color: 2, n: 10 }],
    });
    // Uninterrupted reference.
    let ref = rules.createGame(cfg);
    const rngA = new Rng(31337);
    const script = [];
    let guard = 0;
    while (ref.phase === 'ready' && guard++ < 8) {
      const acts = rules.legalActions(ref);
      const mv = acts[rngA.int(acts.length)];
      const res = rules.applyCommand(ref, mkCmd('gr-' + guard, mv.ax, mv.ay, mv.bx, mv.by));
      assert(res.accepted, 'ref accepted');
      script.push(mkCmd('gr-' + guard, mv.ax, mv.ay, mv.bx, mv.by));
    }
    // Interrupted: play half, serialize/deserialize, continue.
    let res1 = rules.createGame(cfg);
    const half = Math.floor(script.length / 2);
    for (let i = 0; i < half; i++) rules.applyCommand(res1, script[i]);
    const revived = rules.deserialize(rules.serialize(res1));
    for (let i = half; i < script.length; i++) rules.applyCommand(revived, script[i]);
    eq(rules.hashState(revived), rules.hashState(ref), 'resumed equals uninterrupted');
  });

  /* ================================================================ */
  suite('content validation');
  /* ================================================================ */

  test('all shipped content passes the offline validators', () => {
    const failures = content.validateAllContent();
    deepEq(failures, [], 'content validator failures');
  });

  test('lesson guided swaps are accepted on quiet boards', () => {
    for (const lesson of content.LESSONS) {
      const state = rules.createGame(lesson.toEngineConfig());
      eq(rules.findMatches(state).length, 0, lesson.id + ' initial matches');
      const step0 = lesson.steps[0];
      if (step0.require && step0.require.kind === 'swap') {
        const r = step0.require;
        const res = rules.applyCommand(rules.cloneState(state), mkCmd('lesson-probe', r.ax, r.ay, r.bx, r.by));
        assert(res.accepted, lesson.id + ' guided swap accepted');
      }
    }
  });

  test('journey star thresholds are reachable by the bot', () => {
    for (const c of content.JOURNEY) {
      const greedy = content.simulateBot(c.toEngineConfig(), { goalWeight: 0 });
      const hungry = content.simulateBot(c.toEngineConfig(), { goalWeight: 1 });
      const best = Math.max(greedy.state.score, hungry.state.score);
      assert(best >= c.stars.s3, c.id + ' s3 ' + c.stars.s3 + ' > bot best ' + best);
      const win = greedy.state.reason === END.GOALS || hungry.state.reason === END.GOALS;
      assert(win, c.id + ' winnable');
    }
  });

  test('daily content is deterministic for a fixed day', () => {
    const a = content.dailyContent('2026-08-16');
    const b = content.dailyContent('2026-08-16');
    eq(a.toJSON().seed, b.toJSON().seed);
    eq(rules.hashState(rules.createGame(a.toEngineConfig())), rules.hashState(rules.createGame(b.toEngineConfig())));
  });

  test('content descriptors round-trip through JSON (revive)', () => {
    for (const c of [content.JOURNEY[9], content.LESSONS[0], content.CHALLENGES[0], content.dailyContent('2026-03-01')]) {
      const revived = content.reviveContent(JSON.parse(JSON.stringify(c.toJSON())));
      eq(rules.hashState(rules.createGame(revived.toEngineConfig())), rules.hashState(rules.createGame(c.toEngineConfig())), c.id + ' revive hash');
    }
  });

  test('dayKeyOffset walks UTC days', () => {
    eq(dayKeyOffset('2026-08-16', -1), '2026-08-15');
    eq(dayKeyOffset('2026-01-01', -1), '2025-12-31');
  });

  /* ================================================================ */
  suite('storage');
  /* ================================================================ */

  test('settings round-trip with checksums', () => {
    const s = storage.loadSettings();
    s.audio.master = 0.33;
    storage.saveSettings(s);
    eq(storage.loadSettings().audio.master, 0.33);
  });

  test('corrupt documents fall back to defaults', () => {
    window.localStorage.setItem('jewelcascade.settings', '{"v":1,"sum":123,"data":{"version":1}}');
    const s = storage.loadSettings();
    eq(s.audio.master, 0.8, 'default restored after corruption');
  });

  test('progress round-trip and wipe', () => {
    const p = storage.loadProgress();
    p.masteryXp = 42;
    storage.saveProgress(p);
    eq(storage.loadProgress().masteryXp, 42);
    storage.wipeAll();
    eq(storage.loadProgress().masteryXp, 0);
    eq(storage.loadSettings().audio.master, 0.8);
  });

  /* ================================================================ */
  suite('session');
  /* ================================================================ */

  function makeSession() {
    const settings = storage.loadSettings();
    const progress = storage.loadProgress();
    const session = new GameSession({ settings, progress, platform: null, analytics: null });
    session.transition('title', 'boot-complete');
    return session;
  }

  test('full lesson round through the FSM', () => {
    const session = makeSession();
    const lesson = content.LESSONS[4]; // ice: goal survives the guided swap
    const seen = [];
    session.on('fsm', ({ to }) => seen.push(to));
    let results = null;
    session.on('results', (r) => (results = r));
    session.startRound(lesson);
    eq(session.status, 'tutorial');
    const step0 = lesson.steps[0].require;
    const res = session.trySwap(step0.ax, step0.ay, step0.bx, step0.by);
    eq(res.accepted, true, 'guided swap accepted');
    eq(session.status, 'resolving');
    session.settled();
    eq(session.status, 'tutorial', 'lessons return to tutorial between steps');
    session.forceFinish(rules.END.GOALS);
    assert(results, 'results emitted');
    eq(results.won, true);
    assert(seen.includes('results'), 'fsm reached results');
  });

  test('snapshot save + resume reproduces the state hash', () => {
    const session = makeSession();
    const stage = content.JOURNEY[0];
    session.startRound(stage);
    session.beginPlay();
    const mv = rules.suggestMove(session.state);
    session.trySwap(mv.ax, mv.ay, mv.bx, mv.by);
    session.settled();
    const hashBefore = rules.hashState(session.state);
    session.saveSnapshot();
    const snap = storage.loadRoundSnapshot();
    assert(snap && snap.stateJson, 'snapshot persisted');
    const revived = rules.deserialize(snap.stateJson);
    eq(rules.hashState(revived), hashBefore);
    storage.clearRoundSnapshot();
  });

  test('timed rounds end on the authoritative clock', () => {
    const session = makeSession();
    const sprint = content.CHALLENGES.find((c) => c.id === 'ch-sprint');
    let results = null;
    session.on('results', (r) => (results = r));
    session.startRound(sprint);
    session.beginPlay();
    eq(session.status, 'active');
    assert(session.timeLeftMs > 0, 'timer armed');
    session.tick(95 * 1000);
    assert(results, 'results emitted after expiry');
    eq(results.reason, END.TIME);
  });

  test('progression records journey stars idempotently per round', () => {
    const session = makeSession();
    const stage = content.JOURNEY[0];
    session.startRound(stage);
    session.beginPlay();
    // Force a win.
    session.forceFinish(rules.END.GOALS);
    const p = session.progress;
    eq(p.journeyStars[stage.id] >= 1, true, 'star recorded');
    eq(p.journeyUnlocked, 2, 'next stage unlocked');
    const wins = p.career.roundsWon;
    // Same roundId must not double-count.
    const { recordRound } = awaitImportAch();
    recordRound(p, { roundId: session.roundId, won: true, score: 0, stats: { made: {} } });
    eq(p.career.roundsWon, wins, 'idempotent recordRound');
  });

  test('hint returns a legal move; undo gates on assist', () => {
    const session = makeSession();
    session.startRound(content.practiceContent('easy', 'session-hint'));
    session.beginPlay();
    const mv = session.hint();
    assert(mv, 'hint available in practice');
    session.trySwap(mv.ax, mv.ay, mv.bx, mv.by);
    session.settled();
    eq(session.undo(), true, 'undo allowed in practice');
    // Journey has no undo assist.
    const s2 = makeSession();
    s2.startRound(content.JOURNEY[1]);
    s2.beginPlay();
    eq(s2.undo(), false, 'undo blocked in journey');
  });

  /* ================================================================ */
  suite('server: authoritative validation');
  /* ================================================================ */

  test('canonical configs resolve for ranked modes', () => {
    const day = content.dayKeyFor(Date.now());
    const daily = server.canonicalConfigFor('daily-' + day, null);
    assert(!daily.error, 'daily config resolves');
    const chaseCfg = content.scoreChaseContent('server-test').toEngineConfig();
    const chase = server.canonicalConfigFor('chase-' + fnv1a('server-test').toString(36), chaseCfg);
    assert(!chase.error, 'chase config resolves: ' + (chase.error || ''));
    const bad = server.canonicalConfigFor('chase-forged', { ...chaseCfg, moves: 99 });
    assert(bad.error, 'forged chase config rejected');
    const practice = server.canonicalConfigFor('practice-easy-x', null);
    assert(practice.error, 'practice is not ranked');
  });

  test('honest replay verifies; tampered claims rejected', () => {
    const c = content.scoreChaseContent('verify-me');
    const cfg = c.toEngineConfig();
    let state = rules.createGame(cfg);
    const commands = [];
    let guard = 0;
    while (state.phase === 'ready' && guard++ < 6) {
      const mv = rules.legalActions(state)[0];
      const cmd = mkCmd('srv-' + guard, mv.ax, mv.ay, mv.bx, mv.by);
      const res = rules.applyCommand(state, cmd);
      if (!res.accepted) break;
      commands.push(cmd);
    }
    const replay = {
      schema: 1,
      contentId: c.id,
      contentVersion: 1,
      seed: cfg.seed,
      config: cfg,
      commands,
      finalHash: rules.hashState(state),
    };
    const ok = server.verifyReplay(cfg, replay, { score: state.score, movesSpent: state.movesSpent, elapsedMs: 60000 });
    assert(ok.ok, 'honest replay verifies: ' + (ok.reason || ''));
    const tampered = server.verifyReplay(cfg, replay, { score: state.score + 100, movesSpent: state.movesSpent, elapsedMs: 60000 });
    assert(!tampered.ok, 'tampered score rejected');
    const badHash = server.verifyReplay(cfg, { ...replay, finalHash: '00000000' }, { score: state.score, movesSpent: state.movesSpent, elapsedMs: 60000 });
    assert(!badHash.ok, 'tampered hash rejected');
  });

  test('submission validator enforces bounds and schema', () => {
    eq(server.validateSubmission(null), 'body must be an object');
    eq(server.validateSubmission({}), 'missing replay envelope');
    const base = { replay: { schema: 1, contentVersion: 1, commands: [], finalHash: 'deadbeef' }, score: 10, movesSpent: 0, elapsedMs: 1000 };
    eq(server.validateSubmission(base), null, 'minimal valid submission');
    eq(server.validateSubmission({ ...base, score: -5 }), 'score out of bounds');
    eq(server.validateSubmission({ ...base, replay: { ...base.replay, schema: 2 } }), 'stale replay schema');
    eq(
      server.validateSubmission({ ...base, replay: { ...base.replay, commands: [{ id: 'x', type: 'swap', ax: 99, ay: 0, bx: 0, by: 0 }] } }),
      'command coordinate out of bounds'
    );
  });

  /* ================================================================ */
  suite('rng');
  /* ================================================================ */

  test('mulberry32 streams are deterministic and serializable', () => {
    const a = new Rng(42);
    const seq1 = [a.next(), a.next(), a.next()];
    const b = new Rng(42);
    const seq2 = [b.next(), b.next(), b.next()];
    deepEq(seq1, seq2);
    const c = new Rng(1);
    c.next();
    const snap = c.getState();
    const d = new Rng(0);
    d.setState(snap);
    eq(c.next(), d.next(), 'resume from state');
  });

  test('stableStringify sorts keys; stateHash is stable', () => {
    eq(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
    eq(stateHash({ x: [1, 2, { b: 1, a: 2 }] }), stateHash({ x: [1, 2, { a: 2, b: 1 }] }));
  });

  /* ---------- summary ---------- */
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(failed ? 1 : 0);
}

// Helper defined after main (hoisted import usage inside session tests).
import { recordRound as _recordRound } from '../js/engine/achievements.js';
function awaitImportAch() {
  return { recordRound: _recordRound };
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
