/**
 * content.js — versioned content for Jewel Cascade.
 *
 * Every playable round is described by a plain, serializable content
 * descriptor (spec §2 "Difficulty and content generation"):
 *   identifier, content version, seed, initial state (layout/fixed cells,
 *   crates/ice placement), goals, allowed mechanics, par values, tutorial
 *   flags, presentation theme.
 *
 * Descriptors carry two methods (toEngineConfig / toJSON) and are otherwise
 * data. reviveContent() rehydrates a descriptor from its JSON form (used by
 * snapshot resume). Everything here is import-safe in Node — no DOM.
 *
 * The module also ships the offline validators (validateContent /
 * validateAllContent / simulateBot) used by tests/run.mjs to prove basic
 * legality, reachable goals, bounded duration, and absence of soft locks.
 */

import * as rules from './rules.js';
import { Rng, fnv1a, hashStrings } from './rng.js';

export const CONTENT_VERSION = 1;

/** Canonical ruleset constants. */
const DAILY_RULESET = { colors: 6, moves: 24 };
const SCORE_CHASE_RULESET = { width: 8, height: 8, colors: 6, moves: 25, target: 5200 };

/* ------------------------------------------------------------------ *
 *  Descriptor factory
 * ------------------------------------------------------------------ */

/**
 * makeContent — build a content descriptor from plain fields.
 * The same shape rehydrates from JSON, so every field is data.
 */
export function makeContent(d) {
  const c = {
    version: CONTENT_VERSION,
    id: d.id,
    kind: d.kind, // 'lesson' | 'journey' | 'daily' | 'practice' | 'challenge' | 'score'
    mode: d.mode, // session mode string (lesson→learn, score keeps 'score')
    name: d.name,
    desc: d.desc || '',
    seed: d.seed,
    width: d.width,
    height: d.height,
    colors: d.colors,
    moves: d.moves,
    goals: (d.goals || []).map((g) => ({ ...g })),
    layout: d.layout ? d.layout.slice() : null,
    crates: (d.crates || []).map((k) => ({ ...k })), // [{x,y,hp}]
    ice: (d.ice || []).map((k) => ({ ...k })), // [{x,y,level}]
    mechanics: d.mechanics ? d.mechanics.slice() : ['swap'],
    par: d.par || { moves: d.moves, score: d.stars ? d.stars.s2 : 0 },
    stars: d.stars ? { ...d.stars } : null, // {s2, s3}; 1 star = completion
    assists: { undo: !!(d.assists && d.assists.undo), hints: !d.assists || d.assists.hints !== false },
    ranked: !!d.ranked,
    timeLimitSec: d.timeLimitSec || null,
    themeId: d.themeId || 'ember-dusk',
    tutorial: d.tutorial || null, // lesson id when this descriptor is a lesson
    steps: d.steps ? d.steps.map((s) => ({ ...s, focus: s.focus ? s.focus.map((f) => ({ ...f })) : null, require: s.require ? { ...s.require } : null })) : null,
    stage: d.stage || 0, // journey stage number
    mastery: !!d.mastery, // periodic mastery stage flag
    dayKey: d.dayKey || null,
    difficulty: d.difficulty || null,
  };
  c.toEngineConfig = function toEngineConfig() {
    return {
      contentId: c.id,
      contentVersion: c.version,
      seed: c.seed,
      width: c.width,
      height: c.height,
      colors: c.colors,
      moves: c.moves,
      goals: c.goals.map((g) => ({ ...g })),
      layout: c.layout ? c.layout.slice() : null,
      crates: c.crates.map((k) => ({ ...k })),
      ice: c.ice.map((k) => ({ ...k })),
      assists: { ...c.assists },
      ranked: c.ranked,
      timeLimitMs: c.timeLimitSec ? c.timeLimitSec * 1000 : null,
    };
  };
  c.toJSON = function toJSON() {
    return {
      version: c.version,
      id: c.id,
      kind: c.kind,
      mode: c.mode,
      name: c.name,
      desc: c.desc,
      seed: c.seed,
      width: c.width,
      height: c.height,
      colors: c.colors,
      moves: c.moves,
      goals: c.goals.map((g) => ({ ...g })),
      layout: c.layout ? c.layout.slice() : null,
      crates: c.crates.map((k) => ({ ...k })),
      ice: c.ice.map((k) => ({ ...k })),
      mechanics: c.mechanics.slice(),
      par: { ...c.par },
      stars: c.stars ? { ...c.stars } : null,
      assists: { ...c.assists },
      ranked: c.ranked,
      timeLimitSec: c.timeLimitSec,
      themeId: c.themeId,
      tutorial: c.tutorial,
      steps: c.steps ? c.steps.map((s) => ({ ...s, focus: s.focus ? s.focus.map((f) => ({ ...f })) : null, require: s.require ? { ...s.require } : null })) : null,
      stage: c.stage,
      mastery: c.mastery,
      dayKey: c.dayKey,
      difficulty: c.difficulty,
    };
  };
  return c;
}

/** Rehydrate a descriptor from its toJSON() form (snapshot resume). */
export function reviveContent(json) {
  if (!json || typeof json !== 'object' || !json.id) throw new Error('bad content snapshot');
  return makeContent(json);
}

/* ------------------------------------------------------------------ *
 *  UTC day helpers (daily boundaries use the platform-adjusted clock)
 * ------------------------------------------------------------------ */

export function dayKeyFor(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 *  Shared ASCII layouts ('#' hole, '.' random jewel)
 * ------------------------------------------------------------------ */

const LAYOUT_CORNERS_8 = [
  '##....##',
  '#......#',
  '........',
  '........',
  '........',
  '........',
  '#......#',
  '##....##',
];

const LAYOUT_CENTER_8 = [
  '........',
  '........',
  '........',
  '...##...',
  '...##...',
  '........',
  '........',
  '........',
];

const LAYOUT_COLUMNS_9 = [
  '...#...#.',
  '...#...#.',
  '...#...#.',
  '.........',
  '.........',
  '.........',
  '...#...#.',
  '...#...#.',
  '...#...#.',
];

const LAYOUT_RING_9 = [
  '.........',
  '.........',
  '.........',
  '...###...',
  '...###...',
  '...###...',
  '.........',
  '.........',
  '.........',
];

const LAYOUT_HOURGLASS_8 = [
  '........',
  '........',
  '..####..',
  '...##...',
  '...##...',
  '..####..',
  '........',
  '........',
];

const LAYOUTS = {
  corners8: LAYOUT_CORNERS_8,
  donut8: LAYOUT_CENTER_8,
  columns9: LAYOUT_COLUMNS_9,
  ring9: LAYOUT_RING_9,
  hourglass8: LAYOUT_HOURGLASS_8,
};

function playMaskFor(width, height, layout) {
  const mask = new Array(width * height).fill(true);
  if (!layout) return mask;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (layout[y] && layout[y][x] === '#') mask[y * width + x] = false;
    }
  }
  return mask;
}

/**
 * Spread blocker cells deterministically over playable, non-edge cells.
 * Positions derive from the content seed: fixed per stage, feel hand-placed,
 * never land on holes, and never overlap cells in `exclude` (so ice and
 * crates never fight for the same cell).
 */
function spreadCells(seed, n, width, height, layout, exclude) {
  const rng = new Rng(fnv1a(seed));
  const mask = playMaskFor(width, height, layout);
  const skip = exclude || new Set();
  // Keep one cell of margin so blockers never fuse with the board edge.
  const candidates = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (mask[y * width + x] && !skip.has(x + ',' + y)) candidates.push({ x, y });
    }
  }
  rng.shuffle(candidates);
  return candidates.slice(0, Math.min(n, candidates.length));
}

function keySet(cells) {
  return new Set(cells.map((p) => p.x + ',' + p.y));
}

/* ------------------------------------------------------------------ *
 *  Learn — six interactive lessons (one rule at a time, hands-on)
 * ------------------------------------------------------------------ *
 * Lesson boards are partially fixed via ASCII digits so the taught swap is
 * always available and always produces the intended figure, for the lesson's
 * fixed seed (tests/run.mjs asserts legality, quiet initial boards, and that
 * each guided swap is accepted).
 */

const LESSON_DEFS = [
  {
    id: 'swap-basics',
    name: 'Lesson 1 — First Swaps',
    desc: 'Swap two neighbouring jewels to line up three of a kind.',
    seed: 'lesson-1',
    layout: [
      '........',
      '........',
      '...0....',
      '..010...',
      '........',
      '........',
      '........',
      '........',
    ],
    colors: 5,
    moves: 8,
    goals: [{ type: 'score', n: 9999 }], // unreachable: the lesson script owns completion
    steps: [
      {
        text: 'This is your workbench. Jewels line up when three or more of a color touch in a row or column. Swap the marked ruby down into the gap — drag it, or tap one jewel and then its neighbour.',
        focus: [{ x: 3, y: 2 }, { x: 3, y: 3 }],
        require: { kind: 'swap', ax: 3, ay: 2, bx: 3, by: 3 },
      },
      {
        text: 'A match of three! Matched jewels leave the board and new ones cascade in from above. Now make any legal swap of your own.',
        require: { kind: 'any-swap' },
      },
      {
        text: 'Well done. A swap only counts when it makes a line — a swap that matches nothing is refused and the jewels slide back.',
        require: { kind: 'any-swap' },
      },
    ],
  },
  {
    id: 'rays',
    name: 'Lesson 2 — Rays (lines of 4)',
    desc: 'Match four in a line to forge a ray.',
    seed: 'lesson-2',
    layout: [
      '........',
      '........',
      '..2.....',
      '.2122...',
      '........',
      '........',
      '........',
      '........',
    ],
    colors: 5,
    moves: 8,
    goals: [{ type: 'score', n: 9999 }],
    steps: [
      {
        text: 'Four in a line forge a RAY. Swap the marked topaz down to complete a line of four.',
        focus: [{ x: 2, y: 2 }, { x: 2, y: 3 }],
        require: { kind: 'swap', ax: 2, ay: 2, bx: 2, by: 3 },
      },
      {
        text: 'You forged a ray! A ray fires when it is matched or struck, clearing its whole row or column. Rays carry a color and match like ordinary jewels. Make any swap to continue.',
        require: { kind: 'any-swap' },
      },
    ],
  },
  {
    id: 'blooms',
    name: 'Lesson 3 — Blooms (corners)',
    desc: 'Match an L or T shape to grow a bloom.',
    seed: 'lesson-3',
    layout: [
      '........',
      '....4...',
      '....4...',
      '..4414..',
      '........',
      '........',
      '........',
      '........',
    ],
    colors: 6,
    moves: 8,
    goals: [{ type: 'score', n: 9999 }],
    steps: [
      {
        text: 'Matching around a corner — an L or a T — grows a BLOOM. Swap the marked sapphire left into the corner.',
        focus: [{ x: 5, y: 3 }, { x: 4, y: 3 }],
        require: { kind: 'swap', ax: 5, ay: 3, bx: 4, by: 3 },
      },
      {
        text: 'A bloom! When it fires it clears a 3×3 patch around itself. Make any swap to continue.',
        require: { kind: 'any-swap' },
      },
    ],
  },
  {
    id: 'prisms',
    name: 'Lesson 4 — Prisms (lines of 5)',
    desc: 'Match five in a line to cut a prism.',
    seed: 'lesson-4',
    layout: [
      '........',
      '........',
      '...3....',
      '.33533..',
      '........',
      '........',
      '........',
      '........',
    ],
    colors: 6,
    moves: 8,
    goals: [{ type: 'score', n: 9999 }],
    steps: [
      {
        text: 'Five in a line cut a PRISM — the rarest jewel on the bench. Swap the marked emerald down to complete five.',
        focus: [{ x: 3, y: 2 }, { x: 3, y: 3 }],
        require: { kind: 'swap', ax: 3, ay: 2, bx: 3, by: 3 },
      },
      {
        text: 'A prism! Swap a prism with any neighbour to shatter every jewel of that color — or with another special for something spectacular. Make any swap to continue.',
        require: { kind: 'any-swap' },
      },
    ],
  },
  {
    id: 'ice',
    name: 'Lesson 5 — Ice',
    desc: 'Frozen jewels cannot move. Match through them to crack the ice.',
    seed: 'lesson-5',
    layout: [
      '........',
      '........',
      '....1...',
      '..110...',
      '........',
      '.....2..',
      '........',
      '........',
    ],
    ice: [{ x: 3, y: 3, level: 1 }, { x: 5, y: 5, level: 1 }],
    colors: 5,
    moves: 10,
    goals: [{ type: 'score', n: 9999 }],
    steps: [
      {
        text: 'Jewels under ice are frozen — they cannot be swapped, but they still match. Swap the marked sapphire down so the line runs THROUGH the frozen jewel, cracking its ice.',
        focus: [{ x: 4, y: 2 }, { x: 4, y: 3 }],
        require: { kind: 'swap', ax: 4, ay: 2, bx: 4, by: 3 },
      },
      {
        text: 'Cracked! The ice broke and the jewel was collected. One more frozen jewel remains on the bench — play on and break it, or just finish the round.',
        require: { kind: 'any-swap' },
      },
    ],
  },
  {
    id: 'crates',
    name: 'Lesson 6 — Crates',
    desc: 'Crates block cells. Matches beside them break them.',
    seed: 'lesson-6',
    layout: [
      '........',
      '........',
      '...2....',
      '.221c...',
      '...c....',
      '........',
      '........',
      '........',
    ],
    colors: 5,
    moves: 10,
    goals: [{ type: 'score', n: 9999 }],
    steps: [
      {
        text: 'Crates pin the board: they hold no jewel and never move. A match made NEXT to a crate dents it. Swap the marked emerald down — the line will smash both crates at once.',
        focus: [{ x: 3, y: 2 }, { x: 3, y: 3 }],
        require: { kind: 'swap', ax: 3, ay: 2, bx: 3, by: 3 },
      },
      {
        text: 'Both crates broke from one match! Tough crates take two hits. Make any swap to finish the lesson.',
        require: { kind: 'any-swap' },
      },
    ],
  },
];

/**
 * Lessons need a board that is quiet on arrival (no pre-existing matches) and
 * whose guided first swap is always accepted. Rather than hand-hunting seeds,
 * derive one deterministically: the first candidate that passes wins, so the
 * choice is stable across every client and immune to layout edits above.
 */
function pickLessonSeed(def) {
  for (let k = 0; k < 32; k++) {
    const seed = def.seed + (k === 0 ? '' : '-' + k);
    const probe = makeContent({
      ...def,
      seed,
      kind: 'lesson',
      mode: 'learn',
      width: 8,
      height: 8,
      tutorial: def.id,
    });
    let state;
    try {
      state = rules.createGame(probe.toEngineConfig());
    } catch {
      continue;
    }
    if (rules.findMatches(state).length !== 0) continue;
    if (rules.legalActions(state).length === 0) continue;
    const step0 = def.steps && def.steps[0];
    if (step0 && step0.require && step0.require.kind === 'swap') {
      const r = step0.require;
      const res = rules.applyCommand(rules.cloneState(state), {
        id: 'probe',
        type: 'swap',
        ax: r.ax,
        ay: r.ay,
        bx: r.bx,
        by: r.by,
      });
      if (!res.accepted) continue;
    }
    return seed;
  }
  return def.seed;
}

export const LESSONS = LESSON_DEFS.map((l) =>
  makeContent({
    ...l,
    seed: pickLessonSeed(l),
    kind: 'lesson',
    mode: 'learn',
    width: 8,
    height: 8,
    tutorial: l.id,
    mechanics: ['swap'],
    stars: null,
    themeId: 'ember-dusk',
    ranked: false,
  })
);

export function lessonById(id) {
  return LESSONS.find((l) => l.tutorial === id || l.id === id) || null;
}

/* ------------------------------------------------------------------ *
 *  Journey — 40 authored stages
 * ------------------------------------------------------------------ *
 * Difficulty arc: one new concept in isolation → combine with known →
 * mastery test (stages 5, 10, 15, 20, 25, 30, 35, 40). Star thresholds are
 * calibrated against the deterministic bot's score (tests/run.mjs prints a
 * calibration report with --calibrate) and kept conservative.
 */

const THEMES_BY_STAGE = [
  'ember-dusk', 'ember-dusk', 'ember-dusk', 'ember-dusk', 'ember-dusk', // 1-5
  'moonlit-forge', 'moonlit-forge', 'moonlit-forge', 'moonlit-forge', 'moonlit-forge', // 6-10
  'verdant-atelier', 'verdant-atelier', 'verdant-atelier', 'verdant-atelier', 'verdant-atelier', // 11-15
  'frostbound-loft', 'frostbound-loft', 'frostbound-loft', 'frostbound-loft', 'frostbound-loft', // 16-20
  'royal-velvet', 'royal-velvet', 'royal-velvet', 'royal-velvet', 'royal-velvet', // 21-25
  'ember-dusk', 'moonlit-forge', 'verdant-atelier', 'frostbound-loft', 'royal-velvet', // 26-30
  'ember-dusk', 'moonlit-forge', 'verdant-atelier', 'frostbound-loft', 'royal-velvet', // 31-35
  'ember-dusk', 'moonlit-forge', 'frostbound-loft', 'royal-velvet', 'royal-velvet', // 36-40
];

/**
 * Compact authored stage table.
 * goals shorthand: [colorIndex, n] collect | ['ice', n] | ['crates', n] | ['score', n]
 */
const J = [];
function stage(n, name, colors, moves, goals, extra) {
  J.push({ n, name, colors, moves, goals, ...(extra || {}) });
}

/* -- Act 1 (1-5): plain boards, collect goals -- */
stage(1, 'First Light', 5, 20, [[0, 8], [1, 8]], { desc: 'Gather rubies and amber for the workshop lamps.' });
stage(2, 'Kindling', 5, 20, [[1, 10], [2, 10]], { desc: 'Amber and topaz for the kiln.' });
stage(3, 'Sixth Shelf', 6, 22, [[3, 10], [4, 10]], { desc: 'A sixth color joins the bench.' });
stage(4, 'Triple Order', 6, 22, [[0, 8], [3, 8], [5, 8]], { desc: 'Three commissions at once.' });
stage(5, 'Apprentice Trial', 6, 20, [[2, 12], [4, 12]], { mastery: true, desc: 'Mastery: prove the basics under a tighter move limit.' });

/* -- Act 2 (6-10): ice -- */
stage(6, 'First Frost', 5, 22, [[0, 8], ['ice', 6]], { ice: 6, iceLevel: 1, desc: 'A cold snap froze six jewels. Match through them to crack the ice.' });
stage(7, 'Thin Ice', 5, 22, [['ice', 8], [1, 10]], { ice: 8, iceLevel: 1, desc: 'More frost, same patience.' });
stage(8, 'Deep Freeze', 5, 24, [['ice', 6], [2, 10]], { ice: 6, iceLevel: 2, desc: 'Double ice takes two hits each.' });
stage(9, 'Frozen Cargo', 6, 24, [['ice', 10], [5, 10]], { ice: 10, iceLevel: 1, desc: 'Free the amethyst shipment.' });
stage(10, 'Glacier Trial', 6, 26, [['ice', 8], [0, 10]], { ice: 8, iceLevel: 2, mastery: true, desc: 'Mastery: heavy frost, full commission.' });

/* -- Act 3 (11-15): crates -- */
stage(11, 'Packing Day', 5, 22, [['crates', 4], [3, 10]], { crates: 4, crateHp: 1, desc: 'Crates block cells. Match beside them to break them.' });
stage(12, 'Heavy Stock', 5, 24, [['crates', 6], [4, 10]], { crates: 6, crateHp: 1, desc: 'More crates in the way.' });
stage(13, 'Reinforced', 5, 24, [['crates', 4], [1, 12]], { crates: 4, crateHp: 2, desc: 'Sturdy crates take two hits.' });
stage(14, 'Warehouse Maze', 6, 24, [['crates', 6], [2, 12]], { crates: 6, crateHp: 2, layout: 'corners8', desc: 'Crates in a cut-corner hall.' });
stage(15, 'Storekeeper Trial', 6, 26, [['crates', 8], ['ice', 6]], { crates: 8, crateHp: 1, ice: 6, iceLevel: 1, mastery: true, desc: 'Mastery: frost and freight together.' });

/* -- Act 4 (16-20): altered layouts + score goals -- */
stage(16, 'Broken Bench', 5, 22, [[0, 12], [3, 12]], { layout: 'corners8', desc: 'Holes in the bench change how jewels fall.' });
stage(17, 'The Hollow', 5, 22, [[1, 14], [3, 12]], { layout: 'donut8', desc: 'A hole in the middle of everything.' });
stage(18, 'Cold Columns', 6, 24, [['ice', 8], [4, 12]], { layout: 'columns9', width: 9, height: 9, ice: 8, iceLevel: 1, desc: 'Split columns, frozen stock.' });
stage(19, 'Quota', 5, 22, [['score', 2600]], { desc: 'The guild wants points, not pretty colors. Cascades and specials pay best.' });
stage(20, 'Comptroller Trial', 6, 20, [['score', 3400]], { layout: 'donut8', mastery: true, desc: 'Mastery: a high quota on a broken board.' });

/* -- Act 5 (21-25): bigger boards, more colors -- */
stage(21, 'Grand Bench', 6, 24, [[2, 14], [5, 14]], { width: 9, height: 9, desc: 'A wider workbench.' });
stage(22, 'Seventh Color', 7, 26, [[0, 12], [6, 12]], { width: 9, height: 9, desc: 'Opal joins the spectrum.' });
stage(23, 'Opal Rush', 7, 24, [[6, 16], [1, 12]], { width: 9, height: 9, desc: 'Opals scatter the eye.' });
stage(24, 'Frosted Gallery', 7, 28, [['ice', 10], [3, 12]], { width: 9, height: 9, ice: 10, iceLevel: 1, desc: 'A cold gallery of seven colors.' });
stage(25, 'Curator Trial', 7, 28, [['score', 2600], ['ice', 4]], { width: 9, height: 9, ice: 4, iceLevel: 1, mastery: true, desc: 'Mastery: quota and frost on the grand bench.' });

/* -- Act 6 (26-30): heavy blockers -- */
stage(26, 'Deep Cold', 6, 26, [['ice', 12], [0, 12]], { ice: 10, iceLevel: 2, desc: 'The deep cold returns.' });
stage(27, 'Ironbound', 6, 26, [['crates', 8], [2, 12]], { crates: 8, crateHp: 2, layout: 'donut8', desc: 'Reinforced crates around the hollow.' });
stage(28, 'Salt Cellar', 6, 28, [['crates', 4], ['ice', 6]], { crates: 4, crateHp: 2, ice: 6, iceLevel: 1, layout: 'corners8', desc: 'Crates and frost in the cellar.' });
stage(29, 'Night Audit', 6, 22, [['score', 3600], [5, 12]], { desc: 'Points and amethyst before dawn.' });
stage(30, 'Warden Trial', 6, 26, [['crates', 6], ['ice', 6], [4, 8]], { crates: 6, crateHp: 1, ice: 6, iceLevel: 2, layout: 'columns9', width: 9, height: 9, mastery: true, desc: 'Mastery: every blocker you know.' });

/* -- Act 7 (31-35): combinations -- */
stage(31, 'Twin Furnaces', 6, 24, [[0, 16], [1, 16]], { width: 9, height: 9, desc: 'Two great orders, one bench.' });
stage(32, 'Frozen Vault', 7, 30, [['ice', 5], [6, 8]], { width: 9, height: 9, ice: 6, iceLevel: 2, desc: 'A vault of seven-color frost.' });
stage(33, 'Crate District', 7, 26, [['crates', 10], [2, 14]], { width: 9, height: 9, crates: 10, crateHp: 1, layout: 'columns9', desc: 'A district of freight.' });
stage(34, 'High Quota', 7, 24, [['score', 5000]], { width: 9, height: 9, desc: 'The guild raises its sights.' });
stage(35, 'Assayer Trial', 7, 26, [['score', 4600], ['crates', 8]], { width: 9, height: 9, crates: 8, crateHp: 2, mastery: true, desc: 'Mastery: quota among reinforced stock.' });

/* -- Act 8 (36-40): finales -- */
stage(36, 'Ember Wind', 6, 20, [[3, 14], [4, 14]], { layout: 'hourglass8', desc: 'A narrow waist concentrates the fall.' });
stage(37, 'Moon Quota', 7, 22, [['score', 4400], [5, 12]], { layout: 'corners8', desc: 'Tight moves over cut corners.' });
stage(38, 'Frozen Freight', 7, 30, [['crates', 4], ['ice', 4]], { width: 9, height: 9, crates: 4, crateHp: 2, ice: 5, iceLevel: 1, layout: 'ring9', desc: 'The hardest storage room in the workshop.' });
stage(39, 'Penultimate Order', 7, 24, [[0, 14], [3, 14], [6, 14]], { width: 9, height: 9, desc: 'Three colors, seven hues, no excuses.' });
stage(40, 'Master of the Cascade', 7, 30, [['score', 4000], ['ice', 6], ['crates', 4]], { width: 8, height: 8, ice: 6, iceLevel: 2, crates: 4, crateHp: 2, layout: 'donut8', mastery: true, desc: 'Final mastery: everything the workshop has taught you.' });

/**
 * Calibrated star thresholds per stage (1 star = completion).
 * s2 \u2248 40% and s3 \u2248 70% of the deterministic bot's best score for
 * collect/blocker stages; score-quota stages are relative to their quota.
 * Verified reachable by tests/run.mjs.
 */
const JOURNEY_STARS = [
  [2250, 3950], [1900, 3350], [2700, 4750], [1850, 3250], [1700, 2950],
  [4100, 7200], [4550, 8000], [5100, 8950], [3300, 5800], [3700, 6450],
  [3350, 5850], [2650, 4650], [4100, 7150], [3800, 6600], [4150, 7250],
  [2350, 4100], [2550, 4450], [3900, 6850], [3000, 3650], [3550, 3750],
  [2900, 5050], [2050, 3550], [3300, 5750], [3700, 6450], [3000, 3650],
  [3900, 6800], [3050, 5350], [3900, 6850], [4150, 5050], [3550, 6200],
  [2950, 5150], [5000, 8700], [2800, 4850], [5400, 5900], [5300, 6450],
  [1500, 2600], [5050, 5450], [2650, 4600], [2600, 4550], [4600, 5600],
];

function goalsFromShorthand(list) {
  return list.map((g) => {
    if (g[0] === 'ice') return { type: 'ice', n: g[1] };
    if (g[0] === 'crates') return { type: 'crates', n: g[1] };
    if (g[0] === 'score') return { type: 'score', n: g[1] };
    return { type: 'collect', color: g[0], n: g[1] };
  });
}

export const JOURNEY = J.map((s) => {
  const width = s.width || 8;
  const height = s.height || 8;
  const layout = s.layout ? LAYOUTS[s.layout] : null;
  const seed = 'journey-' + s.n;
  const crates = s.crates
    ? spreadCells(seed + '-crates', s.crates, width, height, layout).map((p) => ({ ...p, hp: s.crateHp || 1 }))
    : [];
  const ice = s.ice
    ? spreadCells(seed + '-ice', s.ice, width, height, layout, keySet(crates)).map((p) => ({ ...p, level: s.iceLevel || 1 }))
    : [];
  const goals = goalsFromShorthand(s.goals);
  // Blocker goals can never exceed what is actually placed.
  for (const g of goals) {
    if (g.type === 'crates' && g.n > crates.length) g.n = crates.length;
    if (g.type === 'ice' && g.n > ice.length) g.n = ice.length;
  }
  return makeContent({
    id: 'j' + s.n,
    kind: 'journey',
    mode: 'journey',
    name: 'Stage ' + s.n + ' — ' + s.name,
    desc: s.desc,
    seed,
    width,
    height,
    colors: s.colors,
    moves: s.moves,
    goals,
    layout,
    crates,
    ice,
    mechanics: ['swap', 'specials', ...(s.ice ? ['ice'] : []), ...(s.crates ? ['crates'] : []), ...(layout ? ['holes'] : [])],
    par: { moves: s.moves, score: JOURNEY_STARS[s.n - 1][0] },
    stars: { s2: JOURNEY_STARS[s.n - 1][0], s3: JOURNEY_STARS[s.n - 1][1] },
    assists: { undo: false, hints: true },
    ranked: false,
    themeId: THEMES_BY_STAGE[s.n - 1],
    stage: s.n,
    mastery: !!s.mastery,
  });
});

/* ------------------------------------------------------------------ *
 *  Daily — one shared seed and ruleset per UTC day (immutable)
 * ------------------------------------------------------------------ *
 * dailyContent(dayKey) is deterministic in every client and on the server:
 * identical dayKey → identical descriptor. The seed is published implicitly
 * by the calendar; a defective day is excluded from ranking by the server,
 * never silently replaced.
 */
export function dailyContent(dayKey) {
  const h = fnv1a('jc-daily-v1-' + dayKey);
  const variant = h % 4;
  const second = (h >>> 8) % 4;
  const colors = DAILY_RULESET.colors;
  const colorA = (h >>> 4) % colors;
  let colorB = (h >>> 12) % colors;
  if (colorB === colorA) colorB = (colorB + 1) % colors;
  const layouts = [null, 'corners8', 'donut8', 'columns9'];
  const layoutName = layouts[variant];
  const layout = layoutName ? LAYOUTS[layoutName] : null;
  const width = layoutName === 'columns9' ? 9 : 8;
  const height = layoutName === 'columns9' ? 9 : 8;
  const goals = [
    { type: 'collect', color: colorA, n: 12 },
    { type: 'collect', color: colorB, n: 12 },
  ];
  let crates = [];
  let ice = [];
  if (second === 1) {
    ice = spreadCells('daily-' + dayKey + '-ice', 6, width, height, layout).map((p) => ({ ...p, level: 1 }));
    goals.push({ type: 'ice', n: ice.length });
  } else if (second === 2) {
    crates = spreadCells('daily-' + dayKey + '-crates', 4, width, height, layout).map((p) => ({ ...p, hp: 1 }));
    goals.push({ type: 'crates', n: crates.length });
  }
  return makeContent({
    id: 'daily-' + dayKey,
    kind: 'daily',
    mode: 'daily',
    name: 'Daily — ' + dayKey,
    desc: 'One shared board for every player today. Same seed, same rules.',
    seed: 'daily-' + dayKey,
    width,
    height,
    colors,
    moves: DAILY_RULESET.moves,
    goals,
    layout,
    crates,
    ice,
    mechanics: ['swap', 'specials'],
    stars: { s2: 3200, s3: 4800 },
    assists: { undo: false, hints: true },
    ranked: true,
    themeId: ['ember-dusk', 'moonlit-forge', 'verdant-atelier', 'frostbound-loft', 'royal-velvet'][(h >>> 16) % 5],
    dayKey,
  });
}

/* ------------------------------------------------------------------ *
 *  Practice — selectable difficulty, own seed, undo allowed, unrated
 * ------------------------------------------------------------------ */

export const PRACTICE_DIFFICULTIES = [
  {
    id: 'easy',
    name: 'Easy',
    desc: 'Five colors, generous moves. Learn the rhythms.',
    colors: 5,
    moves: 30,
    goals: [{ type: 'collect', color: 0, n: 10 }, { type: 'collect', color: 2, n: 10 }],
    width: 8,
    height: 8,
  },
  {
    id: 'medium',
    name: 'Medium',
    desc: 'Six colors and a few crates.',
    colors: 6,
    moves: 25,
    goals: [{ type: 'collect', color: 1, n: 12 }, { type: 'collect', color: 4, n: 12 }, { type: 'crates', n: 4 }],
    width: 8,
    height: 8,
    crates: 4,
  },
  {
    id: 'hard',
    name: 'Hard',
    desc: 'Frost on a split-column board.',
    colors: 6,
    moves: 26,
    goals: [{ type: 'ice', n: 8 }, { type: 'collect', color: 5, n: 10 }],
    width: 9,
    height: 9,
    ice: 8,
    layout: 'columns9',
  },
  {
    id: 'expert',
    name: 'Expert',
    desc: 'Seven colors, a quota, and no room for waste.',
    colors: 7,
    moves: 22,
    goals: [{ type: 'score', n: 4800 }],
    width: 9,
    height: 9,
  },
];

export function practiceContent(difficultyId, seedString) {
  const diff = PRACTICE_DIFFICULTIES.find((d) => d.id === difficultyId) || PRACTICE_DIFFICULTIES[0];
  const seed = seedString && String(seedString).trim() ? String(seedString).trim() : 'practice-' + Math.floor(Math.random() * 0xffffffff).toString(36);
  const layout = diff.layout ? LAYOUTS[diff.layout] : null;
  const crates = diff.crates ? spreadCells(seed + '-c', diff.crates, diff.width, diff.height, layout).map((p) => ({ ...p, hp: 1 })) : [];
  const ice = diff.ice ? spreadCells(seed + '-i', diff.ice, diff.width, diff.height, layout).map((p) => ({ ...p, level: 1 })) : [];
  return makeContent({
    id: 'practice-' + diff.id + '-' + fnv1a(seed).toString(36),
    kind: 'practice',
    mode: 'practice',
    name: 'Practice — ' + diff.name,
    desc: diff.desc + ' Seed: ' + seed,
    seed,
    width: diff.width,
    height: diff.height,
    colors: diff.colors,
    moves: diff.moves,
    goals: diff.goals.map((g) => ({ ...g })),
    layout,
    crates,
    ice,
    mechanics: ['swap', 'specials'],
    stars: null,
    assists: { undo: true, hints: true },
    ranked: false,
    themeId: 'ember-dusk',
    difficulty: diff.id,
  });
}

/* ------------------------------------------------------------------ *
 *  Challenge — constrained goals, timers, altered layouts
 * ------------------------------------------------------------------ */

const CHALLENGE_DEFS = [
  {
    id: 'ch-sprint',
    name: 'Sprint',
    desc: 'Ninety seconds. Unlimited swaps — how much can you score?',
    colors: 5,
    moves: 999,
    goals: [{ type: 'score', n: 9999999 }],
    timeLimitSec: 90,
    width: 8,
    height: 8,
  },
  {
    id: 'ch-eight-moves',
    name: 'Eight Moves',
    desc: 'Twelve emeralds in only eight swaps.',
    colors: 5,
    moves: 8,
    goals: [{ type: 'collect', color: 3, n: 12 }],
    width: 8,
    height: 8,
  },
  {
    id: 'ch-ice-storm',
    name: 'Ice Storm',
    desc: 'Crack sixteen sheets of ice before the moves run out.',
    colors: 5,
    moves: 22,
    goals: [{ type: 'ice', n: 16 }],
    ice: 16,
    width: 8,
    height: 8,
  },
  {
    id: 'ch-crate-maze',
    name: 'Crate Maze',
    desc: 'A maze of freight. Clear every crate.',
    colors: 5,
    moves: 20,
    goals: [{ type: 'crates', n: 8 }],
    crates: 8,
    crateHp: 2,
    layout: 'corners8',
    width: 8,
    height: 8,
  },
  {
    id: 'ch-hourglass',
    name: 'Hourglass',
    desc: 'A tight-waisted board and a quota.',
    colors: 6,
    moves: 20,
    goals: [{ type: 'score', n: 2600 }],
    layout: 'hourglass8',
    width: 8,
    height: 8,
  },
  {
    id: 'ch-seven-seas',
    name: 'Seven Seas',
    desc: 'All seven colors, few moves, big order.',
    colors: 7,
    moves: 20,
    goals: [{ type: 'collect', color: 6, n: 14 }, { type: 'collect', color: 4, n: 14 }],
    width: 9,
    height: 9,
  },
  {
    id: 'ch-blind',
    name: "Master's Eye",
    desc: 'No hints. Trust your reading of the board.',
    colors: 6,
    moves: 22,
    goals: [{ type: 'score', n: 3800 }],
    hints: false,
    width: 8,
    height: 8,
  },
  {
    id: 'ch-grand',
    name: 'Grand Trial',
    desc: 'Frost, freight, and a quota on the grand bench.',
    colors: 7,
    moves: 28,
    goals: [{ type: 'score', n: 3600 }, { type: 'ice', n: 6 }, { type: 'crates', n: 4 }],
    ice: 6,
    crates: 4,
    crateHp: 1,
    width: 9,
    height: 9,
  },
];

export const CHALLENGES = CHALLENGE_DEFS.map((d) => {
  const layout = d.layout ? LAYOUTS[d.layout] : null;
  const crates = d.crates
    ? spreadCells(d.id + '-crates', d.crates, d.width, d.height, layout).map((p) => ({ ...p, hp: d.crateHp || 1 }))
    : [];
  const ice = d.ice ? spreadCells(d.id + '-ice', d.ice, d.width, d.height, layout, keySet(crates)).map((p) => ({ ...p, level: 1 })) : [];
  const goals = d.goals.map((g) => ({ ...g }));
  for (const g of goals) {
    if (g.type === 'crates' && g.n > crates.length) g.n = crates.length;
    if (g.type === 'ice' && g.n > ice.length) g.n = ice.length;
  }
  return makeContent({
    id: d.id,
    kind: 'challenge',
    mode: 'challenge',
    name: d.name,
    desc: d.desc,
    seed: 'challenge-' + d.id,
    width: d.width,
    height: d.height,
    colors: d.colors,
    moves: d.moves,
    goals,
    layout,
    crates,
    ice,
    mechanics: ['swap', 'specials'],
    stars: null,
    assists: { undo: false, hints: d.hints !== false },
    ranked: true,
    timeLimitSec: d.timeLimitSec || null,
    themeId: 'royal-velvet',
  });
});

/* ------------------------------------------------------------------ *
 *  Score chase — validated shareable seeds, fixed ruleset
 * ------------------------------------------------------------------ */

export function scoreChaseContent(seedString) {
  const seed = seedString && String(seedString).trim() ? String(seedString).trim() : 'chase';
  return makeContent({
    id: 'chase-' + fnv1a(seed).toString(36),
    kind: 'score',
    mode: 'score',
    name: 'Score chase',
    desc:
      'Fixed ruleset, player-chosen seed. Reach ' +
      SCORE_CHASE_RULESET.target +
      ' points in ' +
      SCORE_CHASE_RULESET.moves +
      ' moves; every unused move banks +' +
      rules.SCORE.LEFTOVER_MOVE +
      '. Seed: ' +
      seed,
    seed: 'chase-' + seed,
    width: SCORE_CHASE_RULESET.width,
    height: SCORE_CHASE_RULESET.height,
    colors: SCORE_CHASE_RULESET.colors,
    moves: SCORE_CHASE_RULESET.moves,
    goals: [{ type: 'score', n: SCORE_CHASE_RULESET.target }],
    mechanics: ['swap', 'specials'],
    stars: null,
    assists: { undo: false, hints: true },
    ranked: true,
    themeId: 'moonlit-forge',
  });
}

/* ------------------------------------------------------------------ *
 *  Offline validators (spec §2: legality, reachable goals, bounded
 *  duration, absence of soft locks) — exercised by tests/run.mjs.
 * ------------------------------------------------------------------ */

/**
 * Deterministic bots used by the validators. Both enumerate the same legal
 * actions the hint API exposes and pick by a fixed key; they differ only in
 * how much they weight goal progress versus immediate score. If either
 * strategy completes the goals, the content's goals are proven reachable.
 */
function goalDebt(state) {
  let debt = 0;
  for (const g of state.goals) {
    if (g.done) continue;
    debt += g.type === 'score' ? g.left / 50 : g.left;
  }
  return debt;
}

function chooseBotMove(state, goalWeight) {
  const actions = rules.legalActions(state);
  if (actions.length === 0) return null;
  let best = null;
  let bestKey = null;
  for (const act of actions) {
    const probe = rules.cloneState(state);
    probe.assists.undo = false;
    const debtBefore = goalDebt(state);
    const scoreBefore = state.score;
    const res = rules.applyCommand(probe, { id: 'bot-probe', type: 'swap', ax: act.ax, ay: act.ay, bx: act.bx, by: act.by });
    if (!res.accepted) continue;
    const key = [
      Math.round((debtBefore - goalDebt(probe)) * 1000 * goalWeight) + (probe.score - scoreBefore),
      -act.ay,
      -act.ax,
      -act.by,
      -act.bx,
    ];
    if (!bestKey || compareKeys(key, bestKey) > 0) {
      bestKey = key;
      best = act;
    }
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function simulateBot(config, { maxTurns = 500, goalWeight = 0 } = {}) {
  let state = rules.createGame(config);
  let turns = 0;
  while (state.phase === 'ready' && turns < maxTurns) {
    const mv = chooseBotMove(state, goalWeight);
    if (!mv) break;
    const res = rules.applyCommand(state, { id: 'bot-' + turns, type: 'swap', ax: mv.ax, ay: mv.ay, bx: mv.bx, by: mv.by });
    if (!res.accepted) return { state, turns, error: 'bot move rejected: ' + res.reason };
    turns++;
  }
  return { state, turns };
}

/**
 * validateContent(descriptor) → {ok, issues[], bot}.
 * Structure, initial-board legality, goal sanity, bot winnability, and star
 * threshold sanity. Deterministic: same descriptor → same verdict.
 */
export function validateContent(c, { botGame = true } = {}) {
  const issues = [];
  if (!c.id || typeof c.id !== 'string') issues.push('missing id');
  if (!Number.isInteger(c.version)) issues.push('missing version');
  if (c.seed === undefined || c.seed === null || c.seed === '') issues.push('missing seed');
  if (!(c.width >= 4 && c.width <= 12 && c.height >= 4 && c.height <= 12)) issues.push('bad dimensions');
  if (!(c.colors >= 3 && c.colors <= 7)) issues.push('bad color count');
  if (!(c.moves >= 1)) issues.push('bad move count');
  if (!Array.isArray(c.goals) || c.goals.length === 0) issues.push('no goals');
  for (const g of c.goals || []) {
    if (g.type === 'collect' && !(g.color >= 0 && g.color < c.colors)) issues.push('collect goal color out of range');
    if (!(g.n > 0)) issues.push('goal target must be positive');
  }
  if (c.stars && !(c.stars.s2 < c.stars.s3)) issues.push('star thresholds not ordered');
  if (issues.length) return { ok: false, issues, bot: null };

  let config;
  try {
    config = c.toEngineConfig();
  } catch (err) {
    return { ok: false, issues: ['toEngineConfig threw: ' + err.message], bot: null };
  }

  let state;
  try {
    state = rules.createGame(config);
  } catch (err) {
    return { ok: false, issues: ['createGame threw: ' + err.message], bot: null };
  }
  if (rules.findMatches(state).length !== 0) issues.push('initial board has matches');
  if (rules.legalActions(state).length === 0) issues.push('initial board has no legal action');

  // Goal sanity: enough blockers on the board to satisfy blocker goals.
  const cratesTotal = state.cells.reduce((n, cell) => n + (cell.crate > 0 ? 1 : 0), 0);
  const iceTotal = state.cells.reduce((n, cell) => n + (cell.ice > 0 ? 1 : 0), 0);
  for (const g of c.goals) {
    if (g.type === 'crates' && g.n > cratesTotal) issues.push('crates goal exceeds placed crates (' + g.n + ' > ' + cratesTotal + ')');
    if (g.type === 'ice' && g.n > iceTotal) issues.push('ice goal exceeds placed ice (' + g.n + ' > ' + iceTotal + ')');
  }

  let bot = null;
  // Time-limited content ends via the session clock, not the rules engine,
  // so a rules-only bot game would look unbounded. Skip it there.
  const rulesBounded = !(c.timeLimitSec && c.moves > 100);
  if (botGame && issues.length === 0 && rulesBounded) {
    const greedy = simulateBot(config, { goalWeight: 0 });
    const hungry = simulateBot(config, { goalWeight: 1 });
    bot = greedy;
    if (greedy.error) issues.push(greedy.error);
    else if (greedy.state.phase !== 'ended' || hungry.state.phase !== 'ended') {
      issues.push('bot game did not terminate (unbounded?)');
    } else if (
      c.kind !== 'lesson' &&
      greedy.state.reason !== rules.END.GOALS &&
      hungry.state.reason !== rules.END.GOALS
    ) {
      issues.push('no bot strategy completed the goals (greedy: ' + greedy.state.reason + ', goal-first: ' + hungry.state.reason + ')');
    }
  }
  return { ok: issues.length === 0, issues, bot };
}

/** Validate every authored descriptor; returns [{id, issues}] for failures. */
export function validateAllContent() {
  const failures = [];
  const all = [
    ...LESSONS,
    ...JOURNEY,
    ...CHALLENGES,
    dailyContent('2026-01-01'),
    dailyContent('2026-06-15'),
    scoreChaseContent('validator'),
    practiceContent('easy', 'validator'),
    practiceContent('medium', 'validator'),
    practiceContent('hard', 'validator'),
    practiceContent('expert', 'validator'),
  ];
  for (const c of all) {
    const r = validateContent(c);
    if (!r.ok) failures.push({ id: c.id, issues: r.issues });
  }
  return failures;
}

/** Deterministic content hash for diagnostics and replay envelopes. */
export function contentHash(c) {
  return hashStrings(c.id, String(c.version), String(c.seed)).toString(16);
}
