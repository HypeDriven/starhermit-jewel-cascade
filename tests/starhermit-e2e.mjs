// E2E helpers: a launch token and a stubbed StarHermit API served through
// page.route, so the signed-in UI can be driven by real clicks offline.
// Missing resources answer 204 (the SDK reads it as null) so the browser logs
// no 404 console errors.
export const launchToken = () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return 'h.' + b64u({ sub: 'user-123456789', game_scope: 'gid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
};

/** Stubs every /api/v1 call; returns the recorded calls. */
export async function stubStarHermit(page, overrides = {}) {
  const calls = [];
  const settings = {};
  let save = null;
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    calls.push(method + ' ' + p);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    for (const [re, fn] of Object.entries(overrides)) {
      if (new RegExp(re).test(method + ' ' + p)) return fn(route, req);
    }
    if (p.includes('/cloud-saves/')) {
      if (method === 'PUT') { save = Buffer.from(JSON.parse(req.postData()).dataBase64, 'base64'); return json(200, {}); }
      return save ? route.fulfill({ status: 200, contentType: 'application/zip', body: save }) : route.fulfill({ status: 204, body: '' });
    }
    if (p === '/api/v1/time') return json(200, { now: Date.now(), serverTime: Date.now(), date: new Date().toISOString().slice(0, 10) });
    if (p.endsWith('/profile')) return json(200, { username: 'pk-1', nickname: 'Al' });
    if (/\/settings$/.test(p)) {
      if (method === 'PATCH') Object.assign(settings, JSON.parse(req.postData()).settings);
      return json(200, { settings });
    }
    if (p.endsWith('/controls')) return json(200, { actions: [] });
    if (p.endsWith('/launch-token')) return json(200, { token: launchToken() });
    return route.fulfill({ status: 204, body: '' });
  });
  return calls;
}
