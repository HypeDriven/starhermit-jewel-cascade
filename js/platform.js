/**
 * platform.js — StarHermit host adapter for Jewel Cascade.
 *
 * Responsibilities (spec §6): read the game scope from the short-lived
 * launch token (never persisted), same-origin /api transport with retries
 * and rate-limit handling, round-trip-adjusted time sync, activity start/end,
 * throttled presence heartbeats, replay-validated score submission, cloud
 * saves with conflict surfacing, telemetry consent pass-through, and a
 * friends/leaderboard read path.
 *
 * The adapter degrades gracefully: without a host (static hosting, file://)
 * every network surface becomes a safe no-op and the game remains fully
 * playable offline. A local `node server.js` provides the full API in dev.
 *
 * Import-safe in Node: no top-level window/document access.
 */

const API_BASE = '/api/v1';
const PROBE_TIMEOUT_MS = 3500;
const REQUEST_TIMEOUT_MS = 9000;
const MAX_RETRIES = 2;

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
    this.apiBase = API_BASE;
    this.launchToken = null; // memory only — NEVER persisted (spec §6)
    this.timeOffsetMs = 0; // serverTime - localTime (round-trip adjusted)
    this.timeSyncedAt = 0;
    this.profile = null; // {displayName, avatar} from host when available
    this._rateLimitedUntil = 0;
    this._activityStartedAt = 0;
    this._lastPresence = 0;
    this._analytics = null;
  }

  /* ---------------- boot ---------------- */

  async init({ analytics } = {}) {
    this._analytics = analytics || null;
    if (typeof window === 'undefined') return;

    // Launch token arrives from the host shell via query param or injected
    // global. It is read once, kept in memory, and scrubbed from the URL.
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get('launch_token') || url.searchParams.get('token');
      const injected = window.__STARHERMIT__ && window.__STARHERMIT__.launchToken;
      this.launchToken = q || injected || null;
      this.hosted = !!this.launchToken;
      if (q && window.history && window.history.replaceState) {
        url.searchParams.delete('launch_token');
        url.searchParams.delete('token');
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      this.launchToken = null;
      this.hosted = false;
    }

    // Probe the API: same-origin /api routes exist both under the host and
    // under the local dev server. Absent API = static hosting = offline mode.
    try {
      const res = await this._rawFetch(this.apiBase + '/time', { method: 'GET' }, PROBE_TIMEOUT_MS);
      const body = res && res.ok ? await res.clone().json().catch(() => null) : null;
      // The platform host also owns /api/v1/time, but its response shape is
      // not this game's server API. Treat only our {ms} contract as online.
      this.online = !!body && typeof body.ms === 'number';
    } catch {
      this.online = false;
    }

    // Guests need a server-minted proof bound to their id before the server
    // will trust X-Guest-Id for cloud saves; mint one when we lack it.
    if (this.online && !this.hosted) await this._ensureGuestProof();

    if (this.hosted) {
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
      if (res && typeof res.ms === 'number') {
        const rtt = t1 - t0;
        const serverAtArrival = res.ms;
        this.timeOffsetMs = serverAtArrival - (t0 + rtt / 2);
        this.timeSyncedAt = t1;
        return true;
      }
    } catch {
      /* recoverable: keep last offset */
    }
    return false;
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

  /* ---------------- activity / presence ---------------- */

  /** Playtime accounting: paired start/end, best-effort. */
  startActivity() {
    if (this._activityStartedAt) return;
    this._activityStartedAt = nowMs();
    if (!this.online) return;
    this._request('POST', '/activity', { body: { event: 'start' }, idempotencyKey: 'act-' + this._activityStartedAt }).catch(() => {});
  }

  endActivity() {
    if (!this._activityStartedAt) return;
    const ms = nowMs() - this._activityStartedAt;
    this._activityStartedAt = 0;
    if (!this.online) return;
    const body = { event: 'end', band: durationBand(ms) };
    this._request('POST', '/activity', { body }).catch(() => {});
  }

  /** Throttled presence heartbeat while actively playing (≥20s apart). */
  presencePing(status) {
    const now = nowMs();
    if (now - this._lastPresence < 20000) return;
    this._lastPresence = now;
    if (!this.online) return;
    this._request('POST', '/presence', { body: { status: status && status.status, mode: status && status.mode } }).catch(() => {});
  }

  /* ---------------- scores / boards ---------------- */

  /**
   * Submit a ranked result. The server replays the ordered command log
   * against the versioned ruleset before accepting (spec §6). Returns the
   * server verdict ({accepted, rank?, reason?}); throws on transport failure.
   */
  async submitScore(results) {
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
    if (!this.online) return { entries: [], validated: false, label: 'offline' };
    const q = new URLSearchParams();
    q.set('board', board);
    if (contentId) q.set('contentId', contentId);
    if (dayKey) q.set('dayKey', dayKey);
    q.set('limit', String(limit));
    return this._request('GET', '/boards?' + q.toString());
  }

  async fetchFriends() {
    if (!this.online) return { friends: [] };
    return this._request('GET', '/friends');
  }

  /* ---------------- cloud saves ---------------- */

  /**
   * Save the progression document. Versioned + checksummed client-side; the
   * server keeps both snapshots on conflict and returns {conflict, theirs}
   * so the player can choose (spec §6).
   */
  async cloudSave(progress) {
    if (!this.online) return null;
    return this._request('POST', '/save', { body: { doc: progress }, idempotencyKey: 'save-' + (progress && progress._savedAt) });
  }

  /** Load the cloud progression document: {doc, savedAt} | null. */
  async cloudLoad() {
    if (!this.online) return null;
    return this._request('GET', '/save');
  }

  /* ---------------- telemetry ---------------- */

  /** Funnel-only batches; the analytics module gates consent before calling. */
  async sendTelemetry(batch) {
    if (!this.online) return false;
    await this._request('POST', '/telemetry', { body: batch });
    return true;
  }
}

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
