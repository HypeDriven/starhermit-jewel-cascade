// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing, the largest
// texture) are the level's own (levelSettings(): the same table every
// StarHermit game reads). The game's art (clear-coated jewels, the table
// textures, sparks and dust, reflections, motion, detail) is the browser
// build's four presets and budgets (js/render/gfx.js TABLE / BUDGETS) keyed
// by the level's quality tier, with the spark and dust counts scaled within
// the tier by the level's particle budget against the tier's anchor level
// (quantum, molecular, terrestrial, galactic), at most 2×. The runtime owns
// the rest of what the old Graphics panel did: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and readout. The old panel's per-category overrides are not offered
// (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size (0 = off). */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "particles" | "animated" | "detailed">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "medium", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { clearcoat: false, texture: 128, sparks: 2048, dust: 90 },
  balanced: { clearcoat: false, texture: 256, sparks: 2048, dust: 170 },
  high: { clearcoat: true, texture: 512, sparks: 2048, dust: 170 },
  ultra: { clearcoat: true, texture: 1024, sparks: 3072, dust: 260 },
};
const PARTICLE_SHARE = { low: 0.25, medium: 0.5, high: 1 };
export const SPARK_MAX = 6144;
export const DUST_MAX = 520;
/** Idle glints per particles tier (gfx.js GLINT_COUNT). */
export const GLINT_COUNT = { low: 0, medium: 6, high: 14 };
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const row = ART[preset];
  const b = { ...BUDGETS[preset] };
  // Sparks and dust grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const share = PARTICLE_SHARE[row.particles];
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k * share));
  b.dust = row.particles === "low" ? 0 : Math.min(DUST_MAX, Math.round(b.dust * k * share));
  b.texture = Math.min(b.texture, s.maxTextureSize);
  return {
    preset, ...row,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    // Engine 1.36.1 bug: antialias "off" recolours fog, haze and translucent overlays; the old Low's MSAA
    // stays until engine 1.36.2 (drop this clamp when pinning 1.36.2+).
    antialias: s.antialias === "off" ? "msaa" : s.antialias,
    budget: b,
  };
}
