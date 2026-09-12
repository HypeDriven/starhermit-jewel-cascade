/**
 * platform.js — StarHermit host adapter for Jewel Cascade.
 *
 * Responsibilities (spec §12): read the short-lived launch token from the URL
 * fragment (read once, stripped, never persisted), same-origin /api transport
 * with retries and rate-limit handling, round-trip-adjusted time sync,
 * 45-minute launch-token refresh, hosted nickname read, read-only hosted
 * leaderboards, and cloud saves mirrored to the hosted zip+base64 slot
 * (debounced, pagehide flush, visible sync status). Activity start/end,
 * presence heartbeats, replay-validated score submission, telemetry and guest
 * identity run ONLY against the game's own dev server (`node server.js`),
 * never against the platform host.
 *
 * The adapter degrades gracefully: without a host (static hosting, file://)
 * every network surface becomes a safe no-op and the game remains fully
 * playable offline.
 *
 * Import-safe in Node: no top-level window/document access.
 */

const API_BASE = '/api/v1';
const PROBE_TIMEOUT_MS = 3500;
const REQUEST_TIMEOUT_MS = 9000;
const MAX_RETRIES = 2;
const CLOUD_DEBOUNCE_MS = 2000;
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MS = 60000;
const CLOUD_SLOT_MAX_BYTES = 10 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

const GUEST_KEY = 'jewelcascade.guest';
const GUEST_PROOF_KEY = 'jewelcascade.guest-proof';

function randomGuestId() {
  const bytes = new Uint8Array(9);
  (globalThis.crypto || {}).getRandomValues(bytes);
  return 'g-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let ephemeralGuest = null; // per-session fallback when localStorage is unavailable

/**
 * Random opaque id (not a credential) for anonymous local-server identity,
 * plus the server-minted HMAC proof that binds it (GET /api/v1/identity).
 * Without storage the id is a per-session random value — never a shared
 * constant, so storage-less players cannot collide on one cloud save.
 */
function guestIdentity() {
  try {
    let id = window.localStorage.getItem(GUEST_KEY);
    if (!id) {
      id = randomGuestId();
      window.localStorage.setItem(GUEST_KEY, id);
    }
    return { id, proof: window.localStorage.getItem(GUEST_PROOF_KEY) || null };
  } catch {
    if (!ephemeralGuest) ephemeralGuest = { id: randomGuestId(), proof: null };
    return ephemeralGuest;
  }
}

export class Platform {
  constructor() {
    this.hosted = false; // running under a StarHermit host shell (launch token)
    this.online = false; // API reachable at all
    this.ownServer = false; // the game's own dev server (node server.js) answered
    this.apiBase = API_BASE;
    this.launchToken = null; // memory only — NEVER persisted (spec §12)
    this.userId = null; // JWT sub (hosted)
    this.gameSlug = null; // JWT game_scope (hosted); never hard-coded
    this.timeOffsetMs = 0; // serverTime - localTime (round-trip adjusted)
    this.timeSyncedAt = 0;
    this.profile = null; // {displayName, userId} from host when available
    this.syncState = 'offline'; // hosted cloud mirror: offline|saving|synced|error
    this.onSyncChange = null;
    this._nickCache = new Map(); // userId -> display nickname (hosted boards)
    this._cloudTimer = null;
    this._cloudDirty = null;
    this._cloudSaving = false;
    this._refreshTimer = null;
    this._rateLimitedUntil = 0;
    this._activityStartedAt = 0;
    this._lastPresence = 0;
    this._analytics = null;
  }

  /* ---------------- boot ---------------- */

  async init({ analytics } = {}) {
    this._analytics = analytics || null;
    if (typeof window === 'undefined') return;

    // Launch token: the host shell delivers it in the URL fragment
    // (#game_token=<jwt>[&session_id=…]) — read once, then strip it from the
    // URL. Query-param (?launch_token=/?token=) and injected-global fallbacks
    // exist for local dev only, never on the platform host.
    try {
      const url = new URL(window.location.href);
      const platformHost = /(^|\.)starhermit\.com$/i.test(url.hostname);
      let token = null;
      if (window.location.hash) {
        const frag = new URLSearchParams(window.location.hash.slice(1));
        token = frag.get('game_token');
        if (token && window.history && window.history.replaceState) {
          frag.delete('game_token');
          frag.delete('session_id');
          const rest = frag.toString();
          window.history.replaceState(null, '', url.pathname + url.search + (rest ? '#' + rest : ''));
        }
      }
      if (!token && !platformHost) {
        token = url.searchParams.get('launch_token') || url.searchParams.get('token') || (window.__STARHERMIT__ && window.__STARHERMIT__.launchToken) || null;
        if (token && window.history && window.history.replaceState) {
          url.searchParams.delete('launch_token');
          url.searchParams.delete('token');
          window.history.replaceState(null, '', url.toString());
        }
      }
      this.launchToken = token;
      this.hosted = !!token;
      const claims = token ? decodeJwtPayload(token) : null;
      this.userId = claims && claims.sub ? String(claims.sub) : null;
      this.gameSlug = claims && claims.game_scope ? String(claims.game_scope) : null;
    } catch {
      this.launchToken = null;
      this.hosted = false;
    }

    // Probe the API: same-origin /api routes exist under the platform host
    // and under the local dev server, and nowhere under static hosting. Any
    // healthy response means reachable — never force-offline on the platform
    // host's /time shape. The {ms} shape uniquely identifies the game's own
    // dev server, which alone exposes the replay/scores/save surface.
    try {
      const res = await this._rawFetch(this.apiBase + '/time', { method: 'GET', headers: this._headers() }, PROBE_TIMEOUT_MS);
      const body = res && res.ok ? await res.clone().json().catch(() => null) : null;
      this.online = !!(res && res.ok);
      this.ownServer = this.online && !this.hosted && !!body && typeof body.ms === 'number';
    } catch {
      this.online = false;
      this.ownServer = false;
    }

    // Guests need a server-minted proof bound to their id before the dev
    // server will trust X-Guest-Id for cloud saves; mint one when we lack it.
    if (this.ownServer) await this._ensureGuestProof();

    if (this.hosted) {
      this._scheduleTokenRefresh();
      await this._loadHostedProfile();
    } else if (this.ownServer) {
      try {
        const res = await this._request('GET', '/profile');
        if (res && res.profile) this.profile = res.profile;
      } catch {
        /* profile is optional chrome */
      }
    }
  }

  /** Authoritative-ish now (ms): local clock + server offset when synced. */
  now() {
    return nowMs() + (this.timeOffsetMs || 0);
  }

  /** Round-trip-adjusted time sync against GET /api/v1/time. */
  async syncTime() {
    if (!this.online) return false;
    const t0 = nowMs();
    try {
      const res = await this._request('GET', '/time', { timeout: PROBE_TIMEOUT_MS });
      const t1 = nowMs();
      // Dev server answers {ms}; the platform host uses its own shape.
      const serverMs = res && typeof res.ms === 'number' ? res.ms : res && typeof res.now === 'number' ? res.now : res && typeof res.time === 'number' ? res.time : null;
      if (serverMs !== null) {
        const rtt = t1 - t0;
        this.timeOffsetMs = serverMs - (t0 + rtt / 2);
        this.timeSyncedAt = t1;
        return true;
      }
    } catch {
      /* recoverable: keep last offset */
    }
    return false;
  }

  /**
   * Scoped launch tokens live 60 min; re-mint every 45 min via the platform
   * endpoint (sending the current token), retrying failures in ~60 s.
   */
  _scheduleTokenRefresh() {
    if (!this.hosted || !this.gameSlug || typeof window === 'undefined') return;
    const loop = (delay) => {
      this._refreshTimer = setTimeout(async () => {
        try {
          const res = await this._rawFetch(
            this.apiBase + '/games/' + encodeURIComponent(this.gameSlug) + '/launch-token',
            { method: 'POST', headers: this._headers() },
            REQUEST_TIMEOUT_MS
          );
          const json = res && res.ok ? await res.json().catch(() => null) : null;
          if (json && typeof json.token === 'string' && json.token) {
            this.launchToken = json.token;
            const claims = decodeJwtPayload(json.token);
            if (claims && claims.sub) this.userId = String(claims.sub);
            if (claims && claims.game_scope) this.gameSlug = String(claims.game_scope);
            loop(TOKEN_REFRESH_MS);
          } else {
            loop(TOKEN_REFRESH_RETRY_MS);
          }
        } catch {
          loop(TOKEN_REFRESH_RETRY_MS);
        }
      }, delay);
    };
    loop(TOKEN_REFRESH_MS);
  }

  /**
   * Hosted identity: launch tokens cannot call /api/v1/me, so read the public
   * profile by user id. Display the NICKNAME only (never the username);
   * fall back to "Player " + id.slice(0, 8).
   */
  async _loadHostedProfile() {
    this.profile = { displayName: this.userId ? 'Player ' + this.userId.slice(0, 8) : 'Player', userId: this.userId };
    if (!this.userId) return;
    try {
      this.profile = { displayName: await this.nicknameFor(this.userId), userId: this.userId };
    } catch {
      /* fallback name already set */
    }
  }

  /** Resolve a user id to a display nickname (cached). Never a username. */
  async nicknameFor(userId) {
    const id = String(userId);
    if (this._nickCache.has(id)) return this._nickCache.get(id);
    let name = 'Player ' + id.slice(0, 8);
    try {
      const res = await this._request('GET', '/users/' + encodeURIComponent(id) + '/profile');
      if (res && typeof res.nickname === 'string' && res.nickname.trim()) name = res.nickname.trim().slice(0, 24);
    } catch {
      /* keep fallback */
    }
    this._nickCache.set(id, name);
    return name;
  }

  /* ---------------- transport ---------------- */

  _rawFetch(url, opts, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS) : null;
    const p = fetch(url, { ...(opts || {}), signal: ctrl ? ctrl.signal : undefined })
      .finally(() => timer && clearTimeout(timer));
    return p;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.launchToken) h.Authorization = 'Bearer ' + this.launchToken;
    else if (typeof window !== 'undefined') {
      const g = guestIdentity();
      h['X-Guest-Id'] = g.id;
      if (g.proof) h['X-Guest-Proof'] = g.proof;
    }
    return h;
  }

  /**
   * Fetch a server-issued guest id + HMAC proof and store them. Without the
   * proof the server treats the guest id as untrusted (cloud saves fall back
   * to a per-IP identity), so a stolen/guessed guest id alone is useless.
   */
  async _ensureGuestProof() {
    if (guestIdentity().proof) return;
    try {
      const res = await this._rawFetch(this.apiBase + '/identity', { method: 'GET' }, PROBE_TIMEOUT_MS);
      const j = res && res.ok ? await res.json() : null;
      if (!j || typeof j.guestId !== 'string' || typeof j.proof !== 'string') return;
      try {
        window.localStorage.setItem(GUEST_KEY, j.guestId);
        window.localStorage.setItem(GUEST_PROOF_KEY, j.proof);
      } catch {
        ephemeralGuest = { id: j.guestId, proof: j.proof }; // session-scoped
      }
    } catch {
      /* offline or old server: proceed without a proof */
    }
  }

  /**
   * JSON request with bounded retries and rate-limit/backoff handling.
   * Structured {"error": ...} responses and 429s become recoverable
   * thrown PlatformErrors with .status / .retryAfterMs.
   */
  async _request(method, path, { body, timeout, idempotencyKey } = {}) {
    if (typeof window === 'undefined') throw platformError(0, 'offline');
    const wait = this._rateLimitedUntil - nowMs();
    if (wait > 0) throw platformError(429, 'rate-limited', wait);

    let attempt = 0;
    for (;;) {
      attempt++;
      let res = null;
      let json = null;
      try {
        const headers = this._headers();
        if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
        res = await this._rawFetch(this.apiBase + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }, timeout);
        if (res.status === 204) return null;
        const text = await res.text();
        json = text ? JSON.parse(text) : null;
      } catch (err) {
        if (attempt > MAX_RETRIES) {
          this.online = false;
          throw platformError(0, 'network: ' + (err && err.message ? err.message : 'failed'));
        }
        await sleep(300 * attempt);
        continue;
      }
      if (res.ok) {
        this.online = true;
        return json;
      }
      if (res.status === 429) {
        const retryAfter = json && typeof json.retryAfterMs === 'number' ? json.retryAfterMs : 2000 * attempt;
        this._rateLimitedUntil = nowMs() + retryAfter;
        if (attempt > MAX_RETRIES) throw platformError(429, (json && json.error) || 'rate-limited', retryAfter);
        await sleep(Math.min(retryAfter, 4000));
        continue;
      }
      const msg = (json && json.error) || 'http-' + res.status;
      // 4xx (other than 429) is a definitive rejection: no retry.
      if (res.status >= 400 && res.status < 500) throw platformError(res.status, msg);
      if (attempt > MAX_RETRIES) throw platformError(res.status, msg);
      await sleep(300 * attempt);
    }
  }

  /* ---------------- activity / presence (dev server only) ----------------
   * The wiki has no per-game presence/telemetry/activity endpoints reachable
   * by launch tokens, so these never fire against the platform host. */

  /** Playtime accounting: paired start/end, best-effort. */
  startActivity() {
    if (this._activityStartedAt) return;
    this._activityStartedAt = nowMs();
    if (!this.ownServer) return;
    this._request('POST', '/activity', { body: { event: 'start' }, idempotencyKey: 'act-' + this._activityStartedAt }).catch(() => {});
  }

  endActivity() {
    if (!this._activityStartedAt) return;
    const ms = nowMs() - this._activityStartedAt;
    this._activityStartedAt = 0;
    if (!this.ownServer) return;
    const body = { event: 'end', band: durationBand(ms) };
    this._request('POST', '/activity', { body }).catch(() => {});
  }

  /** Throttled presence heartbeat while actively playing (≥20s apart). */
  presencePing(status) {
    const now = nowMs();
    if (now - this._lastPresence < 20000) return;
    this._lastPresence = now;
    if (!this.ownServer) return;
    this._request('POST', '/presence', { body: { status: status && status.status, mode: status && status.mode } }).catch(() => {});
  }

  /* ---------------- scores / boards ---------------- */

  /**
   * Submit a ranked result — dev server only; its replay validation re-runs
   * the ordered command log against the versioned ruleset (spec §12). The
   * platform owns hosted leaderboards (script/elo), so clients can never
   * submit there; hosted ranked rounds are recorded as personal bests.
   */
  async submitScore(results) {
    if (this.hosted) return { accepted: false, reason: 'client-cannot-submit' };
    if (!this.online) return { accepted: false, reason: 'offline' };
    const r = results || {};
    const body = {
      contentId: r.contentId,
      contentVersion: r.replay ? r.replay.contentVersion : 1,
      mode: r.mode,
      dayKey: r.mode === 'daily' && r.contentId && r.contentId.indexOf('daily-') === 0 ? r.contentId.slice(6) : undefined,
      score: r.score,
      components: r.components,
      movesSpent: r.movesSpent,
      elapsedMs: r.elapsedMs,
      tieKey: r.tieKey,
      assists: r.replay && r.replay.config ? r.replay.config.assists : undefined,
      durationBand: durationBand(r.elapsedMs || 0),
      replay: r.replay
        ? {
            // roundId lets the server dedupe resubmissions of the same round
            // and lets the client find its own entry (rank) on the board.
            roundId: r.roundId,
            schema: r.replay.schema,
            contentId: r.replay.contentId,
            contentVersion: r.replay.contentVersion,
            seed: r.replay.seed,
            config: r.replay.config,
            commands: r.replay.commands,
            finalHash: r.replay.finalHash,
          }
        : null,
      displayName: this.profile ? this.profile.displayName : undefined,
    };
    return this._request('POST', '/scores', { body, idempotencyKey: 'score-' + r.roundId });
  }

  /** boards: 'global' | 'friends' | 'daily'. Returns {entries, validated, label}. */
  async fetchBoards({ board = 'global', contentId, dayKey, limit = 25 } = {}) {
    if (this.hosted) return this._fetchHostedBoard(board, limit);
    if (!this.online) return { entries: [], validated: false, label: 'offline' };
    const q = new URLSearchParams();
    q.set('board', board);
    if (contentId) q.set('contentId', contentId);
    if (dayKey) q.set('dayKey', dayKey);
    q.set('limit', String(limit));
    return this._request('GET', '/boards?' + q.toString());
  }

  /**
   * Hosted boards are read-only: GET /games/{slug} → leaderboardId, then
   * GET /leaderboards/{id}/entries (friendsOnly for the friends tab), with
   * user ids resolved to nicknames via the profile helper. The platform has
   * one leaderboard per game — no per-day board — so the daily tab shows
   * local records only (label 'local-only'); no leaderboardId means the
   * same.
   */
  async _fetchHostedBoard(board, limit) {
    if (board === 'daily') return { entries: [], validated: false, label: 'local-only', localOnly: true };
    try {
      const game = await this._request('GET', '/games/' + encodeURIComponent(this.gameSlug || ''));
      const leaderboardId = game && game.leaderboardId;
      if (!leaderboardId) return { entries: [], validated: false, label: 'local-only', localOnly: true };
      const q = new URLSearchParams();
      q.set('page', '1');
      q.set('pageSize', String(Math.min(limit, 100)));
      if (board === 'friends') q.set('friendsOnly', 'true');
      const res = await this._request('GET', '/leaderboards/' + encodeURIComponent(leaderboardId) + '/entries?' + q.toString());
      const raw = ((res && res.entries) || []).slice(0, limit);
      const entries = [];
      for (const e of raw) {
        entries.push({
          name: await this.nicknameFor(e.userId != null ? e.userId : e.user_id),
          score: e.score,
          moves: e.moves != null ? e.moves : null,
          at: e.at || e.createdAt || null,
        });
      }
      return { entries, validated: true, label: board === 'friends' ? 'Friends' : 'Global' };
    } catch {
      return { entries: [], validated: false, label: 'offline' };
    }
  }

  async fetchFriends() {
    if (this.hosted) return { friends: [] }; // no fabricated hosted route
    if (!this.online) return { friends: [] };
    return this._request('GET', '/friends');
  }

  /* ---------------- cloud saves ---------------- */

  _setSync(state) {
    if (this.syncState === state) return;
    this.syncState = state;
    if (this.onSyncChange) {
      try {
        this.onSyncChange(state);
      } catch {
        /* UI hook is optional */
      }
    }
  }

  /**
   * Queue a hosted mirror save: bursts collapse into one PUT via a ~2 s
   * debounce; flushCloudSave() (pagehide) cancels the wait and writes now.
   * localStorage remains the offline cache — the cloud slot is only a mirror.
   */
  queueCloudSave(doc) {
    if (!this.hosted) return;
    this._cloudDirty = doc;
    if (this._cloudTimer) return;
    this._cloudTimer = setTimeout(() => {
      this._cloudTimer = null;
      this.flushCloudSave();
    }, CLOUD_DEBOUNCE_MS);
  }

  flushCloudSave() {
    if (!this.hosted) return Promise.resolve(null);
    if (this._cloudTimer) {
      clearTimeout(this._cloudTimer);
      this._cloudTimer = null;
    }
    const doc = this._cloudDirty;
    if (!doc || this._cloudSaving) return Promise.resolve(null);
    this._cloudSaving = true;
    this._setSync('saving');
    return this.cloudSave(doc)
      .then(() => {
        this._cloudDirty = null;
        this._setSync(this.online ? 'synced' : 'offline');
      })
      .catch(() => {
        this._setSync('error');
      })
      .finally(() => {
        this._cloudSaving = false;
      });
  }

  /**
   * Save the progression document. Hosted: PUT the single platform cloud
   * slot /me/cloud-saves/{slug} with a stored zip (progress.json) as
   * {dataBase64}; skipped without a token/slug. Dev server: POST /save with
   * conflict detection (spec §12).
   */
  async cloudSave(progress) {
    if (this.hosted) {
      if (!this.online || !this.gameSlug || !this.userId) return null;
      const bytes = new TextEncoder().encode(JSON.stringify(progress));
      const zip = zipStore('progress.json', bytes);
      if (zip.length > CLOUD_SLOT_MAX_BYTES) return null; // platform slot cap
      await this._request('PUT', '/me/cloud-saves/' + encodeURIComponent(this.gameSlug), { body: { dataBase64: bytesToBase64(zip) } });
      return null;
    }
    if (!this.online) return null;
    return this._request('POST', '/save', { body: { doc: progress }, idempotencyKey: 'save-' + (progress && progress._savedAt) });
  }

  /**
   * Load the cloud progression document: {doc, savedAt} | null. Hosted: the
   * slot answers application/zip bytes (404 = none). On conflict the remote
   * copy wins when newer (see main.js boot merge).
   */
  async cloudLoad() {
    if (this.hosted) {
      if (!this.online || !this.gameSlug || !this.userId) return null;
      try {
        const headers = {};
        if (this.launchToken) headers.Authorization = 'Bearer ' + this.launchToken;
        const res = await this._rawFetch(this.apiBase + '/me/cloud-saves/' + encodeURIComponent(this.gameSlug), { method: 'GET', headers }, REQUEST_TIMEOUT_MS);
        if (!res || res.status === 404 || !res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
        if (!doc || typeof doc !== 'object') return null;
        return { doc, savedAt: doc._savedAt || null };
      } catch {
        return null;
      }
    }
    if (!this.online) return null;
    return this._request('GET', '/save');
  }

  /* ---------------- telemetry (dev server only) ---------------- */

  /** Funnel-only batches; the analytics module gates consent before calling. */
  async sendTelemetry(batch) {
    if (!this.ownServer) return false; // no fabricated hosted route
    await this._request('POST', '/telemetry', { body: batch });
    return true;
  }
}

/** Base64url-decode a JWT payload segment (no signature verification). */
function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch {
    return null;
  }
}

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

export { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };

function platformError(status, message, retryAfterMs) {
  const e = new Error(message);
  e.name = 'PlatformError';
  e.status = status;
  if (retryAfterMs) e.retryAfterMs = retryAfterMs;
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function durationBand(ms) {
  const mins = Math.floor((ms || 0) / 60000);
  if (mins < 1) return '0-1m';
  if (mins < 5) return '1-5m';
  if (mins < 15) return '5-15m';
  if (mins < 30) return '15-30m';
  if (mins < 60) return '30-60m';
  return '60m+';
}
