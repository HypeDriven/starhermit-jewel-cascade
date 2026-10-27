// The look per graphics level: the browser build's four presets and budgets
// (js/render/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest
// GPU its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the spark and dust counts scaled within the tier by the level
// (frame().levelIndex, ≤ 2× as gfx.js budgetFor scaled them by its hardware
// level). The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The old panel's per-category overrides
// are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Clear-coated jewels (Surface detail on High/Ultra). */
  clearcoat: boolean;
  /** Procedural table wood size (tiles ¼, brushed metal ½), px. */
  texture: number;
  /** Live-spark cap and drifting dust motes. */
  sparks: number;
  dust: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections from the studio room. */
  reflections: boolean;
  particles: "low" | "medium" | "high";
  /** Lamp sway and flicker, star shimmer, drifting dust and idle glints. */
  animated: boolean;
  /** Table-top prop gems, wood grain, bevelled tiles, brushed brass, clear-coated gems. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "medium", animated: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { clearcoat: false, texture: 128, sparks: 2048, dust: 90, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { clearcoat: false, texture: 256, sparks: 2048, dust: 170, bloomRes: 0.5, aoRes: 0.5 },
  high: { clearcoat: true, texture: 512, sparks: 2048, dust: 170, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { clearcoat: true, texture: 1024, sparks: 3072, dust: 260, bloomRes: 1, aoRes: 1 },
};
const PARTICLE_SHARE = { low: 0.25, medium: 0.5, high: 1 };
export const SPARK_MAX = 6144;
export const DUST_MAX = 520;
/** Idle glints per particles tier (gfx.js GLINT_COUNT). */
export const GLINT_COUNT = { low: 0, medium: 6, high: 14 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const row = TABLE[preset];
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: sparks and dust grow with
  // the level above the tier's first, at most 2× the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const share = PARTICLE_SHARE[row.particles];
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k * share));
  b.dust = row.particles === "low" ? 0 : Math.min(DUST_MAX, Math.round(b.dust * k * share));
  return { preset, ...row, budget: b };
}
