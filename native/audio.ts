// Sound, as the browser build's js/audio.js: the 37 recorded one-shots
// (sfx/<name>.opus) for the named UI sounds and rules events, the captions
// ("[chime rising x2]", "[big blast]", …) handed to the screens, the device
// vibration on rejects, chimes and blasts, the 10-second timer warning, and
// the quiet music: a per-theme pad chord (hearth G3, night F3, garden A3,
// frost B♭3, velvet A♭3: two detuned sines a fifth apart through a lowpass,
// breathing with a 0.09 Hz LFO) under a generative major-pentatonic pluck
// stem (16 seeded steps on a 0.5 s grid, the same melody per theme) with an
// intensity layer (an off-grid arp a fifth up) crossfaded in by cascade depth
// and decaying back over ~3 s. The browser build ran the pad and the plucks
// as live oscillators; here each is rendered once into a seamless loop
// (OfflineAudioContext, one context a stem) and played looping on the music
// bus. The quiet fall/spawn ticks and the crate thud were synth-only by
// design: they are rendered into short clips too.
//
// The browser build's Master / Music / Effects / Ambience / Voice sliders are
// the runtime's Options (music, effects and interface buses, mute, voice
// limit); its old bus balance is folded into the gains here. The M key still
// silences the game's own sounds (Settings › Mute game sounds; the engine's
// game-level setMuted, the option stays in the settings). The synthesized
// stand-ins it played while a clip loaded are not ported. Every clip and voice
// loads at once in onStart; sounds and the music wait for the mixer to run (in
// a browser, after the first press).
import { frame } from "starhermit:engine";
import { vibrate as deviceVibrate } from "starhermit:input";
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, setMuted as setGameMuted, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { Rng, type RulesEvent } from "./game.ts";

const SPECIAL_RAY_H = 1, SPECIAL_RAY_V = 2, SPECIAL_BLOOM = 3, SPECIAL_PRISM = 4;
void SPECIAL_RAY_H; void SPECIAL_RAY_V;

/** UI sound name → recorded file (js/audio.js UI_SFX). */
const UI_SFX: Record<string, string> = {
  open: "ui-modal-open", close: "ui-modal-close", confirm: "ui-confirm", back: "ui-back", click: "ui-click", hover: "ui-hover",
  toggle: "ui-toggle", tab: "ui-tab-switch", scroll: "ui-scroll-tick", toast: "ui-toast", success: "ui-success", pause: "ui-pause",
  resume: "ui-resume", saved: "ui-settings-saved", select: "gem-select", hint: "hint-reveal", undo: "undo", star: "star-reveal",
  record: "new-record", warn: "ui-timer-warning", tick: "ui-countdown-tick", win: "level-complete", lose: "level-fail",
};
/** Menu sounds play on the interface bus; the rest are effects. */
const INTERFACE = new Set(["ui-modal-open", "ui-modal-close", "ui-confirm", "ui-back", "ui-click", "ui-hover", "ui-toggle", "ui-tab-switch",
  "ui-scroll-tick", "ui-toast", "ui-pause", "ui-resume", "ui-settings-saved", "ui-countdown-tick"]);
/** The recorded clips. */
const FILES = [
  "gem-select", "gem-swap", "match-chime", "ui-error", "ui-click", "ui-confirm", "ui-countdown-tick", "combo-tier-2", "combo-tier-3",
  "cascade", "special-forge", "ray-fire", "bloom-burst", "prism-burst", "ice-crack", "crate-break", "board-shuffle", "goal-complete",
  "level-complete", "level-fail", "star-reveal", "new-record", "hint-reveal", "undo", "ui-back", "ui-modal-open", "ui-modal-close",
  "ui-toggle", "ui-tab-switch", "ui-scroll-tick", "ui-toast", "ui-success", "ui-pause", "ui-resume", "ui-settings-saved",
  "ui-timer-warning", "ui-hover",
];

const clips = new Map<string, AudioClip>();
/** Loads every clip at once (onStart); a sound whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of FILES) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  void loadVoices();
}

let muted = false;
let suspended = false;
/** The game's own mute (the M key / Settings), on top of the runtime's volumes. */
export function setMuted(on: boolean): void {
  muted = on;
  setGameMuted(on);
}
/** A hidden window: the loops fall silent (js/audio.js suspend/resume). */
export function setSuspended(on: boolean): void {
  suspended = on;
  applyLoopGains(0.2);
}
const audible = (): boolean => !suspended && context.state === "running";

function playFile(name: string, gain = 1): boolean {
  if (!audible()) return false;
  const clip = clips.get(name);
  if (!clip) return false;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain }); return true; }
  catch { return false; } // the mixer is full this frame: skip it
}

// -- captions and vibration ----------------------------------------------------------------------
let onCaption: ((key: string, vars?: Record<string, string | number>) => void) | null = null;
/** fn(key, vars) for each sound's caption (the screens show it while captions are on). */
export function setOnCaption(fn: (key: string, vars?: Record<string, string | number>) => void): void { onCaption = fn; }
function caption(key: string, vars?: Record<string, string | number>): void { if (onCaption) onCaption(key, vars); }
function vibrate(ms: number | number[]): void {
  if (muted) return;
  const total = Array.isArray(ms) ? ms.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) : ms;
  try { deviceVibrate(total); } catch { /* not on this device */ }
}

// -- rendered voices: fall/spawn ticks and the crate thud ------------------------------------------
const TICK_RATE = 22050;
/** A sine with an 8 ms attack and an exponential decay to 0.0001, sweeping to freqEnd when given. */
async function renderTone(freq: number, dur: number, gain: number, freqEnd = 0): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(dur * TICK_RATE), TICK_RATE);
  const osc = off.createOscillator();
  osc.frequency.setValueAtTime(freq, 0);
  if (freqEnd > 0) osc.frequency.exponentialRampToValueAtTime(freqEnd, dur);
  const env = off.createGain();
  env.gain.setValueAtTime(0, 0);
  env.gain.linearRampToValueAtTime(gain, 0.008);
  env.gain.exponentialRampToValueAtTime(gain * 0.0001, dur);
  osc.connect(env).connect(off.destination);
  osc.start();
  return createClip(await off.startRendering());
}
let tickFall: AudioClip | null = null, tickSpawn: AudioClip | null = null, thud: AudioClip | null = null;
async function loadVoices(): Promise<void> {
  try {
    [tickFall, tickSpawn, thud] = await Promise.all([
      renderTone(880, 0.03, 0.028 * 2), renderTone(1050, 0.03, 0.028 * 2), renderTone(190, 0.1, 0.18 * 1.6, 90),
    ]);
  } catch (e) { console.warn(`audio: ${String(e)}`); }
}
let lastTickAt = 0, tickWindowStart = 0, tickCount = 0;
/** Quiet and rate-limited (14 a second, 55 ms apart) so cascades never become a noise wall. */
function softTick(spawn: boolean): void {
  const now = frame().time;
  if (now - lastTickAt < 0.055) return;
  if (now - tickWindowStart >= 1) { tickWindowStart = now; tickCount = 0; }
  if (tickCount >= 14) return;
  const clip = spawn ? tickSpawn : tickFall;
  if (!clip || !audible()) return;
  tickCount++;
  lastTickAt = now;
  try { playClip(clip, { bus: "effects" }); } catch { /* voice limit */ }
}

// -- named game sounds (js/audio.js) ----------------------------------------------------------------
function soundReject(): void { playFile("ui-error"); caption("[low buzz]"); vibrate(20); }
function soundMatch(cascade: number): void {
  const c = Math.max(1, cascade || 1);
  playFile(c >= 3 ? "combo-tier-3" : c === 2 ? "combo-tier-2" : "match-chime");
  if (c > 1) caption("[chime rising x{n}]", { n: c }); else caption("[chime]");
  vibrate(15);
  if (c > 1) bumpIntensity(0.12 * (c - 1));
}
function soundBlast(kind: number): void {
  const big = kind === SPECIAL_BLOOM || kind === SPECIAL_PRISM;
  playFile(kind === SPECIAL_BLOOM ? "bloom-burst" : kind === SPECIAL_PRISM ? "prism-burst" : "ray-fire");
  caption(big ? "[big blast]" : "[blast]");
  vibrate(big ? [20, 30, 20] : 15);
  if (big) bumpIntensity(0.2);
}
function soundWin(): void { playFile("level-complete"); caption("[win fanfare]"); vibrate([30, 40, 30]); bumpIntensity(0.5); }
function soundLose(): void { playFile("level-fail"); caption("[soft descending tone]"); }

/** A deterministic rules event stream as sounds (js/audio.js handleRulesEvents). */
export function rulesEvents(events: readonly RulesEvent[]): void {
  if (events.some((e) => e.t === "match" && (e.cascade || 1) >= 2)) playFile("cascade");
  for (const e of events) {
    switch (e.t) {
      case "swap": playFile("gem-swap"); break;
      case "swap-back": case "reject": soundReject(); break;
      case "match": soundMatch(e.cascade ?? 1); break;
      case "create": playFile("special-forge"); caption("[sparkle]"); break;
      case "blast": soundBlast(e.s ?? 0); break;
      case "crack": playFile("ice-crack"); caption("[ice crack]"); break;
      case "damage": if (thud && audible()) { try { playClip(thud, { bus: "effects" }); } catch { /* limit */ } } break;
      case "crate-break": playFile("crate-break"); caption("[crate breaks]"); break;
      case "fall": softTick(false); break;
      case "spawn": softTick(true); break;
      case "shuffle": playFile("board-shuffle"); caption("[swirl]"); break;
      case "goal": if (e.done) { playFile("goal-complete"); caption("[warm bell]"); } break;
      case "prism-swap": soundBlast(SPECIAL_PRISM); break;
      case "end": if (e.reason === "goals-complete") soundWin(); else soundLose(); break;
      default: break;
    }
  }
}
/** A named UI sound (js/audio.js uiSound). */
export function cue(name: string): void {
  if (name === "error") { soundReject(); return; }
  if (name === "win") { soundWin(); return; }
  if (name === "lose") { soundLose(); return; }
  const file = UI_SFX[name];
  if (file) playFile(file);
}
let lastTimerSecond = -1;
/** Timed rounds: one warning pulse a second under 10 s left. */
export function timerUpdate(leftMs: number | null): void {
  if (leftMs == null || leftMs > 10000 || leftMs <= 0) { lastTimerSecond = -1; return; }
  const sec = Math.ceil(leftMs / 1000);
  if (sec !== lastTimerSecond) {
    lastTimerSecond = sec;
    cue("warn");
    if (sec <= 3) caption("[time warning]");
  }
}

// -- the music: pad + pluck stem per ambience, rendered into loops ------------------------------------
const AMBIENCE_ROOTS: Record<string, number> = { hearth: 196.0, night: 174.61, garden: 220.0, frost: 233.08, velvet: 207.65 };
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
const semitone = (base: number, n: number): number => base * Math.pow(2, n / 12);
/** The old bus balance (music 0.65, ambience 0.55 under the runtime's music bus). */
const PAD_GAIN = 0.05 * (0.55 / 0.65);
const PAD_RATE = 11025, PLUCK_RATE = 22050;
const PAD_S = 1 / 0.09, PLUCK_S = 8;

interface Loops { pad: AudioClip; calm: AudioClip; intense: AudioClip }
const rendered = new Map<string, Loops>();
const rendering = new Set<string>();

function pattern(key: string): (number | null)[] {
  const r = new Rng.Rng(Rng.fnv1a("music-" + key));
  const out: (number | null)[] = [];
  for (let i = 0; i < 16; i++) out.push(r.next() < 0.68 ? PENTA[r.int(PENTA.length)]! : null);
  return out;
}
/** Two sines a fifth apart (−4 / +4 cents), each rounded to whole cycles in the loop, through a
 * lowpass at 620 Hz (Q −6.02 dB: the old two one-poles); the gain breathes ±45 % at 0.09 Hz.
 * Two passes over the loop, the second kept: the filter has settled, so the seam doesn't click. */
async function renderPad(root: number): Promise<AudioClip> {
  const N = Math.round(PAD_S * PAD_RATE);
  const off = new OfflineAudioContext(1, 2 * N, PAD_RATE);
  const lp = off.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 620; lp.Q.value = -6.02;
  const breath = off.createGain();
  breath.gain.value = PAD_GAIN;
  const lfo = off.createOscillator();
  lfo.frequency.value = 0.09;
  const depth = off.createGain();
  depth.gain.value = 0.45 * PAD_GAIN;
  lfo.connect(depth).connect(breath.gain);
  lp.connect(breath).connect(off.destination);
  for (const f of [root * Math.pow(2, -4 / 1200), root * 1.5 * Math.pow(2, 4 / 1200)]) {
    const osc = off.createOscillator();
    osc.frequency.value = Math.round(f * PAD_S) / PAD_S;
    osc.connect(lp);
    osc.start();
  }
  lfo.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(N)], PAD_RATE);
}
/** Triangle notes with a 12 ms attack and a 0.5 s exponential decay. Two passes over the loop, the
 * second kept: the first pass's last notes ring into it, as they wrap round the loop. */
async function renderPluck(key: string, part: "calm" | "intense"): Promise<AudioClip> {
  const root = AMBIENCE_ROOTS[key]!;
  const N = PLUCK_S * PLUCK_RATE;
  const off = new OfflineAudioContext(1, 2 * N, PLUCK_RATE);
  const gain = part === "calm" ? 0.16 : 0.1;
  const pat = pattern(key);
  for (let pass = 0; pass < 2; pass++) {
    pat.forEach((degree, step) => {
      if (degree === null) return;
      const f0 = semitone(root * 2, degree);
      const at = pass * PLUCK_S + step * 0.5 + (part === "calm" ? 0 : 0.25);
      const osc = off.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = part === "calm" ? f0 : semitone(f0, 7);
      const env = off.createGain();
      env.gain.setValueAtTime(0, 0);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(gain, at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(env).connect(off.destination);
      osc.start(at);
      osc.stop(at + 0.55);
    });
  }
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(N)], PLUCK_RATE);
}
/** Renders a theme's loops once; they play when ready. */
function renderLoops(key: string): void {
  if (rendering.has(key)) return;
  rendering.add(key);
  Promise.all([renderPad(AMBIENCE_ROOTS[key]!), renderPluck(key, "calm"), renderPluck(key, "intense")]).then(
    ([pad, calm, intense]) => { rendered.set(key, { pad, calm, intense }); },
    (e: unknown) => { console.warn(`music: ${String(e)}`); },
  );
}

let ambienceKey = "hearth";
let wantKey = "hearth";
let started = false;
let unlocked = false;
interface Playing { key: string; pad: Sound; calm: Sound; intense: Sound }
let playing: Playing | null = null;
let baseIntensity = 0, bump = 0, intensity = 0;
/** The theme's ambience key (js/audio.js setAmbience): the loops change at once when rendered. */
export function setAmbience(key: string): void { wantKey = AMBIENCE_ROOTS[key] ? key : "hearth"; }
/** Adaptive layer, 0 calm .. 1 intense. */
export function setScene(v: number): void { baseIntensity = Math.max(0, Math.min(1, v || 0)); }
function bumpIntensity(amount: number): void { bump = Math.min(1, bump + amount); }
/** The first press (the browser build's audio unlock): the music may start. */
export function unlock(): void { unlocked = true; }

function loopGains(): { pad: number; calm: number; intense: number } {
  if (!audible()) return { pad: 0, calm: 0, intense: 0 };
  return { pad: 1, calm: 0.5 * (1 - intensity * 0.55), intense: 0.42 * intensity };
}
function applyLoopGains(seconds: number): void {
  if (!playing) return;
  const g = loopGains();
  playing.pad.fade(g.pad, seconds);
  playing.calm.fade(g.calm, seconds);
  playing.intense.fade(g.intense, seconds);
}
function stopLoops(): void {
  if (!playing) return;
  const p = playing;
  playing = null;
  for (const s of [p.pad, p.calm, p.intense]) { try { s.fade(0, 0.6); } catch { /* ended */ } }
  // Stop once faded (a second later on the frame clock).
  fading.push({ at: frame().time + 0.8, sounds: [p.pad, p.calm, p.intense] });
}
const fading: { at: number; sounds: Sound[] }[] = [];
function startLoops(key: string, l: Loops): void {
  try {
    const g = loopGains();
    // The pad fades in slowly (js/audio.js: setTargetAtTime 1.2 s).
    const pad = playClip(l.pad, { bus: "music", gain: 0, loop: true });
    pad.fade(g.pad, 3);
    const calm = playClip(l.calm, { bus: "music", gain: g.calm, loop: true });
    const intense = playClip(l.intense, { bus: "music", gain: g.intense, loop: true });
    playing = { key, pad, calm, intense };
  } catch (e) { console.warn(`music: ${String(e)}`); playing = null; }
}

let lastUpdate = 0;
/** Each frame: the wanted theme's loops are asked for; once the mixer runs, the crossfade. */
export function update(): void {
  const now = frame().time;
  for (let i = fading.length - 1; i >= 0; i--) {
    if (fading[i]!.at <= now) { for (const s of fading[i]!.sounds) { try { s.stop(); } catch { /* ended */ } } fading.splice(i, 1); }
  }
  if (!rendered.has(wantKey)) { renderLoops(wantKey); return; }
  if (context.state !== "running") return;
  if (!unlocked) return;
  const dt = Math.min(1, Math.max(0, now - lastUpdate));
  lastUpdate = now;
  bump *= Math.exp(-dt / 3);
  const target = Math.max(0, Math.min(1, baseIntensity + bump));
  intensity += (target - intensity) * Math.min(1, dt * 3);
  if (!started || ambienceKey !== wantKey || !playing) {
    if (playing && playing.key === wantKey) { started = true; return; }
    stopLoops();
    ambienceKey = wantKey;
    started = true;
    startLoops(wantKey, rendered.get(wantKey)!);
    return;
  }
  applyLoopGains(0.25);
}
