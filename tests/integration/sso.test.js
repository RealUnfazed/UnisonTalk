const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');

const ENV_KEYS = ['PHASETIME_SSO_BASE_URL', 'PHASETIME_CLIENT_ID', 'PHASETIME_CLIENT_SECRET', 'PHASETIME_REDIRECT_URI'];
const REDIRECT_URI = 'http://localhost:3000/api/auth/sso/phasetime/callback';

// A tiny stand-in for a Phasetime SSO server: just the documented
// /token.php and /userinfo.php endpoints, strict about what it's sent.
function startMockPhasetime(getProfile) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/token.php' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const p = new URLSearchParams(raw);
        const ok = p.get('code') === 'good-code' && p.get('grant_type') === 'authorization_code' &&
          p.get('client_id') === 'cid_test' && p.get('client_secret') === 'secret_test' && p.get('redirect_uri') === REDIRECT_URI;
        ok ? json(200, { access_token: 'tok', token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' });
      });
      return;
    }
    if (url.pathname === '/userinfo.php') {
      return req.headers.authorization === 'Bearer tok' ? json(200, getProfile()) : json(401, { error: 'invalid_token' });
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

describe('Phasetime SSO', () => {
  let ctx, mock, profile;
  const configure = () =>
    Object.assign(process.env, {
      PHASETIME_SSO_BASE_URL: `http://127.0.0.1:${mock.port}`,
      PHASETIME_CLIENT_ID: 'cid_test',
      PHASETIME_CLIENT_SECRET: 'secret_test',
      PHASETIME_REDIRECT_URI: REDIRECT_URI,
    });
  const clear = () => ENV_KEYS.forEach((k) => delete process.env[k]);

  before(async () => {
    ctx = await startTestApp();
    mock = await startMockPhasetime(() => profile);
  });
  after(async () => {
    clear();
    mock.server.close();
    await ctx.stop();
  });
  beforeEach(async () => {
    clear();
    profile = { id: 'pt_42', name: 'José García', email: 'jose@example.com' };
    await resetDb();
  });

  // Starts a flow the way a browser would, returning the `state` Phasetime would echo back.
  async function begin(agent, route = '/api/auth/sso/phasetime') {
    const res = await agent.get(route).redirects(0).expect(302);
    return new URL(res.headers.location).searchParams.get('state');
  }
  const callback = (agent, query) => agent.get('/api/auth/sso/phasetime/callback').query(query).redirects(0);

  it('reports whether SSO is configured, and 503s the login route when it is not', async () => {
    assert.deepEqual((await request(ctx.app).get('/api/auth/sso/status').expect(200)).body, { enabled: false });
    await request(ctx.app).get('/api/auth/sso/phasetime').expect(503);
    configure();
    assert.deepEqual((await request(ctx.app).get('/api/auth/sso/status').expect(200)).body, { enabled: true });
  });

  it('redirects to the provider with the right OAuth2 parameters', async () => {
    configure();
    const res = await request(ctx.app).get('/api/auth/sso/phasetime').redirects(0).expect(302);
    const loc = new URL(res.headers.location);
    assert.equal(loc.origin + loc.pathname, `http://127.0.0.1:${mock.port}/authorize.php`);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('client_id'), 'cid_test');
    assert.equal(loc.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(loc.searchParams.get('state').length, 48);
  });

  it('handles provider errors, missing codes and CSRF (state) mismatches without creating anything', async () => {
    configure();
    const agent = request.agent(ctx.app);
    assert.equal((await callback(agent, { error: 'access_denied' })).headers.location, '/login.html?ssoError=access_denied');
    assert.equal((await callback(agent, {})).headers.location, '/login.html?ssoError=missing_code');
    await begin(agent);
    assert.equal((await callback(agent, { code: 'good-code', state: 'forged' })).headers.location, '/login.html?ssoError=state_mismatch');
    assert.equal(await User.countDocuments(), 0);
  });

  it('url-encodes whatever error code the provider sends back', async () => {
    configure();
    const res = await callback(request.agent(ctx.app), { error: 'x&evil=1#frag' });
    assert.equal(res.headers.location, '/login.html?ssoError=x%26evil%3D1%23frag');
  });

  it('creates an account on first sign-in, and signs into the SAME account next time', async () => {
    configure();
    const agent = request.agent(ctx.app);
    const res = await callback(agent, { code: 'good-code', state: await begin(agent) });
    assert.equal(res.headers.location, '/');
    const me = (await agent.get('/api/auth/me').expect(200)).body.user;
    assert.equal(me.username, 'JoseGarcia');
    assert.equal(me.hasPhasetimeLink, true);
    const stored = await User.findOne({ username: 'JoseGarcia' }).lean();
    assert.equal(stored.password, null);
    assert.equal(stored.phasetimeId, 'pt_42');

    await agent.post('/api/auth/logout').expect(204);
    await callback(agent, { code: 'good-code', state: await begin(agent) });
    assert.equal(await User.countDocuments(), 1);
  });

  it('coexists with password accounts and other SSO accounts (no duplicate-key errors)', async () => {
    configure();
    await makeUser('localguy');
    for (const id of ['pt_1', 'pt_2']) {
      profile = { id, name: `Person ${id}`, email: `${id}@example.com` };
      const agent = request.agent(ctx.app);
      assert.equal((await callback(agent, { code: 'good-code', state: await begin(agent) })).headers.location, '/');
    }
    assert.equal(await User.countDocuments(), 3);
  });

  it('gives a colliding display name a numeric suffix', async () => {
    configure();
    await makeUser('JoseGarcia');
    const agent = request.agent(ctx.app);
    await callback(agent, { code: 'good-code', state: await begin(agent) });
    assert.equal((await agent.get('/api/auth/me')).body.user.username, 'JoseGarcia1');
  });

  it('refuses to silently merge into an existing account that shares the email', async () => {
    configure();
    await makeUser('existing', { email: 'jose@example.com' });
    const agent = request.agent(ctx.app);
    const res = await callback(agent, { code: 'good-code', state: await begin(agent) });
    assert.equal(res.headers.location, '/login.html?ssoError=email_taken');
    assert.equal(await User.countDocuments(), 1);
  });

  it('fails cleanly when the provider rejects the code', async () => {
    configure();
    const agent = request.agent(ctx.app);
    const res = await callback(agent, { code: 'bad-code', state: await begin(agent) });
    assert.equal(res.headers.location, '/login.html?ssoError=token_exchange_failed');
  });

  it('links Phasetime to the signed-in account, refuses an ID owned by someone else, and unlinks', async () => {
    configure();
    await makeUser('alice');
    await makeUser('bob', { phasetimeId: 'pt_42' });
    const alice = await loginAs(ctx.app, 'alice');

    // pt_42 already belongs to bob
    let res = await callback(alice, { code: 'good-code', state: await begin(alice, '/api/auth/sso/phasetime/link') });
    assert.equal(res.headers.location, '/?ssoError=already_linked_elsewhere');

    profile = { id: 'pt_77', name: 'Alice', email: 'a@example.com' };
    res = await callback(alice, { code: 'good-code', state: await begin(alice, '/api/auth/sso/phasetime/link') });
    assert.equal(res.headers.location, '/?ssoLinked=1');
    assert.equal((await alice.get('/api/auth/me')).body.user.hasPhasetimeLink, true);

    // Unlinking removes the field entirely — and two unlinked accounts must not collide (issue #14).
    const bob = await loginAs(ctx.app, 'bob');
    for (const agent of [alice, bob]) {
      const out = await agent.post('/api/auth/sso/phasetime/unlink').send({}).expect(200);
      assert.equal(out.body.user.hasPhasetimeLink, false);
    }
    const docs = await User.find({}).lean();
    assert.ok(docs.every((u) => !('phasetimeId' in u)));
  });

  it('requires a session to start the link flow', async () => {
    configure();
    await request(ctx.app).get('/api/auth/sso/phasetime/link').expect(401);
  });
});
