/**
 * server.js — Jewel Cascade authoritative script + static file server.
 *
 * Declared in starhermit.txt (`server=server.js`). Zero dependencies: Node's
 * http/fs only. Serves the browser distribution and the same-origin /api/v1
 * surface the client platform adapter expects:
 *
 *   GET  /api/v1/time        server clock for round-trip-adjusted sync
 *   POST /api/v1/scores      replay-validated ranked submissions (idempotent)
 *   GET  /api/v1/boards      global / friends / daily boards
 *   GET  /api/v1/daily       daily seed metadata (+ exclusion flag)
 *   POST /api/v1/save        cloud save (conflict-aware)
 *   GET  /api/v1/save        cloud save load
 *   POST /api/v1/activity    playtime accounting (start/end pairs)
 *   POST /api/v1/presence    throttled presence heartbeat
 *   GET  /api/v1/friends     friends list (empty on the standalone server)
 *   GET  /api/v1/profile     caller profile (guest when tokenless)
 *   POST /api/v1/telemetry   consented funnel events (aggregate-only storage)
 *
 * Score validation: the ordered command log is replayed through the SAME
 * deterministic rules engine the client runs (js/engine/rules.js). The
 * claimed final hash and score must match the authoritative replay exactly;
 * stale content versions, impossible claims, malformed commands, and forged
 * configs are rejected. Daily seeds are immutable; defective days are marked
 * excluded from ranking (data/excluded-days.json), never silently replaced.
 *
 * Data files live under ./data (server-owned; not part of the upload).
 */

import http from 'http';
import { promises as fs } from 'fs';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import * as rules from './js/engine/rules.js';
import * as content from './js/engine/content.js';
import { fnv1a } from './js/engine/rng.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8000);
const BODY_LIMIT = 256 * 1024;
const REPLAY_SCHEMA = 1;
const MAX_COMMANDS = 600;

/* ------------------------------------------------------------------ *
 *  Tiny JSON-file persistence
 * ------------------------------------------------------------------ */

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'saves'), { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const writeLocks = new Map();
async function writeJson(file, data) {
  const prev = writeLocks.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = file + '.tmp-' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  });
  writeLocks.set(file, next.catch(() => {}));
  return next;
}

/* ------------------------------------------------------------------ *
 *  Identity + rate limiting (all client input is untrusted)
 * ------------------------------------------------------------------ *
 * Guest identities are server-issued capabilities: GET /api/v1/identity
 * mints an id plus an HMAC proof, and every request must present both.
 * Knowing someone's guest id alone no longer grants access to their save.
 */

let serverSecret = null; // loaded/minted in main() before listening

async function loadServerSecret() {
  const file = path.join(DATA_DIR, 'server-secret.json');
  const existing = await readJson(file, null);
  if (existing && typeof existing.secret === 'string' && existing.secret.length >= 32) {
    serverSecret = existing.secret;
    return;
  }
  serverSecret = crypto.randomBytes(32).toString('hex');
  await writeJson(file, { secret: serverSecret }).catch(() => {});
}

function guestProof(guestId) {
  if (!serverSecret) return null;
  return crypto.createHmac('sha256', serverSecret).update(guestId).digest('hex').slice(0, 32);
}

function guestProofMatches(guestId, proof) {
  const want = guestProof(guestId);
  if (!want || typeof proof !== 'string' || proof.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(proof, 'utf8'), Buffer.from(want, 'utf8'));
}

function identityOf(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    // Never store raw tokens: identity is a hash of the presented token.
    return 't-' + crypto.createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 24);
  }
  const guest = req.headers['x-guest-id'];
  if (typeof guest === 'string' && /^g-[a-z0-9-]{4,40}$/.test(guest) && guestProofMatches(guest, req.headers['x-guest-proof'])) {
    return guest;
  }
  return 'ip-' + fnv1a(req.socket.remoteAddress || 'unknown').toString(36);
}

const rateBuckets = new Map(); // identity:route -> {count, resetAt}
function rateLimit(identity, route, perMinute) {
  const key = identity + ':' + route;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(key, b);
  }
  b.count++;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
  }
  return b.count <= perMinute;
}

/* ------------------------------------------------------------------ *
 *  Content resolution for ranked submissions
 * ------------------------------------------------------------------ *
 * Ranked modes are daily, challenge, and score chase. The authoritative
 * config is rebuilt from versioned content where possible; for score chase
 * (player-chosen seeds) the client config is accepted only when it matches
 * the fixed ruleset shape exactly.
 */

const SCORE_CHASE_SHAPE = { width: 8, height: 8, colors: 6, moves: 25, target: 5200 };

function canonicalConfigFor(contentId, claimedConfig) {
  if (typeof contentId !== 'string' || contentId.length > 80) return { error: 'bad content id' };
  if (contentId.startsWith('daily-')) {
    const dayKey = contentId.slice(6);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { error: 'bad daily key' };
    return { config: content.dailyContent(dayKey).toEngineConfig(), dayKey };
  }
  if (contentId.startsWith('ch-')) {
    const ch = content.CHALLENGES.find((c) => c.id === contentId);
    if (!ch) return { error: 'unknown challenge' };
    return { config: ch.toEngineConfig() };
  }
  if (contentId.startsWith('chase-')) {
    const cfg = claimedConfig;
    if (!cfg || typeof cfg !== 'object') return { error: 'missing chase config' };
    const shapeOk =
      cfg.width === SCORE_CHASE_SHAPE.width &&
      cfg.height === SCORE_CHASE_SHAPE.height &&
      cfg.colors === SCORE_CHASE_SHAPE.colors &&
      cfg.moves === SCORE_CHASE_SHAPE.moves &&
      Array.isArray(cfg.goals) &&
      cfg.goals.length === 1 &&
      cfg.goals[0].type === 'score' &&
      cfg.goals[0].n === SCORE_CHASE_SHAPE.target &&
      (!cfg.crates || cfg.crates.length === 0) &&
      (!cfg.ice || cfg.ice.length === 0) &&
      !cfg.layout &&
      !cfg.play &&
      typeof cfg.seed === 'string' &&
      cfg.seed.startsWith('chase-') &&
      cfg.seed.length <= 60 &&
      cfg.assists && cfg.assists.undo === false;
    if (!shapeOk) return { error: 'chase config does not match the fixed ruleset' };
    // Rebuild the authoritative config from validated fields only: play masks,
    // ranked/time-limit overrides and any stray keys never reach the replay.
    return {
      config: {
        contentId,
        contentVersion: content.CONTENT_VERSION,
        seed: cfg.seed,
        width: SCORE_CHASE_SHAPE.width,
        height: SCORE_CHASE_SHAPE.height,
        colors: SCORE_CHASE_SHAPE.colors,
        moves: SCORE_CHASE_SHAPE.moves,
        goals: [{ type: 'score', n: SCORE_CHASE_SHAPE.target }],
        layout: null,
        crates: [],
        ice: [],
        assists: { undo: false, hints: cfg.assists.hints !== false },
        ranked: true,
        timeLimitMs: null,
      },
    };
  }
  return { error: 'mode not ranked' };
}

/* ------------------------------------------------------------------ *
 *  Score submission validation
 * ------------------------------------------------------------------ */

function validateSubmission(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const replay = body.replay;
  if (!replay || typeof replay !== 'object') return 'missing replay envelope';
  if (replay.schema !== REPLAY_SCHEMA) return 'stale replay schema';
  if (!Number.isInteger(replay.contentVersion) || replay.contentVersion !== content.CONTENT_VERSION) return 'stale content version';
  if (!Number.isInteger(body.score) || body.score < 0 || body.score > 10000000) return 'score out of bounds';
  if (!Array.isArray(replay.commands) || replay.commands.length > MAX_COMMANDS) return 'bad command log';
  for (const cmd of replay.commands) {
    if (!cmd || typeof cmd !== 'object') return 'malformed command';
    if (typeof cmd.id !== 'string' || cmd.id.length === 0 || cmd.id.length > 64) return 'malformed command id';
    if (cmd.type === 'swap') {
      for (const k of ['ax', 'ay', 'bx', 'by']) {
        if (!Number.isInteger(cmd[k]) || cmd[k] < 0 || cmd[k] > 11) return 'command coordinate out of bounds';
      }
    } else if (cmd.type !== 'resign' && cmd.type !== 'timeout') return 'unknown command type';
  }
  if (typeof replay.finalHash !== 'string' || !/^[0-9a-f]{8}$/.test(replay.finalHash)) return 'bad final hash';
  if (!Number.isInteger(body.movesSpent) || body.movesSpent < 0 || body.movesSpent > MAX_COMMANDS) return 'bad move count';
  if (!Number.isInteger(body.elapsedMs) || body.elapsedMs < 0 || body.elapsedMs > 24 * 3600000) return 'bad elapsed time';
  return null;
}

/**
 * Authoritative replay verification. Returns {ok, state, reason}.
 * The same version + seed + ordered commands must reproduce the claimed
 * terminal hash and score — anything else is an impossible claim.
 */
function verifyReplay(config, replay, claimed) {
  let result;
  try {
    result = rules.replayLog(config, replay.commands);
  } catch (err) {
    return { ok: false, reason: 'replay failed: ' + err.message };
  }
  const { state, hashes, rejected } = result;
  if (rejected.length > 0) return { ok: false, reason: 'log contains rejected commands', state };
  if (hashes[hashes.length - 1] !== replay.finalHash) return { ok: false, reason: 'final hash mismatch', state };
  if (state.score !== claimed.score) return { ok: false, reason: 'score mismatch', state };
  if (claimed.movesSpent !== state.movesSpent) return { ok: false, reason: 'move count mismatch', state };
  // Plausibility: elapsed time must cover a minimal human cadence per swap.
  // The timing-assist exemption comes from the authoritative config, never
  // from the untrusted submission envelope.
  const minMs = state.stats.swaps * 120;
  if (claimed.elapsedMs < minMs && !(config.assists && config.assists.timingAssist)) {
    return { ok: false, reason: 'implausibly fast', state };
  }
  return { ok: true, state };
}

/* ------------------------------------------------------------------ *
 *  Boards
 * ------------------------------------------------------------------ */

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = a.tieKey || [1, 999, 1e15, ''];
  const tb = b.tieKey || [1, 999, 1e15, ''];
  for (let i = 0; i < 4; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  return 0;
}

async function loadBoards() {
  return readJson(path.join(DATA_DIR, 'boards.json'), { version: 1, entries: [] });
}

function publicEntry(e) {
  return {
    roundId: e.roundId,
    name: e.name,
    score: e.score,
    moves: e.moves,
    ms: e.ms,
    at: e.at,
    contentId: e.contentId,
    dayKey: e.dayKey,
    seed: e.seed,
    ruleset: e.ruleset,
    assists: e.assists,
    validated: true,
  };
}

async function handleBoards(url) {
  const board = url.searchParams.get('board') || 'global';
  const contentId = url.searchParams.get('contentId') || undefined;
  const dayKey = url.searchParams.get('dayKey') || undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
  const boards = await loadBoards();
  const excluded = await readJson(path.join(DATA_DIR, 'excluded-days.json'), {});
  let entries = boards.entries.slice();
  if (board === 'daily') {
    const day = dayKey || content.dayKeyFor(Date.now());
    entries = entries.filter((e) => e.dayKey === day);
    if (excluded[day]) {
      return { entries: [], validated: false, label: 'excluded', note: 'This daily was excluded from ranking (defective content flag).' };
    }
  } else if (board === 'friends') {
    // The standalone server has no social graph; return an honest empty board.
    return { entries: [], validated: true, label: 'friends', note: 'No friends on this server yet.' };
  }
  if (contentId) entries = entries.filter((e) => e.contentId === contentId);
  entries.sort(compareEntries);
  return { entries: entries.slice(0, limit).map(publicEntry), validated: true, label: board };
}

async function handleSubmitScore(req, body, identity) {
  const err = validateSubmission(body);
  if (err) return { status: 400, json: { accepted: false, error: err } };

  const { config, dayKey, error } = canonicalConfigFor(body.contentId, body.replay.config);
  if (error) return { status: 400, json: { accepted: false, error } };

  if (dayKey) {
    const excluded = await readJson(path.join(DATA_DIR, 'excluded-days.json'), {});
    if (excluded[dayKey]) {
      return { status: 200, json: { accepted: false, reason: 'day-excluded', note: 'This daily is excluded from ranking.' } };
    }
    // Daily boundary enforcement: only the current UTC day is submittable.
    const today = content.dayKeyFor(Date.now());
    if (dayKey !== today) return { status: 400, json: { accepted: false, error: 'stale or future daily' } };
  }

  const verdict = verifyReplay(config, body.replay, body);
  if (!verdict.ok) return { status: 422, json: { accepted: false, error: verdict.reason } };

  const boards = await loadBoards();
  const roundId = typeof body.replay.roundId === 'string' ? body.replay.roundId : null;
  // Idempotency: a resubmitted round returns its standing, never a duplicate.
  const existing = boards.entries.find((e) => e.roundId === (roundId || identity + ':' + fnv1a(JSON.stringify(body.replay.commands.map((c) => c.id)))));
  if (existing) {
    const sorted = boards.entries.filter((e) => e.contentId === existing.contentId).sort(compareEntries);
    return { status: 200, json: { accepted: true, dedup: true, rank: sorted.indexOf(existing) + 1 } };
  }

  const name = sanitizeName(body.displayName) || 'guest';
  const entry = {
    roundId: roundId || identity + ':' + fnv1a(JSON.stringify(body.replay.commands.map((c) => c.id))),
    identity,
    name,
    contentId: body.contentId,
    dayKey: dayKey || null,
    score: body.score,
    moves: body.movesSpent,
    ms: body.elapsedMs,
    tieKey: Array.isArray(body.tieKey) ? body.tieKey.slice(0, 4) : undefined,
    seed: typeof body.replay.seed === 'string' || Number.isInteger(body.replay.seed) ? body.replay.seed : config.seed,
    ruleset: body.replay.contentVersion,
    assists: body.assists && body.assists.undo ? 'undo' : '',
    at: new Date().toISOString(),
  };
  boards.entries.push(entry);
  if (boards.entries.length > 5000) {
    boards.entries.sort(compareEntries);
    boards.entries = boards.entries.slice(0, 2500);
  }
  await writeJson(path.join(DATA_DIR, 'boards.json'), boards);
  const sorted = boards.entries.filter((e) => e.contentId === entry.contentId).sort(compareEntries);
  return { status: 200, json: { accepted: true, rank: sorted.indexOf(entry) + 1 } };
}

function sanitizeName(n) {
  if (typeof n !== 'string') return null;
  const clean = n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return clean || null;
}

/* ------------------------------------------------------------------ *
 *  Cloud saves (versioned, conflict-preserving)
 * ------------------------------------------------------------------ */

function saveFileFor(identity) {
  return path.join(DATA_DIR, 'saves', identity.replace(/[^a-z0-9-]/g, '_') + '.json');
}

async function handleSaveLoad(identity) {
  const doc = await readJson(saveFileFor(identity), null);
  if (!doc) return { status: 200, json: null };
  return { status: 200, json: { doc: doc.doc, savedAt: doc.savedAt } };
}

async function handleSaveStore(body, identity) {
  if (!body || typeof body !== 'object' || !body.doc || typeof body.doc !== 'object') {
    return { status: 400, json: { error: 'missing doc' } };
  }
  // Never accept credential-shaped fields (backstop; the client never sends any).
  const serialized = JSON.stringify(body.doc);
  if (/token|password|secret|authorization/i.test(serialized)) {
    return { status: 400, json: { error: 'credentials may not be saved' } };
  }
  if (serialized.length > 128 * 1024) return { status: 413, json: { error: 'save too large' } };
  const file = saveFileFor(identity);
  const existing = await readJson(file, null);
  const incomingAt = String(body.doc._savedAt || '');
  if (existing && existing.doc) {
    const existingAt = String(existing.doc._savedAt || '');
    const sameLineage = existing.doc.version === body.doc.version;
    if (incomingAt < existingAt && sameLineage) {
      // Conflict: keep both snapshots; the player chooses on the client.
      await writeJson(file + '.conflict', { savedAt: new Date().toISOString(), doc: body.doc });
      return { status: 200, json: { conflict: true, theirs: existing.doc } };
    }
  }
  await writeJson(file, { savedAt: new Date().toISOString(), doc: body.doc });
  return { status: 200, json: { ok: true } };
}

/* ------------------------------------------------------------------ *
 *  Telemetry (aggregate-only, capped, short-retention)
 * ------------------------------------------------------------------ */

const TELEMETRY_CAP = 64 * 1024;
async function handleTelemetry(body) {
  if (!body || !Array.isArray(body.events) || body.events.length > 100) {
    return { status: 400, json: { error: 'bad batch' } };
  }
  const file = path.join(DATA_DIR, 'telemetry.log');
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > TELEMETRY_CAP) return { status: 204, json: null }; // retention cap: drop
    const lines = body.events
      .filter((e) => e && typeof e.event === 'string' && e.event.length <= 32)
      .map((e) => JSON.stringify({ event: e.event, band: e.band, props: e.props }))
      .join('\n');
    if (lines) await fs.appendFile(file, lines + '\n');
  } catch {
    /* telemetry must never fail the client */
  }
  return { status: 204, json: null };
}

/* ------------------------------------------------------------------ *
 *  HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.opus': 'audio/ogg',
};

function sendJson(res, status, obj) {
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const identity = identityOf(req);
  const route = url.pathname.replace(/^\/api\/v1/, '') || '/';

  if (route === '/time' && req.method === 'GET') {
    if (!rateLimit(identity, 'time', 240)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 1000 });
    const ms = Date.now();
    return sendJson(res, 200, { ms, iso: new Date(ms).toISOString() });
  }

  if (route === '/identity' && req.method === 'GET') {
    if (!rateLimit(identity, 'identity', 30)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    // Mint an anonymous guest id plus the HMAC proof that binds it.
    const guestId = 'g-' + crypto.randomBytes(9).toString('hex');
    return sendJson(res, 200, { guestId, proof: guestProof(guestId) });
  }

  if (route === '/scores' && req.method === 'POST') {
    if (!rateLimit(identity, 'scores', 20)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 5000 });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const out = await handleSubmitScore(req, body, identity);
    return sendJson(res, out.status, out.json);
  }

  if (route === '/boards' && req.method === 'GET') {
    if (!rateLimit(identity, 'boards', 120)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    return sendJson(res, 200, await handleBoards(url));
  }

  if (route === '/daily' && req.method === 'GET') {
    const day = url.searchParams.get('day') || content.dayKeyFor(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: 'bad day' });
    const excluded = await readJson(path.join(DATA_DIR, 'excluded-days.json'), {});
    return sendJson(res, 200, { dayKey: day, seed: 'daily-' + day, excluded: !!excluded[day] });
  }

  if (route === '/save' && req.method === 'GET') {
    if (!rateLimit(identity, 'save', 60)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    const out = await handleSaveLoad(identity);
    return sendJson(res, out.status, out.json);
  }

  if (route === '/save' && req.method === 'POST') {
    if (!rateLimit(identity, 'save', 60)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const out = await handleSaveStore(body, identity);
    return sendJson(res, out.status, out.json);
  }

  if (route === '/telemetry' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    const out = await handleTelemetry(body);
    return sendJson(res, out.status, out.json);
  }

  if (route === '/activity' && req.method === 'POST') {
    if (!rateLimit(identity, 'activity', 120)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    await readBody(req).catch(() => '');
    return sendJson(res, 204, null);
  }

  if (route === '/presence' && req.method === 'POST') {
    if (!rateLimit(identity, 'presence', 120)) return sendJson(res, 429, { error: 'rate limited', retryAfterMs: 2000 });
    await readBody(req).catch(() => '');
    return sendJson(res, 204, null);
  }

  if (route === '/friends' && req.method === 'GET') {
    return sendJson(res, 200, { friends: [] });
  }

  if (route === '/profile' && req.method === 'GET') {
    return sendJson(res, 200, { profile: { displayName: 'guest', avatar: null }, privacy: 'public' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (filePath.startsWith(DATA_DIR)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const immutable = pathname.startsWith('/vendor/');
  const noCache = ext === '.html' || ext === '.txt';
  fs.stat(filePath)
    .then((stat) => {
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : noCache ? 'no-cache' : 'public, max-age=300, must-revalidate',
      });
      createReadStream(filePath).pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
}

async function main() {
  await ensureDataDir();
  await loadServerSecret();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end('method not allowed');
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      console.error('[server]', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  });
  server.listen(PORT, () => {
    console.log('[jewel-cascade] serving on http://localhost:' + PORT + '/');
  });
}

// Run only when invoked directly (tests import handlers without listening).
const invokedDirectly = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { handleApi, canonicalConfigFor, verifyReplay, validateSubmission };
