// The browser build's DOM shell (index.html + js/ui/ui.js + css/style.css) as
// starhermit:ui, built every frame: the header (brand and the Boards /
// Achievements / Help / Settings nav), the title (key art under its scrim, the
// logo, Play, the Daily / Journey / Profile chips, invite and sign-in), mode
// select, the Journey map, setup (the per-mode picker and the round's facts
// and goals), the round (status bar, objective and actions rails — drawers
// with edge tabs on compact layouts — the thumb tray in portrait, the lesson
// banner, the Ready… Set… Go! countdown, the text board), the pause and
// results dialogs, the resume offer and reset confirmations, Settings, Help,
// Achievements, Boards, Profile, and the toasts and captions. The browser's
// media queries are layouts picked by the window's logical size: wide
// (≥ 1024 px: rails beside the board), compact (narrower: drawers), portrait
// (the thumb tray), short landscape (≤ 560 px tall: the status bar as a side
// column); the left-handed setting mirrors the drawers and the toasts.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Ach, Content, Rules, Store, Themes, type Content as Round, type Goal } from "./game.ts";
import { T, N, fmtInt, account } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, back, bannerButton, canAct, cellLabel, contentDesc, contentName, copyInvite, cycleCamera, dailyCountdown, dayKey, discardSnapshot,
  doHint, doPause, doSkip, doUndo, fmtTime, goalLeftText, goalText, leaderboardLine, leaveRound, leaveToTitle, masteryProgress, mirrorTap,
  modeName, nextLabel, openFromPause, openJourney, openNav, openProfile, openSetup, palette, pickContent, pickJourney, play, playerName,
  progress, randomChase, REASON_HEADLINES, replayTutorials, restartRound, resultsMenu, resultsNext, resultsRetry, resumeOffer, resumeRound,
  resumeSnapshot, session, setBoardTab, setSetting, settings, signIn, startReplay, startSetup, todayChase, toggleDrawer, toggleMirror,
  wipeAll, type ModeId,
} from "./main.ts";
import { ink } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; phone: boolean; portrait: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const wide = lw >= 1024;
  const shortLand = !wide && lw > lh && lh <= 560;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide, phone: lw < 600, portrait: !wide && lh >= lw, shortLand };
}
const lastHeight = new Map<string, number>();
const pr = (): ui.UiPreferences => ui.preferences();
const hc = (): boolean => pr().highContrast;
function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / pr().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 4;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; width?: number }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 30);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, b.width ?? (buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / pr().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: [cls] }).width / pr().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
const ARROWS: Record<string, string> = { "Arrow Left": "←", "Arrow Right": "→", "Arrow Up": "↑", "Arrow Down": "↓", Escape: "Esc", Slash: "?", "/": "?" };
function kbd(action: string): string { const l = bindingLabel(action, "keyboard"); return ARROWS[l] ?? l; }
function padLabel(action: string): string { return bindingLabel(action, "gamepad") || "—"; }
const starsText = (n: number): string => (n > 0 ? "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n)) : "☆☆☆");
const upper = (s: string): string => s.toLocaleUpperCase();

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  let top = 0;
  if (app.screen === "title") titleBackdrop();
  if (app.screen !== "game") top = header(L);
  switch (app.screen) {
    case "title": titleScreen(L, top); break;
    case "modes": modesScreen(L, top); break;
    case "journey": journeyScreen(L, top); break;
    case "setup": setupScreen(L, top); break;
    case "game": gameScreen(L); break;
    case "settings": settingsScreen(L, top); break;
    case "help": helpScreen(L, top); break;
    case "achievements": achievementsScreen(L, top); break;
    case "boards": boardsScreen(L, top); break;
    case "profile": profileScreen(L, top); break;
  }
  if (app.screen === "game") {
    if (app.overlay === "pause") pauseDialog(L);
    else if (app.overlay === "results") resultsDialog(L);
  }
  modals(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

function header(L: Layout): number {
  const navs: [string, string, "boards" | "achievements" | "help" | "settings"][] = [
    ["nav-boards", T("Boards"), "boards"], ["nav-achievements", T("Achievements"), "achievements"], ["nav-help", T("Help"), "help"], ["nav-settings", T("Settings"), "settings"],
  ];
  const w = L.lw - 24;
  const navCls = L.phone ? "nav-btn-small" : "nav-btn";
  const brandW = buttonWidth("Jewel Cascade", ["nav-btn", "brand"]);
  const navW = navs.reduce((a, [, t]) => a + buttonWidth(t, [navCls]) + 4, 0);
  const oneRow = brandW + navW + 16 <= w;
  const r = ui.place("header", { anchor: "top-start", x: 0, y: 0 }, () => {
    const brand = (): void => { if (ui.style("nav-btn", "brand").id("brand-home").button("Jewel Cascade")) leaveToTitle(); };
    const nav = (width: number): void => flow("nav", navs.map(([id, text, s]) => ({ id, text, style: [navCls], act: () => openNav(s) })), width, oneRow ? "end" : "center", 4);
    if (oneRow) ui.row("header-row", () => { brand(); ui.spacer(); nav(navW + 8); }, { width: w, align: "center" });
    else ui.column("header-col", () => { brand(); nav(w); }, { width: w, align: "center", spacing: 0 });
  }, { style: "topbar", width: L.lw });
  return r.height / L.sc;
}

/** A centred panel under the header, `maxW` wide, scrolling when taller than the window. */
function page(key: string, L: Layout, top: number, maxW: number, build: (w: number) => void, panel = true): void {
  const avail = Math.max(80, L.lh - top);
  const pad = L.phone ? 10 : 16;
  const pw = Math.min(maxW, L.lw - 2 * pad);
  const padIn = panel ? (L.phone ? 14 : 22) : 0;
  const h = lastHeight.get(key) ?? 0;
  const scroll = h > avail;
  ui.place(`page-${key}`, { anchor: "top-start", x: 0, y: top }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-outer`, () => {
        ui.column(`${key}-col`, () => build(pw - 2 * padIn - (scroll ? 12 : 0)), {
          ...(panel ? { style: "panel" } : {}), width: pw - (scroll ? 12 : 0), spacing: 10, padding: panel ? { top: L.phone ? 14 : 19, bottom: L.phone ? 14 : 19, start: padIn, end: padIn } : 0,
        });
      }, { padding: { top: pad, bottom: pad }, align: "center" });
      lastHeight.set(key, r.height / L.sc);
    };
    const fresh = frame().frame - app.openedFrame <= 5;
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => ui.column(`${key}-sc`, body, { width: L.lw - 12, align: "center" }), fresh ? { scrollTo: { top: 0 } } : undefined);
    else ui.column(`${key}-center`, body, { width: L.lw, height: avail, align: "center", justify: "center" });
  }, { width: L.lw });
}
function backRow(w: number, extra: Btn[] = [], primary?: Btn): void {
  const list: Btn[] = [{ id: "btn-back", text: T("Back"), act: back }, ...extra];
  if (primary) list.push(primary);
  flow("back-row", list, w, "end");
}

// ------------------------------------------------------------------ title
function titleBackdrop(): void {
  const f = frame();
  draw.box(0, 0, f.width, f.height, "title-bg");
  if (!hc()) draw.box(0, 0, f.width, f.height, "title-art");
  draw.box(0, 0, f.width, f.height, hc() ? "title-scrim-hc" : "title-scrim");
}
function chip(id: string, title: string, sub: string, w: number, act: () => void): void {
  if (ui.style("chip", { width: w }).id(id).button(title + ". " + sub, {
    content: () => ui.column(`${id}-face`, () => {
      ui.style("chip-title").label(title);
      para(sub, w - 30, "chip-sub", `${id}-sub`);
    }, { spacing: 2, align: "start" }),
  })) act();
}
function titleScreen(L: Layout, top: number): void {
  page("title", L, top, 900, (w) => {
    ui.column("title-wrap", () => {
      const size = Math.max(41.6, Math.min(72, L.lw * 0.08));
      ui.style("game-logo", { text: { size } }).id("title-h").heading("Jewel Cascade");
      para(T("Swap jewels, chase cascades, finish the goals."), w, "tagline", "tagline", true);
      if (ui.style("btn-huge").id("btn-play").button(T("Play"))) play();
      const total = Content.JOURNEY.length;
      const stars = Object.values(progress.journeyStars || {}).reduce((n, s) => n + s, 0);
      const nextStage = Math.min(progress.journeyUnlocked || 1, total);
      const best = (progress.daily.best || {})[dayKey()];
      const level = Ach.masteryLevelForXp(progress.masteryXp || 0);
      const syncs: Record<string, string> = { local: "", syncing: N("cloud: saving…"), saving: N("cloud: saving…"), synced: N("cloud: synced"), offline: N("cloud: offline") };
      const sync = platform.syncState();
      const chips: [string, string, string, () => void][] = [
        ["chip-daily", T("Daily challenge"), (best ? T("Best {score}", { score: fmtInt(best) }) + " · " : "") + T("new board in {time}", { time: dailyCountdown() }), () => openSetup("daily")],
        ["chip-journey", T("Journey"), T("Stage {n} of {total} · {stars}★", { n: nextStage, total, stars }), () => { audio(); openJourney(); }],
        ["chip-profile", T("Profile"), T("{name} · mastery {level}", { name: playerName(), level }) + (sync !== "local" ? " · " + T(syncs[sync]!) : ""), openProfile],
      ];
      const cw = chips.map(([, t, s]) => Math.max(160, Math.min(260, Math.max(textWidth(t, "chip-title"), textWidth(s, "chip-sub")) + 32)));
      const rowW = cw.reduce((a, b) => a + b, 0) + 16;
      if (rowW <= w) ui.row("chips", () => chips.forEach(([id, t, s, act], i) => chip(id, t, s, cw[i]!, act)), { spacing: 8, align: "stretch" });
      else ui.column("chips", () => chips.forEach(([id, t, s, act]) => chip(id, t, s, Math.min(w, 320), act)), { spacing: 8, align: "center" });
      const acct: Btn[] = [];
      if (platform.inviteLink()) acct.push({ id: "btn-invite", text: account().invite, style: ["btn-small"], act: copyInvite });
      if (!platform.signedIn()) acct.push({ id: "btn-signin", text: account().signIn, style: ["btn-small"], act: signIn });
      if (acct.length) flow("title-account", acct, w, "center");
    }, { spacing: 16, align: "center", width: w });
  }, false);
}
function audio(): void { /* chips sound through their target screens */ }

// ------------------------------------------------------------------ mode select
const MODES: [ModeId, string, string, boolean][] = [
  ["learn", N("Learn"), N("Short hands-on lessons — one rule at a time."), false],
  ["journey", N("Journey"), N("40 authored stages with growing mechanics."), false],
  ["daily", N("Daily"), N("One shared seed per UTC day. Same board for everyone."), true],
  ["practice", N("Practice"), N("Your difficulty, your seed, undo allowed. Unrated."), false],
  ["challenge", N("Challenge"), N("Tight move limits, timers and altered layouts."), true],
  ["score", N("Score chase"), N("Chase the board on a validated shareable seed."), true],
];
function modesScreen(L: Layout, top: number): void {
  page("modes", L, top, 896, (w) => {
    heading("h2", T("Choose a mode"), w, "modes-h");
    const gap = 8;
    const cols = L.phone ? 2 : Math.max(1, Math.min(3, Math.floor((w + gap) / (240 + gap))));
    const cw = (w - gap * (cols - 1)) / cols;
    const inner = cw - (L.phone ? 24 : 34);
    ui.column("mode-grid", () => {
      for (let i = 0; i < MODES.length; i += cols) {
        ui.row(`mode-r${i}`, () => {
          for (const [id, name, desc, ranked] of MODES.slice(i, i + cols)) {
            if (ui.style("mode-card", { width: cw, ...(L.phone ? { padding: 12 } : {}) }).id(`mode-${id}`).button(T(name) + ". " + T(desc), {
              content: () => ui.column(`mode-${id}-face`, () => {
                para(T(name), inner, "mode-name");
                para(T(desc), inner, "mode-desc");
                ui.style(ranked ? "badge-ranked" : "badge-casual").label(upper(ranked ? T("Ranked") : T("Casual")));
              }, { spacing: L.phone ? 4 : 6, align: "start", width: inner }),
            })) openSetup(id);
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    backRow(w);
  });
}

// ------------------------------------------------------------------ Journey
function journeyScreen(L: Layout, top: number): void {
  page("journey", L, top, 896, (w) => {
    heading("h2", T("Journey"), w, "journey-h");
    const unlocked = progress.journeyUnlocked || 1;
    let totalStars = 0;
    for (const c of Content.JOURNEY) totalStars += (progress.journeyStars || {})[c.id] || 0;
    const done = Object.keys(progress.journeyStars || {}).length;
    para(T("{done} of {total} stages complete · {stars}★ earned · mastery stages marked ◆", { done, total: Content.JOURNEY.length, stars: totalStars }), w, "dim", "journey-progress");
    const gap = 8;
    const cols = Math.max(4, Math.floor((w + gap) / (74 + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("journey-grid", () => {
      for (let i = 0; i < Content.JOURNEY.length; i += cols) {
        ui.row(`jr-${i}`, () => {
          Content.JOURNEY.slice(i, i + cols).forEach((c, k) => {
            const n = i + k + 1;
            const got = (progress.journeyStars || {})[c.id] || 0;
            const label = T("Stage {n}", { n }) + (c.mastery ? " " + T("(mastery)") : "") + (got ? ", " + T("{n} stars", { n: got }) : "") + (n > unlocked ? ", " + T("locked") : "");
            if (ui.style(n === unlocked ? "stage-current" : "stage-btn", { width: cw, height: Math.max(56, Math.min(cw, 84)) }).id(`stage-${n}`).button(label, {
              disabled: n > unlocked,
              content: () => ui.column(`stage-${n}-face`, () => {
                ui.style("stage-num").label((c.mastery ? "◆ " : "") + String(n));
                ui.style("stage-stars").label("★".repeat(got) + "☆".repeat(3 - got));
              }, { spacing: 2, align: "center" }),
            })) pickJourney(n - 1);
          });
        }, { spacing: gap });
      }
    }, { spacing: gap, width: w });
    backRow(w);
  });
}

// ------------------------------------------------------------------ setup
function pickerItem(id: string, name: string, mark: string, markCls: string, w: number, selected: boolean, act: () => void, sub?: string): void {
  const inner = w - 30;
  if (ui.style("picker-item", { width: w }).id(id).button(name + (sub ? ". " + sub : "") + (mark ? ", " + mark : ""), {
    selected,
    content: () => ui.column(`${id}-face`, () => {
      ui.row(`${id}-row`, () => {
        para(name, Math.max(60, inner - (mark ? textWidth(mark, markCls) + 12 : 0)), "body");
        if (mark) { ui.spacer(); ui.style(markCls).label(mark); }
      }, { width: inner, align: "center" });
      if (sub) para(sub, inner, "dim-small");
    }, { spacing: 2, width: inner }),
  })) act();
}
function setupScreen(L: Layout, top: number): void {
  const mode = app.setupMode;
  page("setup", L, top, 896, (w) => {
    heading("h2", T("Setup — {mode}", { mode: modeName(mode) }), w, "setup-h");
    const choice = app.setupChoice;
    ui.column("setup-picker", () => {
      if (mode === "learn") {
        for (const l of Content.LESSONS) {
          const done = !!(progress.tutorialsDone && progress.tutorialsDone[l.tutorial ?? ""]);
          pickerItem(`pick-${l.id}`, contentName(l), done ? "✓ " + T("done") : "", "done-mark", w, choice?.id === l.id, () => pickContent(l));
        }
      } else if (mode === "daily") {
        const c = Content.dailyContent(dayKey());
        const best = (progress.daily.best || {})[dayKey()];
        pickerItem(`pick-${c.id}`, contentName(c), best ? T("best {score}", { score: fmtInt(best) }) : "", "done-mark", w, choice?.id === c.id, () => pickContent(c));
        para(T("One shared seed per UTC day; your best is kept. Next board in {time}.", { time: dailyCountdown() }), w, "dim");
      } else if (mode === "practice") {
        for (const d of Content.PRACTICE_DIFFICULTIES) {
          pickerItem(`pick-practice-${d.id}`, T(d.name), "", "done-mark", w, choice?.difficulty === d.id && choice?.kind === "practice",
            () => pickContent(Content.practiceContent(d.id, app.practiceSeed)), T(d.desc));
        }
        ui.row("seed-row", () => {
          ui.style("body").label(T("Seed (optional)"));
          app.practiceSeed = ui.textField("practice-seed", app.practiceSeed, { maxChars: 32, width: Math.min(260, w - 160), placeholder: T("random") });
        }, { spacing: 10, align: "center" });
      } else if (mode === "challenge") {
        for (const c of Content.CHALLENGES) {
          const best = (progress.challengesDone || {})[c.id] || 0;
          pickerItem(`pick-${c.id}`, contentName(c), best ? "★".repeat(best) : "", "stage-stars", w, choice?.id === c.id, () => pickContent(c));
        }
      } else if (mode === "score") {
        const before = app.chaseSeed;
        ui.row("chase-row", () => {
          ui.style("body").label(T("Seed"));
          app.chaseSeed = ui.textField("chase-seed", app.chaseSeed, { maxChars: 40, width: Math.min(260, w - 70), placeholder: T("any word or phrase") });
        }, { spacing: 10, align: "center" });
        if (app.chaseSeed !== before && app.chaseSeed.trim()) app.setupChoice = Content.scoreChaseContent(app.chaseSeed);
        flow("chase-btns", [
          { id: "chase-random", text: T("Random"), style: ["btn-small"], act: randomChase },
          { id: "chase-today", text: T("Today's seed"), style: ["btn-small"], act: todayChase },
        ], w);
        para(T("Share a seed with a friend to chase the same board. Fixed ruleset: the same seed and moves always give the same score."), w, "dim");
      }
    }, { spacing: 8, width: w });
    if (choice) setupSummary(choice, w);
    backRow(w, [], { id: "setup-start", text: T("Start"), style: ["btn-primary"], disabled: !choice, act: startSetup });
  });
}
function setupSummary(c: Round, w: number): void {
  ui.column("setup-summary", () => {
    heading("h3", contentName(c), w, "setup-name");
    para(contentDesc(c), w, "dim", "setup-desc");
    const blockers: string[] = [];
    if (c.ice && c.ice.length) blockers.push(T("{n} ice", { n: c.ice.length }));
    if (c.crates && c.crates.length) blockers.push(T("{n} crates", { n: c.crates.length }));
    const rulesLine = T("{w}×{h} · {colors} colors · {moves} moves", { w: c.width, h: c.height, colors: c.colors, moves: c.moves > 100 ? T("unlimited") : c.moves }) + (blockers.length ? " · " + blockers.join(", ") : "");
    const duration = c.timeLimitSec ? T("{time} timed", { time: fmtTime(c.timeLimitSec * 1000) }) : T("~{n} min", { n: Math.max(1, Math.round((Math.min(c.moves, 40) * 4) / 60)) });
    const assists = [c.assists.undo ? T("undo") : T("no undo"), c.assists.hints ? T("hints") : T("no hints")];
    if (settings.access.timingAssist && c.timeLimitSec) assists.push(T("timing assist ×1.5"));
    const ranked = c.ranked ? (platform.signedIn() ? T("Ranked (personal bests)") : T("Ranked (recorded locally)")) : T("Casual");
    facts("setup-facts", [[T("Rules"), rulesLine], [T("Expected duration"), duration], [T("Players"), "1"], [T("Assists"), assists.join(", ")], [T("Ranked?"), ranked]], w);
    ui.style("h4").label(T("Goals"));
    if (c.kind === "lesson") para(T("Finish every guided step."), w, "body");
    else goalList("setup-goals", c.goals.map((g) => ({ ...g, left: g.n, done: false })) as Goal[], w, false);
  }, { spacing: 6, width: w });
}
function facts(id: string, rows: [string, string][], w: number): void {
  const dtW = Math.min(w * 0.42, Math.max(...rows.map(([k]) => textWidth(k + ":", "fact-dt"))) + 4);
  ui.column(id, () => rows.forEach(([k, v], i) => ui.row(`${id}-${i}`, () => {
    ui.column(`${id}-${i}-k`, () => para(k + ":", dtW, "fact-dt"), { width: dtW });
    para(v, w - dtW - 16, "fact-dd", `${id}-${i}-v`);
  }, { spacing: 16, align: "start" })), { spacing: 4, width: w, style: "facts" });
}
function swatch(id: string, g: { type: string; color?: number }): void {
  const pal = palette();
  let bg = "#6b5136", fg = "#ffe9c4", glyph = "▣";
  if (g.type === "collect") { bg = pal[g.color ?? 0] ?? "#ffffff"; fg = g.color === 5 ? "#f4ecdf" : g.color === 6 ? "#2a2440" : "#14101f"; glyph = "RATESMO"[g.color ?? 0] ?? "?"; }
  else if (g.type === "ice") { bg = "#9fd8ef"; fg = "#14303c"; glyph = "❄"; }
  else if (g.type === "score") { return; }
  ui.style({ background: bg, radius: 7, width: 24, height: 24, border: { width: 1, color: "#00000059" }, padding: 0, text: { color: fg, size: 12.8, weight: "800", align: "center" } }).id(id).label(glyph);
}
function goalList(id: string, goals: Goal[], w: number, live: boolean): void {
  ui.column(id, () => goals.forEach((g, i) => ui.row(`${id}-${i}`, () => {
    swatch(`${id}-${i}-sw`, g);
    const text = goalText(g) + (live ? " — " + goalLeftText(g) : "");
    para(text, w - 60, g.done ? "goal-done-text" : "goal-text", `${id}-${i}-t`);
    if (g.done) ui.style("goal-check").label("✓");
  }, { spacing: 8, align: "center" })), { spacing: 6, width: w });
}

// ------------------------------------------------------------------ the round
let lastHudW = 0;
function statusBar(L: Layout, vertical: boolean): ui.Rect {
  const s = session.state!;
  const items: [string, string, string, boolean][] = [["score", T("Score"), fmtInt(s.score), false], ["moves", T("Moves"), s.movesLeft > 100 ? "∞" : String(s.movesLeft), false]];
  if (session.timeLeftMs !== null && session.timeLeftMs !== undefined) items.push(["timer", T("Time"), fmtTime(session.timeLeftMs), session.timeLeftMs < 10000]);
  const stateText = T(app.hudState);
  const build = (): void => {
    for (const [id, k, v, warn] of items) {
      ui.row(`hud-${id}`, () => { ui.style("hud-label").label(upper(k)); ui.style(warn ? "hud-warn" : "hud-value").id(`hud-${id}-v`).label(v); }, { spacing: 6, align: "center" });
    }
    ui.style("hud-state").id("hud-state").label(stateText);
  };
  // Short landscape: a side column under the drawer tab, its readouts centred down it.
  if (vertical) return ui.place("hud-status", { anchor: "top-start", x: 8, y: 60 }, () => ui.column("hud-col", build, { style: "hud-status", width: 152, height: Math.max(120, L.lh - 68), spacing: 5, align: "start", justify: "center" }));
  const r = ui.place("hud-status", { anchor: "top", y: 8 }, () => ui.row("hud-row", build, { style: "hud-status", spacing: L.phone ? 14 : 19, align: "center" }));
  lastHudW = r.width / L.sc;
  return r;
}
function objectiveRail(w: number): void {
  const c = session.content!;
  const s = session.state!;
  heading("h3", T("Objective"), w, "objective-h");
  para(contentName(c), w, "dim", "round-name");
  goalList("hud-goals", s.goals, w, true);
  const assists: string[] = [];
  if (c.assists.undo) assists.push(T("Undo allowed"));
  if (!c.assists.hints) assists.push(T("No hints"));
  if (c.ranked) assists.push(T("Ranked"));
  if (assists.length) para(assists.join(" · "), w, "hint-line", "assists-line");
}
function kbdButton(id: string, text: string, key: string, w: number, disabled: boolean, act: () => void): void {
  if (ui.style("btn", { width: w }).id(id).button(text, {
    disabled,
    content: () => ui.row(`${id}-face`, () => { ui.style("body").label(text); if (key) ui.style("kbd").label(key); }, { spacing: 8, align: "center" }),
  })) { ui.setFocus(null); act(); }
}
function actionsRail(w: number): void {
  const c = session.content!;
  const ready = canAct();
  kbdButton("btn-hint", T("Hint"), kbd("hint"), w, !c.assists.hints, doHint);
  kbdButton("btn-undo", T("Undo"), kbd("undo"), w, !c.assists.undo, doUndo);
  if (session.status === "resolving") kbdButton("btn-skip", T("Skip"), kbd("skip"), w, false, doSkip);
  kbdButton("btn-camera", T("Camera"), kbd("camera"), w, false, cycleCamera);
  kbdButton("btn-mirror", T("Text board"), "", w, false, toggleMirror);
  kbdButton("btn-pause", T("Pause"), kbd("pause"), w, !(ready || session.status === "resolving"), doPause);
}
/** A rail panel; when taller than `maxH` its content scrolls. */
function rail(id: string, x: number, y: number, w: number, maxH: number, build: (w: number) => void): ui.Rect {
  const ch = lastHeight.get(id) ?? 0;
  const scroll = ch > maxH;
  return ui.place(id, { anchor: "top-start", x, y }, () => {
    const inner = (): void => {
      const r = ui.column(`${id}-in`, () => build(w - 32 - (scroll ? 12 : 0)), { spacing: 8 });
      lastHeight.set(id, r.height / ui.preferences().scale + 28);
    };
    ui.column(`${id}-col`, () => {
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - 32, height: maxH - 28 }, inner);
      else inner();
    }, { style: "rail", width: w, ...(scroll ? { height: maxH } : {}) });
  }, { width: w });
}
function gameScreen(L: Layout): void {
  const s = session.state;
  if (!s || !session.content) return;
  const f = frame();
  const sc = L.sc;
  const left = !!settings.display.leftHanded;
  const inRound = !app.replay;
  let x0 = 8, x1 = L.lw - 8, y0 = 8, y1 = L.lh - 8;
  // The status bar: across the top, or a side column in short landscape.
  const st = inRound ? statusBar(L, L.shortLand) : null;
  if (st) {
    if (L.shortLand) x0 = Math.max(x0, st.width / sc + 16);
    else y0 = st.height / sc + 16;
  }
  let trayH = 0;
  if (inRound && L.portrait) trayH = thumbTray(L);
  y1 -= trayH;
  if (inRound && L.wide) {
    const rw = Math.min(240, L.lw * 0.32);
    const railTop = y0;
    const maxH = L.lh - railTop - 8;
    const lr = rail("rail-objective", left ? L.lw - 8 - rw : 8, railTop, rw, maxH, objectiveRail);
    const rr = rail("rail-actions", left ? 8 : L.lw - 8 - rw, railTop, rw, maxH, actionsRail);
    void lr; void rr;
    x0 = 8 + rw + 16; x1 = L.lw - 8 - rw - 16;
    // The status bar sits between the rails.
  } else if (inRound) drawers(L, y0, trayH, left);
  // The lesson / replay banner is carved out of the board's area.
  if (app.banner) {
    const b = banner(L, trayH);
    if (b.side) x1 = Math.min(x1, L.lw - b.w - 16);
    else y1 = Math.min(y1, L.lh - b.bottom - b.h - 8);
  }
  const pw = Math.max(80, x1 - x0), ph = Math.max(80, y1 - y0);
  render.setPlayfield((L.ox + x0) * sc, (L.oy + y0) * sc, pw * sc, ph * sc, f.width, f.height);
  if (app.mirror) mirrorPanel(L, trayH);
  if (app.countdown) ui.place("countdown", "center", () => ui.style("ready").id("ready-text").label(T(app.countdown!)));
  void lastHudW;
}
function thumbTray(L: Layout): number {
  const c = session.content!;
  const list: Btn[] = [
    { id: "tray-hint", text: T("Hint"), disabled: !c.assists.hints, act: () => { ui.setFocus(null); doHint(); } },
    { id: "tray-undo", text: T("Undo"), disabled: !c.assists.undo, act: () => { ui.setFocus(null); doUndo(); } },
    { id: "tray-mirror", text: T("Board"), selected: app.mirror, act: toggleMirror },
    { id: "tray-pause", text: T("Pause"), act: () => { ui.setFocus(null); doPause(); } },
  ];
  if (settings.display.leftHanded) list.reverse();
  const gap = 8;
  const bw = Math.min(144, (L.lw - 20 - gap * (list.length - 1)) / list.length);
  const r = ui.place("thumb-tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    ui.row("tray-row", () => { for (const b of list) button(b, bw); }, { width: L.lw, spacing: gap, justify: "space-evenly", align: "center", style: "thumb-tray" });
  }, { width: L.lw });
  return r.height / L.sc;
}
function drawers(L: Layout, statusBottom: number, trayH: number, left: boolean): void {
  const tabY = L.portrait ? L.lh - trayH - 102 + 44 - 44 : L.shortLand ? 13 : Math.max(statusBottom, 64);
  const tabs: ["objective" | "actions", string, boolean][] = [["objective", T("Objective"), !left], ["actions", T("Actions"), left]];
  for (const [which, text, atStart] of tabs) {
    const bw = buttonWidth(text, ["drawer-tab"]);
    ui.place(`tab-${which}`, { anchor: "top-start", x: atStart ? 0 : L.lw - bw, y: tabY }, () => {
      if (ui.style("drawer-tab", { width: bw }).id(`tab-${which}`).button(text, { selected: app.drawer === which })) toggleDrawer(which);
    });
  }
  if (!app.drawer) return;
  const top = L.shortLand ? 60 : Math.max(statusBottom, 58);
  const bottom = L.portrait ? trayH + 120 - 44 : L.shortLand ? 10 : 88;
  const maxH = Math.max(120, L.lh - top - bottom);
  if (app.drawer === "objective") {
    const w = Math.min(240, L.lw * 0.78);
    rail("rail-objective", left ? L.lw - 8 - w : 8, top, w, maxH, objectiveRail);
  } else {
    const w = Math.min(192, L.lw * 0.78);
    rail("rail-actions", left ? 8 : L.lw - 8 - w, top, w, maxH, actionsRail);
  }
}
function banner(L: Layout, trayH: number): { w: number; h: number; bottom: number; side: boolean } {
  const b = app.banner!;
  const side = L.lh <= 480;
  const w = side ? Math.min(352, L.lw * 0.42) : Math.min(640, L.lw - (L.phone ? 19 : 32));
  const bottom = side ? 6 : L.portrait ? trayH + 52 + 8 : 16;
  const h = lastHeight.get("banner") ?? 90;
  const r = ui.place("tutorial-banner", side ? { anchor: "bottom-end", x: 6, y: bottom } : { anchor: "bottom", y: bottom }, () => {
    ui.column("banner-col", () => {
      para(T(b.text), w - 34, "tutorial-text", "tutorial-text");
      ui.row("banner-meta", () => {
        if (b.meta) ui.style("tutorial-meta").id("tutorial-step").label(b.meta);
        ui.spacer();
        if (ui.style("btn-small").id("btn-banner").button(T(b.button))) bannerButton();
      }, { width: w - 34, align: "center" });
    }, { style: "tutorial-banner", width: w, spacing: 6 });
  });
  lastHeight.set("banner", r.height / L.sc);
  return { w, h, bottom, side };
}
function mirrorPanel(L: Layout, trayH: number): void {
  const s = session.state!;
  const w = Math.min(544, L.lw - 16);
  const inner = w - 30;
  const maxH = Math.min(L.lh * 0.7, 544, L.lh - trayH - 20);
  const bottom = trayH + 10;
  const ch = lastHeight.get("mirror") ?? 0;
  const scroll = ch > maxH - 24;
  ui.place("mirror-panel", { anchor: "bottom", y: bottom }, () => {
    const body = (): void => {
      const iw = inner - (scroll ? 12 : 0);
      const r = ui.column("mirror-body", () => {
        ui.row("mirror-head", () => {
          ui.style("h3").label(T("Text board"));
          ui.spacer();
          if (ui.style("btn-small").id("mirror-close").button(T("Close"))) toggleMirror();
        }, { width: iw, align: "center" });
        const legal = s.phase === "ready" ? Rules.legalActions(s).length : 0;
        para(T("Score {n}", { n: fmtInt(s.score) }) + " · " + (s.movesLeft > 100 ? T("unlimited moves") : T("{n} moves left", { n: s.movesLeft })) + " · " + T("{n} legal swaps.", { n: legal }), iw, "dim", "mirror-summary");
        const step = app.lesson?.content.steps?.[app.lesson.i];
        if (step) ui.column("mirror-guide", () => para(T(step.text), iw - 14, "body"), { style: "guide", width: iw });
        mirrorGrid(iw);
        para(T("Click a jewel, then an adjacent jewel, to swap. Keyboard: arrows move the cursor, Enter selects."), iw, "dim-small");
      }, { spacing: 6, width: iw });
      lastHeight.set("mirror", r.height / L.sc);
    };
    ui.column("mirror-col", () => {
      if (scroll) ui.scrollArea("mirror-scroll", { width: inner, height: maxH - 24 }, body);
      else body();
    }, { style: "mirror-panel", width: w });
  });
}
const GLYPHS = "RATESMO";
const SPECIAL_GLYPHS = ["", "↔", "↕", "✳", "◆"];
function mirrorGrid(w: number): void {
  const s = session.state!;
  const pal = palette();
  const gap = 3;
  const size = Math.floor((w - gap * (s.width - 1)) / s.width);
  ui.column("mirror-board", () => {
    for (let y = 0; y < s.height; y++) {
      ui.row(`mb-${y}`, () => {
        for (let x = 0; x < s.width; x++) {
          const i = y * s.width + x;
          const cell = s.cells[i]!;
          if (!cell.play) { ui.widget("", { role: "none", size: { width: size, height: size } }); continue; }
          let glyph = "", bg = INK_BG, fg = "#f4ecdf";
          let border: ui.Style["border"] = { width: 1, color: "#00000066" };
          if (cell.crate > 0) { glyph = "▣"; bg = "#6b5136"; fg = "#ffe9c4"; if (cell.crate >= 2) border = { width: 4, color: "#3c2a18" }; }
          else if (cell.j) {
            glyph = (GLYPHS[cell.j.c] ?? "?") + (SPECIAL_GLYPHS[cell.j.s] ?? "");
            bg = pal[cell.j.c] ?? "#ffffff";
            fg = cell.j.c === 5 ? "#f4ecdf" : cell.j.c === 6 ? "#2a2440" : "#14101f";
            if (cell.j.s) border = { width: 3, color: "#fff2cf" };
            if (cell.ice > 0) border = { width: cell.ice > 1 ? 5 : 3, color: "#bfe3f2" };
          }
          const label = cellLabel(i);
          const fontSize = Math.max(9.6, Math.min(16, size * 0.4));
          if (ui.style("mirror-cell", { width: size, height: size, background: bg, border, text: { color: fg, size: fontSize } }).id(`cell-${i}`).button(label, {
            selected: i === app.mirrorSel,
            content: () => ui.style({ text: { color: fg, size: fontSize, weight: "800", align: "center" } }).label(glyph || " "),
          })) mirrorTap(i);
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width: w });
}
const INK_BG = "#2d2148";

// ------------------------------------------------------------------ dialogs
function dialogFrame(label: string, L: Layout, maxW: number, build: (w: number) => void, footer: ((w: number) => void) | null, onClose: (() => void) | null, plate = false): void {
  const w = Math.min(maxW, L.lw - 24) - 40;
  const fh = footer ? (lastHeight.get(`dlg-${label}-foot`) ?? 56) + 12 : 0;
  const avail = Math.max(80, L.lh - 32 - 40 - fh);
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => {
      if (plate) ui.column("res-plate", () => undefined, { style: "res-plate", width: w, height: Math.min(136, w * 0.32) });
      build(w);
    }, { spacing: 10, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  const fresh = frame().frame - app.openedFrame <= 4;
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
    if (footer) {
      const r = ui.column(`${label}-foot`, () => footer(w), { width: w, spacing: 8, padding: { top: 12 } });
      lastHeight.set(`dlg-${label}-foot`, r.height / L.sc - 12);
    }
  });
  // The Escape that opened it must not close it the same frame.
  if (!open && frame().frame !== app.openedFrame && onClose) onClose();
}
function pauseDialog(L: Layout): void {
  dialogFrame(T("Paused"), L, 480, (w) => {
    heading("h2", T("Paused"), w, "pause-h");
    button({ id: "btn-resume", text: T("Resume"), style: ["btn-primary"], act: resumeRound }, w);
    ui.column("pause-gap1", () => undefined, { height: 4 });
    button({ id: "btn-pause-settings", text: T("Settings"), act: () => openFromPause("settings") }, w);
    button({ id: "btn-pause-help", text: T("Help"), act: () => openFromPause("help") }, w);
    ui.column("pause-gap2", () => undefined, { height: 4 });
    button({ id: "btn-pause-restart", text: T("Restart round"), act: restartRound }, w);
    button({ id: "btn-pause-leave", text: T("Leave to menu"), style: ["btn-danger"], act: leaveRound }, w);
  }, null, resumeRound);
}
const COMPONENTS: [keyof NonNullable<typeof app.results>["components"], string][] = [
  ["match", N("Matches")], ["cascade", N("Cascade bonuses")], ["special", N("Specials")], ["blocker", N("Blockers cleared")], ["goal", N("Goal bonuses")], ["leftover", N("Unused-move bonus")],
];
const COSMETIC_NAMES: Record<string, string> = {
  "ember-dusk": N("Ember Dusk"), "moonlit-forge": N("Moonlit Forge"), "verdant-atelier": N("Verdant Atelier"), "frostbound-loft": N("Frostbound Loft"),
  "royal-velvet": N("Royal Velvet"), none: N("None"), spark: N("Sparks"), comet: N("Comet embers"), standard: N("Standard"), brass: N("Brass"),
  filigree: N("Filigree"), apprentice: N("Apprentice"), "cascade-master": N("Cascade Master"),
};
const COSMETIC_TYPES: Record<string, string> = { theme: N("theme"), trail: N("trail"), frame: N("frame"), title: N("title") };
function cosmeticName(id: string): string { return COSMETIC_NAMES[id] ? T(COSMETIC_NAMES[id]!) : id; }
function pills(id: string, list: string[], w: number): void {
  const rows: string[][] = [[]];
  let used = 0;
  for (const t of list) {
    const pw = textWidth(t, "ach-pill") + 8;
    if (rows[rows.length - 1]!.length && used + pw > w) { rows.push([]); used = 0; }
    rows[rows.length - 1]!.push(t);
    used += pw;
  }
  ui.column(id, () => rows.forEach((row, ri) => ui.row(`${id}-${ri}`, () => row.forEach((t, k) => {
    if (textWidth(t, "ach-pill") > w) ui.style("ach-pill").id(`${id}-${ri}-${k}`).paragraph(t, w - 28);
    else ui.style("ach-pill").id(`${id}-${ri}-${k}`).label(t);
  }), { spacing: 8 })), { spacing: 8, width: w });
}
function xpBar(id: string, pct: number, w: number): void {
  ui.widget("", {
    role: "meter", size: { width: w, height: 12 },
    draw: (r, s) => {
      const k = s.scale;
      const P = ink(hc());
      draw.roundRect(r.x, r.y, r.width, r.height, 6 * k, P.bg2);
      draw.strokeRoundRect(r.x, r.y, r.width, r.height, 6 * k, P.line, 1);
      const fw = Math.max(0, Math.min(1, pct / 100)) * r.width;
      if (fw > 1) draw.box(r.x, r.y, fw, r.height, { background: { type: "linear", angle: 90, stops: [P.accent, P.gold] }, radius: 6 });
    },
  });
  void id;
}
function resultsDialog(L: Layout): void {
  const r = app.results;
  if (!r) return;
  const showPlate = !hc() && L.lh >= 620;
  dialogFrame(T("Results"), L, 544, (w) => {
    heading("h2", T(REASON_HEADLINES[r.reason] ?? N("Round over")), w, "res-h");
    ui.style("res-stars").id("res-stars").label(starsText(r.stars));
    ui.row("res-score-row", () => {
      ui.style("res-score").label(T("Score"));
      ui.style("res-score", { text: { weight: "700" } }).id("res-score").label(fmtInt(r.score));
      if (r.ranked) ui.style("badge-ranked").label(upper(T("Ranked")));
    }, { spacing: 8, align: "center" });
    const lb = leaderboardLine();
    if (lb) para(lb, w, "dim", "res-lb");
    ui.style("h3").label(T("Score breakdown"));
    ui.column("res-breakdown", () => {
      ui.row("bd-head", () => { ui.style("cell-th").label(T("Component")); ui.spacer(); ui.style("cell-th").label(T("Points")); }, { style: "table-row", width: w, align: "center" });
      const rows = COMPONENTS.filter(([k]) => (r.components[k] || 0) > 0);
      if (!rows.length) ui.row("bd-none", () => ui.style("cell-td").label(T("No points scored")), { style: "table-row", width: w });
      rows.forEach(([k, label]) => ui.row(`bd-${k}`, () => {
        para(T(label), w - 110, "cell-th");
        ui.spacer();
        ui.style("cell-td").label(fmtInt(r.components[k] || 0));
      }, { style: "table-row", width: w, align: "center" }));
      ui.row("bd-total", () => { ui.style("cell-total").label(T("Total")); ui.spacer(); ui.style("cell-total").id("res-total").label(fmtInt(r.score)); }, { style: "table-foot", width: w, align: "center" });
    }, { spacing: 0, width: w });
    ui.style("h3").label(T("Goals"));
    goalList("res-goals", r.goals, w, true);
    const newAch = r.progression?.newAchievements ?? [];
    if (newAch.length) {
      ui.style("h3").label(T("Achievements unlocked"));
      pills("res-ach", newAch.map((key) => { const d = Ach.ACHIEVEMENTS.find((a) => a.key === key); return d ? T(d.name) : key; }), w);
    }
    const m = r.progression?.mastery;
    if (m) {
      ui.style("h3").label(T("Mastery"));
      const after = masteryProgress(m.total);
      xpBar("res-xp", after.pct, w);
      para(T("+{xp} XP · level {level}", { xp: m.gained, level: m.levelAfter }) + (m.levelAfter > m.levelBefore ? " — " + T("level up!") : " · " + T("{n} XP to next", { n: after.toNext })), w, "dim", "res-mastery");
      const unl = (r.progression?.unlocks ?? []).map((u) => T("Unlocked {type}: {name}", { type: T(COSMETIC_TYPES[u.type] ?? u.type), name: cosmeticName(u.id) }));
      if (r.progression?.dailyStreak) unl.push(T("Daily streak {n} 🔥", { n: r.progression.dailyStreak }));
      if (unl.length) pills("res-unlocks", unl, w);
    }
    para(T(app.compare), w, "dim", "res-compare");
  }, (w) => {
    flow("res-buttons", [
      { id: "res-retry", text: T("Retry"), act: resultsRetry },
      { id: "res-replay", text: T("Replay"), act: startReplay },
      { id: "res-next", text: nextLabel(r), style: ["btn-primary"], act: resultsNext },
      { id: "res-menu", text: T("Mode select"), act: resultsMenu },
    ], w);
  }, () => { app.openedFrame = frame().frame; /* the results stay until a choice is made */ }, showPlate);
}
function modals(L: Layout): void {
  if (app.modal === "resume") {
    const o = resumeOffer();
    if (!o) { app.modal = null; return; }
    dialogFrame(T("Resume round?"), L, 480, (w) => {
      heading("h2", T("Resume round?"), w, "resume-h");
      para(T("You have an interrupted round:"), w, "body");
      para(T("{name} — score {score}, {moves} moves left.", { name: o.name, score: o.score, moves: o.moves }), w, "dim", "resume-what");
    }, (w) => flow("resume-btns", [
      { id: "modal-resume", text: T("Resume"), style: ["btn-primary"], act: resumeSnapshot },
      { id: "modal-discard", text: T("Discard"), act: discardSnapshot },
    ], w, "end"), discardSnapshot);
  } else if (app.modal === "wipe") {
    dialogFrame(T("Reset all data?"), L, 480, (w) => {
      heading("h2", T("Reset all data?"), w, "wipe-h");
      para(T("This erases every local setting, progress record, and snapshot for Jewel Cascade on this device. This cannot be undone."), w, "body");
    }, (w) => flow("wipe-btns", [
      { id: "modal-wipe", text: T("Erase everything"), style: ["btn-danger"], act: wipeAll },
      { id: "modal-cancel", text: T("Cancel"), style: ["btn-primary"], act: () => { app.modal = null; } },
    ], w, "end"), () => { app.modal = null; });
  }
}

// ------------------------------------------------------------------ settings
function group(id: string, title: string, w: number, build: (w: number) => void): void {
  ui.column(id, () => { ui.style("h3").label(title); build(w); }, { style: "set-group", width: w, spacing: 8 });
}
function check(id: string, label: string, cur: boolean, set: (v: boolean) => void): void {
  const next = ui.id(id).checkbox(label, cur);
  if (next !== cur) { setSetting(() => set(next)); }
}
function selectRow(id: string, label: string, w: number, cur: number, options: (string | ui.SelectOption)[], set: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, Math.max(90, w * 0.4), "body");
    ui.spacer();
    const next = ui.style({ width: Math.min(280, w * 0.55) }).id(id).select(label, cur, options);
    if (next !== cur) set(next);
  }, { width: w, align: "center", spacing: 10 });
}
const PALETTES: [string, string][] = [["default", N("Default")], ["deuter", N("Deuteranopia-safe")], ["protan", N("Protanopia-safe")], ["tritan", N("Tritanopia-safe")], ["contrast", N("High contrast")]];
const CAMERAS: [string, string][] = [["default", N("Default")], ["low", N("Low (near tabletop)")], ["high", N("High (top-down)")]];
function settingsScreen(L: Layout, top: number): void {
  page("settings", L, top, 640, (w) => {
    heading("h2", T("Settings"), w, "set-h");
    group("set-audio", T("Audio"), w, (iw) => {
      para(T("Volumes for music, effects and the interface, the voice limit and mute are in the StarHermit Options."), iw, "dim");
      flow("audio-opts", [{ id: "btn-options", text: T("Open Options"), act: () => openMenu() }], iw);
      check("set-muted", T("Mute game sounds"), !!settings.audio.muted, (v) => { settings.audio.muted = v; });
      check("set-captions", T("Captions for audio cues"), !!settings.access.captions, (v) => { settings.access.captions = v; });
    });
    group("set-gfx", T("Graphics"), w, (iw) => {
      para(T("Graphics quality, render scale and the frame-rate limit are in the StarHermit Options."), iw, "dim");
    });
    group("set-display", T("Display & accessibility"), w, (iw) => {
      para(T("Text size, high contrast, reduced motion and vibration are in the StarHermit Options."), iw, "dim");
      selectRow("set-palette", T("Color palette"), iw, Math.max(0, PALETTES.findIndex(([k]) => k === settings.display.palette)), PALETTES.map(([, t]) => T(t)),
        (i) => setSetting(() => { settings.display.palette = PALETTES[i]![0]; }));
      check("set-left-handed", T("Left-handed layout"), !!settings.display.leftHanded, (v) => { settings.display.leftHanded = v; });
      check("set-timing-assist", T("Timing assistance"), !!settings.access.timingAssist, (v) => { settings.access.timingAssist = v; });
      check("set-hold-drag", T("Hold to drag jewels"), settings.input.holdToDrag !== false, (v) => { settings.input.holdToDrag = v; });
      flow("tut-btns", [{ id: "btn-replay-tutorials", text: T("Replay tutorials (reset progress)"), style: ["btn-small"], act: replayTutorials }], iw);
    });
    group("set-camera-g", T("Camera"), w, (iw) => {
      selectRow("set-camera", T("Camera preset"), iw, Math.max(0, CAMERAS.findIndex(([k]) => k === (settings.camera.preset || "default"))), CAMERAS.map(([, t]) => T(t)),
        (i) => setSetting(() => { settings.camera.preset = CAMERAS[i]![0]; }));
    });
    group("set-controls", T("Controls"), w, (iw) => {
      para(T("Keys and gamepad buttons are rebound in the StarHermit Options."), iw, "dim");
      flow("ctl-btns", [{ id: "btn-rebind", text: T("Change keys and buttons"), act: () => requestRebind() }], iw);
    });
    group("set-profile", T("Profile & privacy"), w, (iw) => {
      if (platform.signedIn()) para(T("Display name") + ": " + platform.displayName(), iw, "body");
      else ui.row("name-row", () => {
        para(T("Display name"), Math.max(90, iw * 0.4), "body");
        ui.spacer();
        const cur = settings.player.displayName === "Guest" ? "" : settings.player.displayName;
        const next = ui.textField("set-display-name", cur, { maxChars: 24, width: Math.min(280, iw * 0.55), placeholder: T("Guest") });
        if (next !== cur) { settings.player.displayName = next.trim().slice(0, 24) || "Guest"; platform.saveSettings(); }
      }, { width: iw, align: "center", spacing: 10 });
    });
    group("set-danger", T("Danger zone"), w, (iw) => {
      para(T("Erase every local setting, progress record and snapshot for this game."), iw, "dim");
      flow("wipe-row", [{ id: "btn-wipe", text: T("Reset all data"), style: ["btn-danger"], act: () => { app.modal = "wipe"; app.focusNext = "modal-cancel"; app.openedFrame = frame().frame; } }], iw);
    });
    backRow(w);
  });
}

// ------------------------------------------------------------------ help
function helpScreen(L: Layout, top: number): void {
  page("help", L, top, 896, (w) => {
    heading("h2", T("How to play"), w, "help-h");
    const cards: [string, string][] = [
      [T("Swap & match"), T("Swap two neighbouring jewels (drag, or tap one then the other). A swap only counts when it lines up three or more of a color. Keyboard: {keys} move the cursor, {confirm} selects.",
        { keys: ["up", "down", "left", "right"].map(kbd).join("/"), confirm: kbd("confirm") })],
      [T("Moves & goals"), T("Every accepted swap spends one move. Finish all goals before moves run out. Goals sit in the objective rail; the HUD shows moves and score.")],
      [T("Rays (4 in a line)"), T("A line of four forges a ray. It fires when matched or struck and clears a whole row or column.")],
      [T("Blooms (L or T)"), T("Matching around a corner grows a bloom, which clears a 3×3 patch when it fires.")],
      [T("Prisms (5 in a line)"), T("Five in a line cut a prism. Swap it with a jewel to shatter every jewel of that color; swap it with another special for a bigger effect.")],
      [T("Ice"), T("Frozen jewels cannot move but still match. Matching through ice cracks it; deep ice takes two hits.")],
      [T("Crates"), T("Crates hold no jewel and never move. Matches next to a crate dent it; banded crates take two hits.")],
      [T("Controls"), T("{hint} hint · {undo} undo (practice) · {skip} skip animation · {camera} camera · {mute} mute · {pause} pause. Gamepad: {a} select, {b} cancel, {x} hint, {y} undo, {start} pause. Rebind everything in the StarHermit Options.",
        { hint: kbd("hint"), undo: kbd("undo"), skip: kbd("skip"), camera: kbd("camera"), mute: kbd("mute"), pause: kbd("pause"),
          a: padLabel("confirm"), b: padLabel("cancel"), x: padLabel("hint"), y: padLabel("undo"), start: padLabel("pause") })],
      [T("Stars & mastery"), T("Finish goals for ★, beat score thresholds for ★★ and ★★★. Every round earns mastery XP toward cosmetic themes, trails, frames, and titles — looks only, never power.")],
      [T("Fair play"), T("Scoring is deterministic: the same seed and the same moves always produce the same score. Daily seeds never change once published.")],
    ];
    const gap = 10;
    const cols = Math.max(1, Math.min(3, Math.floor((w + gap) / (250 + gap))));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("help-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`help-r${i}`, () => cards.slice(i, i + cols).forEach(([h, t], j) => ui.column(`help-${i + j}`, () => {
          para(h, cw - 32, "h4");
          para(t, cw - 32, "body");
        }, { style: "help-card", width: cw, spacing: 6 })), { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    backRow(w);
  });
}

// ------------------------------------------------------------------ achievements
function achievementsScreen(L: Layout, top: number): void {
  page("achievements", L, top, 896, (w) => {
    heading("h2", T("Achievements"), w, "ach-h");
    const owned = Ach.ACHIEVEMENTS.filter((a) => progress.achievements && progress.achievements[a.key]).length;
    para(T("{n} of {total} unlocked.", { n: owned, total: Ach.ACHIEVEMENTS.length }), w, "dim", "ach-summary");
    ui.column("ach-list", () => {
      for (const a of Ach.ACHIEVEMENTS) {
        const got = progress.achievements && progress.achievements[a.key];
        ui.row(`ach-${a.key}`, () => {
          ui.style("ach-icon").label(got ? "★" : "☆");
          ui.column(`ach-${a.key}-t`, () => {
            para(T(a.name), w - 80, "h4");
            para(T(a.desc) + (got ? " " + T("Unlocked {date}.", { date: String(got.at).slice(0, 10) }) : ""), w - 80, "dim");
          }, { spacing: 2 });
        }, { style: got ? "ach-item" : "ach-item-locked", width: w, spacing: 13, align: "start" });
      }
    }, { spacing: 8, width: w });
    backRow(w);
  });
}

// ------------------------------------------------------------------ boards
function boardTable(id: string, caption: string, rows: { name: string; score: number; moves: string; at: string; me?: boolean }[], w: number): void {
  ui.column(id, () => {
    para(caption, w, "caption-board");
    const cols = [0.1, 0.4, 0.2, 0.12, 0.18].map((k) => k * w);
    const line = (key: string, cells: string[], cls: string): void => void ui.row(key, () => cells.forEach((c, i) => ui.column(`${key}-${i}`, () => para(c, cols[i]! - 8, cls), { width: cols[i]! })), { style: "table-row", width: w, align: "center" });
    line(`${id}-h`, ["#", T("Player"), T("Score"), T("Moves"), T("When")], "cell-th");
    rows.forEach((r, i) => line(`${id}-${i}`, [String(i + 1), r.name, fmtInt(r.score), r.moves, r.at], r.me ? "cell-total" : "cell-td"));
  }, { spacing: 0, width: w });
}
function localBests(tab: number): { name: string; score: number; moves: string; at: string }[] {
  let entries = Store.loadBoards().entries.slice();
  if (tab === 2) entries = entries.filter((e) => e.mode === "daily");
  else if (tab === 1) entries = entries.filter((e) => e.name === playerName());
  return entries.sort((a, b) => b.score - a.score).slice(0, 15).map((e) => ({ name: e.name || T("guest"), score: e.score, moves: String(e.moves ?? "—"), at: String(e.at || "").slice(0, 10) }));
}
function boardsScreen(L: Layout, top: number): void {
  page("boards", L, top, 896, (w) => {
    heading("h2", T("Leaderboards"), w, "boards-h");
    const tabs = [T("Global"), T("Friends"), T("Daily")];
    flow("board-tabs", tabs.map((t, i) => ({ id: `tab-board-${i}`, text: t, style: ["tab"], selected: app.boardTab === i, act: () => setBoardTab(i) })), w, "start");
    const b = app.boards;
    const tab = app.boardTab;
    ui.column("boards-list", () => {
      if (tab !== 2 && b && b.loading) { para(T("Loading boards…"), w, "dim"); return; }
      const lines = b && b.tab === tab ? b.lines : null;
      if (tab !== 2 && lines && lines.length) {
        boardTable("board-remote", (tab === 1 ? T("Friends") : T("Global")) + " — " + T("High score"),
          lines.map((l) => ({ name: l.name, score: l.score, moves: "—", at: l.at ? new Date(l.at).toISOString().slice(0, 10) : "", me: l.me })), w);
        return;
      }
      if (tab !== 2 && lines && !lines.length) para(T("No entries yet — be the first."), w, "dim");
      else para(tab === 2 ? T("Personal bests on this device:") : T("Boards unavailable right now. Personal bests:"), w, "dim");
      const local = localBests(tab);
      if (!local.length) para(T("No local results yet."), w, "dim");
      else boardTable("board-local", T("Local bests (casual)"), local, w);
    }, { spacing: 8, width: w });
    backRow(w);
  });
}

// ------------------------------------------------------------------ profile
const COSMETIC_BUCKETS: [string, keyof typeof progress.cosmeticsUnlocked, string[], "theme" | "trail" | "frame" | "title"][] = [
  [N("Theme"), "themes", Themes.THEMES.map((t) => t.id), "theme"],
  [N("Trail"), "trails", ["none", "spark", "comet"], "trail"],
  [N("Frame"), "frames", ["standard", "brass", "filigree"], "frame"],
  [N("Title"), "titles", ["apprentice", "cascade-master"], "title"],
];
function profileScreen(L: Layout, top: number): void {
  page("profile", L, top, 896, (w) => {
    heading("h2", T("Profile"), w, "prof-h");
    ui.row("prof-head", () => {
      const av = platform.avatarBitmap();
      ui.widget("", {
        role: "none", size: { width: 51, height: 51 },
        draw: (r, s) => {
          const P = ink(hc());
          draw.box(r.x, r.y, r.width, r.height, { background: { type: "linear", angle: 160, stops: [P.accent2, P.accent] }, radius: 999 });
          if (av) draw.image(av, r.x, r.y, r.width, r.height);
          else draw.text(playerName().slice(0, 1).toUpperCase(), r.x + r.width / 2, r.y + r.height / 2 - 14 * s.scale, { size: 24 * s.scale, color: "#2a1a08", weight: "800", align: "center" });
        },
      });
      ui.column("prof-names", () => {
        ui.style("profile-name").id("prof-name").label(playerName());
        ui.style("dim").id("prof-title").label(cosmeticName(settings.cosmetics.title));
      }, { spacing: 2 });
    }, { spacing: 16, align: "center" });
    ui.style("h3").label(T("Mastery"));
    const xp = progress.masteryXp || 0;
    const level = Ach.masteryLevelForXp(xp);
    const mp = masteryProgress(xp);
    xpBar("prof-xp", mp.pct, w);
    para(T("Level {level} · {xp} XP", { level, xp }) + " · " + (mp.toNext ? T("{n} to next", { n: mp.toNext }) : T("max level")), w, "dim", "prof-mastery");
    if (platform.signedIn()) {
      const sync = platform.syncState();
      const labels: Record<string, string> = { syncing: N("cloud: saving…"), saving: N("cloud: saving…"), synced: N("cloud: synced"), offline: N("cloud: offline"), local: "" };
      if (labels[sync]) para(T(labels[sync]!), w, "dim", "prof-sync");
    }
    ui.style("h3").label(T("Career"));
    const c = progress.career;
    facts("prof-stats", [
      [T("Rounds completed"), String(c.roundsCompleted || 0)], [T("Rounds won"), String(c.roundsWon || 0)], [T("Current win streak"), String(c.winStreak || 0)],
      [T("Best win streak"), String(c.bestWinStreak || 0)], [T("Total score"), fmtInt(c.totalScore || 0)], [T("Daily streak"), String((progress.daily && progress.daily.streak) || 0)],
    ], w);
    ui.style("h3").label(T("Cosmetics"));
    for (const [label, bucket, all, kind] of COSMETIC_BUCKETS) {
      const unlocked = (progress.cosmeticsUnlocked && progress.cosmeticsUnlocked[bucket]) || [];
      const cur = Math.max(0, all.indexOf(settings.cosmetics[kind]));
      selectRow(`cos-${kind}`, T(label), w, cur, all.map((id) => ({ text: cosmeticName(id) + (unlocked.includes(id) ? "" : " " + T("(locked)")), disabled: !unlocked.includes(id) })),
        (i) => { if (unlocked.includes(all[i]!)) setSetting(() => { settings.cosmetics[kind] = all[i]!; }); });
    }
    para(T("Cosmetics change looks only — never rules, timing, or information."), w, "dim");
    backRow(w);
  });
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout): void {
  const list = [...app.toasts.map((t) => ({ text: t.text, cls: t.kind === "warn" ? "toast-warn" : t.kind === "ok" ? "toast-ok" : "toast", tcls: "toast-text" })),
    ...app.captions.map((c) => ({ text: c.text, cls: "toast-caption", tcls: "toast-caption-text" }))];
  if (!list.length) return;
  const left = !!settings.display.leftHanded;
  const w = Math.min(352, L.lw - 32);
  const trayH = app.screen === "game" && L.portrait && !app.replay ? (lastHeight.get("tray-h") ?? 64) : 0;
  ui.place("toasts", { anchor: left ? "bottom-start" : "bottom-end", x: 16, y: 16 + trayH }, () => {
    ui.column("toast-col", () => list.forEach((t, i) => {
      ui.column(`toast-${i}`, () => para(t.text, w - 32, t.tcls, `toast-${i}-t`), { style: t.cls });
    }), { spacing: 8, align: left ? "start" : "end" });
  });
}
