# Jewel Cascade

A deterministic match-3 puzzle game set in a jewel workshop suspended in warm
twilight. Swap adjacent jewels to form lines of three or more, create rays,
blooms, and prisms, and complete limited-move goals across six modes.

A StarHermit engine script game (engine 1.27.0): one package played natively
by the StarHermit client and in browsers by the engine's web runtime.

## Run

```sh
starhermit .                 # the StarHermit runtime, in a window
npm run package              # rewrite the web loader (index.html) + starhermit-files.json after any change
```

Browsers open `index.html` from any static host (it loads the pinned engine
from wiki.starhermit.com). `node server.js` is the old dev server and replay
verifier, used only by `tests/run.mjs`.

## Test

```sh
npm test                     # rules/content/session/storage/server, platform, i18n, then the engine checks + play scripts
npm run plays                # regenerate tests/native/*.play from the rules
npm run test:browser         # play the web package in GPU Chrome (desktop, phone, landscape)
npm run css                  # tools/ui-style.css → assets/ui-style.json
```

Set `STARHERMIT` to the runtime and `TSC` to TypeScript 5 if they are not
under `~/sh/runtime`.

## Layout

- `native/` — the engine client: `main.ts` (flow, input, timers), `screens.ts`
  (starhermit:ui), `render.ts` (starhermit:scene), `audio.ts`, `platform.ts`
  (saves, settings, leaderboards), `quality.ts`, `i18n.ts`, `style.ts`, `game.ts`.
- `js/engine/` — pure deterministic rules, content, themes, achievements, RNG.
- `js/session.js`, `js/storage.js`, `js/migrate.js` — round state machine,
  checksummed documents, the browser build's save/settings migration.
- `js/strings.js`, `js/account-strings.js` — nine-locale translation tables.
- `score-script.js` — platform script posting ranked scores (`server=`).
- `spec.md` — the running specification.

## Modes

Learn (6 interactive lessons), Journey (40 authored stages), Daily (one shared
UTC seed), Practice (difficulty + shareable seeds + undo), Challenge (8
constrained boards), Score chase (ranked seeded runs).

## Controls

Pointer/touch: tap-tap or drag to swap. Keyboard: arrows + Enter/Space, Esc
cancel/pause, P pause, H hint, U undo, S skip, C camera, M mute, ? help.
Gamepad: D-pad/stick, A select, B cancel, X hint, Y undo, RB camera, Start pause.
Rebind in the StarHermit Options. A full text board is an equal play path.
