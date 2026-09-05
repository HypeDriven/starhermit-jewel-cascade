# Known Issues — Jewel Cascade

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.

**Follow-up 2026-08-26:** confirmed defects 1–5 fixed (notes inline below). `npm test` 61/61 pass,
`node --check` clean, and the identity/save/chase/boundary fixes re-verified against a live server
on port 39411. Suspected items 3 and 4 were also fixed; 1 and 2 were left as-is (see notes).

**Follow-up (current pass):** re-verified every item against the current source. All five confirmed
defects (1–5) are resolved in code; suspected items 3–4 are resolved; suspected items 1–2 remain
deliberately left as-is. `npm test` 61/61 pass, `node --check` clean on all modules, and the browser
e2e (`tests/e2e.mjs`, run via `npm run test:e2e`) now present and passing on desktop + mobile.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/run.mjs`) | 61/61 pass, 0 failures |
| `node --check` on all modules (`js/**/*.js`, `server.js`, `tests/run.mjs`) | clean |
| `npm run test:e2e` (`node tests/e2e.mjs`) | PASS — full UI playthrough on desktop (1280x800) and mobile (390x844), both reaches results + back to mode select |
| Headless-Chrome boot + interaction (served on :39404) | Boots to title and into the mode picker; **0** console errors, 0 failed requests |
| Corrupt-`localStorage` sweep (8 corruptions × 2 keys, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |
| API fuzzing (`/api/v1/*`, malformed bodies, malformed percent-escapes) | server stayed up |

## Resolved defects

All confirmed defects below were reproduced on 2026-08-20 against the running server on port 39404
(defect 4 against the real `js/storage.js` module) and then fixed and verified on 2026-08-26. They
are listed here for the record; none reproduces in the current source.

### 1. Cloud saves are keyed on an unauthenticated client header — any client can read or overwrite another player's save

**RESOLVED 2026-08-26.** Guest ids are now server-issued capabilities: `GET /api/v1/identity`
mints `g-<random>` plus an HMAC-SHA256 proof keyed by a persisted server secret
(`data/server-secret.json`), and `identityOf` only honors `X-Guest-Id` when the matching
`X-Guest-Proof` header verifies (`server.js:117`). The client fetches and stores the pair in
`Platform._ensureGuestProof` (`js/platform.js`). Spoofed ids now fall back to a per-IP identity.
Trade-off: pre-fix guest ids without a stored proof get a fresh identity on next boot, so their
old cloud save is orphaned (local progress is untouched). Verified live: victim save unreadable
and unwritable without the proof.

- **File:** `server.js:110-121` (`identityOf`) with `server.js:498-503` (`GET /api/v1/identity`)
- **Fix:** `identityOf` requires `guestProofMatches(guest, req.headers['x-guest-proof'])`
  (`server.js:117`) using an HMAC over the persisted secret; the Bearer branch is unchanged.
- **Verified:** live server — victim save unreadable/unwritable without the proof; spoofed ids fall
  back to a per-IP identity.

### 2. Every player without `localStorage` shares one cloud save under the constant id `g-anonymous`

**RESOLVED 2026-08-26.** The `catch` fallback in `guestIdentity` (`js/platform.js:53`) now returns a
per-session random id held in a module-level variable (`js/platform.js:36`, 53-54) instead of the
constant `g-anonymous`. Verified: two header reads in a throwing-`localStorage` environment return
one stable random `g-…` id, never `g-anonymous`.

- **File:** `js/platform.js:44-56` (`guestIdentity`), consumed at `js/platform.js:140`/`js/platform.js:162`
- **Fix:** `catch { if (!ephemeralGuest) ephemeralGuest = { id: randomGuestId(), proof: null }; return ephemeralGuest; }`
- **Verified:** two reads return one stable random `g-…` id, never `g-anonymous`.

### 3. "Erase everything" silently does nothing when `localStorage` is unavailable

**RESOLVED 2026-08-26.** The `safeStorage()` in-memory fallback (`js/storage.js:96-106`) now exposes
`key(i)` and a `length` getter backed by the insertion-ordered `Map`, so `wipeAll`'s iteration
works. Verified by driving the real module with a throwing `localStorage`: `masteryXp` 4242
before wipe, 0 after.

- **File:** `js/storage.js:222-229` (`wipeAll`) with the fallback store built at `js/storage.js:93-106`
- **Fix:** fallback store exposes `key: (i) => [...mem.keys()][i] ?? null` and `get length() { return mem.size; }`.
- **Verified:** driving the real module with a throwing `localStorage` wipes `masteryXp` down to 0.

### 4. Score-chase ruleset check forgets the `play` mask, so a chase entry can be scored on a custom board

**RESOLVED 2026-08-26.** The chase branch of `canonicalConfigFor` (`server.js:162-203`) now rejects
configs carrying `play` (`server.js:177`) and returns a rebuilt canonical config assembled from
validated fields only (fixed shape, pinned `contentId`/`contentVersion`/`ranked`/`timeLimitMs`, empty
crates/ice/layout) — stray keys never reach `createGame`. Verified: honest chase configs still
resolve and replay to the identical state hash; a `play`-bearing config is rejected.

- **File:** `server.js:150-205` (`canonicalConfigFor`) with `js/engine/rules.js`
- **Fix:** `!cfg.play` added to the shape check (`server.js:177`) and the config is rebuilt from
  validated fields only instead of returning the client object.
- **Verified:** chase config with a `play` mask is rejected; honest configs still replay identically.

### 5. A client-supplied flag disables the server's speed plausibility check

**RESOLVED 2026-08-26.** `verifyReplay` (`server.js:255`) now reads the timing-assist exemption from
the authoritative `config.assists` instead of the untrusted `claimed.assists` envelope. Since no
ranked config permits `timingAssist`, the cadence check now always applies. Verified: a
submission with `assists.timingAssist: true` and `elapsedMs: 0` is rejected as implausibly fast.

- **File:** `server.js:239-259` (`verifyReplay`), called as `verifyReplay(config, body.replay, body)` at `server.js:336`
- **Fix:** `!(config.assists && config.assists.timingAssist)` reads the authoritative config, not the
  untrusted `claimed.assists` envelope (`server.js:255`).
- **Verified:** a submission with `timingAssist: true` and `elapsedMs: 0` is rejected as implausibly fast.

## Suspected — not confirmed

### 1. Credential backstop is a substring match over the whole save document

- **File:** `server.js:400` — `if (/token|password|secret|authorization/i.test(serialized))`
- **Concern:** the regex runs over `JSON.stringify(body.doc)`, so any legitimate field or value
  containing those substrings (a cosmetic named "Token", a display name containing "secret") makes the
  whole cloud save fail with `credentials may not be saved`. Observed while testing: a doc containing
  the key `secretProgress` was rejected with HTTP 400.
- **Why unconfirmed:** no shipped content string in `js/engine/content.js` was found to trip it, so it
  may never fire in practice.
- **Decision 2026-08-26:** left as-is. It is a deliberate backstop and the client's progress schema
  contains no matching keys; tightening the regex to quoted keys would still false-positive on
  string values, and a field allowlist would be a larger, riskier change. **Still open.**

### 2. `204 No Content` responses still carry `Content-Type: application/json`

- **File:** `server.js:561`/`server.js:567` — `return sendJson(res, 204, null);`
- **Concern:** live response to `POST /api/v1/presence` is
  `HTTP/1.1 204 No Content` + `Content-Type: application/json`. Node suppresses the body, so nothing
  breaks, but the header is meaningless.
- **Why unconfirmed:** cosmetic; no client behaviour changes.
- **Decision 2026-08-26:** left as-is (cosmetic only). **Still open** (non-defect).

### 3. `data/` — the server's runtime store — is not gitignored

**RESOLVED 2026-08-26.** Added `data/` to `.gitignore` (kept the existing `.local-data/` entry).
One-line, zero-risk fix for a real mismatch.

- **File:** `.gitignore` (`node_modules/`, `.local-data/`, `data/`, `*.log`, `.DS_Store`,
  `test-results/`, `.tmp-build/`) vs `server.js:43` (`const DATA_DIR = path.join(ROOT, 'data');`)
- **Fix:** `data/` added to `.gitignore`.
- **Verified:** `data/` no longer appears as an untracked directory.

### 4. Static-file boundary check is a string prefix, not a path boundary

**RESOLVED 2026-08-26.** `serveStatic` now requires `filePath === ROOT || filePath.startsWith(ROOT +
path.sep)` (`server.js:585`), so a sibling directory named `jewel-cascade…` no longer satisfies
the check. Latent-only here (no such sibling), but the fix is one line and safe.

- **File:** `server.js:581-594` — `if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep))`
  (previously `if (!filePath.startsWith(ROOT))`, with `ROOT = __dirname` lacking a trailing separator).
- **Fix:** proper path-boundary check at `server.js:585`.
- **Verified:** a sibling directory whose name begins with `jewel-cascade` no longer satisfies the
  prefix test (and `data/` is additionally blocked at `server.js:590-594`).

## Checked, no defects found

- **Rules engine** (`js/engine/rules.js`): 61 unit tests pass, covering the deterministic board
  generation, swap legality, cascades, specials, goals, serialization and replay.
- **Replay verification for daily and challenge boards** (`server.js:150-161`): unlike the chase path,
  these rebuild the authoritative config from `content.dailyContent(dayKey)` / `content.CHALLENGES`, so
  a tampered config cannot be substituted. `verifyReplay` additionally rejects logs containing rejected
  commands, hash mismatches, score mismatches and move-count mismatches.
- **Submission input validation** (`server.js:211`, `validateSubmission`): schema version, content
  version, integer score bounds, command-count cap, per-command id length, swap coordinate bounds,
  final-hash format, move count and elapsed time are all checked.
- **Rate limiting** (`server.js:124`, `rateLimit`): per identity *and* route, with an eviction pass once
  the bucket map exceeds 5000 entries — the most complete limiter of the eight games in this batch.
- **Atomic writes** (`server.js:67`, `writeJson`): per-file promise chain plus tmp-file + rename.
- **Malformed input robustness:** malformed JSON, `null`/array bodies, wrong-typed fields on every
  `/api/v1/*` route, and a malformed percent-escape in the URL path all left the process running —
  `serveStatic`'s `decodeURIComponent` is inside the request handler's `try`/`catch` (three sibling
  games in this batch crash on that input).
- **Corrupt / absent `localStorage`:** 16 reload cycles with `jewelcascade.progress-backup` and
  `jewelcascade.guest` set to `''`, `'{'`, `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`, `' garbage'`
  and `'{"version":-1,"data":null}'` all booted cleanly. `unwrap` (`js/storage.js:115`) checks the
  wrapper shape, the FNV-1a checksum and the migration chain with a 16-step guard.

## Not tested

- **A full played round in the browser.** The interactive pass reached the mode picker; the match-3
  board itself was not driven through a complete round, so cascade/special visuals and the results
  screen were only covered by the unit tests. *(Note: the later `tests/e2e.mjs` playthrough now drives
  a complete round on desktop and mobile.)*
- **Three.js render correctness** (`js/render/scene.js`, 2003 lines) and the UI layer (`js/ui/ui.js`,
  2111 lines) were not reviewed line by line — too large for the 16k-token endpoint even split, and
  they carry no unit tests.
- **Audio** (`js/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **Cloud-save conflict resolution** (`server.js:405-418`): the `_savedAt` lineage branch was not
  exercised beyond confirming a straight overwrite.
