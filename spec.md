# Jewel Cascade — Game Design Document

**Status:** running specification. Present tense; describes what the game does today.
Anything the design wants but the code does not do yet is listed in §17.

---

## 1. Overview

**Pitch.** A lapidary's evening shift: swap adjacent jewels on a lit workbench to fill an
order before the moves run out, and forge rays, blooms and prisms out of the runs you cut.

| | |
|---|---|
| Genre | Match-3 / limited-move objective puzzle |
| Players | 1, with asynchronous ranked comparison |
| Session | 90 s – 4 min per round; a Journey act is ~20 min |
| Platforms | Desktop and mobile browsers; portrait and landscape |
| Rendering | Three.js (WebGL) tabletop scene, with a complete DOM/ARIA text board as an equal play path |
| Entry point | `index.html` (declared as `launch` in `starhermit.txt`) |

### File map

| Path | Contents |
|---|---|
| `index.html` | Static DOM shell: 13 screens, HUD, mirror board, live regions |
| `css/style.css` | Full stylesheet: tokens, screens, responsive rules, a11y overrides |
| `js/main.js` | Boot, cross-module wiring, tick loop, adaptive quality governor |
| `js/session.js` | Round FSM, event bus, authoritative clock, results, progression |
| `js/engine/rules.js` | Pure rules engine: board, swaps, cascades, specials, scoring, replay |
| `js/engine/content.js` | Versioned content: lessons, journey, dailies, challenges, practice, chase, validators |
| `js/engine/themes.js` | 5 visual themes + 4 colour-vision jewel palettes |
| `js/engine/rng.js` | mulberry32 `Rng`, FNV-1a hashing, stable stringify |
| `js/engine/achievements.js` | 5 achievements, career counters, 10 mastery levels |
| `js/render/scene.js` | Three.js scene, board build, event-driven animation timeline, particles |
| `js/ui/ui.js` | Screen manager, HUD, mirror board, settings, remapping, gamepad |
| `js/audio.js` | Buses, recorded one-shots, synth fallbacks, adaptive music, captions |
| `js/platform.js` | StarHermit adapter (`/api/v1`), identity, scores, cloud save |
| `js/storage.js` | Checksummed, versioned `localStorage` documents |
| `js/analytics.js` | Consent-gated funnel telemetry |
| `server.js` | Authoritative script: replay verification, boards, saves, static serving |
| `sfx/` | 37 Opus one-shots + `manifest.txt` (canonical) + `manifest.json` (generator) |
| `assets/` | Generated key art (`title-keyart.webp`, `results-plate.webp`), `favicon.svg` |
| `tests/run.mjs` | 61 unit / property / fuzz / golden / server tests |
| `tests/e2e.mjs` | Playwright-core playthrough of the real UI, desktop + mobile |
| `vendor/three.module.js` | Three.js |

---

## 2. Design pillars

**1. The board is the only source of truth, and it is legible without pixels.**
Every rule lives in `js/engine/rules.js`; every presentation layer is a subscriber to the event
stream it emits. That is why the text mirror board (`ui.js:1343-1498`) is a first-class play path
and not an accessibility bolt-on — same state, same events, same `session.trySwap`.
*Rules in:* mechanics expressible as a rules event with a glyph.
*Rules out:* effects carrying information the DOM board cannot restate.

**2. Determinism you can audit.**
Board generation, spawns, shuffles, hints and even cosmetic audio variance draw from seeded
streams. A round is a seed plus an ordered command log; `rules.replayLog` reproduces every
intermediate hash. The server re-runs your round rather than trusting your score.
*Rules in:* seeded daily and challenge content, replayable results, honest leaderboards.
*Rules out:* `Math.random` in gameplay (the sole exception is generating a fresh practice seed),
timers that affect the rules, and any "luck" the player cannot inspect.

**3. Craft, not clearing.**
Scoring pays more for what you *make* than what you remove: a plain jewel is 10, a prism 200, a
detonation 60. Four- and five-runs are the skill expression, and leftover moves bank 120 each.
*Rules in:* specials that combine (prism + ray converts a whole colour into rays).
*Rules out:* boosters, purchasable advantages, totals that hide their components.

**4. A warm workbench, not a neon slot machine.**
Ember dusk, brass and walnut, lit by a hanging filament bulb. Motion is short and physical — a
0.18 s swap, a 0.36 s burst, a drop arc — and all of it skips to the exact deterministic end state.
*Rules in:* volumetric haze, dust, a spring camera, per-theme skies.
*Rules out:* screen-filling flashes, sustained shake, anything that survives reduced motion.

**5. Never dead-ended.**
A resolved board with no legal swap reshuffles for free (`rules.js:985`), falling back to a
deterministic legal pattern after 120 attempts. Practice grants undo; every mode but `ch-blind`
grants hints, computed by fully simulating each legal move.
*Rules in:* a guaranteed-solvable board at all times, validated offline for every shipped level.
*Rules out:* soft locks, "no moves, you lose", hints that are just a random legal swap.

---

## 3. Player experience

**Target player.** Someone who already knows match-3 and wants the objective layer taken
seriously: real goals, real blockers, a score they can dissect, a daily everyone shares.

**First 60 seconds.** Boot bar → title (key art, `Play`, daily/journey/profile chips) → mode grid.
Learn is the first card; its six lessons teach one rule each — first swaps, rays, blooms, prisms,
ice, crates. A lesson pins a banner (`#tutorial-banner`, `role="status"`), highlights the exact
cells, and sets `session.inputFilter` so only the taught swap is accepted: a wrong tap is answered
with "Try the highlighted swap" rather than silence. Lesson seeds are searched (32 attempts,
`pickLessonSeed`) until the guided swap is guaranteed legal on a quiet board. A player who skips
Learn is still taught in place — each mechanic first appears alone in the Journey act that
introduces it (ice at 6, crates at 11, cut layouts at 16, the seventh colour at 22).

**Session shape.** 20–30 moves per round: scan → swap → watch the cascade resolve → read the goal
counters fall. Score, moves and goal changes are announced to screen readers on every change, and
the results overlay breaks the score into its six components.

**Emotional beat.** The peak is the *forged* moment — a five-run collapses into a prism, you swap
it into a colour, and the whole board of that colour converts and detonates in a chain you set up
two moves ago. `special-forge.opus` on creation, `prism-burst.opus` on the fire, and a
music-intensity bump proportional to cascade depth (`main.js:136`).

---

## 4. Core loop and rules contract

Owner of every rule below: `js/engine/rules.js`.

### Board

Flat `state.cells`, `index = y*width + x`, **y = 0 at the top**. A cell is
`{ play, j: {c, s} | null, ice: 0..2, crate: 0..2 }`; `play:false` is a hole (no jewel, no spawn,
no target). Shipped boards are 8×8 or 9×9; the validator accepts 4..12 and 3..7 colours.
Colours 0..6 are `ruby, amber, topaz, emerald, sapphire, amethyst, opal`; specials are
`RAY_H, RAY_V, BLOOM, PRISM`. **Ice** (1–2 layers) locks its jewel against swapping *and* gravity;
each hit strips a layer and the hit reaching 0 also removes the jewel. **Crates** (1–2 HP) hold no
jewel, never move, are gravity walls, and take splash damage from matches on orthogonally adjacent
cells and from direct blast hits.

### Legal actions

`checkSwap` (`rules.js:493`) rejects in order: `ENDED`, `OUT_OF_BOUNDS`, `NOT_ADJACENT`
(Manhattan ≠ 1), `CRATE`, `NO_JEWEL`, `ICE_LOCKED`; it does not test for a match. `legalActions`
(`rules.js:519`) probes only right and down neighbours, skips same-colour pairs, and returns any
prism-bearing pair without probing (a prism swap is always legal). A swap producing no match emits
`swap` then `swap-back {reason:'no-match'}`, increments `stats.invalid`, and **spends no move**.

### Resolution order

`applyCommand` (`rules.js:1034`): validate shape → idempotency ring (last 64 command ids) →
`checkSwap` → match probe → push undo snapshot → `turn++`, `movesLeft--`, `movesSpent++` →
swap and `resolveBoard` (or `resolvePrismSwap`) → `refreshScoreGoal` → terminal check → shuffle
check → emit `turn`.

`resolveBoard` (`rules.js:827`), bounded at 64 cascade steps, repeats:

1. `findMatches` — horizontal runs first, then vertical, maximal runs only (a 5-run is one group of 5).
2. `planCreations` — bloom for any cell in two groups of different direction; then prism for an
   unused run ≥5; then ray-H/ray-V for an unused run of exactly 4. On the first step the creation
   lands on the player's swap cell `b`, else `a`, else the group's middle.
3. Emit `match {cascade, groups}` and score the step.
4. `hitCell` each matched cell (emitting `crack` / `damage` / `crate-break`).
5. `applyRemovals` — crate splash to orthogonal neighbours, then queued specials fire FIFO (each
   index fires at most once), then physical removal.
6. Apply creations (`create`), then `applyGravityAndSpawn`.

Gravity walls are `!play || crate>0 || (j && ice>0)`; columns split into segments at walls, jewels
compact downward inside a segment, and remaining slots refill from a single seeded stream in
column-then-row order. Specials fire on removal: ray-H clears its row, ray-V its column, bloom a
clamped 3×3, a prism every jewel of its own colour. A **prism swap** (`rules.js:913`, always legal,
always spends a move) has three modes: prism+prism clears the board; prism+special converts every
jewel of the partner's colour into that special and fires them all; prism+plain clears that colour.

### Scoring

| Constant | Value | Awarded | Component |
|---|---|---|---|
| `PER_JEWEL` | 10 | every physically removed jewel | `match` / `special` |
| `GROUP_BASE` | 50 | per matched group | `match` |
| `GROUP_EXTRA` | 20 | per jewel beyond 3 in a group | `match` |
| `CASCADE_STEP` | 30 | `× (cascade − 1) × groups`, only when cascade > 1 | `cascade` |
| `MAKE_RAY` / `MAKE_BLOOM` / `MAKE_PRISM` | 80 / 120 / 200 | on creation | `special` |
| `DETONATE` | 60 | per special fired | `special` |
| `CRATE_HIT` / `CRATE_BREAK` | 40 / 100 | per hit / per destroyed crate | `blocker` |
| `ICE_BREAK` | 60 | per ice layer removed | `blocker` |
| `GOAL_DONE` | 300 | per goal completed | `goal` |
| `LEFTOVER_MOVE` | 120 | per unused move, **goals-complete only** | `leftover` |

Per step: `Σ_groups (50 + 20·max(0, len−3))` plus `30·(cascade−1)·groupCount`.
A cell that becomes a special is excluded from physical removal, so it earns neither `PER_JEWEL`
nor collect-goal credit.

**Worked example.** Move 1, clean 8×8, 20 moves, goal `collect ruby 8`.
*Cascade 1* — a horizontal 4-run of rubies made by swapping into `b`.
Group: `50 + 20·1` = **70**. Cascade bonus: 0. `b` becomes a ray-H, so only 3 jewels are removed:
`3 × 10` = **30**, and ruby collect is credited **3**. Creation: `MAKE_RAY` = **80**. Step = **180**.
*Cascade 2* — the refill drops two separate 3-runs. Groups `2 × 50` = 100, jewels `6 × 10` = 60,
cascade `30 × 1 × 2` = 60. Step = **220**. Running total **400**.
Later the ruby goal reaches 0: **+300** (`goal`) → 700. The round ends on goals-complete with 17
moves left: `17 × 120` = **2040** (`leftover`) → final **2740**, and `components` sums exactly to
`score` (asserted by `tests/run.mjs`).

### Goals, terminal states, tie-breaks

Goal types: `collect(color, n)`, `crates(n)`, `ice(n)`, `score(n)`; score goals read the running
total, the others decrement on credit and pay `GOAL_DONE` at zero. End reasons: `goals-complete`,
`out-of-moves`, `resigned`, `time-expired`. Stars (`starRating`, `rules.js:1209`) are 0 unless the
reason is `goals-complete`; then 1 for completion, 2 at `stars.s2`, 3 at `stars.s3`. Ties break on
`[reason === goals-complete ? 0 : 1, stats.invalid, elapsedMs, sessionId]`, lower wins — completion,
then clean play, then speed, then a stable id.

### RNG and seeding

`Rng` is mulberry32 seeded from `fnv1a(seedString)`; the single gameplay stream lives in `state.rng`
and is checkpointed after every gravity and shuffle. Content seeds are strings — `journey-N`,
`daily-<YYYY-MM-DD>`, `challenge-<id>`, `chase-<seed>`, `lesson-N`. Blocker placement uses a
separate stream (suffixes `-crates`, `-ice`) and never uses the outer one-cell margin. `hashState`
is an 8-hex FNV-1a over a key-sorted snapshot omitting `history`, `seen` and `elapsedMs`, so
replays hash-match.

### Undo and hints

**Undo** exists only where `assists.undo` is set (Practice): it restores the pre-swap snapshot
wholesale — score, goals, moves and RNG all revert — preserving the live idempotency ring, depth 60.
**Hints** enumerate `legalActions`, fully resolve each on a clone and rank by
`[scoreGain, cascadesMax, −ay, −ax, −by, −bx]` — deterministic, and genuinely the best move the
engine can see. The highlight clears after 2600 ms.

---

## 5. Modes and progression

| Mode | Content | Ranked | Undo | Hints | Shape |
|---|---|---|---|---|---|
| Learn | 6 lessons | no | no | no | Scripted steps, guided swaps, input filtered |
| Journey | 40 stages | no | no | yes | Authored curve, 8 acts of 5, mastery trial at each act end |
| Daily | 1 per UTC day | **yes** | no | yes | 6 colours, 24 moves, seeded from the day key |
| Practice | 4 difficulties | no | **yes** | yes | Free play, optional custom seed |
| Challenge | 8 fixed | **yes** | no | mostly | Constrained rules |
| Score chase | 1 ruleset | **yes** | no | yes | 8×8, 6 colours, 25 moves, score target 5200 |

**Journey curve.** Act 1 (1-5) is pure collect goals on 5–6 colours. Act 2 (6-10) introduces ice,
one variable at a time: level-1 ice → more ice → level-2 ice → ice plus a colour goal → the
Glacier Trial. Act 3 (11-15) does the same for crates, ending on a stage that combines crates and
ice. Act 4 (16-20) introduces cut layouts (`corners8`, `donut8`, `columns9`) and the first pure
score goals. Act 5 (21-25) opens the 9×9 board and the seventh colour (opal). Acts 6-8 recombine
everything and raise thresholds; stage 40, *Master of the Cascade*, is an 8×8 donut with a score
goal, level-2 ice and 2-HP crates. Star thresholds (`JOURNEY_STARS`, `content.js:591`) are set at
roughly 40% and 70% of the deterministic bot's best score for that stage — every one of them is
proven reachable by `tests/run.mjs`.

**Daily.** `dayKey` is the UTC ISO date. `h = fnv1a('jc-daily-v1-' + dayKey)` picks the layout
(`h%4` → none / corners / donut / columns9), two distinct collect colours of 12 each, an optional
second mechanic (`(h>>>8)%4`: 1 → 6 ice, 2 → 4 crates, else none) and the theme. Stars 3200 / 4800.
A daily streak is tracked on consecutive UTC days, and `daily.best[dayKey]` keeps the best score.

**Challenges.** `ch-sprint` (90 s, effectively unlimited moves, pure score), `ch-eight-moves`
(8 moves, collect 12 emerald), `ch-ice-storm` (16 ice), `ch-crate-maze` (8 two-HP crates on a
cut board), `ch-hourglass`, `ch-seven-seas` (9×9, 7 colours), `ch-blind` — *Master's Eye*, the
only content with hints disabled — and `ch-grand` (three goals at once).

**Unlocks.** Journey stages unlock sequentially (`journeyUnlocked = min(40, stage+1)`). Everything
else is cosmetic and gated on mastery XP: `floor(score/100) + (won ? 10 : 2) + (firstClear ? 15 : 0)`
per round, across ten levels (0/40/100/180/280/400/560/780/1040/1400) awarding the four locked
themes (levels 2/4/6/8), two trails (3, 7), two frames (5, 9) and the *Cascade Master* title (10).
Five achievements: first completion, all three special types made, a 5-win streak, stage 40 cleared,
100 rounds played.

---

## 6. Controls and interaction

| Action | Key (default) | Gamepad | Touch / mouse |
|---|---|---|---|
| Move cursor | Arrow keys | D-pad 12-15 / left stick (0.55 deadzone, 180 ms repeat) | — |
| Select / commit swap | Enter, Space | A (0) | Tap a jewel, then an adjacent jewel |
| Directional swap | — | — | Drag ≥ 24 px, dominant axis wins |
| Cancel / pause | Escape | B (1) | — |
| Pause | P | Start (9) | `#btn-pause` / `#tray-pause` |
| Hint | H | X (2) | `#btn-hint` / `#tray-hint` |
| Undo | U | Y (3) | `#btn-undo` / `#tray-undo` |
| Skip settle | S | — | `#btn-skip` (shown only while resolving) |
| Camera cycle | C | RB (5) | `#btn-camera` (default → low → high) |
| Mute | M | — | Settings |
| Help | ? | — | Header nav |

Every keyboard and the six gamepad bindings are remappable in Settings → Controls, with a capture
listener that Escape cancels and a reset button.

**Tap versus drag** (`scene.js:1716-1864`): a tap is same-cell, ≤ 12 px of movement, ≤ 600 ms.
Drag is disabled entirely when `settings.input.holdToDrag` is off, leaving tap-tap as the only
pointer gesture. Pointer capture is taken on down; right button is ignored; picking raycasts a
math plane with camera shake subtracted first so a shaking camera never misdirects a tap.

**Input locking.** `_inputReady()` requires a state, no animation in flight, not paused, page not
hidden, WebGL context not lost. The lock covers only the resolution animation, and `S` /
`#btn-skip` fast-forwards it to the exact deterministic end state. Learn additionally installs
`session.inputFilter`, which returns `filtered` for anything but the taught pair (in either
direction). Mirror-board taps require `state.phase === 'ready'`.

**Feedback for every input.** Accepted swap → `gem-swap.opus` + the swap animation. Rejected swap
→ red invalid ring, `ui-error.opus`, a 20 ms vibration, a specific reason string
(`INVALID_TEXT`, `ui.js:28`) announced assertively. Selection → a pulsing `#ffd28a` ring and
`gem-select.opus`. Hover (mouse only) → a passive ghost ring. Keyboard cursor → a translucent
`#9fd8ef` plane. Hint → two pulsing green rings for 2600 ms.

---

## 7. Screens and UI flow

Thirteen `section.screen` elements in `index.html`, three of them overlays
(`role="dialog" aria-modal="true"`): **boot, title, mode-select, journey, setup, game, pause\*,
results\*, settings\*, help, achievements, boards, profile**.

The session FSM (`session.js:32-60`) is the authority and `ui.js:736` maps it onto screens:

```
boot → title → { profile-ready | mode-select | preparing(resume) }
mode-select → preparing → { tutorial | countdown } → active
active ↔ paused,  active → resolving → { active | tutorial | results }
results → { preparing(retry) | mode-select | title }
```

Illegal edges are refused with a warning rather than throwing. Overlays are a stack with focus
return; Tab is trapped inside the topmost one.

**Desktop layout** (`.game-layout`, ≥1024 px): a three-column grid — objective rail (15 rem, max
32vw), playfield, actions rail — under a full-width status bar. The header is hidden entirely
while `body.in-game`.

**Mobile portrait** (≤1023 px): one column. Both rails become absolutely positioned drawers opened
by edge tabs, and a five-button thumb tray (hint / undo / mirror / pause) pins to the bottom.
**Mobile landscape** (≤1023 px and ≤560 px tall): the status bar rotates into a 9.5 rem vertical
rail beside the playfield and the drawer tabs move to the vertical edges.

**Safe areas.** `viewport-fit=cover`; `--sat/--sar/--sab/--sal` from `env(safe-area-inset-*)` are
applied to the header, every screen's padding, the game grid, the tutorial banner, the mirror
panel, the toast region, the drawer tabs, both rails and the thumb tray. `ui.updateInsets()`
measures the real rail widths, status height and (in narrow portrait) the tray height and hands
them to `scene.setViewportInsets`, which re-fits the camera symmetrically with a 1.19 margin —
so **the board is never cut off and never sits under a rail, a notch or the thumb tray**. The
other must-never-be-cut elements are the score/moves/timer readouts, the goal counters, and the
results score breakdown; all three live in scrolling panels capped at
`calc(100vh − 2rem − safe areas)`.

---

## 8. Art direction

**Palette.** Ink `#f4ecdf` on a violet ground: `--bg #241a3a`, `--bg-2 #2d2148`, `--panel #31254e`,
`--panel-2 #3a2c5a`, `--panel-line #4a3a68`, dim `#cfc2b8`, muted `#a89bc0`. One warm accent:
`--accent #ffb36b` / `--accent-2 #ffd28a`, plus `--gold #ffc857`, `--danger #ff7b7b`, `--ok #7bd88f`,
`--focus #ffe6b0`. High contrast (`html.hc`) drops the ground to `#100a20`, ink to `#ffffff`, and
thickens borders to 2 px.

Jewels are fixed per colour index so a colour never means two things: `#e5484d ruby`, `#f76b15 amber`,
`#ffd60a topaz`, `#46a758 emerald`, `#3e9bde sapphire`, `#9b5de5 amethyst`, `#f2e9e4 opal` — with
deuter, protan, tritan and high-contrast substitutions (`themes.js:22`) mirrored exactly in the
`.palette-*` CSS classes, so the 3D board and the text mirror never disagree.

**Themes.** Five workbench moods, each supplying sky, fog, three lights, table, board frame and
cells, accent, dust and an ambience key: *Ember Dusk* (default; violet-to-ember sky, `#ffb36b` key,
brass `#c9973f` frame), *Moonlit Forge* (mastery 2; cold key, warm fill), *Verdant Atelier* (4;
starless golden hour), *Frostbound Loft* (6), *Royal Velvet* (8).

**Shape language.** Silhouette carries colour identity — ruby octahedron, amber dodecahedron, topaz
tetrahedron, emerald elongated octahedron, sapphire icosahedron, amethyst hexagonal cone, opal
sphere — flat-shaded, roughness 0.28, emissive at 16% of albedo, so all seven separate in greyscale.
Specials add an overlay rather than a recolour: torus rings for rays, a wireframe icosahedron for
blooms (warm) and prisms (cool, slowly spinning).

**Hero of the screen.** The board, always: the environment (walnut table, brass rim, five seeded
hanging lamps, 260 stars, drifting dust) is fogged and under-lit precisely so the jewels are the
brightest thing in frame. On the title screen the hero is the generated key art
(`assets/title-keyart.webp`), composed with empty sky in the upper centre for the logo.

**Typography.** One system stack (`system-ui, -apple-system, "Segoe UI", Roboto, …`); root 16 px with
18 and 20 px alternatives; headings 650, logo 800 at `clamp(2.6rem, 8vw, 4.5rem)`; `tabular-nums` on
every number that changes in place; measure capped at 70ch.

**Motion.** Swap 0.18 s, swap-back 0.30 s, burst 0.36 s, gravity `0.16 + 0.05/cell` capped at 0.50 s,
shuffle 0.50 s, celebration 1.1 s; fast-forward ×0.55. Creations pop `easeOutBack` to 1.35, matches
to 1.22. The camera is a critically damped 1.6 Hz spring; shake is tiered and tiny (0 / 0.012 / 0.03
/ 0.05). **Reduced motion** (OS-seeded, overridable) zeroes shake, caps bursts at 3 particles, skips
the win celebration, stops dust drift and lamp flicker, and forces CSS transitions to 0.01 ms —
nothing that carries information is animation-only.

**Visual assets the design calls for:** a title backdrop reading as a lapidary's bench at dusk with
room for a logo, a results illustration that says "the order was filled" without words, a favicon
and cover art. All four ship (§15).

---

## 9. Audio direction

**Mix philosophy.** The workshop is quiet. Ambience is a barely-there pad (gain 0.05); the score
comes from the board, so match chimes and blast bursts are the loudest things in the mix. Cascades
are the one place the game gets loud, and the intensity bump decays back over ~3 s.

**Buses.** `master ← {music, effects, ambience, voice}`, gains from `settings.audio.*`, mute on
master; nothing sounds before `unlock()` on a user gesture. Music is two crossfaded layers (calm
pluck stem, intense layer) driven by cascade depth. Ambience is a per-theme pad chord (hearth G3,
night F3, garden A3, frost B♭3, velvet A♭3) with a generative major-pentatonic pluck sequence
scheduled 1.2 s ahead.

**Determinism and cost control.** Cosmetic pitch and variant choices draw from a seeded `Rng` keyed
`jc-audio-fx`, never `Math.random`, so a replay sounds identical. Always-running pooled oscillators
serve the frequent voices and the noise buffer is preallocated — no per-frame allocation. Fall and
spawn ticks are deliberately synth-only, quiet (gain 0.028) and rate-limited to 14/s with a 55 ms
floor, so a 12-step cascade never becomes a noise wall.

**Every clip has a synth fallback.** `_playFile` returns false until the Opus buffer decodes (or
forever, if it 404s) and the caller falls through to a synthesized voice: the game is fully audible
with an empty `sfx/`. **Captions** (`settings.access.captions`) render each cue as a text toast
(`[chime rising x3]`, `[big blast]`, `[ice crack]`, `[time warning]`) for 1600 ms.

### SFX event table

This table is the source for `sfx/manifest.txt`. `ui:<name>` is `audio.uiSound('<name>')`;
`rules:<type>` is a rules event routed by `handleRulesEvents`.

| File | Event id | Description | Usage context |
|---|---|---|---|
| `ui-click.opus` | `ui:click` | Bright glass button click | Primary button press |
| `ui-hover.opus` | `ui:hover` | Very short soft glass tick | Hover / focus move |
| `ui-confirm.opus` | `ui:confirm` | Warm two-note rising chime | Confirm, start a level |
| `ui-back.opus` | `ui:back` | Soft descending glass tone | Back navigation |
| `ui-error.opus` | `ui:error`, `rules:reject`, `rules:swap-back` | Dull muted double buzz | Illegal swap, no-match swap-back |
| `ui-success.opus` | `ui:success` | Ascending three-note gem chime | Achievement / star earned |
| `ui-modal-open.opus` | `ui:open` | Airy whoosh + chime | Overlay opens |
| `ui-modal-close.opus` | `ui:close` | Descending airy whoosh | Overlay closes |
| `ui-toggle.opus` | `ui:toggle` | Switch click + ping | Settings toggle |
| `ui-tab-switch.opus` | `ui:tab` | Glass pane snap | Leaderboard / drawer tabs |
| `ui-scroll-tick.opus` | `ui:scroll` | Tiny crystal bead tick | Per-step list movement |
| `ui-toast.opus` | `ui:toast` | Bell ding + wooden knock | Toast notification |
| `ui-pause.opus` | `ui:pause` | Damped suspended tone | Pause |
| `ui-resume.opus` | `ui:resume` | Rising two-note chime | Resume |
| `ui-countdown-tick.opus` | `ui:tick` | Clock tick + glass ping | 3-2-1 countdown |
| `ui-timer-warning.opus` | `ui:warn` | Tense low pulse | Once per second under 10 s left |
| `ui-settings-saved.opus` | `ui:saved` | Double blip settling warm | Settings committed |
| `gem-select.opus` | `ui:select` | Glassy pick-up tick | Jewel selected (board or mirror) |
| `gem-swap.opus` | `rules:swap` | Two gems sliding and clicking | Accepted swap |
| `match-chime.opus` | `rules:match` (cascade 1) | Three gems chiming together | First match of a chain |
| `combo-tier-2.opus` | `rules:match` (cascade 2) | Brighter stacked chime | Second cascade step |
| `combo-tier-3.opus` | `rules:match` (cascade 3+) | Widest shimmering chime | Third and deeper steps |
| `cascade.opus` | `rules:match` (batch) | Tumbling gem chimes | Once per batch reaching cascade 2 |
| `special-forge.opus` | `rules:create` | Rising crystalline forge shimmer | A ray, bloom or prism is forged |
| `ray-fire.opus` | `rules:blast` (ray) | Beam whoosh with a glass zing | Ray clears a row or column |
| `bloom-burst.opus` | `rules:blast` (bloom) | Round bloom + debris tail | Bloom clears a 3×3 |
| `prism-burst.opus` | `rules:blast` (prism), `rules:prism-swap` | Prismatic shatter | Prism fires or converts a colour |
| `ice-crack.opus` | `rules:crack` | Thin ice fracture | An ice layer breaks |
| `crate-break.opus` | `rules:crate-break` | Wooden crate splitting | A crate is destroyed |
| `board-shuffle.opus` | `rules:shuffle` | Swirling wash of gems | Deadlock reshuffle (free) |
| `goal-complete.opus` | `rules:goal` (done) | Warm bell, long tail | A goal reaches zero |
| `level-complete.opus` | `ui:win`, `rules:end` (goals-complete) | Triumphant jewel fanfare | Round won |
| `level-fail.opus` | `ui:lose`, `rules:end` (other) | Soft descending figure | Round lost or timed out |
| `star-reveal.opus` | `ui:star` | Bright twinkle | Each star on the results screen |
| `new-record.opus` | `ui:record` | Rising fanfare + bell | New personal best |
| `hint-reveal.opus` | `ui:hint` | Airy upward sparkle | Hint highlights a swap |
| `undo.opus` | `ui:undo` | Reversed glass swish | Undo rewinds a swap |

Synth-only by design (no clip, deliberately): jewel fall and spawn ticks (`rules:fall`,
`rules:spawn`) and the crate *damage* thud that does not break (`rules:damage`).

---

## 10. Localization

The product requires en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT.

**Today the game ships English only.** `<html lang="en" dir="ltr">` is fixed; there is no string
table, no locale detection and no `navigator.language` use. User-facing strings live hard-coded in
two places: `index.html` (static screen copy) and `js/ui/ui.js` (`INVALID_TEXT` :28,
`REASON_HEADLINES` :43, `ACTION_LABELS` :75, `COMPONENT_LABELS` :93, `COSMETIC_NAMES` :2019,
the help cards :1899, and the goal-text builders :128), plus content, theme and achievement names
in `js/engine/*.js`. Numbers are formatted through `fmtInt`, which is pinned to `'en-US'`.

The layout is already prepared for the work: CSS uses logical properties throughout, there are
`html[dir="rtl"]` rules for the drawer tabs, and no text is baked into any image — FLUX was never
asked for words, precisely so key art survives translation. Expansion allowance: German and
French run ~35% longer than English, so every button, badge and HUD label wraps rather than
truncating, and the mode cards are already sized for two-line titles. See §17.

---

## 11. Accessibility

- **Keyboard-only path, end to end.** Arrows move a cursor on the 3D board; Enter/Space select and
  commit. Confirm keys are explicitly *not* stolen when focus sits on a `button`, `a[href]` or
  `[role=button]`, so the HUD, the mirror board and every dialog stay operable — `tests/e2e.mjs`
  has a dedicated regression step for exactly this.
- **The text mirror board** (`#mirror-panel`) is a real alternative renderer: every playable cell is
  a `<button>` labelled `row N column M: <colour> <special>, frozen…, selected`, glyphs `R A T E S M O`
  and `↔ ↕ ✳ ◆`, with a live summary of score, moves left and legal-swap count. Holes are
  `aria-hidden`. It is forced open and becomes the playfield when WebGL is unavailable.
- **Focus.** 3 px `--focus` outline at 2 px offset; `focusFirst` prefers `[data-autofocus]`, then the
  primary button, then the heading; overlays restore focus to their opener; Tab is trapped in the
  top overlay.
- **Announcements.** Two live regions — polite `#sr-live` (throttled to 900 ms) and assertive
  `#sr-alert`. Announced: score, moves and goal changes; invalid-move reasons; hint coordinates;
  countdown seconds under 10.5 s; lesson steps; the results summary.
- **Captions** for audio cues, as toasts.
- **Contrast.** Default ink `#f4ecdf` on `#241a3a` clears 4.5:1; a high-contrast mode raises it
  further and thickens borders; four colour-vision jewel palettes, and colour is never the only
  channel (silhouette, glyph and label all carry it).
- **Reduced motion**, seeded from `prefers-reduced-motion`, with the degradations listed in §8.
- **Targets.** `--tap: 44px` minimum on every button, chip, card, picker item, drawer tab, summary,
  select and range; `--gap: 8px` minimum separation. `.btn-small` is 36 px.
- Also: three text sizes, a left-handed layout mirror, timing assistance (×1.5 on timed rounds,
  never on the rules), and a haptics toggle.

---

## 12. StarHermit integration

Conventions per <https://wiki.starhermit.com/>. `starhermit.txt` declares `name`, `launch`,
`owner`, `server=server.js`, `cover=coverart.png`. The client adapter is `js/platform.js`
(`API_BASE = '/api/v1'`); the authoritative script is `server.js`.

**Used.**

| Feature | Route | Behaviour |
|---|---|---|
| Time sync | `GET /time` | Also the online probe; offset = `serverMs − (t0 + rtt/2)` |
| Identity | `GET /identity` | Hosted: launch token → `Authorization: Bearer`. Guest: the server mints `g-…` plus an HMAC-SHA256 proof; the client sends `X-Guest-Id` + `X-Guest-Proof`. Unproven ids fall back to a per-IP identity |
| Profile | `GET /profile` | Hosted only; supplies the leaderboard display name |
| Sessions / activity | `POST /activity` | Round start and end, with a coarse duration band |
| Presence | `POST /presence` | Every 30 s while playing (adapter floor 20 s) |
| Leaderboards | `POST /scores`, `GET /boards` | Ranked modes only. Global / friends / daily boards |
| Cloud save | `POST /save`, `GET /save` | Progress pushed every 60 s and on `pagehide`, with conflict detection |
| Telemetry | `POST /telemetry` | Consent-gated funnel batches |
| Friends | `GET /friends` | Read-only; the server currently returns an honest empty list |

**Score submission is verified, not trusted.** A submission carries a replay envelope
`{schema, contentId, contentVersion, seed, config, commands, finalHash, roundId}`. The server
rebuilds the *authoritative* config — dailies from `content.dailyContent(dayKey)`, challenges from
`content.CHALLENGES`, and score chase only if the client config matches the fixed shape exactly —
then re-runs the command log through the same rules engine and rejects on any rejected command,
hash mismatch, score mismatch, move-count mismatch, or a cadence faster than 120 ms per swap.
Practice, Learn and Journey are not ranked and cannot be submitted. Idempotency is scoped to
`(roundId, identity)`. Boards are capped at 5000 entries, trimmed to the top 2500, and public
entries never expose identity or tie-break keys. Rate limits are per identity *and* per route.

**Not used.** No platform achievements API (the five achievements are local only); no presence
read; no realtime, matchmaking or multiplayer of any kind — the game is single-player with
asynchronous comparison. `GET /api/v1/daily` is served but the client has no caller for it, and
`platform.now()` is computed but unread.

---

## 13. Technical architecture

**Layering.** `rules.js` is pure and import-safe in Node — no DOM, no timers, no randomness beyond
its seeded stream. `session.js` owns exactly one rules state, is the only mutation path (every
command carries a unique id) and publishes an event bus; listener exceptions are caught so a broken
subscriber cannot break the FSM. `scene.js`, `ui.js` and `audio.js` are pure subscribers. `main.js`
wires them and owns the 100 ms tick.

**Determinism and replay.** A round is `seed + config + ordered commands`. `rules.replayLog` returns
the full hash chain; the tests assert two independent replays produce identical hash arrays, and two
golden sessions are pinned to exact scores and final hashes (`451242fa`/1770, `b5633e71`/2330). The
clock advances in whole 100 ms quanta and `elapsedMs` is excluded from the hash, so timing can never
desync a replay.

**Persistence.** Four `localStorage` documents under `jewelcascade.` — `settings`, `progress`,
`snapshot`, `boards` — each wrapped `{v, sum: fnv1a(stableStringify(data)), data}` with a migration
registry; a corrupt checksum, missing migration or >16 hops falls back to defaults instead of
throwing, and an in-memory `Map` store takes over when `localStorage` is unavailable (exposing
`key()`/`length` so "erase everything" still works). Server state under `data/` (never served) holds
the HMAC secret, boards, excluded days, per-identity saves and a telemetry log, all written
atomically via tmp-file + rename behind a per-file lock chain. A resume snapshot (content + state +
command log + roundId) is written after every accepted swap and offered on boot only if it
probe-deserializes to a `ready` state.

**Performance budgets.** Quality tiers set DPR caps 1.0/1.5/2.0, particle caps 512/1024/2048, dust
0/90/170, shadow maps 0/512/1024. On `auto` a governor samples fps each second, dropping
`renderScale` 0.15 (floor 0.55) after 2 s under 45 fps and restoring after 10 s over 58 fps.
Particles are one `THREE.Points` draw call over fixed Float32Arrays; board cells are one instanced
mesh; blast beams come from a pool of 8. Resize coalesces to one rAF; orientation change re-fits
after 250 ms.

**How the e2e test drives the real UI.** It serves the folder statically from an ephemeral port —
deliberately *not* `server.js`, so `/api/v1/*` 404s and the offline path is exercised — launches
headless Chrome via `playwright-core` and clicks the actual visible controls. `window.__jc` is used
read-only, to read `legalActions(state)` and poll session status, never to mutate or bypass.

---

## 14. Testing and acceptance criteria

`npm test` → `node tests/run.mjs`: 15 suites, 61 cases, zero runtime dependencies. Coverage:
deterministic board generation across 25 seeds (no initial match, ≥1 legal action); all eight
rejection reasons; move accounting; every terminal state; each of the four specials created and
detonated; ice and crate behaviour and scoring; undo exactness and hint determinism; serialization,
migration and a rejected version-99 document; a 6-seed replay property test; a 40-content fuzz
sweep plus 10 hand-crafted malformed commands; two pinned golden sessions; `validateAllContent()`
returning empty (every lesson's guided swap accepted, every journey stage bot-winnable with `s3`
reachable); storage round-trip, checksum recovery and wipe; five session-level tests including a
full lesson round and a timed round expiring; and three server tests covering config
canonicalization, replay verification and submission validation.

`npm run test:e2e` → `tests/e2e.mjs`, run at **1280×800** and at **390×844 with touch**, failing on
any `pageerror` or console error (GPU/SwiftShader noise and `/api/v1/` 404s excepted). Ten steps:
boot → title → mode select → practice setup (Easy) → countdown to active → hint and undo (asserting
`movesLeft` actually increased) → a keyboard-only swap on the text board → pause → settings →
resume → up to 45 swaps to the end of the round (failing if a `ready` board ever has zero legal
actions) → results → back to mode select. Screenshots at each stage.

### QA bar, as checkable statements

1. Every implemented feature is reachable with a mouse, a keyboard, a touch screen or a gamepad —
   including play itself, twice over (3D board and text board).
2. Zero console errors or warnings during a full playthrough at both viewports.
3. No text or control is clipped or overlapped at 1280×800, 390×844 portrait, or a 560 px-tall
   landscape; nothing sits under a notch, browser chrome or the thumb tray.
4. A new player is taught: Learn covers all six mechanics with enforced guided swaps, and Journey
   introduces one mechanic at a time.
5. Every score is explainable: the results table lists all six components and they sum to the total.
6. Corrupt or absent `localStorage` never prevents boot or play.
7. The board is never dead: a resolved position with no legal swap always reshuffles for free.
8. Every ranked score on a board has been re-simulated server-side from its command log.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-keyart.webp` | Title-screen backdrop, 1536×864, composed with empty sky for the logo | FLUX.2 klein, seed 70211, 30 steps | generated this pass; wired via `.screen[data-screen="title"]` |
| `assets/results-plate.webp` | Results-overlay banner, 768×432, brass tray of gems with three stars | FLUX.2 klein, seed 41903, 30 steps | generated this pass; wired via `.res-plate` |
| `assets/favicon.svg`, `favicon.svg`, `icon.png` | Site and platform icons | authored | shipped |
| `coverart.png` | Platform cover art (`cover` in `starhermit.txt`) | authored | shipped |
| `sfx/special-forge.opus` | `rules:create` — special forged | MOSS-SoundEffect v2.0, 100 steps | generated this pass; wired in `audio._soundCreate` |
| `sfx/*.opus` (36 others) | See the table in §9 | MOSS-SoundEffect v2.0 | shipped |
| `sfx/manifest.txt` | Canonical `file \| event id \| description \| context` map | authored | rewritten this pass; 37 lines, one per clip |
| `sfx/manifest.json` | Generator input (name, seconds, prompt, event) | authored | rewritten this pass, in sync with `manifest.txt` |
| `sfx/manifest.md` | Historical human-readable list | authored | superseded by `manifest.txt`, retained |
| Jewel geometry, board, environment | Seven procedural gem silhouettes, table, lamps, stars, dust | procedural in `scene.js` | shipped |
| Music and ambience | Five per-theme pads + generative pentatonic pluck stem | procedural WebAudio | shipped |
| 3D model assets | — | — | none: every prop is procedural and a baked GLB would replace a cheaper, theme-recolourable primitive |
| Character animation | — | — | none: the game has no humanoid |

---

## 16. Known limitations

- **No localization.** English only; see §10 and §17. This is the largest gap against the product
  requirements.
- **Creation cells earn no jewel credit.** A 4-run of a goal colour credits 3 towards a collect
  goal, and a 5-run credits 4, because the cell that becomes the special is never removed. This is
  consistent and deliberate but is not explained anywhere in the UI.
- **Prism-swap removal deals no crate splash.** The initial removal pass of a prism swap runs with
  `cause:'effect'`, and splash damage is gated on `cause === 'match'` (`rules.js:697`); only direct
  blast hits damage crates on that path.
- **Journey stage 26** declares an ice goal of 12 but the layout only places 10; the goal is
  silently clamped to the placed count (`content.js:626`). Stages 32 and 38 place more blockers
  than their goals ask for, which is harmless but untidy.
- **`refreshScoreGoal` can emit a duplicate `goal` event** for a score goal within a single batch
  (`rules.js:613`). Cosmetic: the sound and announcement may fire twice.
- **`wipeAll()` also clears the guest id and proof**, so "reset all data" orphans that guest's
  server-side cloud save rather than deleting it.
- **The credential backstop is a substring test** over the whole serialized save document
  (`server.js:400`), so a legitimate field or value containing `token`/`password`/`secret`/
  `authorization` would fail the cloud save with HTTP 400. No shipped content string trips it.
- **`204 No Content` responses still carry `Content-Type: application/json`.** Harmless; Node
  suppresses the body.
- **HUD key hints show `Esc` for pause** while the dedicated binding is `P`; Escape does pause when
  no overlay is open, so both work, but the hint is imprecise.
- **`GET /api/v1/daily` has no client caller**, and `platform.now()` / `timeOffsetMs` are computed
  but never read.
- **Audio cannot be verified headlessly** — Chrome blocks the AudioContext before a user gesture —
  so the `sfx/` bindings are covered by code review and the manifest, not by an automated test.

---

## 17. Design intent not yet implemented

1. **Nine locales.** The design calls for en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR
   and it-IT. The intended shape: a `js/i18n.js` string table keyed by the ids already implicit in
   `INVALID_TEXT` / `REASON_HEADLINES` / `ACTION_LABELS` / `COMPONENT_LABELS` / `COSMETIC_NAMES`,
   locale chosen from an explicit setting falling back to `navigator.languages`, `<html lang>` set
   at boot, and `fmtInt` taking the active locale instead of the pinned `'en-US'`. No image or
   audio asset contains text, so nothing else needs re-authoring.
2. **Leaderboard reads on the Boards screen.** `platform.fetchBoards()` and `fetchFriends()` exist
   and the server serves `GET /boards` and `GET /friends`, but the tab panel is populated from the
   local `jewelcascade.boards` cache; wiring the live fetch is intended.
3. **`tutorial_step` and `settings_change` funnel events** are whitelisted in `analytics.js` and
   are intended to be emitted from the UI layer; today only `start`, `retry`, `round_end` and
   `error` fire.
4. **A distinct `time-expired` cue.** Timed rounds currently end on `level-fail.opus`; the design
   wants the clock running out to sound different from running out of moves.
