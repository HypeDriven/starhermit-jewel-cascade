# Known Issues — Jewel Cascade

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.

**Follow-up 2026-08-26:** confirmed defects 1–5 fixed (notes inline below). `npm test` 61/61 pass,
`node --check` clean, and the identity/save/chase/boundary fixes re-verified against a live server
on port 39411. Suspected items 3 and 4 were also fixed; 1 and 2 were left as-is (see notes).

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/run.mjs`) | 61/61 pass, 0 failures |
| `node --check` on all modules (`js/**/*.js`, `server.js`, `tests/run.mjs`) | clean |
| `tests/e2e.mjs` | not present |
| Headless-Chrome boot + interaction (served on :39404) | Boots to title and into the mode picker; **0** console errors, 0 failed requests |
| Corrupt-`localStorage` sweep (8 corruptions × 2 keys, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |
| API fuzzing (`/api/v1/*`, malformed bodies, malformed percent-escapes) | server stayed up |

## Confirmed defects

Defects 1-3 were reproduced against the running server on port 39404; defect 4 against the real
`js/storage.js` module.

### 1. Cloud saves are keyed on an unauthenticated client header — any client can read or overwrite another player's save

> **Fixed 2026-08-26.** Guest ids are now server-issued capabilities: `GET /api/v1/identity`
> mints `g-<random>` plus an HMAC-SHA256 proof keyed by a persisted server secret
> (`data/server-secret.json`), and `identityOf` only honors `X-Guest-Id` when the matching
> `X-Guest-Proof` header verifies (`server.js:117`). The client fetches and stores the pair in
> `Platform._ensureGuestProof` (`js/platform.js`). Spoofed ids now fall back to a per-IP identity.
> Trade-off: pre-fix guest ids without a stored proof get a fresh identity on next boot, so their
> old cloud save is orphaned (local progress is untouched). Verified live: victim save unreadable
> and unwritable without the proof.

- **File:** `server.js:83` (`identityOf`) with `server.js:468-485` (`GET`/`POST /api/v1/save`)
- **Trigger:** send `X-Guest-Id: <someone else's id>` on `/api/v1/save`.
- **Behaviour:**

  ```js
  const guest = req.headers['x-guest-id'];
  if (typeof guest === 'string' && /^g-[a-z0-9-]{4,40}$/.test(guest)) return guest;
  ```

  The header is accepted verbatim as the identity, and `handleSaveLoad(identity)` /
  `handleSaveStore(body, identity)` use it as the sole authorization key for the per-player save file
  (`saveFileFor(identity)`). Nothing binds the id to the connection, no token is required, and no
  ownership check exists.
- **Expected:** `spec.md` §5 — "Validate all network input for **identity**, session membership …" and
  "Treat client clocks, scores, inventories, roles … as untrusted". The `Authorization: Bearer` branch
  right above hashes a real token; the guest branch has no equivalent.
- **Evidence:** live server —

  ```
  victim stores:      POST /api/v1/save  X-Guest-Id: g-victim-abc123  {"masteryXp":9999,"journeyUnlocked":40}  -> 200 {"ok":true}
  another client GET: GET  /api/v1/save  X-Guest-Id: g-victim-abc123  -> 200 {"doc":{"masteryXp":9999,"journeyUnlocked":40,...}}
  another client PUT: POST /api/v1/save  X-Guest-Id: g-victim-abc123  {"masteryXp":0,"journeyUnlocked":1}      -> 200 {"ok":true}
  victim re-reads:    GET  /api/v1/save                               -> 200 {"doc":{"masteryXp":0,"journeyUnlocked":1,...}}
  ```

### 2. Every player without `localStorage` shares one cloud save under the constant id `g-anonymous`

> **Fixed 2026-08-26.** The `catch` fallback in `guestIdentity` (`js/platform.js:44`) now returns a
> per-session random id held in a module-level variable instead of the constant `g-anonymous`.
> Verified: two header reads in a throwing-`localStorage` environment return one stable random
> `g-…` id, never `g-anonymous`.

- **File:** `js/platform.js:28-42` (`guestId`), consumed at `js/platform.js:140`
- **Trigger:** play in private browsing, from `file://`, or with site data blocked — anything that makes
  `window.localStorage` throw.
- **Behaviour:**

  ```js
  } catch {
    return 'g-anonymous';
  }
  ```

  The fallback is a fixed string, not a per-session random id, and it satisfies the server's
  `/^g-[a-z0-9-]{4,40}$/` filter. All such players therefore collide on a single server-side save file
  and silently overwrite each other. This is defect 1 reached without any attacker at all.
- **Expected:** an ephemeral random id per session (or refusing cloud save when no stable identity
  exists). The function's own doc-comment promises a "Random opaque id".
- **Evidence:** live server —

  ```
  player A: POST /api/v1/save  X-Guest-Id: g-anonymous  {"masteryXp":5000,"player":"A"} -> 200 {"ok":true}
  player B: POST /api/v1/save  X-Guest-Id: g-anonymous  {"masteryXp":1,"player":"B"}    -> 200 {"ok":true}
  player A: GET  /api/v1/save  X-Guest-Id: g-anonymous  -> {"doc":{"masteryXp":1,"player":"B",...}}
  ```

### 3. "Erase everything" silently does nothing when `localStorage` is unavailable

> **Fixed 2026-08-26.** The `safeStorage()` in-memory fallback (`js/storage.js:96`) now exposes
> `key(i)` and a `length` getter backed by the insertion-ordered `Map`, so `wipeAll`'s iteration
> works. Verified by driving the real module with a throwing `localStorage`: `masteryXp` 4242
> before wipe, 0 after.

- **File:** `js/storage.js:217` (`wipeAll`) with the fallback store built at `js/storage.js:93-101`
- **Trigger:** Settings → "Erase everything" in private browsing / with site data blocked.
- **Behaviour:** `safeStorage()`'s in-memory fallback exposes only `getItem`, `setItem` and
  `removeItem` — it has **no `length` and no `key()`**. `wipeAll` iterates with

  ```js
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  ```

  `store.length` is `undefined`, so the loop body never runs, nothing throws, and `js/ui/ui.js:1757`
  then calls `location.reload()`. The player is told their data is gone and it is all still there.
- **Expected:** the destructive confirmation dialog says "This erases every local setting, progress
  record, and snapshot for Jewel Cascade on this device. This cannot be undone."
- **Evidence:** driving the real module with a `localStorage` that throws on `setItem` (the exact
  condition `safeStorage` catches) —

  ```
  saveProgress -> true
  loadProgress before wipe: masteryXp = 4242  journeyUnlocked = 17
  wipeAll threw: null
  loadProgress AFTER  wipe: masteryXp = 4242  journeyUnlocked = 17
  fallback store exposes length? undefined
  ```

  The unit tests miss this because `tests/run.mjs:68-79` installs a mock `localStorage` that *does*
  define `key` and `length`, so the fallback path is never taken.

### 4. Score-chase ruleset check forgets the `play` mask, so a chase entry can be scored on a custom board

> **Fixed 2026-08-26.** The chase branch of `canonicalConfigFor` (`server.js:162`) now rejects
> configs carrying `play` and returns a rebuilt canonical config assembled from validated fields
> only (fixed shape, pinned `contentId`/`contentVersion`/`ranked`/`timeLimitMs`, empty
> crates/ice/layout) — stray keys never reach `createGame`. Verified: honest chase configs still
> resolve and replay to the identical state hash; a `play`-bearing config is rejected.

- **File:** `server.js:121` (`canonicalConfigFor`) with `js/engine/rules.js:316`
- **Trigger:** submit a `chase-…` score whose config carries a `play` array.
- **Behaviour:** the "fixed ruleset shape" check explicitly rejects `layout`, `crates` and `ice` —

  ```js
  (!cfg.crates || cfg.crates.length === 0) &&
  (!cfg.ice || cfg.ice.length === 0) &&
  !cfg.layout &&
  ```

  but never looks at `play`, and the config it returns is the **client's object** (`return { config: cfg };`).
  `createGame` honours it: `} else if (config.play) { play = config.play.slice(); }` — so the board's
  playable-cell mask is attacker-chosen while the replay still verifies cleanly. `contentId`,
  `contentVersion`, `ranked` and `timeLimitMs` are likewise unchecked on this path.
- **Expected:** score chase is documented as "the fixed ruleset shape"; the daily and challenge paths
  correctly rebuild config from content (`content.dailyContent(dayKey).toEngineConfig()`).
- **Evidence:** direct call into the server module —

  ```
  plain chase                -> accepted
  with custom play mask      -> ACCEPTED; config.play preserved, 32 playable cells of 64
  extra unvalidated keys     -> ACCEPTED
  ```

### 5. A client-supplied flag disables the server's speed plausibility check

> **Fixed 2026-08-26.** `verifyReplay` (`server.js:255`) now reads the timing-assist exemption from
> the authoritative `config.assists` instead of the untrusted `claimed.assists` envelope. Since no
> ranked config permits `timingAssist`, the cadence check now always applies. Verified: a
> submission with `assists.timingAssist: true` and `elapsedMs: 0` is rejected as implausibly fast.

- **File:** `server.js:200-203` (`verifyReplay`), called as `verifyReplay(config, body.replay, body)` at `server.js:284`
- **Trigger:** include `"assists": { "timingAssist": true }` at the top level of a score submission.
- **Behaviour:**

  ```js
  const minMs = state.stats.swaps * 120;
  if (claimed.elapsedMs < minMs && !(claimed.assists && claimed.assists.timingAssist)) {
    return { ok: false, reason: 'implausibly fast', state };
  }
  ```

  `claimed` is the raw request body, and `validateSubmission` (`server.js:161-181`) never inspects
  `body.assists` at all — so the submitter decides whether the check applies to them.
- **Expected:** the assist flag should come from the verified replay/config (`state.assists` exists and
  is derived from the authoritative config), not from the untrusted envelope.
- **Evidence:** `validateSubmission` has no `assists` branch; `handleSubmitScore` passes `body` straight
  through as `claimed`. Lower severity than 1-4 because the score itself is still replay-verified —
  only the human-cadence heuristic is bypassed.

## Suspected — not confirmed

### 1. Credential backstop is a substring match over the whole save document

- **File:** `server.js:347-350` — `if (/token|password|secret|authorization/i.test(serialized))`
- **Concern:** the regex runs over `JSON.stringify(body.doc)`, so any legitimate field or value
  containing those substrings (a cosmetic named "Token", a display name containing "secret") makes the
  whole cloud save fail with `credentials may not be saved`. Observed while testing: a doc containing
  the key `secretProgress` was rejected with HTTP 400.
- **Why unconfirmed:** no shipped content string in `js/engine/content.js` was found to trip it, so it
  may never fire in practice.
- **Decision 2026-08-26:** left as-is. It is a deliberate backstop and the client's progress schema
  contains no matching keys; tightening the regex to quoted keys would still false-positive on
  string values, and a field allowlist would be a larger, riskier change.

### 2. `204 No Content` responses still carry `Content-Type: application/json`

- **File:** `server.js:503`/`server.js:509` — `return sendJson(res, 204, null);`
- **Concern:** live response to `POST /api/v1/presence` is
  `HTTP/1.1 204 No Content` + `Content-Type: application/json`. Node suppresses the body, so nothing
  breaks, but the header is meaningless.
- **Why unconfirmed:** cosmetic; no client behaviour changes.
- **Decision 2026-08-26:** left as-is (cosmetic only).

### 3. `data/` — the server's runtime store — is not gitignored

> **Fixed 2026-08-26.** Added `data/` to `.gitignore` (kept the existing `.local-data/` entry).
> One-line, zero-risk fix for a real mismatch.

- **File:** `.gitignore` (`node_modules/`, `.local-data/`, `*.log`, `.DS_Store`) vs `server.js:43`
  (`const DATA_DIR = path.join(ROOT, 'data');`)
- **Concern:** `ensureDataDir()` creates `data/` (with `data/saves/` holding per-identity cloud saves)
  on startup, so player data lands in the working tree as an untracked directory and is a commit
  candidate. The `.local-data/` ignore entry that appears intended for this matches nothing.
  `market-manager`, `number-mahjong` and `open-cells` have the same mismatch.
- **Why unconfirmed:** the `data/` name is generic enough that it may be an intended, separately-managed
  deployment path rather than an oversight.

### 4. Static-file boundary check is a string prefix, not a path boundary

> **Fixed 2026-08-26.** `serveStatic` now requires `filePath === ROOT || filePath.startsWith(ROOT +
> path.sep)` (`server.js:584`), so a sibling directory named `jewel-cascade…` no longer satisfies
> the check. Latent-only here (no such sibling), but the fix is one line and safe.

- **File:** `server.js:525` — `if (!filePath.startsWith(ROOT))`, with `ROOT = __dirname` (no trailing separator)
- **Concern:** a sibling directory whose name begins with `jewel-cascade` would satisfy the prefix test.
- **Why unconfirmed:** no such sibling exists here and a live raw `GET /../fleet-signals/spec.md`
  returned 404.

## Checked, no defects found

- **Rules engine** (`js/engine/rules.js`): 61 unit tests pass, covering the deterministic board
  generation, swap legality, cascades, specials, goals, serialization and replay.
- **Replay verification for daily and challenge boards** (`server.js:118-133`): unlike the chase path,
  these rebuild the authoritative config from `content.dailyContent(dayKey)` / `content.CHALLENGES`, so
  a tampered config cannot be substituted. `verifyReplay` additionally rejects logs containing rejected
  commands, hash mismatches, score mismatches and move-count mismatches.
- **Submission input validation** (`server.js:161`, `validateSubmission`): schema version, content
  version, integer score bounds, command-count cap, per-command id length, swap coordinate bounds,
  final-hash format, move count and elapsed time are all checked.
- **Rate limiting** (`server.js:93`, `rateLimit`): per identity *and* route, with an eviction pass once
  the bucket map exceeds 5000 entries — the most complete limiter of the eight games in this batch.
- **Atomic writes** (`server.js:66`, `writeJson`): per-file promise chain plus tmp-file + rename.
- **Malformed input robustness:** malformed JSON, `null`/array bodies, wrong-typed fields on every
  `/api/v1/*` route, and a malformed percent-escape in the URL path all left the process running —
  `serveStatic`'s `decodeURIComponent` is inside the request handler's `try`/`catch` (three sibling
  games in this batch crash on that input).
- **Corrupt / absent `localStorage`:** 16 reload cycles with `jewelcascade.progress-backup` and
  `jewelcascade.guest` set to `''`, `'{'`, `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`, `' garbage'`
  and `'{"version":-1,"data":null}'` all booted cleanly. `unwrap` (`js/storage.js:110`) checks the
  wrapper shape, the FNV-1a checksum and the migration chain with a 16-step guard.

## Runtime data generated by this pass

Starting the server and exercising `/api/v1/save` created `data/` (and `data/saves/`) inside the game
directory, containing this pass's test cloud-save documents. It has been left in place for central
cleanup rather than deleted.

## Not tested

- **A full played round in the browser.** The interactive pass reached the mode picker; the match-3
  board itself was not driven through a complete round, so cascade/special visuals and the results
  screen were only covered by the unit tests.
- **Three.js render correctness** (`js/render/scene.js`, 2003 lines) and the UI layer (`js/ui/ui.js`,
  2111 lines) were not reviewed line by line — too large for the 16k-token endpoint even split, and
  they carry no unit tests.
- **Audio** (`js/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **Cloud-save conflict resolution** (`server.js:355-362`): the `_savedAt` lineage branch was not
  exercised beyond confirming a straight overwrite.
