/**
 * Jewel Cascade — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *
 *   load → title → Play → mode select → Practice → setup (Easy) → countdown
 *   → active round → hint + undo assists → text-board mirror toggled on →
 *   real swaps by clicking mirror cells (chosen from the rules engine's
 *   legalActions, read-only) → pause → settings from pause → resume →
 *   play until the round ends → results overlay → back to mode select.
 *
 * Runs twice: desktop 1280x800 and mobile 390x844 (touch), the mobile pass
 * using the thumb-tray controls instead of the hidden side rails.
 *
 * The repo's server.js is the StarHermit authoritative script, so this test
 * embeds its own minimal static server on an ephemeral port. The game is
 * designed to run offline: it probes /api/v1/time once at boot, gets a 404
 * from the static server, and continues in offline mode (js/platform.js).
 * That single 404 resource error per pass is expected and filtered out;
 * every other pageerror/console error fails the test.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/jewel-cascade-e2e-${stage}-${vp}.png`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

// Benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs),
// plus the expected one-time 404 from the offline /api/v1/time probe.
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

function createStaticServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(file) || (await fsp.stat(file)).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(await fsp.readFile(file));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
}

const screenVisible = (name) => `[data-screen="${name}"]:not([hidden])`;

async function runPass(browser, vp) {
  const isMobile = vp.name === 'mobile';
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: isMobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (browserNoise.test(m.text()) || /\/api\/v1/.test(url)) return;
    errors.push(`console: ${m.text()} (${url || 'no url'})`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${vp.name}] ${name}`);
  };

  // Visible UI selectors differ per viewport: side rails are hidden drawers
  // on mobile, where the thumb tray carries the same actions.
  const BTN = {
    hint: isMobile ? '#tray-hint' : '#btn-hint',
    undo: isMobile ? '#tray-undo' : '#btn-undo',
    mirror: isMobile ? '#tray-mirror' : '#btn-mirror-toggle',
    pause: isMobile ? '#tray-pause' : '#btn-pause',
  };

  const readGame = () =>
    page.evaluate(() => {
      const jc = window.__jc;
      if (!jc || !jc.session) return null;
      const s = jc.session.state;
      return {
        status: jc.session.status,
        phase: s ? s.phase : null,
        movesLeft: s ? s.movesLeft : null,
        score: s ? s.score : null,
        legal: s ? jc.rules.legalActions(s).length : 0,
      };
    });

  try {
    await step('load + boot → title screen', async () => {
      await page.goto(vp.base, { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector(screenVisible('title'), { timeout: 20000 });
      await page.waitForSelector('#btn-play', { state: 'visible' });
      await page.screenshot({ path: SHOT('title', vp.name) });
    });

    await step('title → mode select', async () => {
      await page.click('#btn-play');
      await page.waitForSelector(screenVisible('mode-select'), { timeout: 5000 });
      await page.screenshot({ path: SHOT('mode-select', vp.name) });
    });

    await step('practice setup (Easy)', async () => {
      await page.click('[data-mode="practice"]');
      await page.waitForSelector(screenVisible('setup'), { timeout: 5000 });
      await page.click('[data-content-id="practice-easy"]');
      await page.waitForFunction(() => !document.getElementById('setup-start').disabled);
      await page.screenshot({ path: SHOT('setup', vp.name) });
      await page.click('#setup-start');
    });

    await step('countdown → round active', async () => {
      await page.waitForFunction(
        () => window.__jc && window.__jc.session.status === 'active' && window.__jc.session.state && window.__jc.session.state.phase === 'ready',
        null,
        { timeout: 20000 },
      );
      await page.waitForSelector(screenVisible('game'), { timeout: 5000 });
      await page.screenshot({ path: SHOT('round-start', vp.name) });
    });

    await step('hint + undo assists work', async () => {
      await page.click(BTN.hint);
      await page.waitForTimeout(300);
      // One real swap via the text board, then undo it.
      await page.click(BTN.mirror);
      await page.waitForSelector('#mirror-panel:not([hidden])');
      const act = await page.evaluate(() => window.__jc.rules.legalActions(window.__jc.session.state)[0]);
      if (!act) throw new Error('no legal swap available at round start');
      const w = await page.evaluate(() => window.__jc.session.state.width);
      await page.click(`[data-cell="${act.ay * w + act.ax}"]`);
      await page.click(`[data-cell="${act.by * w + act.bx}"]`);
      await page.waitForFunction(
        () => window.__jc.session.state.phase === 'ready' && window.__jc.session.status === 'active',
        null,
        { timeout: 20000 },
      );
      const afterSwap = await readGame();
      if (afterSwap.movesLeft === null) throw new Error('no round state after swap');
      await page.screenshot({ path: SHOT('mirror-board', vp.name) });
      // The mirror panel is a full-screen overlay on mobile, so close it
      // before reaching the undo control, then reopen for the play loop.
      await page.click('#btn-mirror-close');
      await page.waitForSelector('#mirror-panel', { state: 'hidden' });
      await page.click(BTN.undo);
      await page.waitForTimeout(400);
      const afterUndo = await readGame();
      if (afterUndo.movesLeft <= afterSwap.movesLeft) {
        throw new Error(`undo did not restore a move (${afterSwap.movesLeft} -> ${afterUndo.movesLeft})`);
      }
    });

    await step('pause → settings → resume', async () => {
      await page.click(BTN.pause);
      await page.waitForSelector(screenVisible('pause'), { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', vp.name) });
      await page.click('#btn-pause-settings');
      await page.waitForSelector(screenVisible('settings'), { timeout: 5000 });
      await page.screenshot({ path: SHOT('settings', vp.name) });
      await page.click('#btn-settings-close');
      await page.waitForSelector('[data-screen="settings"]', { state: 'hidden', timeout: 5000 });
      await page.click('#btn-resume');
      await page.waitForFunction(() => window.__jc.session.status === 'active', null, { timeout: 5000 });
      await page.click(BTN.mirror);
      await page.waitForSelector('#mirror-panel:not([hidden])');
    });

    await step('play swaps through the text board until the round ends', async () => {
      for (let i = 0; i < 45; i++) {
        const st = await readGame();
        if (!st || st.phase === 'ended') break;
        if (st.phase !== 'ready' || st.status !== 'active') {
          await page.waitForTimeout(250);
          continue;
        }
        if (st.legal === 0) throw new Error('round ready but no legal actions');
        const act = await page.evaluate(() => window.__jc.rules.legalActions(window.__jc.session.state)[0]);
        const w = await page.evaluate(() => window.__jc.session.state.width);
        await page.click(`[data-cell="${act.ay * w + act.ax}"]`);
        await page.click(`[data-cell="${act.by * w + act.bx}"]`);
        await page.waitForFunction(
          () => {
            const jc = window.__jc;
            return jc.session.state.phase === 'ended' || (jc.session.state.phase === 'ready' && jc.session.status === 'active');
          },
          null,
          { timeout: 20000 },
        );
        if (i === 2) await page.screenshot({ path: SHOT('mid-round', vp.name) });
      }
      await page.waitForFunction(() => window.__jc.session.state.phase === 'ended', null, { timeout: 20000 });
    });

    await step('results overlay shown', async () => {
      await page.waitForSelector(screenVisible('results'), { timeout: 10000 });
      const headline = await page.textContent('#res-h');
      const score = await page.textContent('#res-score').catch(() => null);
      console.log(`  results: ${headline && headline.trim()}${score ? ' · score ' + score.trim() : ''}`);
      await page.screenshot({ path: SHOT('results', vp.name) });
    });

    await step('results → back to mode select', async () => {
      await page.click('#res-menu');
      await page.waitForSelector(screenVisible('mode-select'), { timeout: 5000 });
      await page.screenshot({ path: SHOT('back-to-modes', vp.name) });
    });
  } finally {
    if (errors.length) {
      throw new Error(`[${vp.name}] console/page errors during pass:\n  ${errors.join('\n  ')}`);
    }
    await context.close();
  }
}

const server = createStaticServer();
let browser = null;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  await runPass(browser, { name: 'desktop', width: 1280, height: 800, base });
  await runPass(browser, { name: 'mobile', width: 390, height: 844, base });

  console.log('PASS - jewel-cascade e2e: full UI playthrough completed on desktop and mobile');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
