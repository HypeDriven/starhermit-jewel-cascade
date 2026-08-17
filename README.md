# Jewel Cascade

A deterministic match-3 puzzle game set in a jewel workshop suspended in warm
twilight. Swap adjacent jewels to form lines of three or more, create rays,
blooms, and prisms, and complete limited-move goals across six modes.

## Run

Any static file server works:

```sh
node server.js          # full server: statics + API (leaderboards, saves, time)
# or
python3 -m http.server  # statics only; all solo modes still work
```

Then open `http://localhost:8000/` (or the port you chose). No build step, no
install — plain ES modules + vendored Three.js (`vendor/three.module.js`).

## Test

```sh
node tests/run.mjs      # rules unit/property/fuzz/golden tests + content validation
```

## Layout

- `js/engine/` — pure deterministic rules (`rules.js`, `rng.js`), content,
  themes, achievements. No DOM; runs in browser, Node tests, and `server.js`.
- `js/render/` — Three.js scene: procedural gems, board, environment, VFX,
  camera, quality tiers.
- `js/ui/` — semantic HTML screens, HUD, accessibility mirror board, input.
- `js/session.js` — game state machine; the only mutation path into rules.
- `js/storage.js` — versioned, checksummed local persistence.
- `js/platform.js` — StarHermit host adapter (time sync, scores, cloud saves);
  degrades gracefully offline.
- `server.js` — authoritative script (replay-validated leaderboards, saves,
  daily seed, telemetry); also the dev server.
- `starhermit.txt` — distribution manifest (`name`, `launch`, `server`).

## Modes

Learn (6 interactive lessons), Journey (40 authored stages), Daily (one shared
UTC seed), Practice (difficulty + shareable seeds + undo), Challenge (8
constrained boards), Score chase (ranked seeded runs).

## Controls

Pointer/touch: tap-tap or drag to swap. Keyboard: arrows + Enter/Space, Esc
pause, H hint, U undo, S skip, C camera, M mute, ? help. Gamepad supported.
Full DOM mirror board for screen readers and no-WebGL play.
