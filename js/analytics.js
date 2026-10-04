/**
 * analytics.js — consent-gated anonymous funnel telemetry for Jewel Cascade.
 *
 * Funnel ONLY (spec §6/§8): 'start', 'tutorial_step', 'round_end', 'retry',
 * 'settings_change', 'error'. Random per-load session id; events are buffered
 * in memory (max 200) only when telemetryConsent is given. Nothing is ever
 * sent: the platform has no telemetry route and standalone play makes no
 * network request, so flush() just drops the batch.
 * Session duration is reported as coarse bands, never raw timestamps.
 * No PII, no raw text, no pointer trails.
 *
 * Import-safe in Node: no top-level window/document access.
 */

const FUNNEL = new Set(['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error']);

/** Keys matching this are dropped client-side as a PII backstop. */
const PII_KEY_RE = /text|name|message|token|email|auth/i;

const BUFFER_MAX = 200;
const FLUSH_THRESHOLD = 25;

function randomSessionId() {
  try {
    const bytes = new Uint8Array(8);
    (globalThis.crypto || {}).getRandomValues(bytes);
    return 's-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 's-' + Math.floor(Math.random() * 0xffffffff).toString(16);
  }
}

/** Coarse duration band from session start; never a raw timestamp. */
function durationBand(startedAt) {
  const mins = Math.floor((Date.now() - startedAt) / 60000);
  if (mins < 1) return '0-1m';
  if (mins < 5) return '1-5m';
  if (mins < 15) return '5-15m';
  if (mins < 30) return '15-30m';
  if (mins < 60) return '30-60m';
  return '60m+';
}

function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const k of Object.keys(props)) {
    if (PII_KEY_RE.test(k)) continue;
    const v = props[k];
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 64);
    }
    // objects/arrays/functions are dropped — aggregate scalars only
  }
  return out;
}

export class Analytics {
  constructor({ platform, storage, settings } = {}) {
    this.platform = platform || null;
    this.storage = storage || null; // reserved (no persisted analytics in v1)
    this.settings = settings || {};
    this.sessionId = randomSessionId();
    this.startedAt = Date.now();
    this.buffer = [];
    this._onPageHide = null;
    if (typeof window !== 'undefined') {
      this._onPageHide = () => this.flush();
      window.addEventListener('pagehide', this._onPageHide);
    }
  }

  get consent() {
    return !!(this.settings && this.settings.privacy && this.settings.privacy.telemetryConsent);
  }

  setConsent(b) {
    if (this.settings && this.settings.privacy) this.settings.privacy.telemetryConsent = !!b;
    if (!b) this.buffer.length = 0; // consent withdrawn: drop what we held
  }

  /**
   * Track a funnel event. Non-whitelisted events are ignored. Safe to call
   * without consent — events simply never leave the device.
   */
  track(event, props) {
    if (!FUNNEL.has(event)) return;
    if (!this.consent) return;
    this.buffer.push({ event, props: sanitizeProps(props), band: durationBand(this.startedAt) });
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    if (this.buffer.length >= FLUSH_THRESHOLD) this.flush();
  }

  /** Drop the buffered batch (no telemetry route exists; nothing leaves the device). */
  flush() {
    this.buffer.length = 0;
    return false;
  }

  dispose() {
    if (typeof window !== 'undefined' && this._onPageHide) {
      window.removeEventListener('pagehide', this._onPageHide);
      this._onPageHide = null;
    }
    this.buffer.length = 0;
  }
}
