/**
 * platform.js — StarHermit host adapter for Jewel Cascade.
 *
 * Responsibilities (spec §12): the shared SDK (starhermit-sdk.js,
 * window.StarHermit) reads the launch token from the URL fragment (stripped,
 * never persisted), renews it, and serves every hosted platform call made
 * here — nickname/avatar, the cloud-save slot game:<slug> (debounced, pagehide
 * flush, visible sync status), the per-player settings KV, keyboard bindings,
 * the invite link and the read-only hosted leaderboard. The adapter itself
 * only adds a round-trip-adjusted GET /api/v1/time, and only when signed in.
 *
 * Standalone (no launch token: static hosting, file://, local dev) the game
 * makes no network request at all: local clock, local boards and progress.
 *
 * Import-safe in Node: no top-level window/document access.
 */

const TIME_URL = '/api/v1/time';
const TIME_TIMEOUT_MS = 3500;

const nowMs = () => Date.now();

export class Platform {
  constructor() {
    // StarHermit SDK (starhermit-sdk.js, window.StarHermit) owns the launch
    // token: read from #game_token= / #access_token=, stripped, renewed.
    this.sh = (typeof window !== 'undefined' && window.StarHermit) || null;
    this.avatarUrl = null; // object URL of the account avatar (hosted)
    this.onAuthChange = null; // fn(signedIn) after a refused renewal etc.
    this.online = false; // signed in to the platform (hosted boards available)
    this.timeOffsetMs = 0; // serverTime - localTime (round-trip adjusted)
    this.timeSyncedAt = 0;
    this.profile = null; // {displayName, userId} from host when available
    this.syncState = 'offline'; // hosted cloud mirror: offline|saving|synced|error
    this.onSyncChange = null;
  }

  /** Running under a StarHermit host shell (the SDK holds a launch token). */
  get hosted() { return !!(this.sh && this.sh.signedIn); }
  get launchToken() { return this.hosted ? this.sh.token : null; } // memory only, never persisted
  get userId() { return this.hosted ? String(this.sh.userId) : null; }
  get gameSlug() { return this.sh ? this.sh.slug : null; } // from game_scope; never hard-coded
  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }

  /* ---------------- boot ---------------- */

  async init() {
    if (typeof window === 'undefined') return;

    if (this.sh) {
      this.sh.init();
      this.sh.on('saved', (ok) => this._setSync(ok ? 'synced' : 'error'));
      this.sh.on('auth', (e) => {
        if (!e.signedIn) { this.profile = null; this.avatarUrl = null; this.online = false; this._setSync('offline'); }
        if (this.onAuthChange) { try { this.onAuthChange(e.signedIn); } catch { /* optional */ } }
      });
    }

    if (this.hosted) {
      this.online = true;
      this.syncState = 'synced';
      await this._loadHostedProfile();
    }
  }

  /** Authoritative-ish now (ms): local clock + server offset when synced. */
  now() {
    return nowMs() + (this.timeOffsetMs || 0);
  }

  /** Signed in only: round-trip-adjusted time sync against GET /api/v1/time. */
  async syncTime() {
    if (!this.hosted) return false;
    const t0 = nowMs();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIME_TIMEOUT_MS) : null;
    try {
      const res = await fetch(TIME_URL, { headers: { Authorization: 'Bearer ' + this.launchToken }, signal: ctrl ? ctrl.signal : undefined });
      const body = res.ok ? await res.json() : null;
      const t1 = nowMs();
      const serverMs = body && typeof body.serverTime === 'number' ? body.serverTime : body && typeof body.now === 'number' ? body.now : body && typeof body.time === 'number' ? body.time : null;
      if (serverMs !== null) {
        this.timeOffsetMs = serverMs - (t0 + (t1 - t0) / 2);
        this.timeSyncedAt = t1;
        return true;
      }
    } catch {
      /* recoverable: keep the local clock */
    } finally {
      if (timer) clearTimeout(timer);
    }
    return false;
  }

  /**
   * Hosted identity: launch tokens cannot call /api/v1/me, so read the public
   * profile by user id. Display the NICKNAME only (never the username);
   * fall back to "Player " + id.slice(0, 8).
   */
  async _loadHostedProfile() {
    this.profile = { displayName: await this.nicknameFor(this.userId), userId: this.userId };
    this.sh.avatarUrl().then((url) => {
      this.avatarUrl = url;
      if (url && this.onSyncChange) { try { this.onSyncChange(this.syncState); } catch { /* optional */ } }
    });
  }

  /** Resolve a user id to a display nickname (SDK-cached). Never a username. */
  async nicknameFor(userId) {
    const id = String(userId);
    const p = this.hosted ? await this.sh.profile(id) : null;
    return p ? p.displayName.slice(0, 24) : 'Player ' + id.slice(0, 6);
  }

  /* ---------------- boards ---------------- */

  /**
   * boards: 'global' | 'friends' | 'daily'. Returns {entries, validated, label}.
   * Standalone there is no remote board (the UI shows local personal bests).
   */
  async fetchBoards({ board = 'global', limit = 25 } = {}) {
    if (!this.hosted) return { entries: [], validated: false, label: 'local-only', localOnly: true };
    return this._fetchHostedBoard(board, limit);
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
      const r = await this.sh.leaderboard(null, { pageSize: Math.min(limit, 100), scope: board === 'friends' ? 'friends' : undefined });
      if (!r || !r.board) return { entries: [], validated: false, label: 'local-only', localOnly: true };
      const entries = [];
      for (const e of (r.items || []).slice(0, limit)) {
        entries.push({
          name: await this.nicknameFor(e.userId),
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
    this._setSync('saving');
    this.sh.saveJSON(doc); // SDK debounces ~2 s
  }

  flushCloudSave() {
    if (!this.hosted) return Promise.resolve(null);
    return this.sh.flushSave(true);
  }

  /**
   * Load the cloud progression document: {doc, savedAt} | null. Hosted: the
   * slot answers application/zip bytes (404 = none). On conflict the remote
   * copy wins when newer (see main.js boot merge). Standalone: null.
   */
  async cloudLoad() {
    if (!this.hosted) return null;
    const doc = await this.sh.loadJSON();
    if (!doc || typeof doc !== 'object') return null;
    return { doc, savedAt: doc._savedAt || null };
  }

  /* ---------------- settings KV, controls, invite (hosted) ---------------- */

  getSettings() { return this.hosted ? this.sh.getSettings() : Promise.resolve({}); }
  patchSettings(obj) { if (this.hosted) this.sh.patchSettings(obj); }
  /** defaults: {action: [code, …]} → the player's effective bindings. */
  loadBindings(defaults) {
    return this.hosted ? this.sh.loadBindings(defaults) : Promise.resolve(JSON.parse(JSON.stringify(defaults)));
  }
  setControl(action, codes) { return this.hosted ? this.sh.setControl(action, codes).catch(() => null) : Promise.resolve(null); }
  resetControls() { return this.hosted ? this.sh.resetControls() : Promise.resolve(null); }
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }
}
