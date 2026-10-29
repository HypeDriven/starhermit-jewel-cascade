// The jewel workshop on starhermit:scene, as the browser build's
// js/render/scene.js drew it: an authored camera over a walnut workbench in
// warm twilight (the sky dome's per-theme gradient, 260 stars, five seeded
// hanging lamps, the brass rim, the table-top prop gems, drifting dust), the
// board (one instanced mesh of checkered cells, the brass frame slab, crates
// with their bands, translucent ice), the seven procedural gem silhouettes
// (one per colour, flat-shaded physical materials, clear-coated where the
// budget allows) with their special overlays (torus rings for rays, a warm
// wireframe for blooms, a cool slowly spinning one for prisms), pooled
// additive spark bursts, idle four-point glints, the blast beams, and the
// markers (selection ring, hover ring, keyboard cursor, hint rings, invalid
// flash). Every rules event stream becomes a timeline (swap 0.18 s, swap-back
// 0.30 s, burst 0.36 s, gravity 0.16 s + 0.05 s a cell up to 0.50 s, shuffle
// 0.50 s, ×0.55 fast) that ends in the exact deterministic state; the camera
// is a critically damped 1.6 Hz spring with tiny tiered shake.
//
// Gaps and changes from three.js: light intensities are three.js's ÷ π (the
// engine's convention); the post chain (GTAO → UnrealBloom → OutputPass →
// grade → SMAA/FXAA, or MSAA) is renderer.ao / bloom / grade (display space,
// as the GradeShader ran after OutputPass) / antialias; the key light's
// shadow is fitted by `distance` (the engine has no ortho shadow bounds);
// timelines run on the runtime's fixed steps (tick) instead of setTimeout and
// performance.now, so a round looks the same in every run; adaptive
// resolution, the pixel-ratio cap and the frame-rate readout are the
// runtime's. The board is framed into the playfield the HUD leaves
// (setViewOffset), as the browser build fitted its canvas between the rails.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DodecahedronGeometry, DoubleSide, FogExp2, Group, HemisphereLight,
  IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, Plane, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry,
  RoomEnvironment, SphereGeometry, SRGBColorSpace, TetrahedronGeometry, TorusGeometry, Vector3, pointerToNdc, renderer, scene,
  type Material, type Texture,
  type OrthographicCamera,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { DUST_MAX, GLINT_COUNT, SPARK_MAX, type Look } from "./quality.ts";
import { Rng, type RulesEvent, type State, type Theme } from "./game.ts";

const PI = Math.PI, TWO_PI = Math.PI * 2;
const CELL = 1.0;
const JEWEL_Y = 0.36;
const FIT_MARGIN = 1.19;
const CAMERA_FOV = 36;
const CAMERA_PRESETS: Record<string, { pitch: number; yaw: number }> = {
  default: { pitch: 0.96, yaw: 0 }, low: { pitch: 0.62, yaw: 0 }, high: { pitch: 1.32, yaw: 0 },
};
const CAMERA_SPRING_HZ = 1.6;
const SLOT = { swap: 0.18, swapBack: 0.3, burst: 0.36, gravityBase: 0.16, gravityPerCell: 0.05, gravityMax: 0.5, shuffle: 0.5, meta: 0.05 };
const FAST_MULTIPLIER = 0.55;
const GLINT_CAP = 16;
const SHAKE_TIERS = { move: 0.012, combo: 0.03, round: 0.05 };
const ICE_COLOR = "#bfe3f2";
const CRATE_COLOR = "#7a5a36";
const CRATE_BAND = "#4a3520";
const SPECIAL = { NONE: 0, RAY_H: 1, RAY_V: 2, BLOOM: 3, PRISM: 4 };
const DEFAULT_PALETTE = ["#e5484d", "#f76b15", "#ffd60a", "#46a758", "#3e9bde", "#9b5de5", "#f2e9e4"];

// -- easing ----------------------------------------------------------------------------------
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function easeOutBack(t: number): number { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

// -- renderer, camera and lights ---------------------------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 200);
camera.position.set(0, 10, 10);
renderer.camera = camera;
scene.background = new Color("#1a1226");
const fog = new FogExp2("#4a2c5a", 0.028);
scene.fog = fog;

const keyLight = new DirectionalLight("#ffb36b", 2.4);
keyLight.position.set(6, 10, 4);
keyLight.shadow.bias = -0.0008;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);
scene.add(keyLight.target);
const fillLight = new DirectionalLight("#7a6cff", 0.55);
fillLight.position.set(-6, 5, -3);
scene.add(fillLight);
const ambient = new AmbientLight("#5c4a7a", 0.5);
scene.add(ambient);
const hemi = new HemisphereLight("#7a6cff", "#6b4a2f", 0.35);
scene.add(hemi);
let ambientBase = 0.5;

let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

const envGroup = new Group();
const boardGroup = new Group();
const jewelGroup = new Group();
const markerGroup = new Group();
const fxGroup = new Group();
scene.add(envGroup); scene.add(boardGroup); scene.add(jewelGroup); scene.add(markerGroup); scene.add(fxGroup);

// -- procedural textures (deterministic canvas art, js/render/scene.js) -------------------------
type Ctx = OffscreenCanvasRenderingContext2D;
function canvasTexture(authored: number, draw: (ctx: Ctx, n: number) => void, srgb: boolean, size = authored): Texture {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  if (size !== authored) ctx.scale(size / authored, size / authored);
  draw(ctx, authored);
  const tex = new CanvasTexture(c);
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
interface R { next(): number }
/** Walnut grain: long, gently waving grain lines plus streaks, as a light multiplier. */
function woodTexture(rng: R, size: number): Texture {
  return canvasTexture(512, (ctx, n) => {
    ctx.fillStyle = "#e8e2dc";
    ctx.fillRect(0, 0, n, n);
    for (let y = 0; y < n; y += 2 + rng.next() * 5) {
      ctx.strokeStyle = `rgba(80,52,34,${0.04 + rng.next() * 0.08})`;
      ctx.lineWidth = 0.8 + rng.next() * 2;
      ctx.beginPath();
      const amp = 2 + rng.next() * 6;
      const ph = rng.next() * TWO_PI;
      for (let x = 0; x <= n; x += 16) ctx.lineTo(x, y + Math.sin(x / 70 + ph) * amp);
      ctx.stroke();
    }
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = `rgba(${rng.next() < 0.5 ? "60,40,25" : "255,245,230"},${0.03 + rng.next() * 0.05})`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 1 + rng.next() * 14, 1);
    }
  }, true, size);
}
/** Cell tile: bevelled rim (light top-left, dark bottom-right) + faint grain. */
function tileTexture(rng: R, size: number): Texture {
  return canvasTexture(128, (ctx, n) => {
    ctx.fillStyle = "#f0ecef";
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(${rng.next() < 0.5 ? "0,0,0" : "255,255,255"},${0.03 + rng.next() * 0.04})`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 2, 2);
    }
    const b = 9;
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(n, 0); ctx.lineTo(n - b, b); ctx.lineTo(b, b); ctx.lineTo(b, n - b); ctx.lineTo(0, n); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.beginPath(); ctx.moveTo(n, n); ctx.lineTo(0, n); ctx.lineTo(b, n - b); ctx.lineTo(n - b, n - b); ctx.lineTo(n - b, b); ctx.lineTo(n, 0); ctx.fill();
    const g = ctx.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.7);
    g.addColorStop(0, "rgba(255,255,255,0.06)");
    g.addColorStop(1, "rgba(0,0,0,0.1)");
    ctx.fillStyle = g;
    ctx.fillRect(b, b, n - 2 * b, n - 2 * b);
  }, true, size);
}
/** Brushed-metal streaks for the brass frame and rim (a roughness map, linear). */
function brushedTexture(rng: R, size: number): Texture {
  const tex = canvasTexture(256, (ctx, n) => {
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) {
      const v = Math.floor(110 + rng.next() * 110);
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 20 + rng.next() * 90, 1);
    }
  }, false, size);
  tex.colorSpace = "";
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
/** Soft round particle sprite. */
function dotTexture(): Texture {
  return canvasTexture(64, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.8)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  }, true);
}
/** Four-point star glint for idle gem sparkle. */
function glintTexture(): Texture {
  return canvasTexture(64, (ctx, n) => {
    const c = n / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.5);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
    for (const [w, h] of [[n, 3], [3, n]] as [number, number][]) {
      const lg = ctx.createLinearGradient(c - w / 2, c - h / 2, c + w / 2, c + h / 2);
      lg.addColorStop(0, "rgba(255,255,255,0)");
      lg.addColorStop(0.5, "rgba(255,255,255,1)");
      lg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = lg;
      ctx.fillRect(c - w / 2, c - h / 2, w, h);
    }
  }, true);
}

// -- gem geometry: one authored silhouette per colour index ---------------------------------------
function buildGemGeometries(): BufferGeometry[] {
  const emerald = new OctahedronGeometry(0.4, 0);
  emerald.scale(0.72, 1.3, 0.72); // elongated baguette
  const amethyst = new ConeGeometry(0.33, 0.78, 6);
  amethyst.translate(0, 0.06, 0);
  return [
    new OctahedronGeometry(0.42, 0), // ruby — classic brilliant
    new DodecahedronGeometry(0.4, 0), // amber — chunky nugget
    new TetrahedronGeometry(0.48, 0), // topaz — sharp shard
    emerald, // emerald — tall baguette
    new IcosahedronGeometry(0.42, 0), // sapphire — faceted globe
    amethyst, // amethyst — crystal point
    new SphereGeometry(0.4, 14, 10), // opal — smooth cabochon
  ];
}
const gemGeos = buildGemGeometries();
function makeGemMaterials(palette: string[]): MeshPhysicalMaterial[] {
  return palette.map((hex) => {
    const color = new Color(hex);
    return new MeshPhysicalMaterial({
      color, roughness: 0.28, metalness: 0.08, flatShading: true, emissive: color.clone().multiplyScalar(0.16),
      envMapIntensity: 0.3, clearcoat: 0, clearcoatRoughness: 0.06,
    });
  });
}

// -- the environment (procedural workshop) -----------------------------------------------------------
const envRng = new Rng.Rng(Rng.fnv1a("jc-env"));
const skyCanvas = new OffscreenCanvas(2, 256);
const skyTex = new CanvasTexture(skyCanvas);
skyTex.colorSpace = SRGBColorSpace;
const skyMesh = new Mesh(new SphereGeometry(80, 24, 16), new MeshBasicMaterial({ map: skyTex, side: BackSide, fog: false }));
envGroup.add(skyMesh);

const STAR_COUNT = 260;
const starPos = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const a = envRng.next() * TWO_PI;
  const el = 0.12 + envRng.next() * 1.35;
  const r = 72;
  starPos[i * 3] = Math.cos(a) * Math.cos(el) * r;
  starPos[i * 3 + 1] = Math.sin(el) * r;
  starPos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
}
const starGeo = new BufferGeometry();
starGeo.setAttribute("position", new BufferAttribute(starPos, 3));
const starMat = new PointsMaterial({ color: "#fff4e0", size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0.85, fog: false });
const stars = new Points(starGeo, starMat);
stars.frustumCulled = false;
// Drawn first: blended points here are not depth-sorted behind the opaque workbench as three.js
// sorted them (the transparent stars showed through the table); drawn before it, the table covers them.
stars.renderOrder = -10;
envGroup.add(stars);

const tableMat = new MeshStandardMaterial({ color: "#6b4a2f", roughness: 0.8, metalness: 0.05, envMapIntensity: 0.12 });
const table = new Mesh(new CylinderGeometry(11, 12.5, 1.4, 28), tableMat);
table.position.y = -0.78;
table.receiveShadow = true;
envGroup.add(table);
const rimMat = new MeshStandardMaterial({ color: "#c9973f", roughness: 0.4, metalness: 0.6, envMapIntensity: 0.7 });
const tableRim = new Mesh(new TorusGeometry(11.6, 0.22, 8, 40), rimMat);
tableRim.rotation.x = PI / 2;
tableRim.position.y = -0.12;
envGroup.add(tableRim);

interface Lamp { group: Group; bulb: MeshStandardMaterial; phase: number }
const lamps: Lamp[] = [];
const cordMat = new MeshStandardMaterial({ color: "#2c2033", roughness: 0.9 });
for (let i = 0; i < 5; i++) {
  const a = (i / 5) * TWO_PI + 0.5;
  const r = 8.0 + envRng.next() * 1.8;
  const y = 5.6 + envRng.next() * 2.0;
  const lamp = new Group();
  const cord = new Mesh(new CylinderGeometry(0.015, 0.015, 6, 4), cordMat);
  cord.position.y = 3;
  const bulbMat = new MeshStandardMaterial({ color: "#ffd9a0", emissive: "#ffb36b", emissiveIntensity: 2.2, roughness: 0.5 });
  const bulb = new Mesh(new SphereGeometry(0.22, 12, 10), bulbMat);
  lamp.add(cord); lamp.add(bulb);
  lamp.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
  envGroup.add(lamp);
  lamps.push({ group: lamp, bulb: bulbMat, phase: envRng.next() * TWO_PI });
}

const props = new Group();
const propMats = makeGemMaterials(DEFAULT_PALETTE);
for (let i = 0; i < 14; i++) {
  const a = envRng.next() * TWO_PI;
  const r = 8.2 + envRng.next() * 2.2;
  const g = new Mesh(gemGeos[i % 7]!, propMats[(i * 3 + 1) % 7]!);
  const s = 0.5 + envRng.next() * 0.7;
  g.scale.setScalar(s);
  g.position.set(Math.cos(a) * r, -0.05 + 0.2 * s, Math.sin(a) * r);
  g.rotation.set(envRng.next() * 0.6, envRng.next() * TWO_PI, envRng.next() * 0.6);
  g.castShadow = true;
  props.add(g);
}
envGroup.add(props);

const dustPos = new Float32Array(DUST_MAX * 3);
const dustSeed = new Float32Array(DUST_MAX * 2);
for (let i = 0; i < DUST_MAX; i++) {
  dustPos[i * 3] = (envRng.next() - 0.5) * 18;
  dustPos[i * 3 + 1] = envRng.next() * 6 + 0.4;
  dustPos[i * 3 + 2] = (envRng.next() - 0.5) * 18;
  dustSeed[i * 2] = envRng.next() * TWO_PI;
  dustSeed[i * 2 + 1] = 0.5 + envRng.next();
}
const dustGeo = new BufferGeometry();
const dustAttr = new BufferAttribute(dustPos, 3);
dustGeo.setAttribute("position", dustAttr);
const dustMat = new PointsMaterial({ color: "#ffcf9e", size: 0.05, transparent: true, opacity: 0.55, depthWrite: false });
const dust = new Points(dustGeo, dustMat);
dust.frustumCulled = false;
envGroup.add(dust);
let dustTime = 0;
let dustVisible = 0;

// Procedural surface detail at the budget's size (table wood = size, tiles ¼, brushed metal ½).
let tex: { wood: Texture; tile: Texture; brushed: Texture } | null = null;
let texSize = 0;
function applyTextureBudget(size: number): void {
  if (size === texSize && tex) return;
  texSize = size;
  const old = tex;
  const rng = new Rng.Rng(Rng.fnv1a("jc-tex"));
  tex = { wood: woodTexture(rng, size), tile: tileTexture(rng, Math.max(32, size / 4)), brushed: brushedTexture(rng, Math.max(64, size / 2)) };
  if (old) { old.wood.dispose(); old.tile.dispose(); old.brushed.dispose(); }
}

// Idle gem glints: a few four-point stars that twinkle on random jewels.
const glintPos = new Float32Array(GLINT_CAP * 3);
const glintCol = new Float32Array(GLINT_CAP * 3);
const glintLife = new Float32Array(GLINT_CAP);
for (let i = 0; i < GLINT_CAP; i++) { glintPos[i * 3 + 1] = -1000; glintLife[i] = -envRng.next() * 2; }
const glintGeo = new BufferGeometry();
const glintPosAttr = new BufferAttribute(glintPos, 3);
const glintColAttr = new BufferAttribute(glintCol, 3);
glintGeo.setAttribute("position", glintPosAttr);
glintGeo.setAttribute("color", glintColAttr);
const glints = new Points(glintGeo, new PointsMaterial({
  size: 0.42, map: glintTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false,
}));
glints.frustumCulled = false;
glints.renderOrder = 21;
glints.visible = false;
fxGroup.add(glints);
let glintCount = 0;
const decorRng = new Rng.Rng(Rng.fnv1a("jc-decor"));
const fxRng = new Rng.Rng(Rng.fnv1a("jc-fx"));

// -- pooled particle field (one Points draw call; fixed typed arrays) ------------------------------
const pPos = new Float32Array(SPARK_MAX * 3);
const pVel = new Float32Array(SPARK_MAX * 3);
const pCol = new Float32Array(SPARK_MAX * 3);
const pLife = new Float32Array(SPARK_MAX);
for (let i = 0; i < SPARK_MAX; i++) pPos[i * 3 + 1] = -1000;
const pGeo = new BufferGeometry();
const pPosAttr = new BufferAttribute(pPos, 3);
const pColAttr = new BufferAttribute(pCol, 3);
pGeo.setAttribute("position", pPosAttr);
pGeo.setAttribute("color", pColAttr);
const particles = new Points(pGeo, new PointsMaterial({
  size: 0.12, map: dotTexture(), vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true,
}));
particles.frustumCulled = false;
particles.renderOrder = 20;
fxGroup.add(particles);
let pHead = 0;
let pCap = 512;
let pLive = 0;
const tmpColor = new Color();
function burstRaw(x: number, y: number, z: number, color: string, count: number, speed: number, spread: number): void {
  if (pCap <= 0) return;
  tmpColor.set(color);
  for (let n = 0; n < count; n++) {
    const i = pHead;
    pHead = (pHead + 1) % pCap;
    const a = Math.random() * TWO_PI;
    const b = Math.acos(2 * Math.random() - 1);
    const s = speed * (0.4 + Math.random() * 0.6);
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = Math.sin(b) * Math.cos(a) * s * spread;
    pVel[i * 3 + 1] = Math.abs(Math.cos(b)) * s;
    pVel[i * 3 + 2] = Math.sin(b) * Math.sin(a) * s * spread;
    pCol[i * 3] = tmpColor.r; pCol[i * 3 + 1] = tmpColor.g; pCol[i * 3 + 2] = tmpColor.b;
    pLife[i] = 0.5 + Math.random() * 0.45;
  }
  pLive = Math.max(pLive, 1);
  pColAttr.needsUpdate = true;
}
function updateParticles(dt: number): void {
  if (!pLive) return;
  const g = -2.6 * dt;
  let any = 0;
  for (let i = 0; i < pCap; i++) {
    if (pLife[i]! <= 0) continue;
    pLife[i] = pLife[i]! - dt;
    if (pLife[i]! <= 0) { pPos[i * 3 + 1] = -1000; continue; }
    any++;
    pVel[i * 3 + 1] = pVel[i * 3 + 1]! + g;
    pPos[i * 3] = pPos[i * 3]! + pVel[i * 3]! * dt;
    pPos[i * 3 + 1] = pPos[i * 3 + 1]! + pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2] = pPos[i * 3 + 2]! + pVel[i * 3 + 2]! * dt;
  }
  pLive = any;
  pPosAttr.needsUpdate = true;
}

// -- beams -----------------------------------------------------------------------------------------
const beamGeo = new BoxGeometry(1, 0.16, 1);
const beams: Mesh<MeshBasicMaterial>[] = [];
for (let i = 0; i < 8; i++) {
  const b = new Mesh(beamGeo, new MeshBasicMaterial({ color: "#fff2cf", transparent: true, opacity: 0, depthWrite: false }));
  b.visible = false;
  b.renderOrder = 15;
  fxGroup.add(b);
  beams.push(b);
}

// -- markers ---------------------------------------------------------------------------------------
function ringMarker(inner: number, outer: number, color: string, opacity: number, y: number): Mesh<MeshBasicMaterial> {
  const m = new Mesh(new RingGeometry(inner, outer, 28), new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false }));
  m.rotation.x = -PI / 2;
  m.position.y = y;
  m.visible = false;
  markerGroup.add(m);
  return m;
}
const selRing = ringMarker(0.4, 0.52, "#ffd28a", 0.95, 0.02);
selRing.renderOrder = 10;
const hoverRing = ringMarker(0.34, 0.44, "#ffffff", 0.35, 0.02);
const cursorMark = new Mesh(new PlaneGeometry(0.92, 0.92), new MeshBasicMaterial({ color: "#9fd8ef", transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false }));
cursorMark.rotation.x = -PI / 2;
cursorMark.position.y = 0.02;
cursorMark.visible = false;
markerGroup.add(cursorMark);
const hintRings = [ringMarker(0.42, 0.54, "#7bd88f", 0.9, 0.025), ringMarker(0.42, 0.54, "#7bd88f", 0.9, 0.025)];
const badRing = ringMarker(0.42, 0.56, "#ff7b7b", 0, 0.03);

// -- jewel views ------------------------------------------------------------------------------------
const ringGeo = new TorusGeometry(0.5, 0.045, 8, 24);
const ringMat = new MeshBasicMaterial({ color: "#fff2cf", transparent: true, opacity: 0.9 });
const bloomMat = new MeshStandardMaterial({ color: "#ffffff", wireframe: true, emissive: "#ffe9a8", emissiveIntensity: 0.7, transparent: true, opacity: 0.8 });
const prismMat = new MeshStandardMaterial({ color: "#ffffff", wireframe: true, emissive: "#cfe8ff", emissiveIntensity: 0.9, transparent: true, opacity: 0.65 });
const bloomGeo = new IcosahedronGeometry(0.55, 0);
const prismGeo = new IcosahedronGeometry(0.6, 1);
class JewelView {
  group = new Group();
  gem: Mesh;
  ringH: Mesh; ringV: Mesh; bloom: Mesh; prismAura: Mesh;
  color = -1; special = -1; idx = -1;
  constructor() {
    this.gem = new Mesh(gemGeos[0]!, jewelMats[0]!);
    this.gem.castShadow = true;
    this.group.add(this.gem);
    this.ringH = new Mesh(ringGeo, ringMat);
    this.ringH.rotation.x = PI / 2;
    this.ringV = new Mesh(ringGeo, ringMat);
    this.bloom = new Mesh(bloomGeo, bloomMat);
    this.prismAura = new Mesh(prismGeo, prismMat);
    for (const m of [this.ringH, this.ringV, this.bloom, this.prismAura]) { m.visible = false; this.group.add(m); }
  }
  configure(color: number, special: number): this {
    if (this.color !== color) {
      this.gem.geometry = gemGeos[color] ?? gemGeos[0]!;
      this.gem.material = jewelMats[color] ?? jewelMats[0]!;
      this.color = color;
    }
    if (this.special !== special) {
      this.special = special;
      this.ringH.visible = special === SPECIAL.RAY_H;
      this.ringV.visible = special === SPECIAL.RAY_V;
      this.bloom.visible = special === SPECIAL.BLOOM;
      this.prismAura.visible = special === SPECIAL.PRISM;
    }
    return this;
  }
}

// -- state -------------------------------------------------------------------------------------------
let look: Look | null = null;
let reducedMotion = false;
let theme: Theme | null = null;
let palette: string[] = DEFAULT_PALETTE.slice();
const jewelMats = makeGemMaterials(DEFAULT_PALETTE);
let frameStyle = "standard";
let trailStyle = "none";
let cameraPreset = "default";

let state: State | null = null;
let width = 0, height = 0;
const viewAt = new Map<number, JewelView>();
const crateAt = new Map<number, { mesh: Mesh; band: Mesh | null }>();
const iceAt = new Map<number, Mesh>();
const viewPool: JewelView[] = [];
let cellMesh: InstancedMesh | null = null;
let frameMesh: Mesh<MeshStandardMaterial> | null = null;
const cellMat = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.15, envMapIntensity: 0.2 });
const frameMat = new MeshStandardMaterial({ color: "#c9973f", roughness: 0.45, metalness: 0.5, envMapIntensity: 0.6 });
const crateGeo = new BoxGeometry(0.9, 0.62, 0.9);
const crateMat = new MeshStandardMaterial({ color: CRATE_COLOR, roughness: 0.85, metalness: 0.02 });
const bandGeo = new BoxGeometry(0.96, 0.14, 0.96);
const bandMat = new MeshStandardMaterial({ color: CRATE_BAND, roughness: 0.5, metalness: 0.4 });
const iceGeo = new BoxGeometry(0.97, 0.78, 0.97);
const iceMats: Record<number, MeshStandardMaterial> = {
  1: new MeshStandardMaterial({ color: ICE_COLOR, transparent: true, opacity: 0.42, roughness: 0.15, metalness: 0, depthWrite: false }),
  2: new MeshStandardMaterial({ color: ICE_COLOR, transparent: true, opacity: 0.62, roughness: 0.15, metalness: 0, depthWrite: false }),
};

interface Tween { t0: number; dur: number; apply: (t: number) => void; onMid?: () => void; midDone?: boolean; onDone?: () => void }
let tweens: Tween[] = [];
let clockMs = 0;
let animating = false;
let pendingState: State | null = null;
let selected = -1;
let hintCells: number[] | null = null;
const cursor = { x: -1, y: -1, active: false };
const shake = { amp: 0, until: 0 };
const shakeVec = new Vector3();
let paused = false;
let decorTime = 0;

/** The host's play input: a swap the player committed (cells x, y). */
let onSwap: ((ax: number, ay: number, bx: number, by: number) => void) | null = null;
let onSelect: (() => void) | null = null;
export function setHandlers(swap: (ax: number, ay: number, bx: number, by: number) => void, select: () => void): void { onSwap = swap; onSelect = select; }

// -- coordinates ---------------------------------------------------------------------------------------
function cellXY(i: number): { x: number; y: number } { return { x: i % width, y: Math.floor(i / width) }; }
function cellPos(i: number): { x: number; z: number } {
  return { x: ((i % width) - (width - 1) / 2) * CELL, z: (Math.floor(i / width) - (height - 1) / 2) * CELL };
}
function idxAt(x: number, y: number): number { return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x; }

// -- view pooling ------------------------------------------------------------------------------------------
function obtainView(): JewelView {
  const v = viewPool.pop() ?? new JewelView();
  if (v.group.parent !== jewelGroup) jewelGroup.add(v.group);
  v.group.visible = true;
  v.group.scale.setScalar(1);
  v.group.rotation.set(0, 0, 0);
  return v;
}
function releaseView(v: JewelView): void {
  v.group.visible = false;
  v.idx = -1;
  jewelGroup.remove(v.group);
  if (viewPool.length < 96) viewPool.push(v);
}

// -- board construction --------------------------------------------------------------------------------------
function clearBoard(): void {
  for (const v of viewAt.values()) releaseView(v);
  viewAt.clear();
  for (const c of crateAt.values()) { boardGroup.remove(c.mesh); if (c.band) boardGroup.remove(c.band); }
  crateAt.clear();
  for (const m of iceAt.values()) boardGroup.remove(m);
  iceAt.clear();
  if (cellMesh) { boardGroup.remove(cellMesh); cellMesh.geometry.dispose(); cellMesh = null; }
  if (frameMesh) { boardGroup.remove(frameMesh); frameMesh.geometry.dispose(); frameMesh = null; }
  tweens = [];
}
const m4 = new Matrix4();
function buildCells(st: State): void {
  const count = st.cells.length;
  const mesh = new InstancedMesh(new BoxGeometry(0.94, 0.1, 0.94), cellMat, count);
  mesh.receiveShadow = true;
  for (let i = 0; i < count; i++) {
    const p = cellPos(i);
    if (st.cells[i]!.play) m4.makeTranslation(p.x, -0.05, p.z);
    else m4.makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -100, 0);
    mesh.setMatrixAt(i, m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  cellMesh = mesh;
  recolorCells();
  boardGroup.add(mesh);
  frameMesh = new Mesh(new BoxGeometry(width * CELL + 0.9, 0.22, height * CELL + 0.9), frameMat);
  frameMesh.position.y = -0.2;
  frameMesh.receiveShadow = true;
  frameMesh.castShadow = true;
  boardGroup.add(frameMesh);
  fitShadow();
  setFrame(frameStyle);
}
function recolorCells(): void {
  if (!cellMesh || !state) return;
  const cA = new Color(theme ? theme.board.cellA : "#3d2c50");
  const cB = new Color(theme ? theme.board.cellB : "#463455");
  const cHole = new Color("#000000");
  for (let i = 0; i < state.cells.length; i++) {
    const { x, y } = cellXY(i);
    cellMesh.setColorAt(i, state.cells[i]!.play ? ((x + y) % 2 === 0 ? cA : cB) : cHole);
  }
  if (cellMesh.instanceColor) cellMesh.instanceColor.needsUpdate = true;
}
/** Fit the key light's shadow box tightly around the board (plus jewel height), scene.js _fitShadow. */
function fitShadow(): void {
  const half = Math.max(width, height) * CELL * 0.5 + 1.2;
  const dir = new Vector3(6, 10, 4).normalize();
  keyLight.target.position.set(0, 0, 0);
  keyLight.position.copy(dir).multiplyScalar(half + 8);
  const sh = keyLight.shadow.camera as OrthographicCamera;
  sh.left = -half; sh.right = half; sh.top = half; sh.bottom = -half; sh.near = 0.5; sh.far = half * 2 + 16;
  sh.updateProjectionMatrix();
}
function addCrate(i: number, hp: number): void {
  const p = cellPos(i);
  const mesh = new Mesh(crateGeo, crateMat);
  mesh.position.set(p.x, 0.26, p.z);
  mesh.castShadow = true;
  boardGroup.add(mesh);
  let band: Mesh | null = null;
  if (hp >= 2) { band = new Mesh(bandGeo, bandMat); band.position.set(p.x, 0.26, p.z); boardGroup.add(band); }
  crateAt.set(i, { mesh, band });
}
function addIce(i: number, level: number): void {
  const p = cellPos(i);
  const mesh = new Mesh(iceGeo, iceMats[Math.min(2, Math.max(1, level))]!);
  mesh.position.set(p.x, JEWEL_Y, p.z);
  boardGroup.add(mesh);
  iceAt.set(i, mesh);
}

/** (Re)builds the board from a rules state (js/render/scene.js buildBoard). */
export function buildBoard(st: State): void {
  state = st;
  width = st.width;
  height = st.height;
  clearBoard();
  buildCells(st);
  for (let i = 0; i < st.cells.length; i++) {
    const cell = st.cells[i]!;
    if (!cell.play) continue;
    if (cell.crate > 0) addCrate(i, cell.crate);
    if (cell.ice > 0 && cell.j) addIce(i, cell.ice);
    if (!cell.j || cell.crate) continue;
    const v = obtainView().configure(cell.j.c, cell.j.s);
    v.idx = i;
    const p = cellPos(i);
    v.group.position.set(p.x, JEWEL_Y, p.z);
    viewAt.set(i, v);
  }
  selected = -1;
  setSelected(-1);
  // A new board starts with the keyboard cursor hidden (its first key shows it on the first cell).
  cursor.active = false;
  cursor.x = cursor.y = -1;
  cursorMark.visible = false;
  animating = false;
  pendingState = null;
  refitCamera();
}
/** No board (title and menus show the empty workbench). */
export function clear(): void {
  clearBoard();
  state = null;
  width = height = 0;
  selected = -1;
  selRing.visible = hoverRing.visible = cursorMark.visible = false;
  cursor.active = false;
  cursor.x = cursor.y = -1;
  clearHint();
  animating = false;
  pendingState = null;
  refitCamera();
}

/** Makes every visible object match the rules state exactly (idempotent; the end of every timeline). */
export function syncToState(st: State): void {
  if (!st || st.width !== width || st.height !== height) return;
  state = st;
  const seen = new Set<number>();
  for (let i = 0; i < st.cells.length; i++) {
    const cell = st.cells[i]!;
    const want = cell.play && cell.j && !cell.crate ? cell.j : null;
    let v = viewAt.get(i) ?? null;
    if (want) {
      if (!v) {
        v = obtainView();
        v.idx = i;
        viewAt.set(i, v);
      }
      const p = cellPos(i);
      v.group.position.set(p.x, JEWEL_Y, p.z);
      v.configure(want.c, want.s);
      v.group.visible = true;
      v.group.scale.setScalar(1);
      v.group.rotation.set(0, 0, 0);
      seen.add(i);
    } else if (v) {
      viewAt.delete(i);
      releaseView(v);
    }
    const iced = cell.play && !!cell.j && !cell.crate && cell.ice > 0;
    const ice = iceAt.get(i);
    if (iced && !ice) addIce(i, cell.ice);
    else if (iced && ice) { ice.material = iceMats[Math.min(2, cell.ice)]!; ice.visible = true; }
    else if (!iced && ice) { boardGroup.remove(ice); iceAt.delete(i); }
    const c = crateAt.get(i);
    if (c && cell.crate <= 0) { boardGroup.remove(c.mesh); if (c.band) boardGroup.remove(c.band); crateAt.delete(i); }
    else if (c && c.band && cell.crate < 2) { boardGroup.remove(c.band); c.band = null; }
    else if (!c && cell.play && cell.crate > 0) addCrate(i, cell.crate); // undo brings a broken crate back
    else if (c && !c.band && cell.crate >= 2) { const p = cellPos(i); c.band = new Mesh(bandGeo, bandMat); c.band.position.set(p.x, 0.26, p.z); boardGroup.add(c.band); }
    if (c && cell.crate > 0) { c.mesh.scale.setScalar(1); c.mesh.rotation.y = 0; }
  }
  for (const [i, v] of [...viewAt]) if (!seen.has(i)) { viewAt.delete(i); releaseView(v); }
  if (selected >= 0 && !viewAt.has(selected)) setSelected(-1);
}

// -- event timelines ---------------------------------------------------------------------------------------
function tween(t: Tween): void { tweens.push(t); }
function tweenPosition(g: Group, t0: number, dur: number, to: { x: number; y: number; z: number }, ease = easeInOutQuad, onDone?: () => void): void {
  let from: { x: number; y: number; z: number } | null = null;
  tween({
    t0, dur,
    apply: (t) => {
      if (!from) from = { x: g.position.x, y: g.position.y, z: g.position.z };
      const k = ease(t);
      g.position.set(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k);
    },
    onDone: () => { g.position.set(to.x, to.y, to.z); if (onDone) onDone(); },
  });
}
function tweenScale(g: Group, t0: number, dur: number, peak: number, ease: (t: number) => number, yoyo: boolean, onMid?: () => void): void {
  let from: number | null = null;
  tween({
    t0, dur: yoyo ? dur * 2 : dur,
    apply: (t) => {
      if (from === null) from = g.scale.x;
      const k = yoyo ? (t < 0.5 ? ease(t * 2) : ease(2 - t * 2)) : ease(t);
      g.scale.setScalar(from + (peak - from) * k);
    },
    ...(onMid ? { onMid } : {}),
    ...(yoyo ? { onDone: () => g.scale.setScalar(1) } : {}),
  });
}
function tweenShakeMesh(o: { position: Vector3 }, t0: number, dur: number): void {
  const base = o.position.x;
  tween({ t0, dur, apply: (t) => { o.position.x = base + Math.sin(t * 40) * 0.05 * (1 - t); }, onDone: () => { o.position.x = base; } });
}

/**
 * One deterministic event stream as a scheduled timeline (js/render/scene.js
 * playEvents); returns its length in ms. The host calls finalize() when that
 * time has passed on the fixed steps (or at once to skip).
 */
export function playEvents(events: readonly RulesEvent[], next: State, fast: boolean): number {
  if (!state) return 0;
  pendingState = next;
  animating = true;
  const mult = fast ? FAST_MULTIPLIER : 1;
  const start = clockMs;
  let cur = clockMs + 30;
  let cat: string | null = null;
  let catDur = 0;
  const slot = (c: string, durS: number): void => {
    const d = durS * 1000;
    if (cat !== c) { cur += catDur; cat = c; catDur = d; } else if (d > catDur) catDur = d;
  };
  let celebrated = false;
  for (const e of events) {
    switch (e.t) {
      case "swap": slot("swap", SLOT.swap * mult); animSwap(e.a!, e.b!, cur, SLOT.swap * mult * 1000, false); break;
      case "swap-back": slot("swap", SLOT.swapBack * mult); animSwap(e.a!, e.b!, cur, SLOT.swapBack * mult * 1000, true); break;
      case "match": {
        slot("burst", SLOT.burst * mult);
        for (const g of e.groups ?? []) for (const i of g.cells) { const v = viewAt.get(i); if (v) tweenScale(v.group, cur, 120, 1.22, easeOutCubic, true); }
        if (!reducedMotion && (e.cascade ?? 1) > 1) addShake(SHAKE_TIERS.combo, 250);
        break;
      }
      case "remove": {
        slot("burst", SLOT.burst * mult);
        const v = viewAt.get(e.idx!);
        const p = cellPos(e.idx!);
        if (v) { viewAt.delete(e.idx!); animRemove(v, cur + 50, 220 * mult); }
        burst(p.x, JEWEL_Y + 0.1, p.z, palette[e.c ?? -1] ?? "#ffffff", 8, 1.6, cur);
        break;
      }
      case "blast": {
        slot("burst", SLOT.burst * mult);
        animBlast(e, cur);
        if (!reducedMotion) addShake(e.s === SPECIAL.PRISM || e.s === SPECIAL.BLOOM ? SHAKE_TIERS.combo : SHAKE_TIERS.move, 220);
        break;
      }
      case "crack": {
        slot("burst", SLOT.burst * mult);
        const mesh = iceAt.get(e.idx!);
        if (mesh) mesh.material = iceMats[Math.max(1, Math.min(2, e.ice ?? 1))]!;
        const p = cellPos(e.idx!);
        burst(p.x, JEWEL_Y + 0.2, p.z, ICE_COLOR, 6, 1.2, cur);
        break;
      }
      case "damage": { slot("burst", SLOT.burst * mult); const c = crateAt.get(e.idx!); if (c) tweenShakeMesh(c.mesh, cur, 200); break; }
      case "crate-break": {
        slot("burst", SLOT.burst * mult);
        const c = crateAt.get(e.idx!);
        if (c) {
          crateAt.delete(e.idx!);
          animCrateBreak(c, cur);
          const p = cellPos(e.idx!);
          burst(p.x, 0.4, p.z, CRATE_COLOR, 10, 1.8, cur);
        }
        break;
      }
      case "create": {
        slot("burst", SLOT.burst * mult);
        const v = viewAt.get(e.idx!);
        if (v) tweenScale(v.group, cur + 50, 220 * mult, 1.35, easeOutBack, true, () => { v.configure(e.c!, e.s!); });
        const p = cellPos(e.idx!);
        burst(p.x, JEWEL_Y + 0.25, p.z, "#fff2cf", 12, 2.0, cur);
        break;
      }
      case "fall": {
        const dist = Math.abs(cellXY(e.to!).y - cellXY(e.from!).y);
        const dur = Math.min(SLOT.gravityMax, SLOT.gravityBase + SLOT.gravityPerCell * dist) * mult;
        slot("gravity", dur);
        animFall(e.from!, e.to!, cur, dur * 1000);
        break;
      }
      case "spawn": {
        const dur = Math.min(SLOT.gravityMax, SLOT.gravityBase + SLOT.gravityPerCell * 2) * mult;
        slot("gravity", dur);
        animSpawn(e.idx!, e.c!, e.s ?? 0, cur, dur * 1000, !!e.materialize);
        break;
      }
      case "shuffle": slot("shuffle", SLOT.shuffle * mult); animShuffle(e.cells ?? [], cur, SLOT.shuffle * mult * 1000, next); break;
      case "prism-swap": slot("burst", SLOT.burst * mult * 1.4); flashWhite(cur); if (!reducedMotion) addShake(SHAKE_TIERS.round, 300); break;
      case "end": {
        slot("meta", SLOT.meta);
        if (e.reason === "goals-complete" && !celebrated) { celebrated = true; celebrate(cur); }
        break;
      }
      default: break; // goal / turn / reject / undo — HUD and audio surfaces
    }
  }
  cur += catDur;
  return Math.max(0, cur - start) + 20;
}
/** The timeline is over (or skipped): every object lands on the exact final state. */
export function finalize(): void {
  const st = pendingState;
  // Pending scheduled effects (bursts) still fire on skip; tween end states apply.
  for (const t of tweens) { try { t.apply(1); if (t.onMid && !t.midDone) t.onMid(); if (t.onDone) t.onDone(); } catch (e) { console.warn(`tween: ${String(e)}`); } }
  tweens = [];
  if (st) syncToState(st);
  pendingState = null;
  animating = false;
  for (const [i, v] of viewAt) {
    const p = cellPos(i);
    v.group.position.set(p.x, JEWEL_Y, p.z);
    v.group.scale.setScalar(1);
    v.group.rotation.set(0, 0, 0);
  }
  setSelected(selected);
}
export function isAnimating(): boolean { return animating; }

function animSwap(a: number, b: number, t0: number, dur: number, isBack: boolean): void {
  const va = viewAt.get(a), vb = viewAt.get(b);
  if (!va || !vb) return;
  const pa = cellPos(a), pb = cellPos(b);
  if (isBack) {
    tweenPosition(va.group, t0, dur * 0.45, { x: pb.x, y: JEWEL_Y, z: pb.z });
    tweenPosition(va.group, t0 + dur * 0.5, dur * 0.45, { x: pa.x, y: JEWEL_Y, z: pa.z });
    tweenPosition(vb.group, t0, dur * 0.45, { x: pa.x, y: JEWEL_Y, z: pa.z });
    tweenPosition(vb.group, t0 + dur * 0.5, dur * 0.45, { x: pb.x, y: JEWEL_Y, z: pb.z });
  } else {
    tweenPosition(va.group, t0, dur, { x: pb.x, y: JEWEL_Y, z: pb.z });
    tweenPosition(vb.group, t0, dur, { x: pa.x, y: JEWEL_Y, z: pa.z });
    viewAt.set(a, vb); viewAt.set(b, va);
    va.idx = b; vb.idx = a;
  }
}
function animRemove(v: JewelView, t0: number, dur: number): void {
  const g = v.group;
  tween({
    t0, dur,
    apply: (t) => { g.scale.setScalar(Math.max(0.001, 1 - easeInOutQuad(t))); g.rotation.y = t * 2.4; },
    onDone: () => { g.scale.setScalar(1); g.rotation.y = 0; releaseView(v); },
  });
}
function animFall(from: number, to: number, t0: number, dur: number): void {
  const v = viewAt.get(from);
  if (!v) return;
  viewAt.delete(from);
  viewAt.set(to, v);
  v.idx = to;
  const p = cellPos(to);
  let s: { x: number; z: number } | null = null;
  tween({
    t0, dur,
    apply: (t) => {
      if (!s) s = { x: v.group.position.x, z: v.group.position.z };
      const k = easeOutCubic(t);
      v.group.position.x = s.x + (p.x - s.x) * Math.min(1, k * 1.6);
      v.group.position.z = s.z + (p.z - s.z) * k;
      v.group.position.y = JEWEL_Y + Math.sin(PI * Math.min(1, k)) * 0.12 * (1 - k);
    },
    onDone: () => v.group.position.set(p.x, JEWEL_Y, p.z),
  });
}
function animSpawn(idx: number, color: number, special: number, t0: number, dur: number, materialize: boolean): void {
  const v = obtainView().configure(color, special);
  v.idx = idx;
  viewAt.set(idx, v);
  const p = cellPos(idx);
  v.group.position.set(p.x, JEWEL_Y + 1.6, p.z - (materialize ? 2.2 : 1.2) * CELL);
  tweenPosition(v.group, t0, dur, { x: p.x, y: JEWEL_Y, z: p.z }, easeOutCubic);
}
function animBlast(e: RulesEvent, t0: number): void {
  const origin = cellPos(e.idx!);
  const beam = beams.find((b) => !b.visible && !b.userData.busy);
  if (beam) {
    beam.userData.busy = true;
    const show = (): void => {
      beam.visible = true;
      beam.material.opacity = 0.85;
      beam.material.color.set(e.s === SPECIAL.PRISM ? "#ffffff" : "#fff2cf");
      if (e.s === SPECIAL.RAY_H) { beam.scale.set(width * CELL, 1, 0.5); beam.position.set(0, JEWEL_Y, origin.z); }
      else if (e.s === SPECIAL.RAY_V) { beam.scale.set(0.5, 1, height * CELL); beam.position.set(origin.x, JEWEL_Y, 0); }
      else if (e.s === SPECIAL.BLOOM) { beam.scale.set(3 * CELL, 1.6, 3 * CELL); beam.position.set(origin.x, JEWEL_Y, origin.z); }
      else { beam.scale.set(width * CELL, 1.4, height * CELL); beam.position.set(0, JEWEL_Y + 0.3, 0); }
    };
    show();
    tween({
      t0, dur: 300,
      apply: (t) => { beam.material.opacity = 0.85 * (1 - t); },
      onDone: () => { beam.visible = false; beam.userData.busy = false; },
    });
  }
  for (const h of e.hits ?? []) { const p = cellPos(h); burst(p.x, JEWEL_Y + 0.1, p.z, "#fff2cf", 3, 1.4, t0); }
}
function animCrateBreak(c: { mesh: Mesh; band: Mesh | null }, t0: number): void {
  tween({
    t0, dur: 250,
    apply: (t) => { const s = Math.max(0.001, 1 - t); c.mesh.scale.setScalar(s); c.mesh.rotation.y = t * 1.5; if (c.band) c.band.scale.setScalar(s); },
    onDone: () => { boardGroup.remove(c.mesh); if (c.band) boardGroup.remove(c.band); c.mesh.scale.setScalar(1); c.mesh.rotation.y = 0; },
  });
}
function animShuffle(cells: number[], t0: number, dur: number, finalState: State): void {
  for (const i of cells) {
    const v = viewAt.get(i);
    if (!v) continue;
    tween({
      t0, dur,
      apply: (t) => { v.group.rotation.y = t * PI * 3; v.group.scale.setScalar(1 - Math.sin(PI * t) * 0.35); },
      onDone: () => {
        v.group.rotation.y = 0;
        v.group.scale.setScalar(1);
        const cell = finalState.cells[i];
        if (cell && cell.j) v.configure(cell.j.c, cell.j.s);
      },
    });
  }
}
function flashWhite(t0: number): void {
  const beam = beams.find((b) => !b.visible && !b.userData.busy);
  if (!beam) return;
  beam.userData.busy = true;
  beam.visible = true;
  beam.material.color.set("#ffffff");
  beam.scale.set(width * CELL * 1.4, 2.5, height * CELL * 1.4);
  beam.position.set(0, JEWEL_Y + 0.4, 0);
  tween({
    t0, dur: 500,
    apply: (t) => { beam.material.opacity = 0.7 * (1 - t); },
    onDone: () => { beam.visible = false; beam.userData.busy = false; },
  });
}
function celebrate(t0: number): void {
  if (reducedMotion) return;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TWO_PI;
    burst(Math.cos(a) * 2.2, JEWEL_Y + 1.2, Math.sin(a) * 2.2, palette[k % palette.length] ?? "#ffd28a", 26, 3.2, t0);
  }
  addShake(SHAKE_TIERS.round, 400, t0);
}
/** A spark burst (fired as the timeline is scheduled, as js/render/scene.js did); trails add their own sparks. */
function burst(x: number, y: number, z: number, color: string, count: number, speed: number, _t0?: number): void {
  if (reducedMotion) count = Math.min(3, count);
  if (look && look.particles === "low") count = Math.floor(count / 2);
  burstRaw(x, y, z, color, count, speed, 1);
  if (trailStyle === "spark") burstRaw(x, y + 0.1, z, "#ffffff", Math.ceil(count / 2), speed * 1.7, 0.7);
  else if (trailStyle === "comet") burstRaw(x, y + 0.05, z, "#ffb36b", Math.ceil(count / 2), speed * 0.6, 1.3);
}
function addShake(amp: number, durMs: number, _at?: number): void {
  if (reducedMotion || amp <= 0) return;
  shake.amp = Math.max(shake.amp, amp);
  shake.until = Math.max(shake.until, clockMs + durMs);
}

// -- hints, selection, invalid flash ----------------------------------------------------------------------
export function showHint(mv: { ax: number; ay: number; bx: number; by: number } | null): void {
  clearHint();
  if (!mv || !state) return;
  hintCells = [idxAt(mv.ax, mv.ay), idxAt(mv.bx, mv.by)];
  hintRings.forEach((r, k) => {
    const i = hintCells![k]!;
    if (i < 0) { r.visible = false; return; }
    const p = cellPos(i);
    r.position.x = p.x; r.position.z = p.z;
    r.visible = true;
  });
}
export function clearHint(): void {
  hintCells = null;
  for (const r of hintRings) r.visible = false;
}
export function flashInvalid(idx: number): void {
  if (idx < 0 || !state) return;
  const p = cellPos(idx);
  badRing.position.x = p.x; badRing.position.z = p.z;
  badRing.visible = true;
  tween({ t0: clockMs, dur: 400, apply: (t) => { badRing.material.opacity = 0.9 * (1 - t); }, onDone: () => { badRing.visible = false; } });
  const v = viewAt.get(idx);
  if (v) tweenShakeMesh(v.group, clockMs, 300);
}
function setSelected(idx: number): void {
  const changed = idx !== selected;
  selected = idx;
  if (idx < 0 || !state) { selRing.visible = false; return; }
  const p = cellPos(idx);
  selRing.position.x = p.x; selRing.position.z = p.z;
  selRing.visible = true;
  if (changed && onSelect) onSelect();
}
export function selectedCell(): number { return selected; }

// -- the keyboard cursor --------------------------------------------------------------------------------------
export function cursorShow(): void {
  if (!state) return;
  if (!cursor.active) {
    cursor.active = true;
    if (cursor.x < 0) {
      outer: for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (state.cells[y * width + x]!.play) { cursor.x = x; cursor.y = y; break outer; }
      }
    }
  }
  placeCursor();
}
export function cursorHide(): void { cursor.active = false; cursorMark.visible = false; }
export function cursorMove(dx: number, dy: number): void {
  if (!state) return;
  cursorShow();
  let { x, y } = cursor;
  for (let step = 0; step < Math.max(width, height); step++) {
    x = (x + dx + width) % width;
    y = (y + dy + height) % height;
    if (state.cells[y * width + x]!.play) break;
  }
  cursor.x = x; cursor.y = y;
  placeCursor();
}
function placeCursor(): void {
  const i = idxAt(cursor.x, cursor.y);
  if (i < 0) return;
  const p = cellPos(i);
  cursorMark.position.x = p.x; cursorMark.position.z = p.z;
  cursorMark.visible = true;
}
export function cursorCell(): { x: number; y: number } | null { return cursor.active && cursor.x >= 0 ? { x: cursor.x, y: cursor.y } : null; }
/** First press selects the jewel under the cursor; a second on a neighbour swaps; the same cell deselects. */
export function cursorConfirm(): void {
  if (!state || !cursor.active) return;
  const i = idxAt(cursor.x, cursor.y);
  if (i < 0) return;
  pickCell(i, true);
}
export function cursorCancel(): boolean {
  if (selected >= 0) { setSelected(-1); return true; }
  return false;
}
/** Tap-tap on a cell (the board, the cursor or the text board's buttons share it). */
function pickCell(i: number, allowEmpty: boolean): void {
  if (!viewAt.has(i) && !allowEmpty) { if (selected >= 0) setSelected(-1); return; }
  if (selected < 0) { if (viewAt.has(i) || allowEmpty) setSelected(i); return; }
  if (selected === i) { setSelected(-1); return; }
  const a = cellXY(selected), b = cellXY(i);
  if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) commitSwap(selected, i);
  else setSelected(i);
}
function commitSwap(a: number, b: number): void {
  if (!onSwap) return;
  const pa = cellXY(a), pb = cellXY(b);
  setSelected(-1);
  clearHint();
  onSwap(pa.x, pa.y, pb.x, pb.y);
}

// -- pointer input (window pixels; the host decides when the board may take it) --------------------------------
const ray = new Raycaster();
const boardPlane = new Plane(new Vector3(0, 1, 0), 0);
const hit = new Vector3();
/** The cell under a window pixel, or -1 (a raycast onto the board's plane, the camera shake taken out first). */
export function pick(x: number, y: number): number {
  if (!state || x < view.x || y < view.y || x > view.x + view.w || y > view.y + view.h) return -1;
  camera.position.sub(shakeVec);
  camera.updateMatrixWorld();
  ray.setFromCamera(pointerToNdc(x, y), camera);
  camera.position.add(shakeVec);
  camera.updateMatrixWorld();
  if (!ray.ray.intersectPlane(boardPlane, hit)) return -1;
  return idxAt(Math.round(hit.x / CELL + (width - 1) / 2), Math.round(hit.z / CELL + (height - 1) / 2));
}
let drag: { from: number; x: number; y: number; at: number; committed: boolean } | null = null;
let inputReady = false;
/** Whether the board takes play input now (a state, no animation, not paused). */
export function setInputReady(on: boolean): void { inputReady = on; if (!on) hoverRing.visible = false; }
const ready = (): boolean => inputReady && !!state && !animating && !paused;
export function pointerDown(x: number, y: number, now: number): void {
  if (!ready()) { drag = null; return; }
  const i = pick(x, y);
  drag = { from: i, x, y, at: now, committed: false };
  if (i >= 0) { const p = cellPos(i); hoverRing.position.x = p.x; hoverRing.position.z = p.z; hoverRing.visible = true; }
}
/** Pointer moves: the hover ghost (mouse only), and a drag past 24 px commits a directional swap. */
export function pointerMove(x: number, y: number, mouse: boolean, holdToDrag: boolean, scale: number): void {
  if (!state) return;
  if (!drag || drag.from < 0) {
    if (mouse && ready() && !drag) {
      const i = pick(x, y);
      if (i >= 0) { const p = cellPos(i); hoverRing.position.x = p.x; hoverRing.position.z = p.z; hoverRing.visible = true; }
      else hoverRing.visible = false;
    }
    return;
  }
  if (drag.committed || !ready() || !holdToDrag) return;
  const dx = (x - drag.x) / scale, dy = (y - drag.y) / scale;
  if (Math.hypot(dx, dy) < 24) return;
  const a = cellXY(drag.from);
  let bx = a.x, by = a.y;
  if (Math.abs(dx) > Math.abs(dy)) bx += dx > 0 ? 1 : -1; else by += dy > 0 ? 1 : -1;
  const target = idxAt(bx, by);
  if (target < 0) return;
  drag.committed = true;
  commitSwap(drag.from, target);
}
/** A tap is the same cell, ≤ 12 px of movement and ≤ 600 ms. */
export function pointerUp(x: number, y: number, now: number, scale: number): void {
  const d = drag;
  drag = null;
  hoverRing.visible = false;
  if (!d || d.committed || d.from < 0 || !ready()) return;
  const up = pick(x, y);
  if (up !== d.from || Math.hypot(x - d.x, y - d.y) / scale > 12 || now - d.at > 0.6) return;
  pickCell(d.from, false);
}
export function pointerCancel(): void { drag = null; hoverRing.visible = false; }
/** The text board's tap on a cell (same selection as the 3D board). */
export function tapCell(i: number): void { if (ready()) pickCell(i, false); }

// -- camera -----------------------------------------------------------------------------------------------------
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
const spring = {
  pos: new Vector3(0, 10, 10), posVel: new Vector3(), look: new Vector3(), lookVel: new Vector3(),
  targetPos: new Vector3(0, 10, 10), targetLook: new Vector3(),
};
let camInit = false;
/** Frames the board inside the playfield (window pixels) of the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if ((Object.keys(next) as (keyof typeof next)[]).every((k) => Math.abs(next[k] - view[k]) < 0.5)) return;
  view = next;
  refitCamera();
}
export function playfield(): { x: number; y: number; w: number; h: number } { return view; }
function refitCamera(): void {
  const safeW = view.w, safeH = view.h;
  camera.aspect = safeW / safeH;
  camera.setViewOffset(safeW, safeH, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
  const preset = CAMERA_PRESETS[cameraPreset] ?? CAMERA_PRESETS.default!;
  const { pitch, yaw } = preset;
  // The empty workbench (title, menus) is framed as an 8 × 8 board.
  const bw = (width || 8) * CELL, bd = (height || 8) * CELL;
  const vfov = (CAMERA_FOV * PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (safeW / safeH));
  let dist = Math.max(((bd * Math.sin(pitch) + 1.0) / 2) * FIT_MARGIN / Math.tan(vfov / 2), (bw / 2) * FIT_MARGIN / Math.tan(hfov / 2));
  // Refine against the actual projection: the near edge of the tilted board spreads wider. Projected
  // by hand (the engine's Vector3.project takes the window's aspect, not a probe camera's).
  const lookAt = new Vector3(0, 0, bd * 0.06);
  const corners: Vector3[] = [];
  for (const x of [-bw / 2 - 0.4, bw / 2 + 0.4]) for (const z of [-bd / 2 - 0.4, bd / 2 + 0.4]) for (const y of [0, 0.9]) corners.push(new Vector3(x, y, z));
  const tanV = Math.tan(vfov / 2), aspect = safeW / safeH;
  const pos = new Vector3(), fwd = new Vector3(), right = new Vector3(), up = new Vector3(), d = new Vector3();
  for (let i = 0; i < 10; i++) {
    pos.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
    fwd.copy(lookAt).sub(pos).normalize();
    right.crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
    up.crossVectors(right, fwd);
    let worst = 0;
    for (const c of corners) {
      d.copy(c).sub(pos);
      const z = d.dot(fwd);
      worst = Math.max(worst, Math.abs(d.dot(right) / z / (tanV * aspect)), Math.abs(d.dot(up) / z / tanV));
    }
    if (worst <= 0.95) break;
    dist *= Math.min(1.5, worst / 0.95 + 0.01);
  }
  spring.targetPos.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
  spring.targetLook.copy(lookAt);
  if (!camInit) { spring.pos.copy(spring.targetPos); spring.look.copy(spring.targetLook); camInit = true; }
}
export function setCameraPreset(name: string): void { cameraPreset = CAMERA_PRESETS[name] ? name : "default"; refitCamera(); }
// -- theme, palette, look, cosmetics -----------------------------------------------------------------------------
function applyLightBalance(): void {
  const ibl = !!look && look.reflections;
  ambient.intensity = ambientBase * (ibl ? 0.55 : 1);
  hemi.intensity = ibl ? 0.3 : 0.45;
}
export function setTheme(t: Theme): void {
  theme = t;
  const ctx = skyCanvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, t.sky.top);
  grad.addColorStop(0.55, t.sky.mid);
  grad.addColorStop(1, t.sky.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  skyTex.needsUpdate = true;
  stars.visible = !!t.sky.stars;
  fog.color.set(t.fog.color);
  fog.density = t.fog.density;
  keyLight.color.set(t.light.key);
  keyLight.intensity = t.light.keyIntensity;
  fillLight.color.set(t.light.fill);
  fillLight.intensity = t.light.fillIntensity;
  ambient.color.set(t.light.ambient);
  hemi.color.set(t.light.fill);
  hemi.groundColor.set(t.table.color);
  ambientBase = t.light.ambientIntensity;
  applyLightBalance();
  tableMat.color.set(t.table.color);
  tableMat.roughness = t.table.roughness;
  rimMat.color.set(t.board.frame);
  dustMat.color.set(t.dust);
  for (const l of lamps) l.bulb.emissive.set(t.light.key);
  recolorCells();
  setFrame(frameStyle);
}
export function setPalette(p: string[]): void {
  palette = p.slice();
  p.forEach((hex, i) => {
    const m = jewelMats[i];
    if (!m) return;
    m.color.set(hex);
    m.emissive.copy(m.color).multiplyScalar(0.16);
  });
}
/** Cosmetic board frame (never touches rules, timing or information). */
export function setFrame(id: string): void {
  frameStyle = id || "standard";
  const m = frameMat;
  const base = theme ? theme.board.frame : "#c9973f";
  if (frameStyle === "brass") { m.color.set("#d4af37"); m.metalness = 0.85; m.roughness = 0.3; m.emissive.set("#000000"); }
  else if (frameStyle === "filigree") { m.color.set(base); m.metalness = 0.6; m.roughness = 0.35; m.emissive.set("#8a6a20"); m.emissiveIntensity = 0.35; }
  else { m.color.set(base); m.metalness = 0.5; m.roughness = 0.45; m.emissive.set("#000000"); }
}
export function setTrail(id: string): void { trailStyle = id || "none"; }
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) shake.amp = 0;
  applyMotion();
}
export function setPaused(on: boolean): void { paused = on; }
const animatedBg = (): boolean => !!look && look.animated && !reducedMotion;
function applyMotion(): void {
  if (!animatedBg()) {
    for (const l of lamps) { l.group.rotation.z = 0; l.bulb.emissiveIntensity = 2.2; }
    starMat.opacity = 0.85;
  }
  if (!animatedBg() || !glintCount) {
    glints.visible = false;
    for (let i = 0; i < GLINT_CAP; i++) glintPos[i * 3 + 1] = -1000;
    glintPosAttr.needsUpdate = true;
  }
}
function setMap(mat: MeshStandardMaterial, slot: "map" | "roughnessMap", t: Texture | null): void {
  if (mat[slot] !== t) mat[slot] = t;
}
/** The look for the graphics level (quality.ts): shadows, reflections, post effects, particles, detail. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  scene.environment = next.reflections ? envMap() : null;
  applyEnv();
  applyLightBalance();
  pCap = Math.max(16, Math.min(SPARK_MAX, b.sparks));
  pHead = pHead % pCap;
  for (let i = pCap; i < SPARK_MAX; i++) { pLife[i] = 0; pPos[i * 3 + 1] = -1000; }
  pGeo.setDrawRange(0, pCap);
  dustVisible = b.dust;
  dustGeo.setDrawRange(0, b.dust);
  dust.visible = b.dust > 0;
  glintCount = GLINT_COUNT[next.particles] ?? 0;
  const detailed = next.detailed;
  props.visible = detailed;
  if (detailed) applyTextureBudget(b.texture);
  setMap(tableMat, "map", detailed && tex ? tex.wood : null);
  setMap(rimMat, "roughnessMap", detailed && tex ? tex.brushed : null);
  setMap(cellMat, "map", detailed && tex ? tex.tile : null);
  setMap(frameMat, "roughnessMap", detailed && tex ? tex.brushed : null);
  for (const m of jewelMats) m.clearcoat = detailed && b.clearcoat ? 1 : 0;
  // Specials glow a little brighter when bloom can pick them up.
  const glow = next.bloom ? 1.7 : 1;
  bloomMat.emissiveIntensity = 0.7 * glow;
  prismMat.emissiveIntensity = 0.9 * glow;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.35, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only lamps, glints, specials and specular highlights bloom (UnrealBloomPass 0.45, 0.4, 0.92).
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.4, threshold: 0.92, resolution: b.bloomRes } : null;
  // The GradeShader after OutputPass (display space): a gentle S-curve (slope ~1.11 at mid-grey), +12 %
  // saturation, warm highlights / violet shadows, the 0.26 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.12,
    shadows: [0.97, 0.95, 1.05], highlights: [1.04, 1.0, 0.95], split: [0.2, 0.8],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  applyMotion();
}

// -- the frame --------------------------------------------------------------------------------------------------------
/** One fixed step (ms): the timeline's tweens (frozen while paused). */
export function tick(dtMs: number): void {
  if (paused) return;
  clockMs += dtMs;
  for (let i = 0; i < tweens.length; i++) {
    const t = tweens[i]!;
    const k = (clockMs - t.t0) / t.dur;
    if (k < 0) continue;
    const c = Math.min(1, k);
    try { t.apply(c); } catch (e) { console.warn(`tween: ${String(e)}`); }
    if (t.onMid && !t.midDone && c >= 0.5) { t.midDone = true; t.onMid(); }
    if (k >= 1) {
      tweens.splice(i, 1);
      i--;
      if (t.onDone) t.onDone();
    }
  }
}
function springVec(cur: Vector3, vel: Vector3, target: Vector3, k: number, d: number, dt: number): void {
  vel.x += ((target.x - cur.x) * k - vel.x * d) * dt;
  vel.y += ((target.y - cur.y) * k - vel.y * d) * dt;
  vel.z += ((target.z - cur.z) * k - vel.z * d) * dt;
  cur.x += vel.x * dt; cur.y += vel.y * dt; cur.z += vel.z * dt;
}
/** Each rendered frame: particles, decor, the camera spring and shake, marker pulses. */
/** three r161 scaled scene.environment by each material's envMapIntensity; the engine (as r163+)
 * does that only for a material's own envMap, so every standard material carries the room itself. */
function applyEnv(): void {
  const env = scene.environment;
  scene.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (x instanceof MeshStandardMaterial && x.envMap !== env) x.envMap = env;
  });
}
export function update(dtIn: number, time: number): void {
  applyEnv();
  const dt = Math.min(0.1, Math.max(0, dtIn));
  if (!paused) {
    updateParticles(dt);
    updateDecor(dt, time);
  }
  const w = TWO_PI * CAMERA_SPRING_HZ;
  const step = Math.min(dt, 0.05);
  springVec(spring.pos, spring.posVel, spring.targetPos, w * w, 2 * w, step);
  springVec(spring.look, spring.lookVel, spring.targetLook, w * w, 2 * w, step);
  camera.position.copy(spring.pos);
  camera.lookAt(spring.look);
  if (shake.amp > 0 && clockMs < shake.until && !reducedMotion) {
    const a = shake.amp * Math.min(1, ((shake.until - clockMs) / 1000) * 4);
    shakeVec.set((fxRng.next() - 0.5) * 2 * a, (fxRng.next() - 0.5) * 2 * a * 0.6, (fxRng.next() - 0.5) * 2 * a);
  } else {
    shake.amp = 0;
    shakeVec.set(0, 0, 0);
  }
  camera.position.add(shakeVec);
  if (selRing.visible) selRing.scale.setScalar(1 + Math.sin(time * 5) * 0.06);
  if (hintCells) { const s = 1 + Math.sin(time * 6) * 0.1; for (const r of hintRings) r.scale.setScalar(s); }
}
function updateDecor(dt: number, now: number): void {
  if (dust.visible && animatedBg()) {
    dustTime += dt;
    const t = dustTime;
    for (let i = 0; i < dustVisible; i++) {
      const ph = dustSeed[i * 2]!, sp = dustSeed[i * 2 + 1]!;
      dustPos[i * 3] = dustPos[i * 3]! + Math.sin(t * 0.3 * sp + ph) * 0.0016;
      dustPos[i * 3 + 1] = dustPos[i * 3 + 1]! + Math.cos(t * 0.22 * sp + ph * 1.7) * 0.0011;
      dustPos[i * 3 + 2] = dustPos[i * 3 + 2]! + Math.cos(t * 0.26 * sp + ph * 0.6) * 0.0016;
    }
    dustAttr.needsUpdate = true;
  }
  if (animatedBg()) {
    decorTime = now;
    for (const l of lamps) {
      l.group.rotation.z = Math.sin(decorTime * 0.4 + l.phase) * 0.03;
      l.bulb.emissiveIntensity = 2.0 + Math.sin(decorTime * 3.1 + l.phase * 3) * 0.25;
    }
    starMat.opacity = 0.72 + Math.sin(decorTime * 0.9) * 0.13;
    if (glintCount) updateGlints(dt);
  }
  for (const v of viewAt.values()) {
    if (v.special === SPECIAL.PRISM && v.prismAura.visible) { v.prismAura.rotation.y += dt * 1.4; v.prismAura.rotation.x += dt * 0.7; }
  }
}
function updateGlints(dt: number): void {
  const views = viewAt.size ? [...viewAt.values()] : null;
  let any = false;
  for (let i = 0; i < GLINT_CAP; i++) {
    if (i >= glintCount || !views) { glintPos[i * 3 + 1] = -1000; continue; }
    glintLife[i] = glintLife[i]! + dt;
    const t = glintLife[i]!;
    if (t >= 0.9) {
      const v = views[Math.floor(decorRng.next() * views.length)]!;
      const p = v.group.position;
      glintPos[i * 3] = p.x + (decorRng.next() - 0.5) * 0.3;
      glintPos[i * 3 + 1] = p.y + 0.18 + decorRng.next() * 0.12;
      glintPos[i * 3 + 2] = p.z + (decorRng.next() - 0.5) * 0.3;
      glintLife[i] = -decorRng.next() * 2.5;
    }
    // Fade in and out over 0.9 s; above 1.0 so bloom catches the peak.
    const k = t < 0 ? 0 : Math.sin((Math.min(t, 0.9) / 0.9) * PI);
    const b = k * 1.6;
    glintCol[i * 3] = b; glintCol[i * 3 + 1] = b * 0.96; glintCol[i * 3 + 2] = b * 0.88;
    if (k > 0) any = true;
  }
  glints.visible = any;
  glintPosAttr.needsUpdate = true;
  glintColAttr.needsUpdate = true;
}
export type { Material };
