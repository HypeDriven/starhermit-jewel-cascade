// Jewel Cascade on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content and session (js/engine/*.js,
// js/session.js) are the browser build's, unchanged in what they decide; this
// module is what js/main.js and js/ui/ui.js did around them: the session's
// state machine mapped onto screens (title → mode select → Journey map /
// setup → the round with its Ready… Set… Go! countdown ⇄ pause → results →
// next / retry / replay / mode select), the event presentation (sounds,
// captions, announcements and the board's timeline per rules event), the
// Learn runner (one banner step at a time, the taught swap enforced through
// session.inputFilter), the keyboard cursor, taps, drags and pads on the
// board, the text board (the accessible play path), the timed rounds' clock,
// Hint, Undo, Skip and Camera, the results with their score breakdown,
// mastery and unlocks, the replay of the finished round, the local boards and
// posting ranked scores to the high-score board, the resume offer for an
// interrupted round, and the lifecycle (a hidden window pauses the round, as
// visibilitychange did). The screens and HUD are drawn by screens.ts
// (starhermit:ui), the workshop by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the session's 100 ms clock,
// the countdown, the board's timelines and every delay that used setTimeout
// run on them, so pauses, a hidden window and slow frames never cost time and
// play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, primaryPointer } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Ach, Content, Rules, Sess, Store, Themes, type Content as Round, type Move, type Results, type RulesEvent, type Session, type Status } from "./game.ts";
import * as audio from "./audio.ts";
import { T, N, account, fmtInt } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "modes" | "journey" | "setup" | "game" | "help" | "achievements" | "boards" | "profile" | "settings";
export type Overlay = "pause" | "results" | null;
export type ModeId = "learn" | "journey" | "daily" | "practice" | "challenge" | "score";

const STEP_MS = 1000 / 60;
export const settings = platform.settings;
export const progress = platform.progress;

export const app = {
  screen: "title" as Screen,
  overlay: null as Overlay,
  /** A modal over everything: the resume offer, the reset confirmation. */
  modal: null as "resume" | "wipe" | null,
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  /** Where Settings and Help go back to (the pause menu of a round, or the title). */
  returnTo: "title" as "title" | "pause",
  setupMode: null as ModeId | null,
  setupChoice: null as Round | null,
  practiceSeed: "",
  chaseSeed: "",
  hudState: N("Get ready"),
  countdown: null as string | null,
  /** The compact layouts' drawers. */
  drawer: null as "objective" | "actions" | null,
  mirror: false,
  mirrorSel: -1,
  lesson: null as { content: Round; i: number; shown: number; crates: number } | null,
  banner: null as { text: string; meta: string; button: string } | null,
  results: null as Results | null,
  lb: null as { posted: boolean; rank: number | null } | "posting" | null,
  compare: "",
  replay: null as { left: number; i: number; done: boolean } | null,
  boardTab: 0,
  boards: null as { tab: number; lines: platform.BoardLine[] | null; loading: boolean } | null,
  confirmWipe: false,
  toasts: [] as { text: string; kind: string; until: number }[],
  captions: [] as { text: string; until: number }[],
};
export let session: Session;
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
let lastAnnounce = -10;
/** The live regions (polite throttled to 900 ms, assertive always). */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  if (!assertive && now() - lastAnnounce < 0.9) return;
  lastAnnounce = now();
  ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** js/ui/ui.js toast(): three at most, 2.6 s each. */
export function toast(text: string, kind = "", silent = false): void {
  app.toasts.push({ text, kind, until: now() + 2.6 });
  while (app.toasts.length > 3) app.toasts.shift();
  if (!silent) audio.cue("toast");
}
const timers: { left: number; fn: () => void }[] = [];
/** setTimeout on the fixed steps. */
function after(ms: number, fn: () => void): void { timers.push({ left: ms, fn }); }
export function contentName(c: Round | Record<string, unknown> | null): string {
  if (!c || !c.name) return T("Round");
  const n = String(c.name);
  let m: RegExpExecArray | null;
  if ((m = /^Stage (\d+) — (.+)$/.exec(n))) return T("Stage {n} — {name}", { n: m[1]!, name: T(m[2]!) });
  if ((m = /^Daily — (.+)$/.exec(n))) return T("Daily — {date}", { date: m[1]! });
  if ((m = /^Practice — (.+)$/.exec(n))) return T("Practice — {level}", { level: T(m[1]!) });
  return T(n);
}
export function contentDesc(c: Round | null): string {
  if (!c || !c.desc) return "";
  const d = String(c.desc);
  const cut = d.indexOf(" Seed: ");
  const head = cut >= 0 ? d.slice(0, cut) : d;
  const seed = cut >= 0 ? " " + T("Seed: {seed}", { seed: d.slice(cut + 7) }) : "";
  const m = /^Fixed ruleset, player-chosen seed\. Reach (\d+) points in (\d+) moves; every unused move banks \+(\d+)\.$/.exec(head);
  const text = m ? T("Fixed ruleset, player-chosen seed. Reach {target} points in {moves} moves; every unused move banks +{bonus}.", { target: m[1]!, moves: m[2]!, bonus: m[3]! }) : T(head);
  return text + seed;
}
export const COLOR_NAMES = [N("ruby"), N("amber"), N("topaz"), N("emerald"), N("sapphire"), N("amethyst"), N("opal")];
export function goalText(g: { type: string; color?: number; n: number }): string {
  if (g.type === "collect") return T("Collect {n} {color}", { n: g.n, color: T(COLOR_NAMES[g.color ?? 0]!) });
  if (g.type === "ice") return T("Break {n} ice", { n: g.n });
  if (g.type === "crates") return T("Break {n} crates", { n: g.n });
  if (g.type === "score") return T("Score {n}", { n: fmtInt(g.n) });
  return g.type;
}
export function goalLeftText(g: { type: string; left: number; done: boolean }): string {
  if (g.done) return T("done");
  if (g.type === "score") return T("{n} to go", { n: fmtInt(g.left) });
  return T("{n} left", { n: g.left });
}
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
export function modeName(mode: ModeId | null): string {
  return mode ? ({ learn: T("Learn"), journey: T("Journey"), daily: T("Daily"), practice: T("Practice"), challenge: T("Challenge"), score: T("Score chase") })[mode] : "";
}
export function playerName(): string {
  if (platform.signedIn() && platform.displayName()) return platform.displayName();
  const n = settings.player.displayName;
  return !n || n === "Guest" ? T("Guest") : n;
}
export function palette(): string[] {
  const p = preferences().highContrast ? "contrast" : settings.display.palette;
  return Themes.JEWEL_PALETTES[p] ?? Themes.JEWEL_PALETTES.default!;
}
export function masteryProgress(xp: number): { pct: number; toNext: number } {
  const level = Ach.masteryLevelForXp(xp);
  const cur = Ach.MASTERY_LEVELS[level - 1]!;
  const next = Ach.MASTERY_LEVELS[level];
  if (!next) return { pct: 100, toNext: 0 };
  return { pct: Math.max(0, Math.min(100, ((xp - cur.xp) / (next.xp - cur.xp)) * 100)), toNext: next.xp - xp };
}
export function dayKey(): string { return Content.dayKeyFor(platform.nowMs()); }
export function dailyCountdown(): string {
  const n = platform.nowMs();
  const left = Math.max(0, Date.parse(Content.dayKeyFor(n) + "T00:00:00Z") + 86400000 - n);
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000), s = Math.floor((left % 60000) / 1000);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
const INVALID_TEXT: Record<string, string> = {
  ended: N("The round is over."), "out-of-bounds": N("That cell is outside the board."), "not-adjacent": N("Jewels must be neighbours to swap."),
  "no-jewel": N("There is no jewel there."), "crate-cell": N("Crates cannot be moved — match beside them."),
  "ice-locked": N("That jewel is frozen in ice. Match through it to crack it."), "no-match": N("That swap makes no line of three."),
  "bad-command": N("That move was not understood."), duplicate: N("Already done."), "no-undo": N("Nothing to undo."),
  "not-active": N("Hold on — the board is settling."), filtered: N("The lesson is guiding a different move."),
};
export const REASON_HEADLINES: Record<string, string> = {
  "goals-complete": N("Commission complete!"), "out-of-moves": N("Out of moves"), resigned: N("Round resigned"), "time-expired": N("Time expired"),
};

// ------------------------------------------------------------------ navigation
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.confirmWipe = false;
  ui.setFocus(null);
  if (screen !== "game") { app.drawer = null; app.mirror = false; }
  if (screen === "boards") refreshBoards();
}
/** Leave whatever round is on to the title (js/ui/ui.js leaveToTitle). */
export function leaveToTitle(): void {
  audio.cue("back");
  if (session.status === "active" || session.status === "resolving") session.pause("leave");
  if (session.status === "paused") session.abandon("leave");
  if (session.status !== "title") session.transition("title", "home");
  app.overlay = null;
  render.clear();
  show("title", "btn-play");
}
export function goModes(): void {
  if (session.status === "title" || session.status === "profile-ready" || session.status === "progression") session.transition("mode-select", "play");
  show("modes", "mode-learn");
}
export function play(): void { audio.cue("confirm"); goModes(); }
export function openNav(screen: "boards" | "achievements" | "help" | "settings"): void {
  audio.cue("open");
  app.returnTo = "title";
  show(screen, null);
}
/** Settings or Help from the pause menu: back returns to it. */
export function openFromPause(screen: "settings" | "help"): void {
  audio.cue("open");
  app.returnTo = "pause";
  app.overlay = null;
  show(screen, null);
}
/** A page's Back (Settings, Help, Achievements, Boards, Profile). */
export function back(): void {
  audio.cue("back");
  if (app.returnTo === "pause" && session.status === "paused") {
    app.returnTo = "title";
    show("game", null);
    openOverlay("pause", "btn-resume");
    return;
  }
  if (app.screen === "journey" || app.screen === "setup") {
    if (app.screen === "setup" && app.setupMode === "journey") { show("journey", null); return; }
    if (session.status !== "mode-select") session.transition("mode-select", "back");
    show("modes", "mode-learn");
    return;
  }
  if (app.screen === "modes") { leaveToTitle(); return; }
  show("title", "btn-play");
}
export function openProfile(): void {
  audio.cue("open");
  if (session.status === "title") session.transition("profile-ready", "profile-chip");
  app.returnTo = "title";
  show("profile", null);
}
function openOverlay(o: Exclude<Overlay, null>, focus: string): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}

// ------------------------------------------------------------------ mode select, Journey, setup
export function openSetup(mode: ModeId): void {
  audio.cue("open");
  if (mode === "journey") { openJourney(); return; }
  if (session.status === "title") session.transition("mode-select", mode);
  app.setupMode = mode;
  app.setupChoice = null;
  if (mode === "daily") app.setupChoice = Content.dailyContent(dayKey());
  show("setup", mode === "daily" ? "setup-start" : null);
}
export function openJourney(): void {
  if (session.status === "title") session.transition("mode-select", "journey");
  show("journey", `stage-${Math.min(progress.journeyUnlocked || 1, Content.JOURNEY.length)}`);
}
export function pickJourney(i: number): void {
  audio.cue("click");
  app.setupMode = "journey";
  app.setupChoice = Content.JOURNEY[i]!;
  show("setup", "setup-start");
}
export function pickContent(c: Round): void { audio.cue("click"); app.setupChoice = c; }
export function randomChase(): void {
  audio.cue("click");
  app.chaseSeed = Math.random().toString(36).slice(2, 10);
  app.setupChoice = Content.scoreChaseContent(app.chaseSeed);
}
export function todayChase(): void {
  audio.cue("click");
  app.chaseSeed = dayKey();
  app.setupChoice = Content.scoreChaseContent(app.chaseSeed);
}
export function startSetup(): void {
  if (!app.setupChoice) return;
  audio.cue("confirm");
  // Practice takes the seed field as it stands when Start is pressed.
  if (app.setupMode === "practice" && app.setupChoice.difficulty && app.practiceSeed.trim()) app.setupChoice = Content.practiceContent(app.setupChoice.difficulty, app.practiceSeed);
  session.startRound(app.setupChoice);
}

// ------------------------------------------------------------------ session wiring
function applyTheme(): void {
  const theme = Themes.themeById(settings.cosmetics.theme);
  render.setTheme(theme);
  audio.setAmbience(theme.ambience);
}
let paletteKey = "";
function applyPalette(): void {
  const p = palette();
  const k = p.join(",");
  if (k === paletteKey) return;
  paletteKey = k;
  render.setPalette(p);
}
function applyGraphics(): void {
  render.setCameraPreset(settings.camera.preset || "default");
  render.setFrame(settings.cosmetics.frame);
  render.setTrail(settings.cosmetics.trail);
  applyPalette();
}
let lastResolveReason = "";
function wireSession(): void {
  session.on("fsm", ({ to, reason }: { to: Status; reason: string }) => {
    lastResolveReason = reason;
    switch (to) {
      case "title": app.overlay = null; app.banner = null; app.countdown = null; break;
      case "preparing": app.overlay = null; show("game", null); break;
      case "countdown": show("game", null); runCountdown(); break;
      case "tutorial": app.hudState = N("Lesson"); show("game", null); startLesson(); break;
      case "active":
        if (reason === "resume") { app.overlay = null; audio.cue("resume"); }
        app.hudState = N("Your move");
        break;
      case "resolving": app.hudState = N("Settling…"); break;
      case "paused":
        app.hudState = N("Paused");
        openOverlay("pause", "btn-resume");
        audio.cue("pause");
        render.setPaused(true);
        break;
      case "results": if (app.overlay === "pause") app.overlay = null; break;
      default: break;
    }
    if (to !== "paused") render.setPaused(false);
    render.setInputReady(to === "active" || to === "tutorial");
  });
  session.on("round", ({ content: c, resumed }: { content: Round; resumed: boolean }) => {
    applyTheme();
    applyPalette();
    render.buildBoard(session.state!);
    app.hudState = resumed ? N("Resumed") : N("Get ready");
    app.mirrorSel = -1;
    app.results = null;
    app.lb = null;
    app.replay = null;
    app.lesson = null;
    app.banner = null;
    session.inputFilter = null;
    if (c.tutorial && !resumed) app.lesson = { content: c, i: 0, shown: -1, crates: 0 };
    lastHud = "";
  });
  session.on("rules", ({ events, state, fast }: { events: RulesEvent[]; state: NonNullable<Session["state"]>; fast: boolean }) => {
    audio.rulesEvents(events);
    const dur = render.playEvents(events, state, !!fast);
    const maxCascade = events.reduce((m, e) => (e.t === "match" ? Math.max(m, e.cascade || 1) : m), 1);
    audio.setScene(Math.min(1, (maxCascade - 1) / 2));
    if (session.status === "resolving") resolve = { left: dur };
    else if (dur > 0) resolve = { left: dur, cosmetic: true };
    lessonRules(events);
  });
  session.on("undo", () => {
    render.syncToState(session.state!);
    audio.cue("undo");
    toast(T("Undone."), "", true);
    app.mirrorSel = -1;
  });
  session.on("hint", (mv: Move) => {
    render.showHint(mv);
    after(2600, () => render.clearHint());
    audio.cue("hint");
    toast(T("Hint: watch the two highlighted jewels."), "", true);
    announce(T("Hint shown on the board.") + " " + T("row {r} column {c}", { r: mv.ay + 1, c: mv.ax + 1 }) + " ↔ " + T("row {r} column {c}", { r: mv.by + 1, c: mv.bx + 1 }));
  });
  session.on("skip", () => { if (resolve) resolve.left = 0; });
  session.on("invalid", ({ reason, ax, ay }: { reason: string; ax?: number; ay?: number }) => {
    if (typeof ax === "number" && typeof ay === "number" && session.state) render.flashInvalid(Rules.idx(session.state, ax, ay));
    audio.cue("error");
    const msg = T(INVALID_TEXT[reason] ?? N("That move is not legal."));
    toast(msg, "warn", true);
    announce(msg, true);
  });
  session.on("hud", (h: { score: number; movesLeft: number; goals: { type: string; color?: number; n: number; left: number; done: boolean }[] }) => {
    const key = h.goals.map((g) => g.left + (g.done ? "d" : "")).join(",");
    if (key === lastHud) return;
    lastHud = key;
    announce(T("Score {n}.", { n: fmtInt(h.score) }) + " " + (h.movesLeft > 100 ? T("Unlimited moves.") : T("{n} moves left.", { n: h.movesLeft })) + " " +
      h.goals.map((g) => goalText(g) + " " + goalLeftText(g)).join(". "));
  });
  session.on("timer", ({ leftMs }: { leftMs: number }) => {
    audio.timerUpdate(leftMs);
    if (leftMs > 0 && leftMs <= 10500 && Math.round(leftMs / 1000) !== Math.round((leftMs + 100) / 1000)) announce(T("{n} seconds", { n: Math.ceil(leftMs / 1000) }));
  });
  session.on("results", (r: Results) => {
    session._lastResults = r;
    resolve = null;
    endLessonQuietly();
    audio.cue(r.won ? "win" : "lose");
    showResults(r);
  });
}
let lastHud = "";
/** The board's timeline in flight: settles the session when it ends (or is skipped). */
let resolve: { left: number; cosmetic?: boolean } | null = null;

// ------------------------------------------------------------------ the countdown (Ready… Set… Go!)
const COUNT = [N("Ready…"), N("Set…"), N("Go!")];
let countdownGen = 0;
function runCountdown(): void {
  const gen = ++countdownGen;
  app.countdown = "";
  announce(T("Get ready"), true);
  COUNT.forEach((s, i) => after(i * 620, () => {
    if (gen !== countdownGen) return;
    app.countdown = s;
    audio.cue("tick");
    if (i === COUNT.length - 1) audio.cue("confirm");
  }));
  after(COUNT.length * 620 + 120, () => {
    if (gen !== countdownGen) return;
    app.countdown = null;
    session.beginPlay("countdown-complete");
    announce(T("Go! {name}", { name: contentName(session.content) }), true);
  });
}

// ------------------------------------------------------------------ the Learn runner
function startLesson(): void {
  const l = app.lesson;
  if (!l || !l.content.steps || !l.content.steps.length) return;
  if (l.shown === l.i) return;
  showLessonStep();
}
function showLessonStep(): void {
  const l = app.lesson!;
  const steps = l.content.steps!;
  l.shown = l.i;
  const s = steps[l.i]!;
  app.banner = { text: s.text, meta: T("Step {n} of {total}", { n: l.i + 1, total: steps.length }), button: N("End lesson") };
  announce(T("Lesson step {n} of {total}.", { n: l.i + 1, total: steps.length }) + " " + T(s.text), true);
  if (s.require && s.require.kind === "swap") {
    const r = s.require as { ax: number; ay: number; bx: number; by: number };
    session.inputFilter = (ax, ay, bx, by) =>
      (ax === r.ax && ay === r.ay && bx === r.bx && by === r.by) || (ax === r.bx && ay === r.by && bx === r.ax && by === r.ay);
    if (s.focus && s.focus.length === 2) render.showHint({ ax: s.focus[0]!.x, ay: s.focus[0]!.y, bx: s.focus[1]!.x, by: s.focus[1]!.y });
  } else {
    session.inputFilter = null;
    render.clearHint();
  }
}
function lessonRules(events: RulesEvent[]): void {
  const l = app.lesson;
  if (!l) return;
  const s = l.content.steps?.[l.i];
  if (!s || !s.require) return;
  const w = session.state!.width;
  const same = (idx: number | undefined, x?: number, y?: number): boolean => idx === (y ?? 0) * w + (x ?? 0);
  const accepted = events.some((e) => e.t === "turn");
  const r = s.require;
  let hit = false;
  switch (r.kind) {
    case "swap":
      hit = events.some((e) => e.t === "swap" && ((same(e.a, r.ax, r.ay) && same(e.b, r.bx, r.by)) || (same(e.a, r.bx, r.by) && same(e.b, r.ax, r.ay))));
      break;
    case "any-swap": hit = accepted; break;
    case "create": hit = events.some((e) => e.t === "create" && (!r.s || r.s.includes(e.s!))); break;
    case "break-ice": hit = events.some((e) => e.t === "crack" && e.ice === 0); break;
    case "break-crate":
      l.crates += events.filter((e) => e.t === "crate-break").length;
      hit = l.crates >= (r.n || 1);
      break;
    default: hit = accepted;
  }
  if (!hit) return;
  l.i++;
  if (l.i >= l.content.steps!.length) endLesson(true);
  else showLessonStep();
}
function endLesson(completed: boolean): void {
  if (!app.lesson) return;
  app.lesson = null;
  app.banner = null;
  session.inputFilter = null;
  render.clearHint();
  if (completed) {
    announce(T("Lesson complete!"), true);
    toast(T("Lesson complete!"), "ok");
    // Let the last move's timeline settle before the results.
    after(900, () => { if (session.state && session.state.phase === "ready") session.forceFinish(Rules.END.GOALS); });
  }
}
function endLessonQuietly(): void { app.lesson = null; if (!app.replay) app.banner = null; session.inputFilter = null; }
/** The banner's button: End lesson, or End replay. */
export function bannerButton(): void {
  audio.cue("click");
  if (app.replay) { endReplay(); return; }
  endLesson(false);
  session.abandon("leave-lesson");
  render.clear();
  show("modes", "mode-learn");
}

// ------------------------------------------------------------------ playing
/** The board's swap (taps, drags, the cursor and the text board all come here). */
function swap(ax: number, ay: number, bx: number, by: number): void {
  audio.unlock();
  session.trySwap(ax, ay, bx, by);
  app.mirrorSel = -1;
}
export function canAct(): boolean { return session.status === "active" || session.status === "tutorial"; }
export function doHint(): void { audio.unlock(); session.hint(); }
export function doUndo(): void { audio.unlock(); session.undo(); }
export function doSkip(): void { session.requestSkip(); }
export function doPause(): void { session.pause("user"); }
export function resumeRound(): void { session.resume(); }
export function cycleCamera(): void {
  const order = ["default", "low", "high"];
  const next = order[(order.indexOf(settings.camera.preset || "default") + 1) % order.length]!;
  settings.camera.preset = next;
  platform.saveSettings();
  render.setCameraPreset(next);
  toast(T("Camera: {preset}", { preset: T(({ default: N("default"), low: N("low"), high: N("high") } as Record<string, string>)[next] ?? next) }));
}
export function toggleMute(): void {
  settings.audio.muted = !settings.audio.muted;
  platform.saveSettings();
  audio.setMuted(settings.audio.muted);
  toast(settings.audio.muted ? T("Muted") : T("Sound on"));
}
export function restartRound(): void {
  audio.cue("click");
  app.overlay = null;
  app.replay = null;
  session.restart();
}
export function leaveRound(): void {
  audio.cue("back");
  app.overlay = null;
  session.abandon("leave");
  render.clear();
  show("modes", "mode-learn");
}
export function toggleMirror(): void {
  audio.cue("tab");
  app.mirror = !app.mirror;
  app.mirrorSel = -1;
  app.drawer = null;
  if (app.mirror) { app.openedFrame = frame().frame; app.focusNext = "mirror-close"; }
}
export function toggleDrawer(which: "objective" | "actions"): void {
  audio.cue("tab");
  app.drawer = app.drawer === which ? null : which;
}
/** A text-board cell press (js/ui/ui.js mirrorTap). */
export function mirrorTap(i: number): void {
  const s = session.state;
  if (!s || s.phase !== "ready" || !canAct()) return;
  const cell = s.cells[i]!;
  const movable = !!cell.j && !cell.crate && cell.ice === 0;
  if (app.mirrorSel < 0) {
    if (movable) { app.mirrorSel = i; audio.cue("select"); }
    else announce(T(INVALID_TEXT[cell.crate ? "crate-cell" : cell.ice > 0 ? "ice-locked" : "no-jewel"]!), true);
    return;
  }
  if (app.mirrorSel === i) { app.mirrorSel = -1; return; }
  const a = { x: app.mirrorSel % s.width, y: Math.floor(app.mirrorSel / s.width) };
  const b = { x: i % s.width, y: Math.floor(i / s.width) };
  if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) swap(a.x, a.y, b.x, b.y);
  else app.mirrorSel = movable ? i : -1;
}

// ------------------------------------------------------------------ results
function showResults(r: Results): void {
  app.results = r;
  recordLocalBoardEntry(r);
  for (let s = 0; s < r.stars; s++) after(400 + s * 350, () => audio.cue("star"));
  if ((r.progression?.newAchievements ?? []).length) audio.cue("success");
  const boards = Store.loadBoards();
  const best = boards.entries.filter((e) => e.contentId === r.contentId && e.roundId !== r.roundId).reduce((m, e) => Math.max(m, e.score), 0);
  const isBest = r.score >= best && r.score > 0;
  app.compare = isBest ? N("New personal best on this board!") : T("Personal best on this board: {score}.", { score: fmtInt(Math.max(best, r.score)) });
  if (isBest) audio.cue("record");
  postToLeaderboard(r);
  openOverlay("results", "res-next");
  announce(T(REASON_HEADLINES[r.reason] ?? N("Round over")) + " " + T("Score {n}.", { n: fmtInt(r.score) }) + " " + T("{n} stars.", { n: r.stars }), true);
}
function recordLocalBoardEntry(r: Results): void {
  try {
    const boards = Store.loadBoards();
    boards.entries.push({
      roundId: r.roundId, contentId: r.contentId, mode: r.mode, name: playerName(), score: r.score, won: r.won, moves: r.movesSpent,
      ms: r.elapsedMs, seed: r.replay ? r.replay.seed : null, assists: r.replay && (r.replay.config.assists as { undo?: boolean })?.undo ? "undo" : "",
      at: new Date(platform.nowMs()).toISOString(), validated: false,
    });
    if (boards.entries.length > 400) boards.entries.splice(0, boards.entries.length - 400);
    Store.saveBoards(boards);
  } catch { /* boards are best-effort */ }
}
let lbSeq = 0;
/** Signed in only: a ranked round's score to the high-score board, with the rank. */
function postToLeaderboard(r: Results): void {
  const seq = ++lbSeq;
  app.lb = null;
  if (!r.ranked || !platform.signedIn()) return;
  app.lb = "posting";
  void platform.postLeaderboard(r.score).then((res) => { if (seq === lbSeq) app.lb = res; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  const sh = account();
  if (r === "posting") return sh.lbPosting;
  if (!r.posted) return sh.lbNotPosted;
  return r.rank ? sh.lbRank.replace("{rank}", String(r.rank)) : sh.lbPosted;
}
export function nextLabel(r: Results): string {
  if (r.mode === "journey" && r.won && r.contentId !== "j40") return T("Next stage");
  if (r.mode === "learn") return T("Next lesson");
  return T("Play again");
}
export function resultsRetry(): void { audio.cue("click"); app.overlay = null; session.restart(); }
export function resultsMenu(): void {
  audio.cue("back");
  app.overlay = null;
  session.transition("mode-select", "results-menu");
  render.clear();
  show("modes", "mode-learn");
}
export function resultsNext(): void {
  audio.cue("confirm");
  const r = session._lastResults;
  app.overlay = null;
  if (!r || !session.content) { session.transition("mode-select", "next"); render.clear(); show("modes", "mode-learn"); return; }
  if (r.mode === "journey") {
    const next = Content.JOURNEY[Math.min((session.content.stage || 1) + 1, Content.JOURNEY.length) - 1];
    if (r.won && next && r.contentId !== "j40") { session.transition("progression", "next-stage"); session.startRound(next); return; }
    session.transition("progression", "journey-next");
    session.transition("mode-select", "journey-next");
    render.clear();
    openJourney();
    return;
  }
  if (r.mode === "learn") {
    const idx = Content.LESSONS.findIndex((l) => l.id === r.contentId);
    const next = Content.LESSONS[idx + 1];
    session.transition("progression", "next-lesson");
    if (r.won && next) session.startRound(next);
    else { session.transition("mode-select", "lessons-done"); render.clear(); show("modes", "mode-learn"); }
    return;
  }
  session.transition("progression", "again");
  session.startRound(session.content);
}

// ------------------------------------------------------------------ replay (the recorded command log, spectated)
let replayState: NonNullable<Session["state"]> | null = null;
export function startReplay(): void {
  const r = session._lastResults;
  if (!r || !r.replay) return;
  audio.cue("click");
  try { replayState = Rules.createGame(r.replay.config); } catch { toast(T("Replay unavailable for this round."), "warn"); return; }
  app.overlay = null;
  render.buildBoard(replayState);
  render.setInputReady(false);
  app.replay = { left: 600, i: 0, done: false };
  app.banner = { text: T("Replay of your round — {n} moves.", { n: r.replay.commands.length }), meta: "", button: N("End replay") };
}
function replayStep(): void {
  const rp = app.replay, r = session._lastResults;
  if (!rp || !r || !r.replay || !replayState) return;
  if (rp.i >= r.replay.commands.length || replayState.phase !== "ready") {
    rp.done = true;
    app.banner = { text: T("Replay complete — final score {score}.", { score: fmtInt(replayState.score) }), meta: "", button: N("End replay") };
    return;
  }
  const res = Rules.applyCommand(replayState, r.replay.commands[rp.i++]! as unknown as Record<string, unknown>);
  if (res.events.length) {
    const dur = render.playEvents(res.events, replayState, false);
    audio.rulesEvents(res.events);
    replayResolve = dur;
  }
  rp.left = 1500;
}
let replayResolve = 0;
function endReplay(): void {
  app.replay = null;
  replayState = null;
  replayResolve = 0;
  app.banner = null;
  render.finalize();
  if (session.state) render.buildBoard(session.state);
  openOverlay("results", "res-next");
}

// ------------------------------------------------------------------ settings and profile
export function setSetting(fn: () => void): void {
  fn();
  platform.saveSettings();
  audio.cue("saved");
  applyGraphics();
  applyTheme();
}
export function replayTutorials(): void {
  progress.tutorialsDone = {};
  platform.saveProgress();
  toast(T("Tutorials reset — they will play again from Learn."), "ok");
}
export function wipeAll(): void {
  audio.cue("close");
  app.modal = null;
  platform.wipeAll();
  audio.setMuted(false);
  applyGraphics();
  applyTheme();
  leaveToTitle();
  toast(T("Progress reset."), "ok");
}
export function copyInvite(): void {
  audio.cue("click");
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(account().copied, "ok"); }
  catch { toast(account().copyFailed.replace("{link}", link)); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ boards
export function refreshBoards(): void {
  const tab = app.boardTab;
  if (tab === 2) { app.boards = { tab, lines: null, loading: false }; return; }
  app.boards = { tab, lines: null, loading: true };
  void platform.readBoard(tab === 1).then((lines) => { if (app.boards && app.boards.tab === tab) app.boards = { tab, lines, loading: false }; });
}
export function setBoardTab(i: number): void {
  if (i === app.boardTab) return;
  audio.cue("tab");
  app.boardTab = i;
  refreshBoards();
}

// ------------------------------------------------------------------ the resume offer
export function resumeOffer(): { name: string; score: number | string; moves: number | string } | null {
  const snap = Store.loadRoundSnapshot();
  if (!snap || !snap.stateJson) return null;
  try {
    const probe = Rules.deserialize(snap.stateJson);
    if (probe.phase !== "ready") return null;
    return { name: contentName(snap.content), score: fmtInt(probe.score), moves: probe.movesLeft };
  } catch { return null; }
}
export function resumeSnapshot(): void {
  audio.cue("confirm");
  app.modal = null;
  const snap = Store.loadRoundSnapshot();
  if (!snap) return;
  try {
    session._roundIdKept = snap.roundId;
    if (session.status !== "title" && session.status !== "mode-select") session.transition("title", "resume");
    session.startRound(Content.reviveContent(snap.content), { resumed: true, resumedState: snap.stateJson, resumedCommands: snap.commands });
    session.beginPlay("resumed");
    countdownGen++; // a resumed round skips the countdown
    app.countdown = null;
  } catch (e) {
    console.warn(`resume: ${String(e)}`);
    Store.clearRoundSnapshot();
  }
}
export function discardSnapshot(): void { audio.cue("close"); app.modal = null; Store.clearRoundSnapshot(); }

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  audio.unlock();
  const fresh = frame().frame !== app.openedFrame;
  if (app.modal) return; // the modal's own buttons and Escape
  const action = e.action;
  if (action === "mute") { toggleMute(); return; }
  if (action === "help" && !ui.capturingKeys()) {
    if (app.screen === "game" && (session.status === "active" || session.status === "resolving")) { session.pause("help"); openFromPause("help"); }
    else if (app.screen !== "game" && app.screen !== "help") { app.returnTo = "title"; show("help", null); }
    return;
  }
  if (app.screen !== "game") {
    if ((action === "cancel" || action === "pause") && fresh && app.screen !== "title" && !ui.capturingKeys()) back();
    return;
  }
  if (app.overlay === "pause") { if ((action === "cancel" || action === "pause") && fresh) resumeRound(); return; }
  if (app.overlay) return;
  if (app.mirror && action === "cancel" && fresh) { toggleMirror(); return; }
  if (app.drawer && action === "cancel" && fresh) { app.drawer = null; return; }
  switch (action) {
    case "up": case "down": case "left": case "right": {
      if (!canAct() || app.mirror) return;
      ui.setFocus(null);
      const d = ({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as Record<string, [number, number]>)[action]!;
      render.cursorMove(d[0], d[1]);
      cursorAnnounce();
      break;
    }
    case "confirm": case "confirm2":
      if (ui.focused()) return; // Enter/Space belong to the focused control
      if (canAct() && !app.mirror) { render.cursorShow(); render.cursorConfirm(); }
      break;
    case "cancel":
      if (render.cursorCancel()) return;
      if (fresh && (session.status === "active" || session.status === "resolving")) session.pause("cancel");
      break;
    case "pause": if (fresh) { if (session.status === "paused") resumeRound(); else session.pause("user"); } break;
    case "hint": doHint(); break;
    case "undo": doUndo(); break;
    case "skip": doSkip(); break;
    case "camera": cycleCamera(); break;
    default: break;
  }
});
function cursorAnnounce(): void {
  const c = render.cursorCell();
  const s = session.state;
  if (!c || !s) return;
  announce(cellLabel(c.y * s.width + c.x));
}
/** A cell's spoken description (js/ui/ui.js mirror labels). */
export function cellLabel(i: number): string {
  const s = session.state!;
  const cell = s.cells[i]!;
  const x = i % s.width, y = Math.floor(i / s.width);
  const SPECIAL_LABELS = ["", N("horizontal ray"), N("vertical ray"), N("bloom"), N("prism")];
  const what = cell.crate > 0
    ? (cell.crate > 1 ? T("crate, {n} hits left", { n: cell.crate }) : T("crate, 1 hit left"))
    : cell.j
      ? T(COLOR_NAMES[cell.j.c]!) + (cell.j.s ? " " + T(SPECIAL_LABELS[cell.j.s]!) : "") + (cell.ice > 0 ? ", " + (cell.ice > 1 ? T("frozen deeply") : T("frozen")) : "")
      : T("empty");
  return T("row {r} column {c}: {what}", { r: y + 1, c: x + 1, what }) + (i === app.mirrorSel ? ", " + T("selected") : "");
}

// Board presses: queued and decided after the frame's UI is built (the playfield's rectangle is this
// frame's; a press on a HUD widget is the widget's).
const queued: { kind: "down" | "move" | "up"; x: number; y: number; mouse: boolean }[] = [];
let lastTouch = -1e9;
let boardPress = false;
function boardInput(): void {
  const f = frame();
  for (const q of queued.splice(0)) {
    const pf = render.playfield();
    const inside = q.x >= pf.x && q.y >= pf.y && q.x <= pf.x + pf.w && q.y <= pf.y + pf.h;
    const free = app.screen === "game" && !app.overlay && !app.modal && !app.mirror && !app.drawer && !app.replay && !ui.pointerOver();
    if (q.kind === "down") {
      boardPress = inside && free;
      if (boardPress) { audio.unlock(); render.pointerDown(q.x, q.y, now()); } else render.pointerCancel();
    } else if (q.kind === "move") {
      render.pointerMove(q.x, q.y, q.mouse && free && inside, settings.input.holdToDrag !== false, f.scale);
    } else {
      if (boardPress) render.pointerUp(q.x, q.y, now(), f.scale);
      boardPress = false;
    }
  }
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queued.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, mouse: true });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) queued.push({ kind: "move", x, y, mouse: primaryPointer() === "fine" }); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  audio.unlock();
  if (e.phase === "start") queued.push({ kind: "down", x: e.x, y: e.y, mouse: false });
  else if (e.phase === "move") queued.push({ kind: "move", x: e.x, y: e.y, mouse: false });
  else if (e.phase === "end") queued.push({ kind: "up", x: e.x, y: e.y, mouse: false });
  else { queued.length = 0; boardPress = false; render.pointerCancel(); }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  session = new Sess.GameSession({ settings, progress });
  wireSession();
  render.setHandlers(swap, () => audio.cue("select"));
  audio.setMuted(!!settings.audio.muted);
  audio.setOnCaption((key, vars) => {
    if (!settings.access.captions) return;
    app.captions.push({ text: T(key, vars), until: now() + 1.6 });
    while (app.captions.length > 3) app.captions.shift();
  });
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyTheme();
  applyGraphics();
  render.clear();
  session.transition("title", "boot-complete");
  show("title", "btn-play");
  if (resumeOffer()) { app.modal = "resume"; app.focusNext = "modal-resume"; audio.cue("open"); }
});
platform.onSettingsChange(() => { applyGraphics(); applyTheme(); audio.setMuted(!!settings.audio.muted); });
platform.onProgressMerged(() => toast(T("Cloud save applied."), "ok"));
platform.onPlayer(() => { if (!platform.signedIn() && started) toast(account().signedOut); });
let started = false;
onPreferencesChange((p) => { render.setReducedMotion(p.reducedMotion); applyPalette(); });
onSessionEnded(() => toast(account().signedOut));
let hidden = false;
onSuspend(() => {
  hidden = true;
  if (session.status === "active" || session.status === "resolving") session.pause("hidden");
  session.saveSnapshot();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });

onFixedUpdate(() => {
  if (hidden) return;
  started = true;
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i]!;
    t.left -= STEP_MS;
    if (t.left <= 0) { timers.splice(i, 1); i--; t.fn(); }
  }
  if (session.status === "paused") return;
  render.tick(STEP_MS);
  session.tick(STEP_MS);
  if (resolve) {
    resolve.left -= STEP_MS;
    if (resolve.left <= 0) {
      const r = resolve;
      resolve = null;
      render.finalize();
      if (!r.cosmetic) session.settled();
    }
  }
  if (app.replay) {
    if (replayResolve > 0) { replayResolve -= STEP_MS; if (replayResolve <= 0) render.finalize(); }
    if (!app.replay.done) { app.replay.left -= STEP_MS; if (app.replay.left <= 0) replayStep(); }
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  applyTokens(preferences().highContrast, settings.cosmetics.theme);
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until > t);
  app.captions = app.captions.filter((x) => x.until > t);
  void lastResolveReason;
});
onRender(() => {
  drawScreens();
  boardInput();
  render.update(frameDt, now());
});
