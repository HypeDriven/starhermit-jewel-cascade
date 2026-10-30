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
| Platforms | The StarHermit client (native) and browsers (the engine's web runtime); desktop and phones, portrait and landscape |
| Engine | StarHermit engine script game, pinned to engine **1.28.0** (host API 1.30, `engine.minor=30`) |
| Rendering | `starhermit:scene` tabletop scene, `starhermit:ui` menus and HUD, with a complete text board as an equal play path |
| Entry point | `native/main.ts` (`engine.entry`); browsers open the loader `index.html` (`launch`) |

### File map

| Path | Contents |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, cover, launch, the engine pin, capabilities (`platform,storage,clipboard`), the 14 `control.*` actions with their `engine.gamepad.*` defaults |
| `native/main.ts` | Entry: the session's state machine mapped onto screens, event presentation, the Learn runner, input (actions, pointer, touch), timers on fixed steps, results, replay, boards, lifecycle |
| `native/screens.ts` | Every screen, the HUD, rails / drawers / thumb tray, the text board, dialogs, toasts and captions (`starhermit:ui`) |
| `native/render.ts` | The workshop scene: environment, board, gems, specials, markers, particles, the event timeline, camera framing, picking (`starhermit:scene`) |
| `native/audio.ts` | Recorded one-shots, rendered music / pad loops, rendered tick and thud voices, captions, vibration (`starhermit:audio`) |
| `native/platform.ts` | Saves, the game's synced options, the documents' backend, the old cloud save and account settings migration, player, clock, leaderboards, score posting (`starhermit:platform`, `starhermit:storage`) |
| `native/quality.ts` | The browser build's graphics presets and budgets keyed by the runtime's quality tier and level |
| `native/i18n.ts` | `T()` over the translation tables in the runtime's interface language |
| `native/style.ts` | Registers `assets/ui-style.json`, the theme of the runtime's widgets, high-contrast and theme-accent tokens |
| `native/game.ts` | Typed facade over the shared JavaScript modules below |
| `js/engine/rules.js` | Pure rules engine: board, swaps, cascades, specials, scoring, replay |
| `js/engine/content.js` | Versioned content: lessons, journey, dailies, challenges, practice, chase, validators |
| `js/engine/themes.js` | 5 visual themes + 4 colour-vision jewel palettes |
| `js/engine/rng.js` | mulberry32 `Rng`, FNV-1a hashing, stable stringify |
| `js/engine/achievements.js` | 5 achievements, career counters, 10 mastery levels |
| `js/session.js` | Round FSM, event bus, 100 ms clock, results, progression |
| `js/storage.js` | Checksummed, versioned documents on a pluggable backend (`setBackend`) |
| `js/migrate.js` | Reading the browser build's cloud save and account settings (pure) |
| `js/strings.js`, `js/account-strings.js` | Translation tables (`globalThis.JC_STRINGS`) and the StarHermit account strings, nine locales |
| `assets/ui-style.json` | The style sheet, converted from `tools/ui-style.css` with `starhermit css` (`npm run css`) |
| `assets/*.webp` | Title key art and results plate |
| `sfx/*.opus` | 37 one-shots (`manifest.txt` canonical, `manifest.json` generator input; both left out of the package) |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (never edited by hand) |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished ranked round's score and posts it to the `high-score` leaderboard |
| `server.js` | Local dev server and replay verifier (left out of the package; only `tests/run.mjs` uses it) |
| `tests/` | `run.mjs` (rules, content, session, storage, server), `platform.test.mjs`, `i18n.test.mjs`, `native.mjs` + `native/*.play` |
| `tools/` | `css.mjs`, `package-web.mjs`, `gen-plays.mjs` (play scripts from the rules), `browser-play.mjs` (GPU Chrome play) |

---

## 2. Design pillars

**1. The board is the only source of truth, and it is legible without pixels.**
Every rule lives in `js/engine/rules.js`; every presentation layer is a subscriber to the event
stream it emits. That is why the text board (`native/screens.ts` mirrorGrid) is a first-class play path
and not an accessibility bolt-on — same state, same events, same `session.trySwap`.
*Rules in:* mechanics expressible as a rules event with a glyph.
*Rules out:* effects carrying information the text board cannot restate.

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

**First 60 seconds.** Title (key art, `Play`, daily/journey/profile chips) → mode select.
Learn is the first card; its six lessons teach one rule each — first swaps, rays, blooms, prisms,
ice, crates. A lesson pins a banner (announced as each step opens), highlights the exact
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
music-intensity bump proportional to cascade depth (`native/main.ts`, the rules handler).

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


---

## 6. Controls and interaction

Actions are the manifest's `control.*` lines; players rebind keys and pads in the runtime's
Options › Controls (Settings › Controls › *Change keys and buttons* opens it). The action names
are the browser build's, so bindings saved with the account carry over.

| Action | Key (default) | Gamepad | Touch / mouse |
|---|---|---|---|
| Move cursor | Arrow keys (wrap round the board, skip holes) | D-pad / left stick | — |
| Select / commit swap | Enter, Space (`confirm`, `confirm2`) | South (A) | Tap a jewel, then a neighbour |
| Directional swap | — | — | Drag ≥ 24 px, dominant axis wins (off with *Hold to drag jewels* unticked) |
| Cancel | Escape (deselects, then pauses; closes the text board / drawer; Back on menu pages) | East (B) | — |
| Pause | P | Start | Pause in the actions rail / thumb tray |
| Hint | H | West (X) | Hint button |
| Undo | U | North (Y) | Undo button (Practice only) |
| Skip settle | S | — | Skip button (shown only while resolving) |
| Camera cycle | C | Right shoulder | Camera button (default → low → high) |
| Mute game sounds | M | — | Settings › Audio |
| Help | ? (Slash) | — | Header nav |

A tap is same-cell, ≤ 12 px of movement, ≤ 600 ms. Pointer presses are queued and decided after
the frame's UI is built: a press inside the playfield and not on a widget is the board's; the
board raycasts the table plane with the camera shake taken out first. The board takes input only
in the `active`/`tutorial` states with no timeline running. Enter/Space on a focused widget belong
to the widget (the text board and every HUD button stay keyboard-operable). Learn installs
`session.inputFilter`, which refuses anything but the taught pair. Feedback: an accepted swap plays
`gem-swap` and the swap animation; a rejected one a red ring, `ui-error`, a 20 ms vibration and the
reason as a toast and an assertive announcement; selection a pulsing gold ring and `gem-select`;
hover (mouse) a ghost ring; the keyboard cursor a translucent blue square; a hint two pulsing green
rings for 2.6 s.

---

## 7. Screens and UI flow

All of it is `starhermit:ui`, built every frame (`native/screens.ts`). Screens: **title, mode select,
Journey map, setup, game, Settings, Help, Achievements, Boards, Profile**; dialogs: **pause, results,
resume offer, reset confirmation**. The header (brand → title; Boards, Achievements, Help, Settings)
shows on every screen but the game. The session FSM (`js/session.js`) stays the authority:

```
boot → title → { profile-ready | mode-select | preparing(resume) }
mode-select → preparing → { tutorial | countdown } → active
active ↔ paused,  active → resolving → { active | tutorial | results }
results → { preparing(retry) | mode-select | title }
```

- **Title**: the key art under a scrim (high contrast: the scrim alone), the logo (sized as
  `clamp(41.6, 8vw, 72)` px), the tagline, **Play**, the Daily / Journey / Profile chips (best today
  and the countdown to the next daily; stage and stars; name, mastery and the cloud status signed
  in), **Invite a friend** (signed in) and **Sign in with StarHermit** (guests).
- **Mode select**: six cards (two columns on phones), each with its Casual / Ranked badge.
- **Journey**: 40 stage buttons (current stage outlined in gold, mastery stages ◆, stars), locked
  ones disabled.
- **Setup**: the per-mode picker (lessons with ✓ done; today's Daily with its best; the four practice
  difficulties and an optional seed field; the eight challenges with stars; score chase's seed field
  with Random / Today's seed), then the chosen round's facts (rules, duration, players, assists,
  ranked) and goals; Back / Start.
- **Game**: the status bar (score, moves or ∞, time on timed rounds, the state line); the objective
  rail (round name, goals with colour swatches, assists line) and the actions rail (Hint, Undo, Skip,
  Camera, Text board, Pause with their keys); the lesson / replay banner; the **Ready… Set… Go!**
  countdown (620 ms a step); the text board.
- **Pause**: Resume, Settings, Help (both come back to the pause menu), Restart round, Leave to menu.
- **Results**: the plate art (hidden in high contrast and under 620 px tall), the headline, stars,
  score with the Ranked badge, the leaderboard line, the score breakdown table (six components that
  sum to the total), goals, achievements unlocked, mastery bar with XP and unlocks (and the daily
  streak), the personal-best line; Retry, Replay (the recorded command log played back at 1.5 s a
  move under a banner), Next stage / Next lesson / Play again, Mode select. It stays until a choice.
- **Resume offer**: at start, when the device holds an interrupted round's snapshot.

**Layouts** (the browser build's media queries, picked from the window's logical size):
**wide** (≥ 1024 px) — rails beside the board, the status bar centred above it; **compact** — the
rails are drawers opened by the *Objective* / *Actions* edge tabs; **portrait** adds the bottom
thumb tray (Hint, Undo, Board, Pause) with the tabs above it; **short landscape** (≤ 560 px tall) —
the status bar is a side column under the drawer tab. *Left-handed layout* mirrors the rails, tabs,
tray order and toasts. The board is framed into the playfield the HUD leaves (camera view offset,
1.19 margin, refined against the projected corners), so it never sits under a rail, the tray, the
banner or a notch (`frame().safeArea`).

---

## 8. Art direction

**Palette.** Ink `#f4ecdf` on a violet ground: bg `#241a3a`, bg-2 `#2d2148`, panel `#31254e`,
panel-2 `#3a2c5a`, line `#4a3a68`, dim `#cfc2b8`, muted `#a89bc0`; accent `#ffb36b` / `#ffd28a`
(following the theme), gold `#ffc857`, danger `#ff7b7b`, ok `#7bd88f`, focus `#ffe6b0`. The
runtime's high-contrast option swaps in the old `html.hc` tokens (ground `#100a20`, ink `#ffffff`)
and the high-contrast jewel palette.

Jewels are fixed per colour index: `#e5484d ruby`, `#f76b15 amber`, `#ffd60a topaz`, `#46a758 emerald`,
`#3e9bde sapphire`, `#9b5de5 amethyst`, `#f2e9e4 opal`, with deuter, protan, tritan and high-contrast
substitutions (`themes.js`), shared by the 3D board, the goal swatches and the text board.

**Themes.** Five workbench moods (sky gradient, fog, three lights, table, frame, cells, accent, dust,
ambience): *Ember Dusk* (default), *Moonlit Forge* (mastery 2), *Verdant Atelier* (4), *Frostbound
Loft* (6), *Royal Velvet* (8). Cosmetic frames (standard / brass / filigree) and spark trails (none /
sparks / comet embers) unlock with mastery.

**Shape language.** Silhouette carries colour identity — ruby octahedron, amber dodecahedron, topaz
tetrahedron, emerald elongated octahedron, sapphire icosahedron, amethyst hexagonal cone, opal
sphere — flat-shaded physical materials, roughness 0.28, emissive at 16 % of albedo, environment
reflections at 0.3 and (High/Ultra with detail) a clearcoat. Specials add an overlay: torus rings
for rays, a warm wireframe icosahedron for blooms, a cool slowly spinning one for prisms.

**Scene.** A walnut table with a brass rim, five seeded hanging lamps, 260 stars, drifting dust,
14 prop gems; ACES filmic tone mapping (exposure 1.05); a warm key directional light (shadow fitted
round the board), a cool fill, hemisphere and ambient terms (light intensities are three.js r161's (minor 23+),
the engine's convention; the ambient is trimmed with image-based lighting on); reflections from
`PMREMGenerator.fromScene(new RoomEnvironment(renderer))`; procedural canvas textures (walnut grain,
bevelled tiles, brushed brass) at the budget's size.

**Motion.** Swap 0.18 s, swap-back 0.30 s, burst 0.36 s, gravity `0.16 + 0.05/cell` capped at
0.50 s, shuffle 0.50 s; fast-forward ×0.55; creations pop `easeOutBack` to 1.35, matches to 1.22;
the camera is a critically damped 1.6 Hz spring with tiny tiered shake. Timelines run on the
runtime's fixed steps. Reduced motion (the runtime's option) zeroes shake, caps bursts at 3
particles, skips the win celebration and stops dust, lamp flicker, star shimmer and glints.

**Graphics levels.** The runtime's Options choose the level (Auto by default); its quality tier
picks the browser build's preset (`native/quality.ts`):

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows (key light) | off | 512 | 1024 | 2048 (held to the level's cap) |
| Ambient occlusion (`renderer.ao`) | off | off | on | high |
| Bloom 0.45 / 0.4 / threshold 0.92 | off | ½ res | ½ res | full res |
| Colour grade (display space: contrast 0.11, saturation 1.12, warm highlights / violet shadows, vignette 0.26) | off | on | on | on |
| Anti-aliasing | MSAA | FXAA | SMAA | MSAA |
| Reflections (IBL) | off | on | on | on |
| Particles / sparks cap / glints | low / 512 / 0 | medium / 1024 / 6 | high / 2048 / 14 | high / 3072 / 14 |
| Dust motes | 0 | 85 | 170 | 260 |
| Animated background | no | yes | yes | yes |
| Surface detail (props, wood, tiles, brass) / texture size | plain | 256 | 512 + clearcoat | 1024 + clearcoat |

Sparks and dust scale up to 2× within a tier with the level index. Render scale, the pixel-ratio
cap, adaptive resolution, the frame-rate limit and the FPS readout are the runtime's.

---

## 9. Audio direction

**Mix philosophy.** The workshop is quiet. Ambience is a barely-there pad; the score comes from
the board, so match chimes and blast bursts are the loudest things in the mix. Cascades are the one
place the game gets loud, and the intensity bump decays back over ~3 s.

**Buses.** The runtime's music, effects and interface buses (Options › Audio: volumes, mute, voice
limit); the old relative balance (music 0.65, ambience 0.55) is folded into the gains. Menu sounds
play on the interface bus. *Mute game sounds* (M) silences the game's own sounds on top. Music is a
per-theme pad chord (hearth G3, night F3, garden A3, frost B♭3, velvet A♭3: two detuned sines a fifth
apart through a lowpass, breathing at 0.09 Hz) under a 16-step seeded pentatonic pluck stem on a
0.5 s grid, with an intensity layer (an off-grid arp a fifth up) crossfaded in by cascade depth. The
pad and both pluck layers are rendered once per theme into seamless loops (a slice a frame) and
played looping; nothing sounds before the first press in a browser.

**Determinism and cost control.** Melodies are seeded per theme (`music-<ambience>`); clips load one
at a time once the mixer runs. Fall and spawn ticks and the crate *damage* thud are rendered short
clips (synth-only by design), quiet and rate-limited to 14/s with a 55 ms floor. **Captions** (Settings ›
*Captions for audio cues*) show each cue as a toast (`[chime rising x3]`, `[big blast]`, `[ice crack]`,
`[time warning]`) for 1.6 s. Rejects, chimes and blasts vibrate the device (the runtime's vibration
option applies).

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

---

## 10. Localization

en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT. Every player-facing string goes
through `T()` (`native/i18n.ts`) over `js/strings.js` (English source strings are the keys; en-GB,
es-ES and fr-CA list only their differences) and `js/account-strings.js`; content names and
descriptions, achievement and cosmetic names, captions and the text board's cell descriptions
included. "Jewel Cascade" and "StarHermit" stay as they are. The language is the runtime's
interface language (Options › Language: the player's choice, else the account's preferred language,
else the device's); a change shows on the next frame without touching the round. Numbers use the
locale's grouping. `tests/i18n.test.mjs` fails on any untranslated, unused or placeholder-drifting row.

---

## 11. Accessibility

- **Keyboard-only and pad-only play, end to end**: the board cursor, every widget focusable, dialogs
  take Escape / East.
- **The text board** is a real alternative renderer: every playable cell is a button labelled
  `row N column M: <colour> <special>, frozen…, selected`, glyphs `R A T E S M O` and `↔ ↕ ✳ ◆`, crates
  `▣`, with a live line of score, moves left and legal-swap count, the lesson's step, and the same
  selection rules as the board.
- **Announcements** (`ui.announce`, polite throttled to 900 ms, assertive): score, moves and goal
  changes; invalid-move reasons; hints; countdown seconds under 10.5 s; the cursor's cell; lesson
  steps; the results summary.
- **Runtime options**: text size, high contrast (tokens and the high-contrast jewel palette), reduced
  motion, vibration, interface scale. **Game options**: colour palette (deuter / protan / tritan /
  contrast), left-handed layout, timing assistance (×1.5 on timed rounds, never on the rules),
  captions, hold to drag.
- Targets are at least 44 px (36 px small buttons); colour is never the only channel.

---

## 12. StarHermit integration

Through the engine's host API (`starhermit:platform`, `starhermit:storage`); signed out (a guest)
the game makes no platform calls beyond public leaderboard reads.

| Feature | How | Behaviour |
|---|---|---|
| Progress | `saves` (schema 1): the progress document | Device at once, the account debounced by the runtime; another device's save is merged in (`storage.mergeProgress`: the best of each; streaks from the newer side) and a toast confirms; a conflict resolves with the same merge |
| Old cloud save | `saves.foreign()` + `replaceForeign` | The browser build's slot (the JS SDK's ZIP with the progress JSON) is parsed (`js/migrate.js`), merged and replaced once |
| Game options | `settings` key `prefs` (synced) | Palette, left-handed, timing assist, captions, hold to drag, camera preset, cosmetics, mute, guest name |
| Old account settings | `settings.legacyKeys()` / `legacy` / `removeLegacy` | The old settings object's top-level keys, `ui.language` and `audio.options`: the game options carry over (unless this device has options), then all are removed |
| Device data | `storage` KV | The resume snapshot and the local boards (`jewelcascade.snapshot`, `jewelcascade.boards`) |
| Player | `player()`, `avatar()` | Nickname on the Profile chip and screen, the avatar on Profile; guests use the local display name |
| Invite | `inviteLink()` + `clipboard` | *Invite a friend* on the title (signed in) |
| Sign-in | `requestSignIn()` | *Sign in with StarHermit* on the title (guests) |
| Clock | `serverTime()` / `serverNow()` | The Daily's UTC date and countdown follow the platform's clock (the device's offline) |
| Leaderboards | `leaderboards.list/entries` | Boards › Global (top 25 of `high-score`, guests too), Friends (signed in, `friendsOnly`); Daily and unavailable boards show this device's bests |
| Score posting | `sessions.practice()` + `connectGame` → `score-script.js` | Every finished ranked round (Daily, Challenge, Score chase) signed in: the results read "Posting score…", then "Leaderboard rank: #N" (or posted / not posted) |

Results and leaderboards come only from `score-script.js` (range-checked integer, 0–1,000,000,
higher is better): the client never reports a result to the platform itself. Replay verification
lives in `server.js` (the dev server), not on the platform board. No platform achievements, rooms,
voice or multiplayer.

---

## 13. Technical architecture

**Layering.** `rules.js` is pure; `session.js` owns one rules state and is the only mutation path;
`native/main.ts` subscribes to its events (`fsm`, `round`, `rules`, `hud`, `invalid`, `hint`, `undo`,
`timer`, `results`) and drives `render.ts` (the timeline), `audio.ts` and the screens, as the
browser build's `main.js` / `ui.js` did.

**Time.** `setFixedRate(60)`: each fixed step advances the session's 100 ms-quantum clock (active
and resolving only), the board's tweens (frozen while paused), the settle of a timeline
(`session.settled()` when its length has passed, or at once on Skip) and every former `setTimeout`
(countdown, hint clear, lesson end, replay steps). A hidden window (`onSuspend`) pauses the round and
saves its snapshot; nothing runs while hidden. Play scripts therefore replay exactly.

**Persistence.** `js/storage.js` keeps its `{v, sum, data}` documents and migrations; native/platform.ts
installs the backend (progress ↔ the engine save, settings ↔ the synced `prefs` setting, the rest ↔
device KV). A resume snapshot (content + state + command log + roundId) is written after every
accepted swap and offered at start when it deserializes to a `ready` state.

**Performance.** Cells are one instanced mesh, particles one `Points` draw over fixed arrays (only
live ones updated), beams a pool of 8, jewel views pooled; procedural textures are made once per
budget size; the music renders a slice a frame. Blended stars draw first (`renderOrder -10`) so
the table covers them.

---

## 14. Testing and acceptance criteria

`npm test` → `test:unit` (`node tests/run.mjs` — 61 rules / property / fuzz / golden / content /
session / storage / server cases — and `node --test tests/platform.test.mjs tests/i18n.test.mjs`)
then `test:native` (`node tests/native.mjs`): the web index matches the files, `tsc` (TypeScript 5.9,
no `skipLibCheck`), `starhermit check .` with zero warnings, and every `tests/native/*.play` as a
signed-out `--render-check` driving the real UI:

- `journey-stage1.play` — Play › Journey › Stage 1 › Start, the round played to *Commission complete!*
  by keyboard swaps (the rules' own hint chooses), the exact score, Next stage;
- `learn-lessons.play` — all six lessons, each guided swap on the board cursor, Next lesson between;
- `practice-assists.play` — Practice › Easy with a typed seed: Hint, a swap, Undo, Camera, a swap on
  the text board, Pause › Settings › Back › Resume, Leave to menu;
- `challenge-timer.play` — Sprint: a swap, the 10-second warning, *Time expired*;
- `screens.play` — Boards (tabs), Achievements, Help (the `?` key, Escape back), Settings with the
  reset confirmation cancelled, Profile, the Daily and Score chase setups, the Journey map.

The scripts are generated from the rules (`npm run plays`, `tools/gen-plays.mjs`). `npm run package`
rewrites the loader and the index after every change. `npm run test:browser`
(`tools/browser-play.mjs`) plays the web package in Chrome on the AMD GPU at 1280×800, 390×844 (DPR 3)
and 844×390 (DPR 3): start, mode select, Journey, setup, countdown, a swap by keys or taps, a hint,
the drawer, pause and resume, failing on console errors or warnings or the error screen.

### QA bar, as checkable statements

1. Every feature is reachable with a mouse, a keyboard, a touch screen or a gamepad — including play
   itself, twice over (3D board and text board).
2. Zero console errors or warnings in the browser check at all three views.
3. No text or control is clipped or overlapped at 1280×800, 390×844 portrait or 844×390 landscape.
4. A new player is taught: Learn covers all six mechanics with enforced guided swaps.
5. Every score is explainable: the results list the components and they sum to the total.
6. Corrupt or absent stored documents never prevent start or play.
7. The board is never dead: a resolved position with no legal swap reshuffles for free.

---

## 15. Asset inventory

| Path | Purpose | Source |
|---|---|---|
| `assets/title-keyart.webp` | Title backdrop (`.title-art`) | FLUX.2 klein, seed 70211 |
| `assets/results-plate.webp` | Results plate (`.res-plate`) | FLUX.2 klein, seed 41903 |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform cover and icon | authored |
| `sfx/*.opus` | The 37 one-shots of the table in §9 | MOSS-SoundEffect v2.0 |
| Gems, board, environment, textures | procedural (`native/render.ts`) | — |
| Music and ambience | rendered loops (`native/audio.ts`) | — |

---

## 16. Known limitations

- **Creation cells earn no jewel credit** (a 4-run of a goal colour credits 3): consistent, not explained in the UI.
- **Prism-swap removal deals no crate splash** (`rules.js`: splash is gated on `cause === 'match'`).
- **Journey stage 26** declares an ice goal of 12 but places 10 (clamped); stages 32 and 38 place more blockers than their goals ask.
- **`refreshScoreGoal` can emit a duplicate `goal` event** for a score goal in one batch (sound and announcement may repeat).
- **Guests' old browser localStorage progress does not migrate** (the engine cannot read it); signed-in players' cloud saves do.
- **The resume offer appears only at start**, as in the browser build.
- **Not ported**: the per-category graphics overrides (the runtime's Options choose a level), the in-game key remapping list and the old mute-all/volume sliders (runtime Options), the consent-gated funnel telemetry (it never sent anything), the frosted backdrop-blur panels of High/Ultra, and the WebGL-unavailable fallback (the runtime renders everywhere).
- **Dust motes draw as small squares**, as the browser build's untextured points did.
- **Score posting and the Friends board are not live-tested here** (signed-out checks); their logic is the shared platform code other ports use.

---

## 17. Design intent not yet implemented

1. **A distinct `time-expired` cue.** Timed rounds end on `level-fail.opus`.
2. **Replay-verified platform boards.** The replay check lives only in `server.js`; the platform's
   `high-score` board range-checks the client's score through `score-script.js`.
