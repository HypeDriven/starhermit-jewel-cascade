// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, past ~/games/tools/
// engine-web-smoke.mjs's start, at a desktop viewport, a phone (DPR 3) and a
// phone held sideways: Enter on the focused Play opens mode select, Tab and
// Enter open the Journey, Enter on stage 1 and on Start begins the round, the
// countdown runs; on the desktop the board cursor makes a swap by keys, on the
// phones two taps on the board make one, the drawer tab opens the Objective;
// Escape (or the tray's Pause) pauses and Escape resumes. Fails on console
// errors or warnings or the runtime's error screen.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it. playwright-core is
// resolved from GAME_DIR's node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);
const waitMs = Number(opt('--wait', '8000'));

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's clock (platform.serverTime / serverNow), as the game host answers it.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
const dsf = 3;
let failed = false;
const start = [['shot', 'title'], ['key', 'Enter'], ['shot', 'modes'], ['key', 'Tab'], ['key', 'Enter'], ['shot', 'journey'], ['key', 'Enter'], ['shot', 'setup'], ['key', 'Enter'], ['wait', 900], ['shot', 'countdown'], ['wait', 3000], ['shot', 'round']];
const desktop = [...start, ['key', 'ArrowRight'], ['key', 'Enter'], ['key', 'ArrowDown'], ['key', 'Enter'], ['wait', 300], ['shot', 'swapped'], ['key', 'KeyH'], ['shot', 'hint'], ['key', 'Escape'], ['shot', 'paused'], ['key', 'Escape'], ['shot', 'resumed']];
// Phones: two taps on neighbouring cells near the board's middle, the Objective drawer, Pause from the tray / Escape.
const phone = (ax, ay, bx, by, tx, ty) => [...start, ['tap', ax, ay], ['tap', bx, by], ['wait', 300], ['shot', 'swapped'], ['tap', tx, ty], ['shot', 'drawer'], ['tap', tx, ty], ['key', 'Escape'], ['shot', 'paused'], ['key', 'Escape'], ['shot', 'resumed']];
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, steps: desktop },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: dsf, steps: phone(0.44, 0.47, 0.56, 0.47, 0.1, 0.84) },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: dsf, steps: phone(0.55, 0.5, 0.61, 0.5, 0.06, 0.08) },
];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(3000);
  await page.mouse.click(4, 4);
  await page.waitForTimeout(1500);
  for (const [op, a, b] of v.steps) {
    if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(120); await page.keyboard.up(a); }
    if (op === 'down') await page.keyboard.down(a);
    if (op === 'up') await page.keyboard.up(a);
    if (op === 'press') { await page.mouse.move(v.viewport.width * a, v.viewport.height * b); await page.mouse.down(); }
    if (op === 'lift') await page.mouse.up();
    if (op === 'tap') await page.touchscreen.tap(v.viewport.width * a, v.viewport.height * b);
    if (op === 'wait') { await page.waitForTimeout(a); continue; }
    if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
    await page.waitForTimeout(1200);
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
