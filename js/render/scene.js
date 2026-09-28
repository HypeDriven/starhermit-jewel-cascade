/**
 * scene.js — Jewel Cascade Three.js renderer.
 *
 * The jewel workshop suspended in warm twilight: an authored camera over a
 * workbench, original procedural gem geometry (one silhouette per color so
 * color is always reinforced by shape), PBR lighting with one dominant key,
 * pooled particles, image-based lighting and an optional post chain (GTAO,
 * bloom, colour grade, FXAA/SMAA). Graphics settings (render/gfx.js) scale
 * shadows/DPR/props/particles/effects without ever touching rules or hazard
 * legibility.
 *
 * Contract with the session (see main.js):
 *   buildBoard(state)            — (re)build the board from a rules state
 *   playEvents(events, state, {fast}) — animate a deterministic event stream,
 *                                  then settle every object into the exact
 *                                  final state and fire onSettled()
 *   syncToState(state)           — idempotent exact reconciliation
 *   skipSettle()                 — jump cosmetics to the deterministic end
 *   onSwap(ax,ay,bx,by)          — assigned by the host; the only play input
 *   showHint(mv)/clearHint(), flashInvalid(idx, reason)
 *   setTheme/setPalette/setGraphics/graphicsInfo/setReducedMotion/
 *   setCameraPreset/setPaused/setHidden/resize/getStats
 *   cursorMove/cursorConfirm/cursorCancel — keyboard board navigation
 *   setViewportInsets({left,right,top,bottom}) — shared layout model so the
 *                                  board frames inside the DOM shell
 *
 * Rendering consumes immutable snapshots plus event streams; no render code
 * ever mutates rules state. Animation timing derives from the performance
 * clock, not frame counts. Cosmetic randomness draws from its own seeded
 * stream and can never change rules outcomes.
 */

import * as THREE from '../../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLE_CAP, DUST_COUNT, GLINT_COUNT } from './gfx.js';
import { Rng, fnv1a } from '../engine/rng.js';
import { SPECIAL } from '../engine/rules.js';

/* ------------------------------------------------------------------ *
 *  Framing and motion constants (authored, exposed — no magic offsets)
 * ------------------------------------------------------------------ */

const CELL = 1.0; // world units per board cell
const JEWEL_Y = 0.36; // jewel rest height above the board plane
const BOARD_TOP_Y = 0.0;
const FIT_MARGIN = 1.19; // breathing room around the board
const CAMERA_FOV = 36; // low-distortion perspective

const CAMERA_PRESETS = {
  default: { pitch: 0.96, yaw: 0.0 }, // ~55° from the table plane
  low: { pitch: 0.62, yaw: 0.0 }, // near tabletop
  high: { pitch: 1.32, yaw: 0.0 }, // near top-down
};
const CAMERA_SPRING_HZ = 1.6; // critically damped spring frequency

const SLOT = {
  swap: 0.18,
  swapBack: 0.3,
  burst: 0.36,
  gravityBase: 0.16,
  gravityPerCell: 0.05,
  gravityMax: 0.5,
  shuffle: 0.5,
  meta: 0.05,
  celebrate: 1.1,
};
const FAST_MULTIPLIER = 0.55;

const GLINT_CAP = 16;

const SHAKE_TIERS = { ack: 0.0, move: 0.012, combo: 0.03, round: 0.05 };

const ICE_COLOR = '#bfe3f2';
const CRATE_COLOR = '#7a5a36';
const CRATE_BAND = '#4a3520';

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------ *
 *  Procedural gem geometry — one authored silhouette per color index.
 *  Flat-shaded facets read as cut stone without any textures.
 * ------------------------------------------------------------------ */

function buildGemGeometries() {
  const emerald = new THREE.OctahedronGeometry(0.4, 0);
  emerald.scale(0.72, 1.3, 0.72); // elongated baguette
  const amethyst = new THREE.ConeGeometry(0.33, 0.78, 6);
  amethyst.translate(0, 0.06, 0);
  return [
    new THREE.OctahedronGeometry(0.42, 0), // ruby — classic brilliant
    new THREE.DodecahedronGeometry(0.4, 0), // amber — chunky nugget
    new THREE.TetrahedronGeometry(0.48, 0), // topaz — sharp shard
    emerald, // emerald — tall baguette
    new THREE.IcosahedronGeometry(0.42, 0), // sapphire — faceted globe
    amethyst, // amethyst — crystal point
    new THREE.SphereGeometry(0.4, 14, 10), // opal — smooth cabochon
  ];
}

function makeGemMaterials(palette) {
  // Physical gems: the clearcoat layer (enabled with `detail`) adds a sharp
  // lacquer highlight over each facet; env reflections come from scene IBL.
  return palette.map((hex) => {
    const color = new THREE.Color(hex);
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.28,
      metalness: 0.08,
      flatShading: true,
      emissive: color.clone().multiplyScalar(0.16),
      envMapIntensity: 0.3,
      clearcoat: 0,
      clearcoatRoughness: 0.06,
    });
  });
}

/* ------------------------------------------------------------------ *
 *  Procedural textures (deterministic canvas art, built once)
 * ------------------------------------------------------------------ */

function canvasTexture(size, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Walnut grain: concentric growth rings plus streaks, as a light multiplier. */
function woodTexture(rng) {
  return canvasTexture(512, (ctx, n) => {
    ctx.fillStyle = '#e8e2dc';
    ctx.fillRect(0, 0, n, n);
    // Long, gently waving grain lines (straight-cut plank, not end grain).
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
      ctx.fillStyle = `rgba(${rng.next() < 0.5 ? '60,40,25' : '255,245,230'},${0.03 + rng.next() * 0.05})`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 1 + rng.next() * 14, 1);
    }
  });
}

/** Cell tile: bevelled rim (light top-left, dark bottom-right) + faint grain. */
function tileTexture(rng) {
  return canvasTexture(128, (ctx, n) => {
    ctx.fillStyle = '#f0ecef';
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(${rng.next() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + rng.next() * 0.04})`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 2, 2);
    }
    const b = 9;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(n, 0); ctx.lineTo(n - b, b); ctx.lineTo(b, b); ctx.lineTo(b, n - b); ctx.lineTo(0, n); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.moveTo(n, n); ctx.lineTo(0, n); ctx.lineTo(b, n - b); ctx.lineTo(n - b, n - b); ctx.lineTo(n - b, b); ctx.lineTo(n, 0); ctx.fill();
    const g = ctx.createRadialGradient(n / 2, n / 2, n * 0.1, n / 2, n / 2, n * 0.7);
    g.addColorStop(0, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = g;
    ctx.fillRect(b, b, n - 2 * b, n - 2 * b);
  });
}

/** Brushed-metal streaks for the brass frame (roughness map, linear). */
function brushedTexture(rng) {
  const tex = canvasTexture(256, (ctx, n) => {
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) {
      const v = Math.floor(110 + rng.next() * 110);
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(rng.next() * n, rng.next() * n, 20 + rng.next() * 90, 1);
    }
  }, false);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Soft round particle sprite (points are square without it). */
function dotTexture() {
  return canvasTexture(64, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  });
}

/** Four-point star glint for idle gem sparkle. */
function glintTexture() {
  return canvasTexture(64, (ctx, n) => {
    const c = n / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const [w, h] of [[n, 3], [3, n]]) {
      const lg = ctx.createLinearGradient(c - w / 2, c - h / 2, c + w / 2, c + h / 2);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,1)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(c - w / 2, c - h / 2, w, h);
    }
  });
}

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, richer saturation, warm highlights / violet shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.12);
      s *= mix(vec3(0.97, 0.95, 1.05), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/* ------------------------------------------------------------------ *
 *  Tween engine (schedule-time allocation only; the frame loop allocs none)
 * ------------------------------------------------------------------ */

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
function easeOutBack(t) {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

/* ------------------------------------------------------------------ *
 *  Pooled particle field (one Points draw call; fixed typed arrays)
 * ------------------------------------------------------------------ */

class ParticlePool {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); // seconds remaining
    this.maxLife = new Float32Array(capacity);
    this.head = 0;
    this.active = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.mat = new THREE.PointsMaterial({
      size: 0.12,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
    // Park everything far below until used.
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -1000;
  }

  burst(x, y, z, color, count, speed, spread) {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.capacity;
      const a = Math.random() * TWO_PI;
      const b = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.sin(b) * Math.cos(a) * s * (spread || 1);
      this.vel[i * 3 + 1] = Math.abs(Math.cos(b)) * s;
      this.vel[i * 3 + 2] = Math.sin(b) * Math.sin(a) * s * (spread || 1);
      this.col[i * 3] = c.r;
      this.col[i * 3 + 1] = c.g;
      this.col[i * 3 + 2] = c.b;
      this.life[i] = this.maxLife[i] = 0.5 + Math.random() * 0.45;
    }
  }

  update(dt) {
    const g = -2.6 * dt;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -1000;
        continue;
      }
      this.vel[i * 3 + 1] += g;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  setCapacityUsed(cap) {
    // Hide the pool entirely on the low tier (capacity 0 means skip updates).
    this.points.visible = cap > 0;
    this.visibleCap = cap;
  }

  dispose(scene) {
    scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  Jewel view — group with gem mesh + special overlays, reconfigurable
 * ------------------------------------------------------------------ */

let gemGeos = null; // lazily built shared geometry cache

class JewelView {
  constructor(parent) {
    this.group = new THREE.Group();
    this.gem = new THREE.Mesh();
    this.gem.castShadow = true;
    this.group.add(this.gem);

    // Special overlays (hidden unless configured).
    const ringGeo = new THREE.TorusGeometry(0.5, 0.045, 8, 24);
    this.ringH = new THREE.Mesh(ringGeo, JewelView.ringMaterial());
    this.ringH.rotation.x = Math.PI / 2;
    this.ringV = new THREE.Mesh(ringGeo, JewelView.ringMaterial());
    this.bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), JewelView.bloomMaterial());
    this.prismAura = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), JewelView.prismMaterial());
    for (const m of [this.ringH, this.ringV, this.bloom, this.prismAura]) {
      m.visible = false;
      this.group.add(m);
    }
    this.color = -1;
    this.special = -1;
    this.idx = -1;
    parent.add(this.group);
  }

  static ringMaterial() {
    if (!JewelView._ringMat) {
      JewelView._ringMat = new THREE.MeshBasicMaterial({ color: '#fff2cf', transparent: true, opacity: 0.9 });
    }
    return JewelView._ringMat;
  }
  static bloomMaterial() {
    if (!JewelView._bloomMat) {
      JewelView._bloomMat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        wireframe: true,
        emissive: '#ffe9a8',
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.8,
      });
    }
    return JewelView._bloomMat;
  }
  static prismMaterial() {
    if (!JewelView._prismMat) {
      JewelView._prismMat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        wireframe: true,
        emissive: '#cfe8ff',
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.65,
      });
    }
    return JewelView._prismMat;
  }

  /** Configure gem geometry/material + overlays. Shared caches: no churn. */
  configure(color, special, materials) {
    if (this.color !== color) {
      this.gem.geometry = gemGeos[color];
      this.gem.material = materials[color];
      this.color = color;
    }
    if (this.special !== special) {
      this.special = special;
      this.ringH.visible = special === SPECIAL.RAY_H;
      this.ringV.visible = special === SPECIAL.RAY_V;
      this.bloom.visible = special === SPECIAL.BLOOM;
      this.prismAura.visible = special === SPECIAL.PRISM;
      const base = materials[color];
      if (special === SPECIAL.PRISM) {
        this.gem.material = base; // prism keeps its color; aura + spin read as prismatic
      }
    }
    return this;
  }

  dispose(parent) {
    parent.remove(this.group);
  }
}

/* ------------------------------------------------------------------ *
 *  JewelScene
 * ------------------------------------------------------------------ */

export class JewelScene {
  constructor(canvas, { settings } = {}) {
    this.canvas = canvas;
    this.settings = settings || {};
    this.onSwap = null; // assigned by host
    this.onSettled = null; // assigned by host
    this.onContextLost = null;

    this.q = null; // resolved graphics settings (render/gfx.js)
    this.adaptiveScale = 1;
    this.pixelRatio = 1;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this._frames = [];
    this.reducedMotion = false;
    this.paused = false;
    this.hidden = false;

    this.theme = null;
    this.palette = null;

    this.state = null; // last built rules state (read-only reference)
    this.width = 0;
    this.height = 0;
    this.viewAt = new Map(); // idx -> JewelView
    this.crateAt = new Map(); // idx -> {mesh, band}
    this.iceAt = new Map(); // idx -> mesh
    this.viewPool = [];
    this.tweens = [];
    this.beams = [];
    this._animating = false;
    this._pendingState = null;
    this._settleAt = 0;
    this._settleTimer = null;

    this.selected = -1;
    this.dragFrom = -1;
    this.dragTarget = -1;
    this.pointerDownAt = 0;
    this.pointerDownPos = { x: 0, y: 0 };
    this.hintCells = null;
    this.cursor = { x: -1, y: -1, active: false };
    this.shake = { amp: 0, until: 0, x: 0, y: 0, z: 0 };
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };

    this._decorRng = new Rng(fnv1a('jc-decor'));
    this._fxRng = new Rng(fnv1a('jc-fx'));

    this._fps = 60;
    this._lastFrame = 0;
    this._raf = 0;
    this._disposed = false;

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._shake = new THREE.Vector3();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_TOP_Y);
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._camInit = false;
    this._contextLost = false;
    this._dragCommitted = false;
    this._dustVisible = DUST_COUNT.high;
    this.cameraPreset = 'default';

    this._initRenderer(canvas);
    this._initSceneGraph();
    this._initEnvironment();
    this._initMarkers();
    this._initInput();
    this.setGraphics(this.settings.graphics || {});
    this._startLoop();
  }

  /* ================= renderer / graph bootstrap ================= */

  _initRenderer(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gpu = JewelScene._gpuName(this.renderer);
    let mobile = false;
    try {
      mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
    } catch {
      /* non-fatal */
    }
    this.detected = detectPreset(this.gpu, { mobile });

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      if (this.onContextLost) {
        try {
          this.onContextLost();
        } catch {
          /* host callback must not break the loop */
        }
      }
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // The browser restores the same canvas context; force three.js to
      // re-upload every GPU resource from the retained CPU-side descriptors.
      this._contextLost = false;
      this.renderer.compile(this.scene, this.camera);
      this._lastFrame = 0;
    });
  }

  static _gpuName(r) {
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch {
      return '';
    }
  }

  _initSceneGraph() {
    this.scene = new THREE.Scene();
    // Background via the scene (not the clear colour) so post targets match.
    this.scene.background = new THREE.Color('#1a1226');
    this.scene.fog = new THREE.FogExp2('#4a2c5a', 0.028);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 200);
    this.camera.position.set(0, 10, 10);
    this._camSpring = {
      pos: new THREE.Vector3(0, 10, 10),
      posVel: new THREE.Vector3(),
      look: new THREE.Vector3(0, 0, 0),
      lookVel: new THREE.Vector3(),
      targetPos: new THREE.Vector3(0, 10, 10),
      targetLook: new THREE.Vector3(0, 0, 0),
    };

    // Light rig: one dominant warm key, soft cool fill, ambient base.
    this.keyLight = new THREE.DirectionalLight('#ffb36b', 2.4);
    this.keyLight.position.set(6, 10, 4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.left = -8;
    this.keyLight.shadow.camera.right = 8;
    this.keyLight.shadow.camera.top = 8;
    this.keyLight.shadow.camera.bottom = -8;
    this.keyLight.shadow.camera.far = 40;
    this.keyLight.shadow.bias = -0.0008;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.castShadow = false;
    this.scene.add(this.keyLight, this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight('#7a6cff', 0.55);
    this.fillLight.position.set(-6, 5, -3);
    this.scene.add(this.fillLight);

    this.ambient = new THREE.AmbientLight('#5c4a7a', 0.5);
    this.scene.add(this.ambient);

    // Hemisphere fill: cool sky above, warm bounce from the workbench below.
    this.hemi = new THREE.HemisphereLight('#7a6cff', '#6b4a2f', 0.35);
    this.scene.add(this.hemi);

    // Image-based lighting (neutral studio room, prefiltered once) for reflections.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
      pmrem.dispose();
    } catch {
      this.envTexture = null;
    }

    this.envGroup = new THREE.Group(); // environment modules
    this.boardGroup = new THREE.Group(); // cells, frame, blockers
    this.jewelGroup = new THREE.Group(); // active pieces
    this.markerGroup = new THREE.Group(); // selection/ghosts/cursor/hints
    this.fxGroup = new THREE.Group(); // beams, flashes
    this.scene.add(this.envGroup, this.boardGroup, this.jewelGroup, this.markerGroup, this.fxGroup);
  }

  /* ================= environment (procedural workshop) ================= */

  _initEnvironment() {
    if (!gemGeos) gemGeos = buildGemGeometries();
    const rng = new Rng(fnv1a('jc-env'));

    // Sky dome: canvas gradient texture (deterministic, tiny).
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 2;
    this.skyCanvas.height = 256;
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    const skyGeo = new THREE.SphereGeometry(80, 24, 16);
    this.skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ map: this.skyTex, side: THREE.BackSide, fog: false }));
    this.envGroup.add(this.skyMesh);

    // Stars (seeded hemisphere points).
    const starCount = 260;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const a = rng.next() * TWO_PI;
      const el = 0.12 + rng.next() * 1.35;
      const r = 72;
      starPos[i * 3] = Math.cos(a) * Math.cos(el) * r;
      starPos[i * 3 + 1] = Math.sin(el) * r;
      starPos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: '#fff4e0', size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0.85, fog: false })
    );
    this.envGroup.add(this.stars);

    // Workbench slab.
    this.table = new THREE.Mesh(
      new THREE.CylinderGeometry(11, 12.5, 1.4, 28),
      new THREE.MeshStandardMaterial({ color: '#6b4a2f', roughness: 0.8, metalness: 0.05, envMapIntensity: 0.12 })
    );
    this.table.position.y = -0.78;
    this.table.receiveShadow = true;
    this.envGroup.add(this.table);

    // Rim under the slab.
    this.tableRim = new THREE.Mesh(
      new THREE.TorusGeometry(11.6, 0.22, 8, 40),
      new THREE.MeshStandardMaterial({ color: '#c9973f', roughness: 0.4, metalness: 0.6, envMapIntensity: 0.7 })
    );
    this.tableRim.rotation.x = Math.PI / 2;
    this.tableRim.position.y = -0.12;
    this.envGroup.add(this.tableRim);

    // Hanging lamps: cord + warm emissive bulb, seeded heights/angles.
    this.lamps = [];
    const lampCount = 5;
    for (let i = 0; i < lampCount; i++) {
      const a = (i / lampCount) * TWO_PI + 0.5;
      const r = 8.0 + rng.next() * 1.8;
      const y = 5.6 + rng.next() * 2.0;
      const lamp = new THREE.Group();
      const cord = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 6, 4),
        new THREE.MeshStandardMaterial({ color: '#2c2033', roughness: 0.9 })
      );
      cord.position.y = 3;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 12, 10),
        new THREE.MeshStandardMaterial({ color: '#ffd9a0', emissive: '#ffb36b', emissiveIntensity: 2.2, roughness: 0.5 })
      );
      lamp.add(cord, bulb);
      lamp.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      lamp.userData.phase = rng.next() * TWO_PI;
      this.envGroup.add(lamp);
      this.lamps.push(lamp);
    }

    // Gem clusters scattered on the table (reused gem geometry; seeded).
    this.props = new THREE.Group();
    const propMats = makeGemMaterials(['#e5484d', '#f76b15', '#ffd60a', '#46a758', '#3e9bde', '#9b5de5', '#f2e9e4']);
    for (let i = 0; i < 14; i++) {
      const a = rng.next() * TWO_PI;
      const r = 8.2 + rng.next() * 2.2;
      const g = new THREE.Mesh(gemGeos[i % 7], propMats[(i * 3 + 1) % 7]);
      const s = 0.5 + rng.next() * 0.7;
      g.scale.setScalar(s);
      g.position.set(Math.cos(a) * r, -0.05 + 0.2 * s, Math.sin(a) * r);
      g.rotation.set(rng.next() * 0.6, rng.next() * TWO_PI, rng.next() * 0.6);
      g.castShadow = true;
      this.props.add(g);
    }
    this.envGroup.add(this.props);

    // Drifting dust motes.
    const dustCap = DUST_COUNT.high;
    this.dustPos = new Float32Array(dustCap * 3);
    this.dustSeed = new Float32Array(dustCap * 2);
    for (let i = 0; i < dustCap; i++) {
      this.dustPos[i * 3] = (rng.next() - 0.5) * 18;
      this.dustPos[i * 3 + 1] = rng.next() * 6 + 0.4;
      this.dustPos[i * 3 + 2] = (rng.next() - 0.5) * 18;
      this.dustSeed[i * 2] = rng.next() * TWO_PI;
      this.dustSeed[i * 2 + 1] = 0.5 + rng.next();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3).setUsage(THREE.DynamicDrawUsage));
    dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 20);
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: '#ffcf9e', size: 0.05, transparent: true, opacity: 0.55, depthWrite: false })
    );
    this.envGroup.add(this.dust);
    this._dustTime = 0;

    // Procedural surface detail (applied when graphics `detail` is detailed).
    const texRng = new Rng(fnv1a('jc-tex'));
    this.tex = {
      wood: woodTexture(texRng),
      tile: tileTexture(texRng),
      brushed: brushedTexture(texRng),
    };

    // Idle gem glints: a few four-point stars that twinkle on random jewels.
    this.glintPos = new Float32Array(GLINT_CAP * 3);
    this.glintCol = new Float32Array(GLINT_CAP * 3);
    this.glintLife = new Float32Array(GLINT_CAP);
    for (let i = 0; i < GLINT_CAP; i++) {
      this.glintPos[i * 3 + 1] = -1000;
      this.glintLife[i] = -rng.next() * 2;
    }
    const glintGeo = new THREE.BufferGeometry();
    glintGeo.setAttribute('position', new THREE.BufferAttribute(this.glintPos, 3).setUsage(THREE.DynamicDrawUsage));
    glintGeo.setAttribute('color', new THREE.BufferAttribute(this.glintCol, 3).setUsage(THREE.DynamicDrawUsage));
    glintGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.glints = new THREE.Points(
      glintGeo,
      new THREE.PointsMaterial({ size: 0.42, map: glintTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
    );
    this.glints.frustumCulled = false;
    this.glints.renderOrder = 21;
    this.glints.visible = false;
    this.fxGroup.add(this.glints);
    this._glintCount = 0;

    // Effects pool + beams.
    this.particles = new ParticlePool(this.fxGroup, PARTICLE_CAP.high);
    this._beamGeo = new THREE.BoxGeometry(1, 0.16, 1);
    this._beamMat = new THREE.MeshBasicMaterial({ color: '#fff2cf', transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(this._beamGeo, this._beamMat.clone());
      b.visible = false;
      b.renderOrder = 15;
      this.fxGroup.add(b);
      this.beams.push(b);
    }
  }

  _initMarkers() {
    // Grounded selection ring (lift/pose + rim + marker, never bloom alone).
    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.52, 28),
      new THREE.MeshBasicMaterial({ color: '#ffd28a', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
    );
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.position.y = 0.02;
    this.selRing.visible = false;
    this.selRing.renderOrder = 10;
    this.markerGroup.add(this.selRing);

    // Hover ghost ring.
    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.44, 24),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.02;
    this.hoverRing.visible = false;
    this.markerGroup.add(this.hoverRing);

    // Keyboard cursor marker (square).
    this.cursorMark = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 0.92),
      new THREE.MeshBasicMaterial({ color: '#9fd8ef', transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })
    );
    this.cursorMark.rotation.x = -Math.PI / 2;
    this.cursorMark.position.y = 0.02;
    this.cursorMark.visible = false;
    this.markerGroup.add(this.cursorMark);

    // Hint rings (two) + connecting arrow.
    this.hintRings = [];
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.54, 28),
        new THREE.MeshBasicMaterial({ color: '#7bd88f', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
      );
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.025;
      r.visible = false;
      this.markerGroup.add(r);
      this.hintRings.push(r);
    }

    // Invalid-action flash ring.
    this.badRing = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.56, 28),
      new THREE.MeshBasicMaterial({ color: '#ff7b7b', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    this.badRing.rotation.x = -Math.PI / 2;
    this.badRing.position.y = 0.03;
    this.badRing.visible = false;
    this.markerGroup.add(this.badRing);
  }

  /* ================= public configuration ================= */

  setTheme(theme) {
    this.theme = theme;
    const t = theme;
    // Sky gradient.
    const ctx = this.skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, t.sky.top);
    grad.addColorStop(0.55, t.sky.mid);
    grad.addColorStop(1, t.sky.bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    this.skyTex.needsUpdate = true;
    this.stars.visible = !!t.sky.stars;

    this.scene.fog.color.set(t.fog.color);
    this.scene.fog.density = t.fog.density;
    this.keyLight.color.set(t.light.key);
    this.keyLight.intensity = t.light.keyIntensity;
    this.fillLight.color.set(t.light.fill);
    this.fillLight.intensity = t.light.fillIntensity;
    this.ambient.color.set(t.light.ambient);
    this.ambient.intensity = t.light.ambientIntensity;
    this.hemi.color.set(t.light.fill);
    this.hemi.groundColor.set(t.table.color);
    this._ambientBase = t.light.ambientIntensity;
    this._applyLightBalance();
    this.table.material.color.set(t.table.color);
    this.table.material.roughness = t.table.roughness;
    this.tableRim.material.color.set(t.board.frame);
    this.dust.material.color.set(t.dust);
    for (const lamp of this.lamps) {
      lamp.children[1].material.emissive.set(t.light.key);
    }
    if (this.cellMesh) this._recolorCells();
    if (this.frameStyle) this.setFrame(this.frameStyle);
  }

  setPalette(palette) {
    this.palette = palette;
    if (!this.jewelMats) {
      this.jewelMats = makeGemMaterials(palette);
      if (this.q && this.q.detail === 'detailed') for (const m of this.jewelMats) m.clearcoat = 1;
    } else {
      palette.forEach((hex, i) => {
        const c = new THREE.Color(hex);
        this.jewelMats[i].color.copy(c);
        this.jewelMats[i].emissive.copy(c).multiplyScalar(0.16);
      });
    }
  }

  /* ================= graphics settings ================= */

  /** Apply saved graphics settings (settings.graphics; `{}` = Auto). Live, no reload. */
  setGraphics(saved) {
    const g = resolve(saved || {}, this.detected);
    this.q = g;
    // Shadows: map size per tier; the frustum is fitted to the board in buildBoard.
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) this.keyLight.shadow.mapSize.set(size, size);
    if (this.keyLight.shadow.map) {
      this.keyLight.shadow.map.dispose();
      this.keyLight.shadow.map = null;
    }
    // Image-based reflections.
    this.scene.environment = g.reflections === 'on' ? this.envTexture : null;
    this._applyLightBalance();
    // Particles, dust and idle glints.
    this.particles.setCapacityUsed(PARTICLE_CAP[g.particles]);
    this._dustVisible = DUST_COUNT[g.particles] || 0;
    this.dust.visible = this._dustVisible > 0;
    this._glintCount = GLINT_COUNT[g.particles] || 0;
    // Surface detail: props, wood grain, bevelled tiles, brushed brass, clearcoat.
    const detailed = g.detail === 'detailed';
    this.props.visible = detailed;
    this._setMap(this.table.material, 'map', detailed ? this.tex.wood : null);
    this._setMap(this.tableRim.material, 'roughnessMap', detailed ? this.tex.brushed : null);
    if (this.cellMesh) this._setMap(this.cellMesh.material, 'map', detailed ? this.tex.tile : null);
    if (this.frameMesh) this._setMap(this.frameMesh.material, 'roughnessMap', detailed ? this.tex.brushed : null);
    if (this.jewelMats) for (const m of this.jewelMats) m.clearcoat = detailed ? 1 : 0;
    // Specials glow a little brighter when bloom can pick them up.
    const glow = g.bloom === 'on' ? 1.7 : 1;
    JewelView.bloomMaterial().emissiveIntensity = 0.7 * glow;
    JewelView.prismMaterial().emissiveIntensity = 0.9 * glow;
    this._applyMotion();
    // Materials pick up shadow-map changes on recompile.
    this.scene.traverse((o) => {
      if (o.material && !o.isPoints) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      }
    });
    this.adaptiveScale = 1;
    this._frames = [];
    this.postFailed = false;
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    this.canvas.dataset.gfxPreset = g.preset;
    this.canvas.dataset.gfxAuto = g.auto ? 'true' : 'false';
    document.body.dataset.gfxPreset = g.preset;
    this._applySize();
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(words) {
    const size = this.renderer.getSize(this._v2d || (this._v2d = new THREE.Vector2()));
    const px = [Math.round(size.x * this.pixelRatio), Math.round(size.y * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, words),
      fps: Math.round(this._fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _setMap(mat, slot, tex) {
    if (mat[slot] === tex) return;
    mat[slot] = tex;
    mat.needsUpdate = true;
  }

  // With IBL on, the flat ambient term is trimmed so the board keeps its contrast.
  _applyLightBalance() {
    if (!this.ambient) return;
    const base = this._ambientBase !== undefined ? this._ambientBase : 0.5;
    const ibl = this.q && this.q.reflections === 'on';
    this.ambient.intensity = base * (ibl ? 0.55 : 1);
    this.hemi.intensity = ibl ? 0.3 : 0.45;
  }

  _applyMotion() {
    this._animatedBg = !!this.q && this.q.background === 'animated' && !this.reducedMotion;
    if (!this._animatedBg) {
      for (const lamp of this.lamps) {
        lamp.rotation.z = 0;
        lamp.children[1].material.emissiveIntensity = 2.2;
      }
      this.stars.material.opacity = 0.85;
    }
    if (!this._animatedBg || !this._glintCount) {
      this.glints.visible = false;
      for (let i = 0; i < GLINT_CAP; i++) this.glintPos[i * 3 + 1] = -1000;
    }
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    if (this.composer) {
      this.composer.passes.forEach((p) => p.dispose && p.dispose());
      this.composer.dispose();
    }
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const W = Math.max(1, Math.round(w * pr));
      const H = Math.max(1, Math.round(h * pr));
      const target = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.HalfFloatType,
        samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, W, H);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        const hi = g.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only lamps, glints, specials and specular highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.4, 0.92));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(W, H));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / W, 1 / H);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(1000 / avg)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, +(this.adaptiveScale - 0.1).toFixed(2));
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, +(this.adaptiveScale + 0.05).toFixed(2));
    return before !== this.adaptiveScale;
  }

  setReducedMotion(b) {
    this.reducedMotion = !!b;
    if (this.reducedMotion) this.shake.amp = 0;
    if (this.q) this._applyMotion();
  }

  /** Cosmetic board frame (never touches rules, timing, or information). */
  setFrame(id) {
    this.frameStyle = id || 'standard';
    if (!this.frameMesh) return;
    const m = this.frameMesh.material;
    if (id === 'brass') {
      m.color.set('#d4af37');
      m.metalness = 0.85;
      m.roughness = 0.3;
      m.emissive.set('#000000');
    } else if (id === 'filigree') {
      m.color.set(this.theme ? this.theme.board.frame : '#c9973f');
      m.metalness = 0.6;
      m.roughness = 0.35;
      m.emissive.set('#8a6a20');
      m.emissiveIntensity = 0.35;
    } else {
      m.color.set(this.theme ? this.theme.board.frame : '#c9973f');
      m.metalness = 0.5;
      m.roughness = 0.45;
      m.emissive.set('#000000');
    }
  }

  /** Cosmetic swap/match trail style. */
  setTrail(id) {
    this.trailStyle = id || 'none';
  }

  setCameraPreset(name) {
    this.cameraPreset = CAMERA_PRESETS[name] ? name : 'default';
    this._refitCamera();
  }

  setViewportInsets(insets) {
    this.insets = { left: 0, right: 0, top: 0, bottom: 0, ...(insets || {}) };
    this._refitCamera();
  }

  setPaused(b) {
    this.paused = !!b;
  }

  setHidden(b) {
    this.hidden = !!b;
    if (this.hidden) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else {
      this._lastFrame = 0;
      this._startLoop();
    }
  }

  getStats() {
    const info = this.renderer.info.render;
    return { fps: Math.round(this._fps), calls: info.calls, triangles: info.triangles };
  }

  resize() {
    this._applySize();
    this._refitCamera();
  }

  _applySize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this._applyPixelRatio();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.width) this._refitCamera();
  }

  /** Pixel ratio = min(dpr, preset cap) × preset/render scale × adaptive scale. */
  _applyPixelRatio() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const q = this.q || { dprCap: 1, scale: 1 };
    const dpr = Math.min(window.devicePixelRatio || 1, q.dprCap) * q.scale * this.adaptiveScale;
    this.pixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this._size = [w, h];
  }

  /**
   * Frame the board inside the safe rect (canvas minus the DOM insets,
   * applied through a view offset so the board is centred in the free area).
   */
  _refitCamera() {
    if (!this.width) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // Safe rect = canvas minus the DOM insets, applied asymmetrically through a
    // camera view offset so the board is centred in the uncovered area.
    const ins = this.insets;
    const safeW = Math.max(160, w - ins.left - ins.right);
    const safeH = Math.max(160, h - ins.top - ins.bottom);
    const offX = Math.min(ins.left, w - safeW), offY = Math.min(ins.top, h - safeH);
    this.camera.aspect = safeW / safeH;
    this.camera.setViewOffset(safeW, safeH, -offX, -offY, w, h);
    this.camera.updateProjectionMatrix();

    const preset = CAMERA_PRESETS[this.cameraPreset || 'default'];
    const pitch = preset.pitch;
    const yaw = preset.yaw;

    const boardW = this.width * CELL;
    const boardD = this.height * CELL;
    // Projected vertical extent of the tilted board, plus jewel height.
    const projH = boardD * Math.sin(pitch) + 1.0;
    const projW = boardW;
    const vfov = (CAMERA_FOV * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (safeW / safeH));
    const distV = (projH / 2) * FIT_MARGIN / Math.tan(vfov / 2);
    const distH = (projW / 2) * FIT_MARGIN / Math.tan(hfov / 2);
    let dist = Math.max(distV, distH);

    // Refine against the actual projection: the near edge of the tilted
    // board sits closer to the camera and spreads wider than the centre-
    // distance estimate, which crops the outer columns on narrow viewports.
    const probe = this._probeCam || (this._probeCam = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 200));
    probe.aspect = safeW / safeH;
    probe.updateProjectionMatrix();
    const look = new THREE.Vector3(0, 0, boardD * 0.06);
    const corners = [];
    for (const x of [-boardW / 2 - 0.4, boardW / 2 + 0.4]) for (const z of [-boardD / 2 - 0.4, boardD / 2 + 0.4]) for (const y of [0, 0.9]) corners.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    for (let i = 0; i < 10; i++) {
      probe.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
      probe.lookAt(look);
      probe.updateMatrixWorld();
      let worst = 0;
      for (const c of corners) { v.copy(c).project(probe); worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y)); }
      if (worst <= 0.95) break;
      dist *= Math.min(1.5, worst / 0.95 + 0.01);
    }

    const cp = this._camSpring;
    cp.targetPos.set(
      Math.sin(yaw) * Math.cos(pitch) * dist,
      Math.sin(pitch) * dist,
      Math.cos(yaw) * Math.cos(pitch) * dist
    );
    cp.targetLook.set(0, 0, boardD * 0.06); // bias toward the near edge
    // Snap immediately on first build; spring on later refits.
    if (!this._camInit) {
      cp.pos.copy(cp.targetPos);
      cp.look.copy(cp.targetLook);
      this._camInit = true;
    }
  }

  /* ================= board construction ================= */

  buildBoard(state) {
    this.state = state;
    this.width = state.width;
    this.height = state.height;
    this._clearBoard();
    this._buildCells(state);
    this._buildBlockers(state);
    if (!this.jewelMats) this.setPalette(this.settings.__palette || ['#e5484d', '#f76b15', '#ffd60a', '#46a758', '#3e9bde', '#9b5de5', '#f2e9e4']);
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      if (!cell.play || !cell.j || cell.crate) continue;
      const v = this._obtainView();
      v.configure(cell.j.c, cell.j.s, this.jewelMats);
      v.idx = i;
      const p = this._cellPos(i);
      v.group.position.set(p.x, JEWEL_Y, p.z);
      v.group.scale.setScalar(1);
      v.group.visible = true;
      this.viewAt.set(i, v);
    }
    this.selected = -1;
    this.dragFrom = -1;
    this._animating = false;
    this._pendingState = null;
    this._refitCamera();
    // Prewarm shader variants before play (no compile hitches mid-round).
    this.renderer.compile(this.scene, this.camera);
  }

  _clearBoard() {
    for (const v of this.viewAt.values()) this._releaseView(v);
    this.viewAt.clear();
    for (const c of this.crateAt.values()) {
      this.boardGroup.remove(c.mesh);
      if (c.band) this.boardGroup.remove(c.band);
    }
    this.crateAt.clear();
    for (const m of this.iceAt.values()) this.boardGroup.remove(m);
    this.iceAt.clear();
    if (this.cellMesh) {
      this.boardGroup.remove(this.cellMesh);
      this.cellMesh.dispose ? this.cellMesh.dispose() : null;
      this.cellMesh = null;
    }
    if (this.frameMesh) {
      this.boardGroup.remove(this.frameMesh);
      this.frameMesh = null;
    }
    this.tweens.length = 0;
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
  }

  _buildCells(state) {
    const theme = this.theme;
    const count = state.cells.length;
    const geo = new THREE.BoxGeometry(0.94, 0.1, 0.94);
    const detailed = this.q && this.q.detail === 'detailed';
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15, envMapIntensity: 0.2, map: detailed ? this.tex.tile : null });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const cA = new THREE.Color(theme ? theme.board.cellA : '#3d2c50');
    const cB = new THREE.Color(theme ? theme.board.cellB : '#463455');
    const cHole = new THREE.Color('#000000');
    for (let i = 0; i < count; i++) {
      const cell = state.cells[i];
      const p = this._cellPos(i);
      if (cell.play) {
        m4.makeTranslation(p.x, -0.05, p.z);
        mesh.setMatrixAt(i, m4);
        const { x, y } = this._cellXY(i);
        mesh.setColorAt(i, (x + y) % 2 === 0 ? cA : cB);
      } else {
        m4.makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -100, 0);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, cHole);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.cellMesh = mesh;
    this.boardGroup.add(mesh);

    // Frame slab under the playable area.
    const fw = this.width * CELL + 0.9;
    const fd = this.height * CELL + 0.9;
    this.frameMesh = new THREE.Mesh(
      new THREE.BoxGeometry(fw, 0.22, fd),
      new THREE.MeshStandardMaterial({
        color: theme ? theme.board.frame : '#c9973f',
        roughness: 0.45,
        metalness: 0.5,
        envMapIntensity: 0.6,
        roughnessMap: detailed ? this.tex.brushed : null,
      })
    );
    this.frameMesh.position.y = -0.2;
    this.frameMesh.receiveShadow = true;
    this.frameMesh.castShadow = true;
    this._fitShadow();
    this.boardGroup.add(this.frameMesh);
    if (this.frameStyle && this.frameStyle !== 'standard') this.setFrame(this.frameStyle);
  }

  /** Fit the key light's shadow box tightly around the board (plus jewel height). */
  _fitShadow() {
    const half = Math.max(this.width, this.height) * CELL * 0.5 + 1.2;
    const sh = this.keyLight.shadow.camera;
    const dir = this._v1.set(6, 10, 4).normalize();
    this.keyLight.target.position.set(0, 0, 0);
    this.keyLight.position.copy(dir).multiplyScalar(half + 8);
    Object.assign(sh, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: half * 2 + 16 });
    sh.updateProjectionMatrix();
  }

  _recolorCells() {
    if (!this.cellMesh || !this.state) return;
    const cA = new THREE.Color(this.theme.board.cellA);
    const cB = new THREE.Color(this.theme.board.cellB);
    const cHole = new THREE.Color('#000000');
    for (let i = 0; i < this.state.cells.length; i++) {
      const cell = this.state.cells[i];
      const { x, y } = this._cellXY(i);
      this.cellMesh.setColorAt(i, cell.play ? ((x + y) % 2 === 0 ? cA : cB) : cHole);
    }
    if (this.cellMesh.instanceColor) this.cellMesh.instanceColor.needsUpdate = true;
    this.frameMesh.material.color.set(this.theme.board.frame);
  }

  _buildBlockers(state) {
    const crateGeo = new THREE.BoxGeometry(0.9, 0.62, 0.9);
    const crateMat = new THREE.MeshStandardMaterial({ color: CRATE_COLOR, roughness: 0.85, metalness: 0.02 });
    const bandGeo = new THREE.BoxGeometry(0.96, 0.14, 0.96);
    const bandMat = new THREE.MeshStandardMaterial({ color: CRATE_BAND, roughness: 0.5, metalness: 0.4 });
    const iceGeo = new THREE.BoxGeometry(0.97, 0.78, 0.97);
    const iceMat = new THREE.MeshStandardMaterial({
      color: ICE_COLOR,
      transparent: true,
      opacity: 0.42,
      roughness: 0.15,
      metalness: 0,
      depthWrite: false,
    });
    const ice2Mat = iceMat.clone();
    ice2Mat.opacity = 0.62;
    this._iceMats = { 1: iceMat, 2: ice2Mat };
    this._crateMat = crateMat;
    this._crateGeo = crateGeo;
    this._bandGeo = bandGeo;
    this._bandMat = bandMat;
    this._iceGeo = iceGeo;

    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      if (!cell.play) continue;
      const p = this._cellPos(i);
      if (cell.crate > 0) {
        const mesh = new THREE.Mesh(crateGeo, crateMat);
        mesh.position.set(p.x, 0.26, p.z);
        mesh.castShadow = true;
        this.boardGroup.add(mesh);
        let band = null;
        if (cell.crate >= 2) {
          band = new THREE.Mesh(bandGeo, bandMat);
          band.position.set(p.x, 0.26, p.z);
          this.boardGroup.add(band);
        }
        this.crateAt.set(i, { mesh, band });
      }
      if (cell.ice > 0 && cell.j) {
        const mesh = new THREE.Mesh(iceGeo, this._iceMats[Math.min(2, cell.ice)]);
        mesh.position.set(p.x, JEWEL_Y, p.z);
        this.boardGroup.add(mesh);
        this.iceAt.set(i, mesh);
      }
    }
  }

  /* ================= coordinate helpers ================= */

  _cellXY(i) {
    return { x: i % this.width, y: Math.floor(i / this.width) };
  }

  _cellPos(i) {
    const x = i % this.width;
    const y = Math.floor(i / this.width);
    return {
      x: (x - (this.width - 1) / 2) * CELL,
      z: (y - (this.height - 1) / 2) * CELL,
    };
  }

  _idxAt(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  /** Project a cell to CSS pixels (shared layout model for DOM anchors). */
  projectCell(x, y) {
    const i = this._idxAt(x, y);
    const p = this._cellPos(i);
    this._v1.set(p.x, JEWEL_Y, p.z).project(this.camera);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return { x: (this._v1.x * 0.5 + 0.5) * w, y: (-this._v1.y * 0.5 + 0.5) * h };
  }

  /* ================= view pooling ================= */

  _obtainView() {
    const v = this.viewPool.pop() || new JewelView(this.jewelGroup);
    if (v.group.parent !== this.jewelGroup) this.jewelGroup.add(v.group);
    v.group.visible = true;
    v.group.scale.setScalar(1);
    v.group.rotation.set(0, 0, 0);
    return v;
  }

  _releaseView(v) {
    v.group.visible = false;
    v.idx = -1;
    this.jewelGroup.remove(v.group);
    if (this.viewPool.length < 96) this.viewPool.push(v);
  }

  /* ================= exact reconciliation ================= */

  /**
   * syncToState — make every visible object match the rules state exactly.
   * Idempotent; also the fast-forward target of skipSettle().
   */
  syncToState(state) {
    if (!state || state.width !== this.width || state.height !== this.height) return;
    this.state = state;
    const seen = new Set();
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      const want = cell.play && cell.j && !cell.crate ? cell.j : null;
      let v = this.viewAt.get(i) || null;
      if (want) {
        if (!v) {
          v = this._obtainView();
          v.idx = i;
          this.viewAt.set(i, v);
          const p = this._cellPos(i);
          v.group.position.set(p.x, JEWEL_Y, p.z);
        }
        v.configure(want.c, want.s, this.jewelMats);
        v.group.visible = true;
        v.group.scale.setScalar(1);
        seen.add(i);
      } else if (v) {
        this.viewAt.delete(i);
        this._releaseView(v);
      }
      // Ice overlays track state.
      const iced = cell.play && cell.j && !cell.crate && cell.ice > 0;
      const hasIce = this.iceAt.get(i);
      if (iced && !hasIce) {
        const mesh = new THREE.Mesh(this._iceGeo, this._iceMats[Math.min(2, cell.ice)]);
        const p = this._cellPos(i);
        mesh.position.set(p.x, JEWEL_Y, p.z);
        this.boardGroup.add(mesh);
        this.iceAt.set(i, mesh);
      } else if (iced && hasIce) {
        hasIce.material = this._iceMats[Math.min(2, cell.ice)];
        hasIce.visible = true;
      } else if (!iced && hasIce) {
        this.boardGroup.remove(hasIce);
        this.iceAt.delete(i);
      }
      // Crates track state (they only ever break).
      const c = this.crateAt.get(i);
      if (c && cell.crate <= 0) {
        this.boardGroup.remove(c.mesh);
        if (c.band) this.boardGroup.remove(c.band);
        this.crateAt.delete(i);
      } else if (c && c.band && cell.crate < 2) {
        this.boardGroup.remove(c.band);
        c.band = null;
      }
    }
    for (const [i, v] of [...this.viewAt]) {
      if (!seen.has(i)) {
        this.viewAt.delete(i);
        this._releaseView(v);
      }
    }
    // Selection may point at a vanished jewel.
    if (this.selected >= 0 && !this.viewAt.has(this.selected)) this._setSelected(-1);
  }

  /* ================= event scheduling ================= */

  /**
   * playEvents — turn one deterministic event stream into a scheduled
   * cosmetic timeline. Every path ends with an exact syncToState + onSettled.
   */
  playEvents(events, state, { fast } = {}) {
    if (!this.state) return;
    this._pendingState = state;
    this._animating = true;
    const mult = fast ? FAST_MULTIPLIER : 1;
    let cursor = this._clock() + 0.03; // absolute timeline (performance clock)
    let cat = null;
    let catDur = 0;
    const openSlot = (c, dur) => {
      if (cat !== c) {
        cursor += catDur;
        cat = c;
        catDur = dur;
      } else if (dur > catDur) {
        catDur = dur;
      }
    };
    let celebrated = false;

    for (const e of events) {
      switch (e.t) {
        case 'swap': {
          openSlot('swap', SLOT.swap * mult);
          this._animSwap(e.a, e.b, cursor, SLOT.swap * mult, false);
          break;
        }
        case 'swap-back': {
          openSlot('swap', SLOT.swapBack * mult);
          this._animSwap(e.a, e.b, cursor, SLOT.swapBack * mult, true);
          break;
        }
        case 'match': {
          openSlot('burst', SLOT.burst * mult);
          for (const g of e.groups) {
            for (const i of g.cells) {
              const v = this.viewAt.get(i);
              if (v) this._tweenScale(v.group, cursor, 0.12, 1.22, easeOutCubic, true);
            }
          }
          if (!this.reducedMotion && e.cascade > 1) this._addShake(SHAKE_TIERS.combo, 0.25);
          break;
        }
        case 'remove': {
          openSlot('burst', SLOT.burst * mult);
          const v = this.viewAt.get(e.idx);
          const p = this._cellPos(e.idx);
          if (v) {
            this.viewAt.delete(e.idx);
            this._animRemove(v, cursor + 0.05, 0.22 * mult);
          }
          const color = this.palette ? this.palette[e.c] || '#ffffff' : '#ffffff';
          this._burst(p.x, JEWEL_Y + 0.1, p.z, color, 8, 1.6);
          break;
        }
        case 'blast': {
          openSlot('burst', SLOT.burst * mult);
          this._animBlast(e, cursor);
          if (!this.reducedMotion) this._addShake(e.s === SPECIAL.PRISM || e.s === SPECIAL.BLOOM ? SHAKE_TIERS.combo : SHAKE_TIERS.move, 0.22);
          break;
        }
        case 'crack': {
          openSlot('burst', SLOT.burst * mult);
          const mesh = this.iceAt.get(e.idx);
          if (mesh) mesh.material = this._iceMats[Math.max(1, Math.min(2, e.ice))] || mesh.material;
          const p = this._cellPos(e.idx);
          this._burst(p.x, JEWEL_Y + 0.2, p.z, ICE_COLOR, 6, 1.2);
          break;
        }
        case 'damage': {
          openSlot('burst', SLOT.burst * mult);
          const c = this.crateAt.get(e.idx);
          if (c) this._tweenShakeMesh(c.mesh, cursor, 0.2);
          break;
        }
        case 'crate-break': {
          openSlot('burst', SLOT.burst * mult);
          const c = this.crateAt.get(e.idx);
          if (c) {
            this.crateAt.delete(e.idx);
            this._animCrateBreak(c, cursor);
            const p = this._cellPos(e.idx);
            this._burst(p.x, 0.4, p.z, CRATE_COLOR, 10, 1.8);
          }
          break;
        }
        case 'create': {
          openSlot('burst', SLOT.burst * mult);
          const v = this.viewAt.get(e.idx);
          if (v) {
            this._tweenScale(v.group, cursor + 0.05, 0.22 * mult, 1.35, easeOutBack, true, () => {
              v.configure(e.c, e.s, this.jewelMats);
            });
          }
          const p = this._cellPos(e.idx);
          this._burst(p.x, JEWEL_Y + 0.25, p.z, '#fff2cf', 12, 2.0);
          break;
        }
        case 'fall': {
          const { y: fy } = this._cellXY(e.from);
          const { y: ty } = this._cellXY(e.to);
          const dist = Math.abs(ty - fy);
          const dur = Math.min(SLOT.gravityMax, (SLOT.gravityBase + SLOT.gravityPerCell * dist)) * mult;
          openSlot('gravity', dur);
          this._animFall(e.from, e.to, cursor, dur);
          break;
        }
        case 'spawn': {
          const dur = Math.min(SLOT.gravityMax, (SLOT.gravityBase + SLOT.gravityPerCell * 2)) * mult;
          openSlot('gravity', dur);
          this._animSpawn(e.idx, e.c, e.s, cursor, dur, e.materialize);
          break;
        }
        case 'shuffle': {
          openSlot('shuffle', SLOT.shuffle * mult);
          this._animShuffle(e.cells, cursor, SLOT.shuffle * mult, state);
          break;
        }
        case 'prism-swap': {
          openSlot('burst', SLOT.burst * mult * 1.4);
          this._flashWhite(cursor);
          if (!this.reducedMotion) this._addShake(SHAKE_TIERS.round, 0.3);
          break;
        }
        case 'end': {
          openSlot('meta', SLOT.meta);
          if (e.reason === 'goals-complete' && !celebrated) {
            celebrated = true;
            this._celebrate(cursor);
          }
          break;
        }
        default:
          break; // goal / turn / reject / undo — HUD & audio surfaces
      }
    }
    cursor += catDur;

    // Settle exactly when the timeline completes (timers, not frame counts).
    if (this._settleTimer) clearTimeout(this._settleTimer);
    const settleInMs = Math.max(0, (cursor - this._clock()) * 1000);
    this._settleTimer = setTimeout(() => this._finalize(), settleInMs + 20);
  }

  _finalize() {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    const st = this._pendingState;
    this.tweens.length = 0;
    if (st) this.syncToState(st);
    this._pendingState = null;
    this._animating = false;
    this._resetTransientPose();
    if (this.onSettled) {
      try {
        this.onSettled();
      } catch (err) {
        console.error('[scene] onSettled', err);
      }
    }
  }

  /** Fast-forward: every object jumps to the deterministic end state. */
  skipSettle() {
    if (!this._animating) return;
    this._finalize();
  }

  _resetTransientPose() {
    // After settling, every jewel rests at its cell position at unit scale.
    for (const [i, v] of this.viewAt) {
      const p = this._cellPos(i);
      v.group.position.set(p.x, JEWEL_Y, p.z);
      v.group.scale.setScalar(1);
    }
    this._setSelected(this.selected); // refresh ring position
  }

  /* ================= individual animations ================= */

  _tween(obj) {
    this.tweens.push(obj);
  }

  /**
   * Position tween with lazy start-pose capture: the first apply() reads the
   * current position, so chained tweens compose without cumulative lerp and
   * every path converges to the exact target.
   */
  _tweenPosition(group, t0, dur, to, ease, onDone) {
    let from = null;
    this._tween({
      t0,
      dur,
      apply: (t) => {
        if (!from) from = { x: group.position.x, y: group.position.y, z: group.position.z };
        const k = (ease || easeInOutQuad)(t);
        group.position.set(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k);
      },
      onDone: () => {
        group.position.set(to.x, to.y, to.z);
        if (onDone) onDone();
      },
    });
  }

  _tweenScale(group, t0, dur, peak, ease, yoyo, onMid) {
    let from = null;
    this._tween({
      t0,
      dur: yoyo ? dur * 2 : dur,
      apply: (t) => {
        if (from === null) from = group.scale.x;
        const k = yoyo ? (t < 0.5 ? ease(t * 2) : ease(2 - t * 2)) : ease(t);
        group.scale.setScalar(from + (peak - from) * k);
      },
      onMid: onMid || null,
      onDone: yoyo
        ? () => group.scale.setScalar(1)
        : null,
    });
  }

  _tweenShakeMesh(mesh, t0, dur) {
    const base = mesh.position.x;
    this._tween({
      t0,
      dur,
      apply: (t) => {
        const decay = 1 - t;
        mesh.position.x = base + Math.sin(t * 40) * 0.05 * decay;
      },
      onDone: () => {
        mesh.position.x = base;
      },
    });
  }

  _animSwap(a, b, t0, dur, isBack) {
    const va = this.viewAt.get(a);
    const vb = this.viewAt.get(b);
    if (!va || !vb) return;
    const pa = this._cellPos(a);
    const pb = this._cellPos(b);
    if (isBack) {
      // No-match: slide over and back (jewels never change ownership).
      this._tweenPosition(va.group, t0, dur * 0.45, { x: pb.x, y: JEWEL_Y, z: pb.z }, easeInOutQuad);
      this._tweenPosition(va.group, t0 + dur * 0.5, dur * 0.45, { x: pa.x, y: JEWEL_Y, z: pa.z }, easeInOutQuad);
      this._tweenPosition(vb.group, t0, dur * 0.45, { x: pa.x, y: JEWEL_Y, z: pa.z }, easeInOutQuad);
      this._tweenPosition(vb.group, t0 + dur * 0.5, dur * 0.45, { x: pb.x, y: JEWEL_Y, z: pb.z }, easeInOutQuad);
    } else {
      this._tweenPosition(va.group, t0, dur, { x: pb.x, y: JEWEL_Y, z: pb.z }, easeInOutQuad);
      this._tweenPosition(vb.group, t0, dur, { x: pa.x, y: JEWEL_Y, z: pa.z }, easeInOutQuad);
      this.viewAt.set(a, vb);
      this.viewAt.set(b, va);
      va.idx = b;
      vb.idx = a;
    }
  }

  _animRemove(view, t0, dur) {
    const g = view.group;
    this._tween({
      t0,
      dur,
      apply: (t) => {
        const s = Math.max(0.001, 1 - easeInOutQuad(t));
        g.scale.setScalar(s);
        g.rotation.y += 0.12;
      },
      onDone: () => {
        g.scale.setScalar(1);
        g.rotation.y = 0;
        this._releaseView(view);
      },
    });
  }

  _animFall(from, to, t0, dur) {
    const v = this.viewAt.get(from);
    if (!v) return;
    this.viewAt.delete(from);
    this.viewAt.set(to, v);
    v.idx = to;
    const p = this._cellPos(to);
    // Slight vertical arc so falls read as drops, not slides.
    let startPos = null;
    this._tween({
      t0,
      dur,
      apply: (t) => {
        if (!startPos) startPos = { x: v.group.position.x, y: v.group.position.y, z: v.group.position.z };
        const k = easeOutCubic(t);
        v.group.position.x = startPos.x + (p.x - startPos.x) * Math.min(1, k * 1.6);
        v.group.position.z = startPos.z + (p.z - startPos.z) * k;
        v.group.position.y = JEWEL_Y + Math.sin(Math.PI * Math.min(1, k)) * 0.12 * (1 - k);
      },
      onDone: () => {
        v.group.position.set(p.x, JEWEL_Y, p.z);
      },
    });
  }

  _animSpawn(idx, color, special, t0, dur, materialize) {
    const v = this._obtainView();
    v.configure(color, special || SPECIAL.NONE, this.jewelMats);
    v.idx = idx;
    this.viewAt.set(idx, v);
    const p = this._cellPos(idx);
    const startZ = p.z - (materialize ? 2.2 : 1.2) * CELL;
    v.group.position.set(p.x, JEWEL_Y + 1.6, startZ);
    this._tweenPosition(v.group, t0, dur, { x: p.x, y: JEWEL_Y, z: p.z }, easeOutCubic);
  }

  _animBlast(e, t0) {
    // Beam flash across the affected line/area + particles along the path.
    const origin = this._cellPos(e.idx);
    const beam = this.beams.find((b) => !b.visible);
    if (beam) {
      beam.visible = true;
      beam.material.opacity = 0.85;
      beam.material.color.set(e.s === SPECIAL.PRISM ? '#ffffff' : '#fff2cf');
      if (e.s === SPECIAL.RAY_H) {
        beam.scale.set(this.width * CELL, 1, 0.5);
        beam.position.set(0, JEWEL_Y, origin.z);
      } else if (e.s === SPECIAL.RAY_V) {
        beam.scale.set(0.5, 1, this.height * CELL);
        beam.position.set(origin.x, JEWEL_Y, 0);
      } else if (e.s === SPECIAL.BLOOM) {
        beam.scale.set(3 * CELL, 1.6, 3 * CELL);
        beam.position.set(origin.x, JEWEL_Y, origin.z);
      } else {
        beam.scale.set(this.width * CELL, 1.4, this.height * CELL);
        beam.position.set(0, JEWEL_Y + 0.3, 0);
      }
      this._tween({
        t0,
        dur: 0.3,
        apply: (t) => {
          beam.material.opacity = 0.85 * (1 - t);
        },
        onDone: () => {
          beam.visible = false;
        },
      });
    }
    if (e.hits) {
      for (const h of e.hits) {
        const p = this._cellPos(h);
        this._burst(p.x, JEWEL_Y + 0.1, p.z, '#fff2cf', 3, 1.4);
      }
    }
  }

  _animCrateBreak(c, t0) {
    const mesh = c.mesh;
    const band = c.band;
    this._tween({
      t0,
      dur: 0.25,
      apply: (t) => {
        const s = Math.max(0.001, 1 - t);
        mesh.scale.setScalar(s);
        mesh.rotation.y = t * 1.5;
        if (band) band.scale.setScalar(s);
      },
      onDone: () => {
        this.boardGroup.remove(mesh);
        if (band) this.boardGroup.remove(band);
        mesh.scale.setScalar(1);
        mesh.rotation.y = 0;
      },
    });
  }

  _animShuffle(cells, t0, dur, finalState) {
    for (const i of cells) {
      const v = this.viewAt.get(i);
      if (!v) continue;
      this._tween({
        t0,
        dur,
        apply: (t) => {
          v.group.rotation.y = t * Math.PI * 3;
          const s = 1 - Math.sin(Math.PI * t) * 0.35;
          v.group.scale.setScalar(s);
        },
        onDone: () => {
          v.group.rotation.y = 0;
          v.group.scale.setScalar(1);
          const cell = finalState.cells[i];
          if (cell && cell.j) v.configure(cell.j.c, cell.j.s, this.jewelMats);
        },
      });
    }
  }

  _flashWhite(t0) {
    const beam = this.beams.find((b) => !b.visible);
    if (!beam) return;
    beam.visible = true;
    beam.material.color.set('#ffffff');
    beam.scale.set(this.width * CELL * 1.4, 2.5, this.height * CELL * 1.4);
    beam.position.set(0, JEWEL_Y + 0.4, 0);
    this._tween({
      t0,
      dur: 0.5,
      apply: (t) => {
        beam.material.opacity = 0.7 * (1 - t);
      },
      onDone: () => {
        beam.visible = false;
      },
    });
  }

  _celebrate(t0) {
    if (this.reducedMotion) return;
    const colors = this.palette || ['#ffd28a'];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TWO_PI;
      this._burst(Math.cos(a) * 2.2, JEWEL_Y + 1.2, Math.sin(a) * 2.2, colors[k % colors.length], 26, 3.2);
    }
    this._addShake(SHAKE_TIERS.round, 0.4);
  }

  _burst(x, y, z, color, count, speed) {
    if (this.reducedMotion) count = Math.min(3, count);
    if (this.q && this.q.particles === 'low') count = Math.floor(count / 2);
    this.particles.burst(x, y, z, color, count, speed, 1);
    // Cosmetic trail variants: spark adds white glints, comet adds slow embers.
    if (this.trailStyle === 'spark') this.particles.burst(x, y + 0.1, z, '#ffffff', Math.ceil(count / 2), speed * 1.7, 0.7);
    else if (this.trailStyle === 'comet') this.particles.burst(x, y + 0.05, z, '#ffb36b', Math.ceil(count / 2), speed * 0.6, 1.3);
  }

  _addShake(amp, dur) {
    if (this.reducedMotion || amp <= 0) return;
    this.shake.amp = Math.max(this.shake.amp, amp);
    this.shake.until = Math.max(this.shake.until, this._clock() + dur);
  }

  /* ================= hints / selection / invalid ================= */

  showHint(mv) {
    this.clearHint();
    if (!mv) return;
    this.hintCells = [this._idxAt(mv.ax, mv.ay), this._idxAt(mv.bx, mv.by)];
    this.hintRings.forEach((r, k) => {
      const i = this.hintCells[k];
      if (i < 0) {
        r.visible = false;
        return;
      }
      const p = this._cellPos(i);
      r.position.x = p.x;
      r.position.z = p.z;
      r.visible = true;
    });
  }

  clearHint() {
    this.hintCells = null;
    for (const r of this.hintRings) r.visible = false;
  }

  flashInvalid(idx, reason) {
    if (idx >= 0) {
      const p = this._cellPos(idx);
      this.badRing.position.x = p.x;
      this.badRing.position.z = p.z;
      this.badRing.visible = true;
      const t0 = this._clock();
      this._tween({
        t0,
        dur: 0.4,
        apply: (t) => {
          this.badRing.material.opacity = 0.9 * (1 - t);
        },
        onDone: () => {
          this.badRing.visible = false;
        },
      });
      const v = this.viewAt.get(idx);
      if (v) this._tweenShakeMesh(v.group, t0, 0.3);
    }
  }

  _setSelected(idx) {
    const changed = idx !== this.selected;
    this.selected = idx;
    if (idx < 0) {
      this.selRing.visible = false;
      return;
    }
    const p = this._cellPos(idx);
    this.selRing.position.x = p.x;
    this.selRing.position.z = p.z;
    this.selRing.visible = true;
    if (changed && typeof this.onSelect === 'function') {
      try {
        this.onSelect(idx);
      } catch {
        /* audio callback must never break input */
      }
    }
  }

  /* ================= keyboard cursor ================= */

  cursorActive() {
    return this.cursor.active;
  }

  cursorShow() {
    if (!this.state) return;
    if (!this.cursor.active) {
      this.cursor.active = true;
      if (this.cursor.x < 0) {
        // First playable cell.
        outer: for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            if (this.state.cells[y * this.width + x].play) {
              this.cursor.x = x;
              this.cursor.y = y;
              break outer;
            }
          }
        }
      }
    }
    this._placeCursor();
  }

  cursorHide() {
    this.cursor.active = false;
    this.cursorMark.visible = false;
  }

  cursorMove(dx, dy) {
    if (!this.state) return;
    this.cursorShow();
    const w = this.width;
    const h = this.height;
    let { x, y } = this.cursor;
    for (let step = 0; step < Math.max(w, h); step++) {
      x = (x + dx + w) % w;
      y = (y + dy + h) % h;
      if (this.state.cells[y * w + x].play) break;
    }
    this.cursor.x = x;
    this.cursor.y = y;
    this._placeCursor();
  }

  _placeCursor() {
    const i = this._idxAt(this.cursor.x, this.cursor.y);
    if (i < 0) return;
    const p = this._cellPos(i);
    this.cursorMark.position.x = p.x;
    this.cursorMark.position.z = p.z;
    this.cursorMark.visible = true;
  }

  /**
   * Keyboard confirm: first press selects the jewel under the cursor; the
   * second press on an adjacent cell swaps; same cell deselects; a distant
   * cell moves selection.
   */
  cursorConfirm() {
    if (!this.state || !this.cursor.active) return;
    const i = this._idxAt(this.cursor.x, this.cursor.y);
    if (i < 0) return;
    if (this.selected < 0) {
      this._setSelected(i);
      return;
    }
    if (this.selected === i) {
      this._setSelected(-1);
      return;
    }
    const a = this._cellXY(this.selected);
    const b = this._cellXY(i);
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) {
      this._commitSwap(this.selected, i);
    } else {
      this._setSelected(i);
    }
  }

  cursorCancel() {
    if (this.selected >= 0) {
      this._setSelected(-1);
      return true;
    }
    return false;
  }

  /* ================= pointer input ================= */

  _initInput() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => this._onDown(e));
    el.addEventListener('pointermove', (e) => this._onMove(e));
    el.addEventListener('pointerup', (e) => this._onUp(e));
    el.addEventListener('pointercancel', (e) => this._onCancel(e));
    el.addEventListener('lostpointercapture', (e) => this._onCancel(e));
  }

  _inputReady() {
    return !!(this.state && !this._animating && !this.paused && !this.hidden && !this._contextLost);
  }

  _cellFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return -1;
    this._ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    // Raycast against the board's math plane; shake is subtracted first so
    // picking truth never depends on camera cosmetics.
    this.camera.position.sub(this._shakeVec());
    this._raycaster.setFromCamera(this._ndc, this.camera);
    this.camera.position.add(this._shakeVec());
    const hit = this._raycaster.ray.intersectPlane(this._plane, this._v1);
    if (!hit) return -1;
    const x = Math.round(hit.x / CELL + (this.width - 1) / 2);
    const y = Math.round(hit.z / CELL + (this.height - 1) / 2);
    const i = this._idxAt(x, y);
    if (i < 0) return -1;
    return i;
  }

  _onDown(e) {
    if (!this._inputReady() || e.button === 2) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported: drag still works within the canvas */
    }
    const i = this._cellFromEvent(e);
    this.pointerDownAt = performance.now();
    this.pointerDownPos.x = e.clientX;
    this.pointerDownPos.y = e.clientY;
    this.dragFrom = i;
    this.dragTarget = -1;
    this._dragCommitted = false;
    if (i >= 0) {
      const p = this._cellPos(i);
      this.hoverRing.position.x = p.x;
      this.hoverRing.position.z = p.z;
      this.hoverRing.visible = true;
    }
  }

  _onMove(e) {
    if (!this.state) return;
    if (this.dragFrom < 0) {
      // Passive hover ghost (fine pointers only; never required).
      if (e.pointerType === 'mouse' && this._inputReady()) {
        const i = this._cellFromEvent(e);
        if (i >= 0) {
          const p = this._cellPos(i);
          this.hoverRing.position.x = p.x;
          this.hoverRing.position.z = p.z;
          this.hoverRing.visible = true;
        } else {
          this.hoverRing.visible = false;
        }
      }
      return;
    }
    if (this._dragCommitted || !this._inputReady()) return;
    // Hold-to-drag setting: when off, only tap-tap swaps commit.
    if (this.settings.input && this.settings.input.holdToDrag === false) return;
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const DRAG_THRESHOLD = 24; // CSS px: beyond this a drag commits directionally
    if (dist < DRAG_THRESHOLD) return;
    const a = this._cellXY(this.dragFrom);
    let bx = a.x;
    let by = a.y;
    if (Math.abs(dx) > Math.abs(dy)) bx += dx > 0 ? 1 : -1;
    else by += dy > 0 ? 1 : -1;
    const target = this._idxAt(bx, by);
    if (target < 0) return;
    this.dragTarget = target;
    this._dragCommitted = true;
    this._commitSwap(this.dragFrom, target);
  }

  _onUp(e) {
    const wasDrag = this._dragCommitted;
    const from = this.dragFrom;
    this.dragFrom = -1;
    this.dragTarget = -1;
    this._dragCommitted = false;
    this.hoverRing.visible = false;
    if (!this._inputReady() || wasDrag || from < 0) return;
    const up = this._cellFromEvent(e);
    const dt = performance.now() - this.pointerDownAt;
    const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (up !== from || moved > 12 || dt > 600) return; // not a tap
    this._tap(from);
  }

  _onCancel() {
    // Lost capture / cancel: drop drag state safely; nothing was committed.
    this.dragFrom = -1;
    this.dragTarget = -1;
    this._dragCommitted = false;
    this.hoverRing.visible = false;
  }

  _tap(i) {
    if (!this.viewAt.has(i)) {
      // Tapped a non-jewel cell (crate/hole/ice-locked): explain via flash.
      if (this.selected >= 0) this._setSelected(-1);
      return;
    }
    if (this.selected < 0) {
      this._setSelected(i);
      return;
    }
    if (this.selected === i) {
      this._setSelected(-1);
      return;
    }
    const a = this._cellXY(this.selected);
    const b = this._cellXY(i);
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) {
      this._commitSwap(this.selected, i);
    } else {
      this._setSelected(i);
    }
  }

  _commitSwap(a, b) {
    if (!this.onSwap) return;
    const pa = this._cellXY(a);
    const pb = this._cellXY(b);
    this._setSelected(-1);
    this.clearHint();
    try {
      this.onSwap(pa.x, pa.y, pb.x, pb.y);
    } catch (err) {
      console.error('[scene] onSwap', err);
    }
  }

  /* ================= frame loop ================= */

  _clock() {
    return performance.now() / 1000;
  }

  _startLoop() {
    if (this._raf || this.hidden || this._disposed) return;
    const loop = () => {
      if (this._disposed || this.hidden) {
        this._raf = 0;
        return;
      }
      this._raf = requestAnimationFrame(loop);
      const now = this._clock();
      const dt = this._lastFrame ? Math.min(0.1, now - this._lastFrame) : 0.016;
      this._lastFrame = now;
      if (dt > 0) this._fps += (1 / dt - this._fps) * 0.06;
      this._update(now, dt);
      this._render(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _render(dt) {
    if (this._adapt(dt * 1000)) this._applyPixelRatio();
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this._size || this._size[0] !== w || this._size[1] !== h) this._applyPixelRatio();
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
      this.canvas.dataset.gfxPost = this.composer ? 'on' : 'off';
    }
    if (this.composer) {
      try {
        this.composer.render(dt);
        return;
      } catch {
        this.postFailed = true;
        this.composer = null;
        this.canvas.dataset.gfxPost = 'off';
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _update(now, dt) {
    // Tweens run on the wall clock; pausing freezes cosmetic time.
    if (!this.paused) {
      const tw = this.tweens;
      for (let i = tw.length - 1; i >= 0; i--) {
        const t = tw[i];
        const k = (now - t.t0) / t.dur;
        if (k < 0) continue;
        const clamped = Math.min(1, k);
        try {
          t.apply(clamped);
        } catch (err) {
          console.error('[scene tween]', err);
        }
        if (t.onMid && !t._midDone && clamped >= 0.5) {
          t._midDone = true;
          t.onMid();
        }
        if (k >= 1) {
          tw.splice(i, 1);
          if (t.onDone) t.onDone();
        }
      }
      this.particles.update(dt);
      this._updateDecor(dt, now);
    }

    // Camera spring (critically damped; interruptible; never cumulative lerp).
    const cp = this._camSpring;
    const w = TWO_PI * CAMERA_SPRING_HZ;
    const k = w * w;
    const d = 2 * w;
    const step = Math.min(dt, 0.05);
    this._springVec(cp.pos, cp.posVel, cp.targetPos, k, d, step);
    this._springVec(cp.look, cp.lookVel, cp.targetLook, k, d, step);
    this.camera.position.copy(cp.pos);
    this.camera.lookAt(cp.look);

    // Camera shake: low-amplitude, event-tiered, never affects raycast math.
    if (this.shake.amp > 0 && now < this.shake.until && !this.reducedMotion) {
      const decay = Math.max(0, (this.shake.until - now) * 4);
      const a = this.shake.amp * Math.min(1, decay);
      this._shake.set(
        (this._fxRng.next() - 0.5) * 2 * a,
        (this._fxRng.next() - 0.5) * 2 * a * 0.6,
        (this._fxRng.next() - 0.5) * 2 * a
      );
    } else {
      this.shake.amp = 0;
      this._shake.set(0, 0, 0);
    }
    this.camera.position.add(this._shake);

    // Selection ring pulse + hint pulse.
    if (this.selRing.visible) {
      const s = 1 + Math.sin(now * 5) * 0.06;
      this.selRing.scale.setScalar(s);
    }
    if (this.hintCells) {
      const s = 1 + Math.sin(now * 6) * 0.1;
      for (const r of this.hintRings) r.scale.setScalar(s);
    }
  }

  _springVec(cur, vel, target, k, d, dt) {
    // Semi-implicit integration of a critically damped spring.
    const ax = (target.x - cur.x) * k - vel.x * d;
    const ay = (target.y - cur.y) * k - vel.y * d;
    const az = (target.z - cur.z) * k - vel.z * d;
    vel.x += ax * dt;
    vel.y += ay * dt;
    vel.z += az * dt;
    cur.x += vel.x * dt;
    cur.y += vel.y * dt;
    cur.z += vel.z * dt;
  }

  _shakeVec() {
    return this._shake;
  }

  _updateDecor(dt, now) {
    // Dust drift (deterministic phases; off with a static background or reduced motion).
    if (this.dust.visible && this._animatedBg) {
      this._dustTime += dt;
      const t = this._dustTime;
      const n = this._dustVisible || DUST_COUNT.high;
      for (let i = 0; i < n; i++) {
        const ph = this.dustSeed[i * 2];
        const sp = this.dustSeed[i * 2 + 1];
        this.dustPos[i * 3] += Math.sin(t * 0.3 * sp + ph) * 0.0016;
        this.dustPos[i * 3 + 1] += Math.cos(t * 0.22 * sp + ph * 1.7) * 0.0011;
        this.dustPos[i * 3 + 2] += Math.cos(t * 0.26 * sp + ph * 0.6) * 0.0016;
      }
      this.dust.geometry.attributes.position.needsUpdate = true;
    }
    // Lamp sway + flicker, star shimmer and idle gem glints.
    if (this._animatedBg) {
      for (const lamp of this.lamps) {
        lamp.rotation.z = Math.sin(now * 0.4 + lamp.userData.phase) * 0.03;
        lamp.children[1].material.emissiveIntensity = 2.0 + Math.sin(now * 3.1 + lamp.userData.phase * 3) * 0.25;
      }
      this.stars.material.opacity = 0.72 + Math.sin(now * 0.9) * 0.13;
      if (this._glintCount) this._updateGlints(dt);
    }
    // Prism aura slow spin (any visible prism overlays).
    for (const v of this.viewAt.values()) {
      if (v.special === SPECIAL.PRISM && v.prismAura.visible) {
        v.prismAura.rotation.y += dt * 1.4;
        v.prismAura.rotation.x += dt * 0.7;
      }
    }
  }

  _updateGlints(dt) {
    const views = this.viewAt.size ? [...this.viewAt.values()] : null;
    let any = false;
    for (let i = 0; i < GLINT_CAP; i++) {
      if (i >= this._glintCount || !views) {
        this.glintPos[i * 3 + 1] = -1000;
        continue;
      }
      this.glintLife[i] += dt;
      const t = this.glintLife[i];
      if (t >= 0.9) {
        // Respawn on a random settled jewel's upper facet after a short rest.
        const v = views[Math.floor(this._decorRng.next() * views.length)];
        const p = v.group.position;
        this.glintPos[i * 3] = p.x + (this._decorRng.next() - 0.5) * 0.3;
        this.glintPos[i * 3 + 1] = p.y + 0.18 + this._decorRng.next() * 0.12;
        this.glintPos[i * 3 + 2] = p.z + (this._decorRng.next() - 0.5) * 0.3;
        this.glintLife[i] = -this._decorRng.next() * 2.5;
      }
      // Fade in and out over 0.9 s; above 1.0 so bloom catches the peak.
      const k = t < 0 ? 0 : Math.sin((Math.min(t, 0.9) / 0.9) * Math.PI);
      const b = k * 1.6;
      this.glintCol[i * 3] = b;
      this.glintCol[i * 3 + 1] = b * 0.96;
      this.glintCol[i * 3 + 2] = b * 0.88;
      if (k > 0) any = true;
    }
    this.glints.visible = any;
    this.glints.geometry.attributes.position.needsUpdate = true;
    this.glints.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this._disposed = true;
    if (this.composer) this.composer.dispose();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._clearBoard();
    this.particles.dispose(this.fxGroup);
    this.renderer.dispose();
  }
}
