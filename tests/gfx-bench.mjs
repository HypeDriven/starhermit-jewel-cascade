// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice (Easy) round and keeps swapping jewels with real mouse clicks on the 3D board — the
// rules engine's first legal swap, located on screen through the scene's own cell projection, like a
// player tapping two neighbours — so cascades, sparks, glints, dust and the post chain run all the time.
// A new round starts from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const visible = (name) => `[data-screen="${name}"]:not([hidden])`;

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-play', { state: 'visible', timeout: 20000 });
  await page.click('.nav-btn[data-nav="settings"]');
  await page.waitForSelector(visible('settings'), { timeout: 5000 });
  if (!(await page.evaluate(() => document.getElementById('set-gfx-group').open))) await page.click('#gfx-title');
  await page.waitForSelector('#gfx-preset', { state: 'visible' });
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('game-canvas').dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForSelector('[data-screen="settings"]', { state: 'hidden', timeout: 5000 });
}

async function startRound(page) {
  await page.click('#btn-play');
  await page.waitForSelector(visible('mode-select'), { timeout: 5000 });
  await page.click('[data-mode="practice"]');
  await page.waitForSelector(visible('setup'), { timeout: 5000 });
  await page.click('[data-content-id="practice-easy"]');
  await page.waitForFunction(() => !document.getElementById('setup-start').disabled);
  await page.click('#setup-start');
  await page.waitForFunction(() => window.__jc?.session.status === 'active' && window.__jc.session.state?.phase === 'ready', null, { timeout: 20000 });
}

async function step(page) {
  const s = await page.evaluate(() => {
    const jc = window.__jc, st = jc.session.state;
    if (!st || st.phase === 'ended') return { ended: true };
    if (jc.session.status !== 'active') return { busy: true };
    if (st.phase !== 'ready') return { busy: true };
    const act = jc.rules.legalActions(st)[0];
    if (!act) return { busy: true };
    const r = document.getElementById('game-canvas').getBoundingClientRect();
    const a = jc.scene.projectCell(act.ax, act.ay), b = jc.scene.projectCell(act.bx, act.by);
    return { a: { x: r.left + a.x, y: r.top + a.y }, b: { x: r.left + b.x, y: r.top + b.y } };
  });
  if (s.ended) {
    if (await page.locator('#res-retry').isVisible()) {
      await page.click('#res-retry', { timeout: 3000 });
      await page.waitForFunction(() => window.__jc?.session.status === 'active', null, { timeout: 20000 }).catch(() => {});
    }
    return;
  }
  if (s.busy) return;
  await page.mouse.click(s.a.x, s.a.y);
  await page.mouse.click(s.b.x, s.b.y);
}

export async function start(page) {
  await startRound(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(250).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
