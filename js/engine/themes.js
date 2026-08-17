/**
 * themes.js — the five visual themes of the jewel workshop.
 *
 * Themes change environment, lighting, board dressing, and accents only.
 * Gameplay jewel hues are fixed (see JEWEL_COLORS) so color reading is
 * consistent and testable after tone mapping; accessibility palettes remap
 * them in one place.
 */

/** Fixed gameplay jewel hues (sRGB), index-aligned with COLOR_NAMES. */
export const JEWEL_COLORS = [
  '#e5484d', // ruby
  '#f76b15', // amber
  '#ffd60a', // topaz
  '#46a758', // emerald
  '#3e9bde', // sapphire
  '#9b5de5', // amethyst
  '#f2e9e4', // opal
];

/** Color-vision-safe remaps, same slot order. Shapes always reinforce color. */
export const JEWEL_PALETTES = {
  default: JEWEL_COLORS,
  deuter: ['#d7263d', '#f4845f', '#f7e05f', '#2a9d8f', '#4cc9f0', '#7209b7', '#f8f7ff'],
  protan: ['#e01e37', '#ff8c42', '#fff75e', '#06d6a0', '#59c3ff', '#8338ec', '#f1faee'],
  tritan: ['#ef476f', '#f78c6b', '#ffd166', '#06d6a0', '#118ab2', '#9d4edd', '#edf6f9'],
  contrast: ['#ff1744', '#ff6d00', '#ffea00', '#00e676', '#2979ff', '#d500f9', '#ffffff'],
};

export const THEMES = [
  {
    id: 'ember-dusk',
    name: 'Ember Dusk',
    desc: 'The original workshop: warm lamplight under a violet twilight.',
    unlock: null,
    sky: { top: '#2b1b4d', mid: '#7a3b6e', bottom: '#e8815a', stars: true },
    fog: { color: '#4a2c5a', density: 0.028 },
    light: {
      key: '#ffb36b',
      keyIntensity: 2.4,
      fill: '#7a6cff',
      fillIntensity: 0.55,
      ambient: '#5c4a7a',
      ambientIntensity: 0.5,
    },
    table: { color: '#6b4a2f', roughness: 0.8 },
    board: { frame: '#c9973f', cellA: '#3d2c50', cellB: '#463455', grid: '#201736' },
    accent: '#ffb36b',
    dust: '#ffcf9e',
    ambience: 'hearth',
  },
  {
    id: 'moonlit-forge',
    name: 'Moonlit Forge',
    desc: 'Cool moonlight over banked coals and quiet tools.',
    unlock: { mastery: 2 },
    sky: { top: '#0b1026', mid: '#1d2b53', bottom: '#3a506b', stars: true },
    fog: { color: '#16213c', density: 0.03 },
    light: {
      key: '#9fc6ff',
      keyIntensity: 2.0,
      fill: '#ff9d5c',
      fillIntensity: 0.4,
      ambient: '#2c3d5c',
      ambientIntensity: 0.55,
    },
    table: { color: '#4a4a55', roughness: 0.7 },
    board: { frame: '#8fa3bf', cellA: '#1c2438', cellB: '#232c44', grid: '#0e1424' },
    accent: '#9fc6ff',
    dust: '#bcd6ff',
    ambience: 'night',
  },
  {
    id: 'verdant-atelier',
    name: 'Verdant Atelier',
    desc: 'A greenhouse bench at golden hour, leaves against the glass.',
    unlock: { mastery: 4 },
    sky: { top: '#1d4e3d', mid: '#4a8f5d', bottom: '#e8c96a', stars: false },
    fog: { color: '#2c5c44', density: 0.024 },
    light: {
      key: '#ffe9a8',
      keyIntensity: 2.3,
      fill: '#9fffc8',
      fillIntensity: 0.5,
      ambient: '#3d6b4f',
      ambientIntensity: 0.55,
    },
    table: { color: '#7a5c38', roughness: 0.75 },
    board: { frame: '#d9b45c', cellA: '#24402f', cellB: '#2b4a37', grid: '#142419' },
    accent: '#b8e986',
    dust: '#fff3c4',
    ambience: 'garden',
  },
  {
    id: 'frostbound-loft',
    name: 'Frostbound Loft',
    desc: 'A garret above the snowline; breath fogs the skylight.',
    unlock: { mastery: 6 },
    sky: { top: '#101d2e', mid: '#274b63', bottom: '#9fc3d8', stars: true },
    fog: { color: '#1d3242', density: 0.026 },
    light: {
      key: '#dff3ff',
      keyIntensity: 2.1,
      fill: '#8fb7ff',
      fillIntensity: 0.5,
      ambient: '#3c5468',
      ambientIntensity: 0.6,
    },
    table: { color: '#5c6b76', roughness: 0.65 },
    board: { frame: '#c3d6e2', cellA: '#1c2c38', cellB: '#243442', grid: '#0e1a22' },
    accent: '#bfe8ff',
    dust: '#eaf7ff',
    ambience: 'frost',
  },
  {
    id: 'royal-velvet',
    name: 'Royal Velvet',
    desc: 'Deep curtains and candle-gold for the master showcase.',
    unlock: { mastery: 8 },
    sky: { top: '#2e0a2e', mid: '#5c1445', bottom: '#a83a5c', stars: false },
    fog: { color: '#3c1038', density: 0.03 },
    light: {
      key: '#ffd28a',
      keyIntensity: 2.5,
      fill: '#c86bff',
      fillIntensity: 0.45,
      ambient: '#5c2c50',
      ambientIntensity: 0.5,
    },
    table: { color: '#4a2030', roughness: 0.55 },
    board: { frame: '#e8b54a', cellA: '#38122e', cellB: '#421838', grid: '#200a1c' },
    accent: '#ffd28a',
    dust: '#ffe3b3',
    ambience: 'velvet',
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}
