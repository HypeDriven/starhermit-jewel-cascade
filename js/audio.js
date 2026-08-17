/**
 * audio.js — Jewel Cascade audio engine.
 *
 * Fully synthesized WebAudio (no audio files). Everything is silent until
 * unlock() is called from a user gesture; before that every public method is
 * a no-op. Buses: master ← {music, effects, ambience, voice}; per-bus gains
 * come from settings.audio, master carries the mute.
 *
 * Determinism: all cosmetic pitch/variant choices draw from seeded Rng
 * streams (fnv1a keys), never Math.random, so replays sound identical.
 * No per-frame allocations: a small always-running oscillator pool serves
 * the frequent sounds (ticks, chimes); the noise buffer is preallocated once.
 *
 * Import-safe in Node: no top-level window/document/AudioContext access.
 */

import { Rng, fnv1a } from './engine/rng.js';

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

const SPECIAL_RAY_H = 1;
const SPECIAL_RAY_V = 2;
const SPECIAL_BLOOM = 3;
const SPECIAL_PRISM = 4;

/** Pad chord roots (Hz) per ambience key. */
const AMBIENCE_ROOTS = {
  hearth: 196.0, // G3 — warm
  night: 174.61, // F3 — hushed
  garden: 220.0, // A3 — open
  frost: 233.08, // Bb3 — cold shimmer
  velvet: 207.65, // Ab3 — plush
};
const DEFAULT_AMBIENCE = 'hearth';

/** Major pentatonic semitone offsets used by the generative pluck stem. */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];

const PAD_GAIN = 0.05;
const SCHED_LOOKAHEAD_S = 1.2; // how far ahead the music sequencer schedules
const SCHED_TICK_MS = 250; // scheduler wake interval
const INTENSITY_DECAY_TAU_S = 3; // cascade bump decays toward base over ~3s
const TICK_MIN_GAP_S = 0.055; // rate limit for fall/spawn ticks
const TICK_MAX_PER_SECOND = 14;

const semitone = (base, n) => base * Math.pow(2, n / 12);

/* ------------------------------------------------------------------ *
 *  Voice pool — always-running oscillators, reused; no per-sound allocs.
 * ------------------------------------------------------------------ */

class VoicePool {
  constructor(ctx, destination, size, type) {
    this.voices = [];
    for (let i = 0; i < size; i++) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 8000;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(destination);
      osc.start();
      this.voices.push({ osc, filter, gain, busyUntil: 0 });
    }
  }

  /** Oldest finished voice, or null when all are busy (steal-free). */
  acquire(now) {
    let best = null;
    for (const v of this.voices) {
      if (v.busyUntil <= now) return v;
      if (!best || v.busyUntil < best.busyUntil) best = v;
    }
    return null; // all busy: drop the sound rather than steal mid-envelope
  }

  dispose() {
    for (const v of this.voices) {
      try {
        v.osc.stop();
        v.osc.disconnect();
        v.filter.disconnect();
        v.gain.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.voices.length = 0;
  }
}

/* ------------------------------------------------------------------ *
 *  AudioEngine
 * ------------------------------------------------------------------ */

export class AudioEngine {
  constructor({ settings } = {}) {
    this.settings = settings || {};
    this.ctx = null;
    this.buses = null; // {master, music, effects, ambience, voice}
    this.musicLayers = null; // {calm, intense} gains under music bus
    this.pool = null;
    this.noiseBuffer = null;

    this.captionsEnabled = false;
    this.onCaption = null; // cb(text)

    this.ambienceKey = null;
    this.pad = null; // {oscA, oscB, lfo, lfoGain, filter, gain}
    this.pluckPattern = null; // seeded note sequence for the calm stem
    this.pluckStep = 0;
    this.nextNoteTime = 0;

    this.baseIntensity = 0; // set via setScene
    this.bump = 0; // transient cascade excitement, decays to 0
    this.intensity = 0; // smoothed value driving the layer crossfade
    this._schedTimer = null;
    this._lastSchedWall = 0;

    this._lastTickAt = 0;
    this._tickWindowStart = 0;
    this._tickCount = 0;
    this._lastTimerSecond = -1;

    this._rngFx = new Rng(fnv1a('jc-audio-fx'));
    this._suspended = false;
  }

  /* ---------------- lifecycle ---------------- */

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  unlock() {
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this._suspended = false;
    this._startScheduler();
  }

  _buildGraph() {
    const ctx = this.ctx;
    const mk = () => {
      const g = ctx.createGain();
      return g;
    };
    const master = mk();
    master.connect(ctx.destination);
    const buses = { master, music: mk(), effects: mk(), ambience: mk(), voice: mk() };
    for (const k of ['music', 'effects', 'ambience', 'voice']) buses[k].connect(master);
    this.buses = buses;

    // Adaptive music layers under the music bus.
    const calm = mk();
    const intense = mk();
    calm.connect(buses.music);
    intense.connect(buses.music);
    calm.gain.value = 0.5;
    intense.gain.value = 0;
    this.musicLayers = { calm, intense };

    this.pool = new VoicePool(ctx, buses.effects, 12, 'sine');

    // Preallocated deterministic noise buffer (seeded — replays sound alike).
    const len = Math.floor(ctx.sampleRate * 1.0);
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    const nrng = new Rng(fnv1a('jc-audio-noise'));
    for (let i = 0; i < len; i++) data[i] = nrng.next() * 2 - 1;

    this.applyVolumes();
    if (this.ambienceKey) this._startPad(this.ambienceKey);
    this.nextNoteTime = ctx.currentTime + 0.1;
  }

  get ready() {
    return !!(this.ctx && this.buses);
  }

  _audible() {
    return this.ready && this.ctx.state === 'running' && !this._suspended;
  }

  /* ---------------- volumes / mute ---------------- */

  applyVolumes() {
    if (!this.buses) return;
    const a = (this.settings && this.settings.audio) || {};
    const t = this.ctx.currentTime;
    const set = (bus, v) => {
      const target = Math.max(0, Math.min(1, typeof v === 'number' ? v : 1));
      bus.gain.cancelScheduledValues(t);
      bus.gain.setTargetAtTime(target, t, 0.03);
    };
    set(this.buses.music, a.music !== undefined ? a.music : 0.65);
    set(this.buses.effects, a.effects !== undefined ? a.effects : 0.9);
    set(this.buses.ambience, a.ambience !== undefined ? a.ambience : 0.55);
    set(this.buses.voice, a.voice !== undefined ? a.voice : 0.8);
    const masterVol = a.muted ? 0 : a.master !== undefined ? a.master : 0.8;
    set(this.buses.master, masterVol);
  }

  setVolumes(audioSettings) {
    if (this.settings) this.settings.audio = { ...(this.settings.audio || {}), ...(audioSettings || {}) };
    this.applyVolumes();
  }

  setMuted(b) {
    if (this.settings && this.settings.audio) this.settings.audio.muted = !!b;
    this.applyVolumes();
  }

  setCaptionsEnabled(b) {
    this.captionsEnabled = !!b;
  }

  _caption(text) {
    if (this.captionsEnabled && typeof this.onCaption === 'function') {
      try {
        this.onCaption(text);
      } catch {
        /* UI callback must never break audio */
      }
    }
  }

  /* ---------------- low-level synth helpers ---------------- */

  /**
   * Pooled tone. opts: {freq, freqEnd, dur, gain, type ignored (pool is sine),
   * filter, at, bus}. Schedules a percussive envelope via ctx.currentTime.
   */
  _tone({ freq, freqEnd = 0, dur = 0.15, gain = 0.2, filter = 8000, at = 0, destination = null }) {
    if (!this._audible()) return;
    const t = this.ctx.currentTime + at;
    const v = this.pool.acquire(t);
    if (!v) return;
    v.busyUntil = t + dur + 0.05;
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(gain, t + 0.008);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(Math.max(1, freq), t);
    if (freqEnd > 0) v.osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    v.filter.frequency.cancelScheduledValues(t);
    v.filter.frequency.setValueAtTime(filter, t);
  }

  /** One-shot filtered noise burst (rare sounds only — buffer sources are cheap). */
  _noise({ dur = 0.25, gain = 0.25, type = 'bandpass', freq = 1200, freqEnd = 0, q = 1, at = 0, destination = null }) {
    if (!this._audible()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd > 0) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(destination || this.buses.effects);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = () => {
      try {
        src.disconnect();
        f.disconnect();
        g.disconnect();
      } catch {
        /* noop */
      }
    };
  }

  /* ---------------- named game sounds ---------------- */

  _soundSwap() {
    this._tone({ freq: 660, dur: 0.045, gain: 0.1, filter: 2400 });
    this._tone({ freq: 520, dur: 0.05, gain: 0.09, filter: 2200, at: 0.055 });
  }

  _soundReject() {
    this._tone({ freq: 130, freqEnd: 105, dur: 0.18, gain: 0.16, filter: 700 });
    this._tone({ freq: 138, freqEnd: 110, dur: 0.18, gain: 0.1, filter: 700 });
    this._caption('[low buzz]');
    this.vibrate(20);
  }

  _soundMatch(cascade) {
    const c = Math.max(1, cascade || 1);
    const base = 523.25 * Math.pow(1.09, Math.min(c - 1, 8)); // pitch rises with cascade
    const steps = [0, 4, 7];
    for (let i = 0; i < steps.length; i++) {
      this._tone({ freq: semitone(base, steps[i]), dur: 0.16, gain: 0.14, filter: 4200, at: i * 0.055 });
    }
    this._caption(c > 1 ? '[chime rising x' + c + ']' : '[chime]');
    this.vibrate(15);
    if (c > 1) this._bumpIntensity(0.12 * (c - 1));
  }

  _soundCreate(kind) {
    // Sparkle gliss; variant per special kind.
    const roots = { [SPECIAL_RAY_H]: 780, [SPECIAL_RAY_V]: 880, [SPECIAL_BLOOM]: 660, [SPECIAL_PRISM]: 990 };
    const f0 = roots[kind] || 760;
    const v = this._rngFx.int(3); // seeded variant: replays sound identical
    this._tone({ freq: f0, freqEnd: f0 * 2, dur: 0.28, gain: 0.12, filter: 6000, at: 0 });
    this._tone({ freq: f0 * 1.5, freqEnd: f0 * 3, dur: 0.22, gain: 0.08, filter: 7000, at: 0.05 + v * 0.02 });
    this._caption('[sparkle]');
  }

  _soundBlast(kind) {
    const big = kind === SPECIAL_BLOOM || kind === SPECIAL_PRISM;
    this._noise({ dur: big ? 0.4 : 0.22, gain: big ? 0.3 : 0.2, freq: big ? 900 : 1400, freqEnd: 300, q: 0.8 });
    this._tone({ freq: big ? 65 : 80, freqEnd: 40, dur: big ? 0.5 : 0.32, gain: big ? 0.3 : 0.2, filter: 300 });
    this._caption(big ? '[big blast]' : '[blast]');
    this.vibrate(big ? [20, 30, 20] : 15);
    if (big) this._bumpIntensity(0.2);
  }

  _soundCrack() {
    for (let i = 0; i < 3; i++) {
      this._noise({ dur: 0.03, gain: 0.08, type: 'highpass', freq: 3200, q: 1.5, at: i * 0.03 });
    }
    this._caption('[ice crack]');
  }

  _soundKnock(broke) {
    this._tone({ freq: broke ? 150 : 190, freqEnd: 90, dur: 0.1, gain: 0.18, filter: 900 });
    this._noise({ dur: 0.05, gain: 0.1, freq: 800, q: 2 });
    if (broke) this._tone({ freq: 120, freqEnd: 70, dur: 0.14, gain: 0.16, filter: 800, at: 0.07 });
    if (broke) this._caption('[crate breaks]');
  }

  _soundSoftTick(spawn) {
    // Quiet + rate-limited so cascades never become noise walls.
    const now = this.ctx.currentTime;
    if (now - this._lastTickAt < TICK_MIN_GAP_S) return;
    if (now - this._tickWindowStart >= 1) {
      this._tickWindowStart = now;
      this._tickCount = 0;
    }
    if (this._tickCount >= TICK_MAX_PER_SECOND) return;
    this._tickCount++;
    this._lastTickAt = now;
    this._tone({ freq: spawn ? 1050 : 880, dur: 0.03, gain: 0.028, filter: 3600 });
  }

  _soundShuffle() {
    this._noise({ dur: 0.6, gain: 0.14, freq: 400, freqEnd: 2800, q: 4 });
    this._noise({ dur: 0.5, gain: 0.1, freq: 2400, freqEnd: 350, q: 4, at: 0.18 });
    this._caption('[swirl]');
  }

  _soundGoal() {
    this._tone({ freq: 880, dur: 0.9, gain: 0.16, filter: 4000 });
    this._tone({ freq: 1318.5, dur: 0.7, gain: 0.07, filter: 5000, at: 0.01 });
    this._caption('[warm bell]');
  }

  _soundWin() {
    // Short original 4-note motif: E5 – G5 – C6 – E6.
    const motif = [659.25, 783.99, 1046.5, 1318.5];
    const times = [0, 0.14, 0.28, 0.46];
    for (let i = 0; i < motif.length; i++) {
      this._tone({ freq: motif[i], dur: i === 3 ? 0.55 : 0.16, gain: 0.16, filter: 5000, at: times[i] });
      this._tone({ freq: motif[i] * 2, dur: i === 3 ? 0.4 : 0.1, gain: 0.05, filter: 6000, at: times[i] });
    }
    this._caption('[win fanfare]');
    this.vibrate([30, 40, 30]);
    this._bumpIntensity(0.5);
  }

  _soundLose() {
    const seq = [392, 329.63, 261.63];
    for (let i = 0; i < seq.length; i++) {
      this._tone({ freq: seq[i], dur: 0.35, gain: 0.1, filter: 2400, at: i * 0.22 });
    }
    this._caption('[soft descending tone]');
  }

  /* ---------------- rules event mapping ---------------- */

  /**
   * Map a deterministic rules event stream to sounds. `state` is accepted for
   * API symmetry with the renderer (currently unused — sounds key off events).
   */
  handleRulesEvents(events, state) {
    if (!this.ready) return;
    for (const e of events) {
      switch (e.t) {
        case 'swap':
          this._soundSwap();
          break;
        case 'swap-back':
        case 'reject':
          this._soundReject();
          break;
        case 'match':
          this._soundMatch(e.cascade);
          break;
        case 'create':
          this._soundCreate(e.s);
          break;
        case 'blast':
          this._soundBlast(e.s);
          break;
        case 'crack':
          this._soundCrack();
          break;
        case 'damage':
          this._soundKnock(false);
          break;
        case 'crate-break':
          this._soundKnock(true);
          break;
        case 'fall':
          this._soundSoftTick(false);
          break;
        case 'spawn':
          this._soundSoftTick(true);
          break;
        case 'shuffle':
          this._soundShuffle();
          break;
        case 'goal':
          if (e.done) this._soundGoal();
          break;
        case 'prism-swap':
          this._soundBlast(SPECIAL_PRISM);
          break;
        case 'end':
          if (e.reason === 'goals-complete') this._soundWin();
          else this._soundLose();
          break;
        default:
          break; // turn / undo / remove carry no dedicated sound
      }
    }
  }

  /* ---------------- UI sounds ---------------- */

  /** name: 'open' | 'close' | 'confirm' | 'back' | 'error' | 'tick' */
  uiSound(name) {
    if (!this._audible()) return;
    switch (name) {
      case 'open':
        this._tone({ freq: 440, freqEnd: 660, dur: 0.09, gain: 0.08, filter: 3000 });
        break;
      case 'close':
        this._tone({ freq: 620, freqEnd: 430, dur: 0.09, gain: 0.08, filter: 3000 });
        break;
      case 'confirm':
        this._tone({ freq: 523.25, dur: 0.09, gain: 0.1, filter: 3400 });
        this._tone({ freq: 784, dur: 0.14, gain: 0.1, filter: 3400, at: 0.07 });
        break;
      case 'back':
        this._tone({ freq: 392, dur: 0.08, gain: 0.08, filter: 2600 });
        break;
      case 'error':
        this._soundReject();
        break;
      case 'tick':
        this._tone({ freq: 1180, dur: 0.035, gain: 0.05, filter: 4200 });
        break;
      default:
        break;
    }
  }

  /**
   * Timed-round warning: call from the session 'timer' event. Ticks once per
   * second while under 10s remain.
   */
  timerUpdate(leftMs) {
    if (!this._audible() || leftMs == null) return;
    if (leftMs > 10000 || leftMs <= 0) {
      this._lastTimerSecond = -1;
      return;
    }
    const sec = Math.ceil(leftMs / 1000);
    if (sec !== this._lastTimerSecond) {
      this._lastTimerSecond = sec;
      this.uiSound('tick');
      if (sec <= 3) this._caption('[time warning]');
    }
  }

  /* ---------------- haptics ---------------- */

  /** Vibration wrapper honoring settings.input.haptics. */
  vibrate(pattern) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    const input = (this.settings && this.settings.input) || {};
    if (input.haptics === false) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* unsupported pattern — ignore */
    }
  }

  /* ---------------- ambience + adaptive music ---------------- */

  /** Quiet generative pad; per-key chord roots. */
  setAmbience(key) {
    const k = AMBIENCE_ROOTS[key] ? key : DEFAULT_AMBIENCE;
    if (k === this.ambienceKey) return;
    this.ambienceKey = k;
    // Reseed the pluck stem per ambience: same ambience → same melody.
    const r = new Rng(fnv1a('music-' + k));
    const pattern = [];
    for (let i = 0; i < 16; i++) {
      pattern.push(r.next() < 0.68 ? PENTA[r.int(PENTA.length)] : null); // null = rest
    }
    this.pluckPattern = pattern;
    this.pluckStep = 0;
    if (this.ready) this._startPad(k);
  }

  _startPad(key) {
    this._stopPad();
    const ctx = this.ctx;
    const root = AMBIENCE_ROOTS[key];
    const t = ctx.currentTime;
    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.value = root;
    oscA.detune.value = -4;
    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = root * 1.5; // fifth above
    oscB.detune.value = 4;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 620;
    filter.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.setTargetAtTime(PAD_GAIN, t, 1.2); // slow fade-in
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = PAD_GAIN * 0.45;
    lfo.connect(lfoGain).connect(gain.gain);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain).connect(this.buses.ambience);
    oscA.start();
    oscB.start();
    lfo.start();
    this.pad = { oscA, oscB, lfo, lfoGain, filter, gain };
  }

  _stopPad() {
    if (!this.pad) return;
    const p = this.pad;
    const t = this.ctx.currentTime;
    try {
      p.gain.gain.cancelScheduledValues(t);
      p.gain.gain.setTargetAtTime(0, t, 0.15);
      for (const o of [p.oscA, p.oscB, p.lfo]) o.stop(t + 0.6);
      setTimeout(() => {
        try {
          p.oscA.disconnect();
          p.oscB.disconnect();
          p.lfo.disconnect();
          p.lfoGain.disconnect();
          p.filter.disconnect();
          p.gain.disconnect();
        } catch {
          /* noop */
        }
      }, 800);
    } catch {
      /* already stopped */
    }
    this.pad = null;
  }

  /** Adaptive layer: 0 calm .. 1 intense. Cascades add a decaying bump. */
  setScene(intensity) {
    this.baseIntensity = Math.max(0, Math.min(1, intensity || 0));
  }

  _bumpIntensity(amount) {
    this.bump = Math.min(1, this.bump + amount);
  }

  _startScheduler() {
    if (this._schedTimer || !this.ctx) return;
    this._lastSchedWall = Date.now();
    this._schedTimer = setInterval(() => this._scheduleMusic(), SCHED_TICK_MS);
  }

  _stopScheduler() {
    if (this._schedTimer) {
      clearInterval(this._schedTimer);
      this._schedTimer = null;
    }
  }

  /**
   * Lookahead sequencer. Runs every SCHED_TICK_MS; schedules pluck notes on
   * ctx.currentTime up to SCHED_LOOKAHEAD_S ahead. Calm stem plays on a 0.5s
   * grid; the intensity layer doubles the grid (0.25s) and is crossfaded in
   * by the smoothed intensity value.
   */
  _scheduleMusic() {
    if (!this._audible() || !this.pluckPattern) return;
    const ctx = this.ctx;

    // Smooth intensity toward base+bump; bump decays with ~3s time constant.
    const now = Date.now();
    const dt = Math.min(1, (now - this._lastSchedWall) / 1000);
    this._lastSchedWall = now;
    this.bump *= Math.exp(-dt / INTENSITY_DECAY_TAU_S);
    const target = Math.max(0, Math.min(1, this.baseIntensity + this.bump));
    this.intensity += (target - this.intensity) * Math.min(1, dt * 3);

    const t = ctx.currentTime;
    const setX = (g, v) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(v, t, 0.25);
    };
    setX(this.musicLayers.calm, 0.5 * (1 - this.intensity * 0.55));
    setX(this.musicLayers.intense, 0.42 * this.intensity);

    const root = AMBIENCE_ROOTS[this.ambienceKey] || AMBIENCE_ROOTS[DEFAULT_AMBIENCE];
    const base = root * 2;
    const horizon = t + SCHED_LOOKAHEAD_S;
    if (this.nextNoteTime < t - 1) this.nextNoteTime = t + 0.05; // resync after suspend
    while (this.nextNoteTime < horizon) {
      const at = this.nextNoteTime - t;
      const degree = this.pluckPattern[this.pluckStep % this.pluckPattern.length];
      if (degree !== null && degree !== undefined) {
        const f = semitone(base, degree);
        // Calm pluck on the 0.5s grid.
        this._pluck(f, at, this.musicLayers.calm, 0.16);
        // Intensity layer: an extra off-grid arp note, audible via crossfade.
        if (this.intensity > 0.05) {
          this._pluck(semitone(f, 7), at + 0.25, this.musicLayers.intense, 0.1);
        }
      }
      this.pluckStep++;
      this.nextNoteTime += 0.5;
    }
  }

  /** Pluck voice routed to a music layer (not the effects pool). */
  _pluck(freq, at, destination, gain) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + Math.max(0, at);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(g).connect(destination);
    osc.start(t);
    osc.stop(t + 0.55);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* noop */
      }
    };
  }

  /* ---------------- suspend / resume / dispose ---------------- */

  /** Tab hidden: stop scheduling and suspend the context cleanly. */
  suspend() {
    this._suspended = true;
    this._stopScheduler();
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    this._suspended = false;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.ctx) {
      this.nextNoteTime = this.ctx.currentTime + 0.1;
      this._startScheduler();
    }
  }

  dispose() {
    this._stopScheduler();
    if (this.pad) this._stopPad();
    if (this.pool) this.pool.dispose();
    if (this.ctx) {
      try {
        for (const k of ['music', 'effects', 'ambience', 'voice', 'master']) this.buses[k].disconnect();
      } catch {
        /* noop */
      }
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.buses = null;
    this.pool = null;
    this.musicLayers = null;
  }
}
