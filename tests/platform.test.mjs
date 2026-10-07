// Platform over the shared StarHermit SDK: token, profile, cloud save,
// settings KV, controls, invite link and the standalone guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a UMD classic script; under "type": "module" load it as CommonJS by hand.
const sdkModule = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('../js/starhermit-sdk.js', import.meta.url), 'utf8'))(sdkModule, sdkModule.exports);
const SDK = sdkModule.exports;
const { Platform } = await import('../js/platform.js');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => 'h.' + b64u({ sub: 'user-123456789', game_scope: 'gid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

function backend() {
  const calls = [], saves = {}, settings = {}, controls = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers && init.headers.Authorization;
    calls.push({ method, url, body, auth });
    const r = (st, b) => new Response(b, { status: st });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(body.dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/time')) return r(200, JSON.stringify({ now: Date.now() }));
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'pk', nickname: 'Al' }));
    if (/\/settings$/.test(url)) {
      if (method === 'PATCH') Object.assign(settings, body.settings);
      return r(200, JSON.stringify({ settings }));
    }
    if (url.endsWith('/controls')) {
      if (method === 'PUT') { Object.assign(controls, body.bindings); return r(200, '{}'); }
      if (method === 'DELETE') { for (const k of Object.keys(controls)) delete controls[k]; return r(204, null); }
      return r(200, JSON.stringify({ actions: Object.entries(controls).map(([action, codes]) => ({ action, codes })) }));
    }
    return r(404, '');
  };
  return { calls, saves, fetch };
}

function install(hash, fetchImpl, hostname = 'localhost') {
  let replaced = null;
  const loc = { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: 'https://' + hostname + '/' + hash };
  const win = { location: loc, history: { replaceState: (a, b, u) => { replaced = u; } } };
  const sdk = SDK.create({ window: win, fetch: fetchImpl });
  globalThis.window = { StarHermit: sdk, location: loc, localStorage: { getItem: () => null, setItem() {} } };
  globalThis.fetch = fetchImpl;
  return { sdk, replaced: () => replaced };
}

test('launch token: profile, cloud save game:<slug>, settings, controls, invite', async () => {
  const be = backend();
  const { sdk, replaced } = install('#game_token=' + token(), be.fetch);
  const p = new Platform();
  await p.init();
  assert.equal(p.hosted, true);
  assert.equal(p.gameSlug, 'gid-1');
  assert.equal(replaced(), '/');
  assert.equal(p.profile.displayName, 'Al');

  p.queueCloudSave({ journeyUnlocked: 5, _savedAt: '2026-10-03' });
  assert.equal(p.syncState, 'saving');
  await p.flushCloudSave();
  const put = be.calls.find((c) => c.method === 'PUT' && c.url.includes('cloud-saves'));
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:gid-1'));
  assert.equal(p.syncState, 'synced');
  assert.deepEqual((await p.cloudLoad()).doc, { journeyUnlocked: 5, _savedAt: '2026-10-03' });

  p.patchSettings({ audio: { muted: true } });
  await new Promise((r) => setTimeout(r, 10));
  const patch = be.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, '/api/v1/games/gid-1/settings');
  assert.deepEqual(patch.body, { settings: { audio: { muted: true } } });
  assert.deepEqual(await p.getSettings(), { audio: { muted: true } });

  await p.setControl('hint', ['KeyJ']);
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['KeyJ'], undo: ['KeyU'] });
  await p.resetControls();
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });

  assert.ok(p.inviteLink().endsWith('/game-invite/user-123456789/gid-1'));
  assert.ok(be.calls.every((c) => c.auth === 'Bearer ' + sdk.token));

  const sent = [];
  sdk.submitScores = async (sc) => { sent.push(sc); return Object.keys(sc); };
  sdk.leaderboard = async (key) => ({ items: key === 'high-score' ? [{ userId: 'user-123456789', rank: 7 }] : [] });
  assert.deepEqual(await p.submitScore(4321), { posted: true, rank: 7 });
  assert.deepEqual(sent, [{ 'high-score': 4321 }]);
  sdk.submitScores = async () => [];
  assert.deepEqual(await p.submitScore(1), { posted: false, rank: null });
  sdk.signOut();
});

test('standalone: no network calls at all', async () => {
  const urls = [];
  install('', async (u) => { urls.push(String(u)); throw new Error('offline'); });
  const p = new Platform();
  await p.init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), false);
  p.queueCloudSave({ a: 1 });
  await p.flushCloudSave();
  p.patchSettings({ a: 1 });
  assert.deepEqual(await p.getSettings(), {});
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(p.inviteLink(), null);
  assert.equal(await p.syncTime(), false);
  assert.deepEqual((await p.fetchBoards({ board: 'global' })).entries, []);
  assert.equal(await p.cloudLoad(), null);
  assert.deepEqual(await p.submitScore(5000), { posted: false, rank: null });
  assert.deepEqual(urls, []);
});

test('hosted domain without a token offers sign-in', async () => {
  install('', async () => { throw new Error('offline'); }, 'gid-1.starhermit.com');
  const p = new Platform();
  await p.init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true);
});

test('leaderboard line strings in every locale', async () => {
  const { SH_STRINGS } = await import('../js/ui/gfx-i18n.js');
  assert.equal(Object.keys(SH_STRINGS).length, 9);
  for (const [l, t] of Object.entries(SH_STRINGS)) {
    for (const k of ['lbPosting', 'lbRank', 'lbPosted', 'lbNotPosted']) assert.ok(t[k], l + ' ' + k);
    assert.ok(t.lbRank.includes('{rank}'));
  }
});
