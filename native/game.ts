// The browser build's pure game modules, imported unchanged in what they
// decide (allowJs): the deterministic rules (js/engine/rules.js: board,
// swaps, cascades, specials, scoring, hints, undo, replay), the versioned
// content (js/engine/content.js: lessons, Journey, the Daily, practice,
// challenges, score chase), the themes and colour-vision palettes, the
// achievements and mastery levels, the seeded RNG, the session (js/session.js:
// the round state machine, its command log, snapshots and progression) and the
// versioned, checksummed documents (js/storage.js, on the backend
// native/platform.ts installs). Typed here with the shapes this client reads.
import * as RulesJs from "../js/engine/rules.js";
import * as ContentJs from "../js/engine/content.js";
import * as ThemesJs from "../js/engine/themes.js";
import * as AchJs from "../js/engine/achievements.js";
import * as RngJs from "../js/engine/rng.js";
import * as SessionJs from "../js/session.js";
import * as StorageJs from "../js/storage.js";

export interface Jewel { c: number; s: number }
export interface Cell { play: boolean; j: Jewel | null; ice: number; crate: number }
export interface Goal { type: "collect" | "ice" | "crates" | "score"; color?: number; n: number; left: number; done: boolean }
export interface Components { match: number; cascade: number; special: number; blocker: number; goal: number; leftover: number }
export interface State {
  width: number; height: number; cells: Cell[]; score: number; components: Components;
  movesLeft: number; movesSpent: number; turn: number; goals: Goal[]; phase: "ready" | "ended"; reason: string | null;
  assists: { undo: boolean; hints: boolean }; elapsedMs: number; stats: Record<string, unknown>;
}
/** One rules event (js/engine/rules.js emits them; fields by type). */
export interface RulesEvent {
  t: string; a?: number; b?: number; idx?: number; c?: number; s?: number; cascade?: number;
  groups?: { cells: number[] }[]; hits?: number[]; ice?: number; from?: number; to?: number; materialize?: boolean;
  cells?: number[]; reason?: string; done?: boolean;
}
export interface Move { ax: number; ay: number; bx: number; by: number }
export interface LessonStep {
  text: string;
  focus: { x: number; y: number }[] | null;
  require: { kind: string; ax?: number; ay?: number; bx?: number; by?: number; s?: number[]; n?: number } | null;
}
export interface ContentGoal { type: Goal["type"]; color?: number; n: number }
export interface Content {
  version: number; id: string; kind: string; mode: string; name: string; desc: string; seed: string;
  width: number; height: number; colors: number; moves: number; goals: ContentGoal[];
  crates: { x: number; y: number; hp: number }[]; ice: { x: number; y: number; level: number }[];
  stars: { s2: number; s3: number } | null; assists: { undo: boolean; hints: boolean }; ranked: boolean;
  timeLimitSec: number | null; tutorial: string | null; steps: LessonStep[] | null; stage: number; mastery: boolean;
  dayKey: string | null; difficulty: string | null;
  toEngineConfig(): Record<string, unknown>;
  toJSON(): Record<string, unknown>;
}
export interface Theme {
  id: string; name: string; desc: string; unlock: { mastery: number } | null;
  sky: { top: string; mid: string; bottom: string; stars: boolean };
  fog: { color: string; density: number };
  light: { key: string; keyIntensity: number; fill: string; fillIntensity: number; ambient: string; ambientIntensity: number };
  table: { color: string; roughness: number };
  board: { frame: string; cellA: string; cellB: string; grid: string };
  accent: string; dust: string; ambience: string;
}
export interface Achievement { key: string; name: string; desc: string }
export interface MasteryLevel { level: number; xp: number; reward: { type: string; id: string } | null }

export interface Progress {
  version: number; journeyStars: Record<string, number>; journeyUnlocked: number; tutorialsDone: Record<string, boolean>;
  challengesDone: Record<string, number>; achievements: Record<string, { at: string }>; masteryXp: number;
  career: { roundsCompleted: number; roundsWon: number; winStreak: number; bestWinStreak: number; specialsMade: Record<string, boolean>; totalScore: number };
  seenRounds: string[]; daily: { lastPlayed: string | null; streak: number; best: Record<string, number> };
  practice: { plays: number };
  cosmeticsUnlocked: { themes: string[]; trails: string[]; frames: string[]; titles: string[] };
  _savedAt?: string;
}
export interface Settings {
  version: number;
  audio: { master: number; music: number; effects: number; ambience: number; voice: number; muted: boolean };
  motion: { reduced: boolean };
  display: { highContrast: boolean; palette: string; textSize: string; leftHanded: boolean };
  input: { holdToDrag: boolean; haptics: boolean; keyboardMap: unknown; gamepadMap: unknown };
  access: { timingAssist: boolean; tutorialReplay: boolean; captions?: boolean };
  privacy: { telemetryConsent: boolean };
  camera: { preset: string };
  player: { displayName: string; avatar: unknown };
  cosmetics: { theme: string; trail: string; frame: string; title: string };
}
export interface Snapshot { savedAt: number; content: Record<string, unknown>; config: Record<string, unknown>; stateJson: string; commands: unknown[]; roundId: string }
export interface BoardEntry {
  roundId: string; contentId: string; mode: string; name: string; score: number; won: boolean; moves: number; ms: number;
  seed: unknown; assists: string; at: string; validated: boolean;
}
export interface Results {
  roundId: string; mode: string; contentId: string; contentName: string; won: boolean; reason: string; score: number;
  components: Components; stars: number; goals: Goal[]; stats: Record<string, unknown>; movesSpent: number; movesTotal: number;
  elapsedMs: number; ranked: boolean; replay: { config: Record<string, unknown>; commands: { id: string; type: string }[]; seed: string } | null;
  timeLimitSec: number | null;
  progression?: {
    stars: number; firstClear: boolean; newAchievements: string[];
    mastery: { gained: number; total: number; levelBefore: number; levelAfter: number } | null;
    unlocks: { type: string; id: string }[]; dailyStreak: number | null;
  };
}
export type Status = "boot" | "title" | "profile-ready" | "mode-select" | "preparing" | "tutorial" | "countdown" | "active" | "paused" | "resolving" | "results" | "progression";
export interface Session {
  status: Status; content: Content | null; state: State | null; mode: string | null; roundId: string | null;
  timeLeftMs: number | null; timeTotalMs: number | null; settings: Settings; progress: Progress;
  inputFilter: ((ax: number, ay: number, bx: number, by: number) => boolean) | null;
  _roundIdKept: string | null; _lastResults?: Results;
  on(event: string, cb: (payload: never) => void): () => void;
  transition(to: Status, reason: string): boolean;
  startRound(content: Content, opts?: { resumed?: boolean; resumedState?: string; resumedCommands?: unknown[] }): void;
  beginPlay(reason?: string): void;
  trySwap(ax: number, ay: number, bx: number, by: number): { accepted: boolean; reason?: string };
  settled(): void;
  requestSkip(): void;
  hint(): Move | null;
  undo(): boolean;
  pause(reason?: string): boolean;
  resume(): boolean;
  forceFinish(reason?: string): boolean;
  abandon(reason?: string): void;
  restart(): void;
  tick(dtMs: number): void;
  saveSnapshot(): void;
  emitHud(force?: boolean): void;
}

interface RulesApi {
  SPECIAL: { NONE: 0; RAY_H: 1; RAY_V: 2; BLOOM: 3; PRISM: 4 };
  END: { GOALS: string; MOVES: string; RESIGNED: string; TIME: string };
  idx(state: State, x: number, y: number): number;
  legalActions(state: State): Move[];
  createGame(config: Record<string, unknown>): State;
  applyCommand(state: State, cmd: Record<string, unknown>): { accepted: boolean; reason?: string; events: RulesEvent[] };
  deserialize(json: string): State;
  suggestMove(state: State): Move | null;
}
interface ContentApi {
  LESSONS: Content[]; JOURNEY: Content[]; CHALLENGES: Content[];
  PRACTICE_DIFFICULTIES: { id: string; name: string; desc: string }[];
  dayKeyFor(ms: number): string;
  dailyContent(dayKey: string): Content;
  practiceContent(difficultyId: string, seed?: string): Content;
  scoreChaseContent(seed: string): Content;
  reviveContent(json: unknown): Content;
}
interface ThemesApi { THEMES: Theme[]; JEWEL_PALETTES: Record<string, string[]>; themeById(id: string): Theme }
interface AchApi { ACHIEVEMENTS: Achievement[]; MASTERY_LEVELS: MasteryLevel[]; masteryLevelForXp(xp: number): number }
export interface SeededRng { next(): number; int(n: number): number }
interface RngApi { fnv1a(s: string): number; stableStringify(v: unknown): string; Rng: new (seed: number) => SeededRng }
interface SessionApi { GameSession: new (opts: { settings: Settings; progress: Progress; platform?: unknown; analytics?: unknown }) => Session }
export interface Backend {
  getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void;
  key(i: number): string | null; readonly length: number;
}
interface StorageApi {
  setBackend(b: Backend): void;
  defaultSettings(): Settings; defaultProgress(): Progress;
  loadSettings(): Settings; saveSettings(s: Settings): boolean;
  loadProgress(): Progress; saveProgress(p: Progress, touch?: boolean): boolean;
  loadRoundSnapshot(): Snapshot | null; clearRoundSnapshot(): void;
  loadBoards(): { version: number; entries: BoardEntry[] }; saveBoards(b: { version: number; entries: BoardEntry[] }): boolean;
  wipeAll(): void;
  mergeProgress(local: Progress, remote: unknown): Progress;
}

export const Rules = RulesJs as unknown as RulesApi;
export const Content = ContentJs as unknown as ContentApi;
export const Themes = ThemesJs as unknown as ThemesApi;
export const Ach = AchJs as unknown as AchApi;
export const Rng = RngJs as unknown as RngApi;
export const Sess = SessionJs as unknown as SessionApi;
export const Store = StorageJs as unknown as StorageApi;
