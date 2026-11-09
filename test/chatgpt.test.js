const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { createChatGPT } = require('../chatgpt');
const { createApp } = require('../server');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const clock = 1794260000000;

function fixture({ scopes = 'openid email profile resource.invoke chatgpt.tokens.use.direct', modifyClaims,
  events, catalogError, refresh = false, badSignature = false } = {}) {
  const session = {};
  const calls = [];
  let nonce;
  let refreshCount = 0;
  function idToken() {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const claims = { iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'test-user',
      email: 'student@example.com', exp: clock / 1000 + 3600, nonce };
    modifyClaims?.(claims);
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = badSignature ? Buffer.alloc(256) : crypto.sign('sha256', Buffer.from(unsigned), privateKey);
    return `${unsigned}.${signature.toString('base64url')}`;
  }
  const auth = createChatGPT({ now: () => clock, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      if (options.body.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        return Response.json({ access_token: 'renewed-token', refresh_token: 'rotated-refresh', expires_in: 3600, scope: scopes });
      }
      return Response.json({ access_token: 'test-access-token', refresh_token: 'test-refresh',
        id_token: idToken(), token_type: 'Bearer', expires_in: refresh ? 1 : 3600, scope: scopes });
    }
    if (url.endsWith('/models')) {
      if (catalogError) return new Response('private upstream details', { status: catalogError });
      return Response.json({ models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }] });
    }
    if (url.endsWith('/responses')) {
      const values = events || [
        { type: 'response.output_text.delta', delta: 'Day 1: Visit a park.' },
        { type: 'response.completed' },
      ];
      const bytes = Buffer.from(values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join(''));
      return new Response(new ReadableStream({ start(controller) {
        // Split frames, including their CRLF delimiters, across network chunks.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
        controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error('Unexpected request');
  } });
  function begin() {
    const url = new URL(auth.begin(session, 'http://127.0.0.1:3000/auth/callback', 'urn:uuid:test-host'));
    nonce = session.attempt.nonce;
    return url;
  }
  async function finish() {
    const url = begin();
    await auth.finish(session, new URLSearchParams({ state: url.searchParams.get('state'),
      code: 'test-code', client_id: 'oaiapp_test' }));
    return url;
  }
  return { auth, session, calls, begin, finish, refreshCount: () => refreshCount };
}

test('sign-in uses PKCE, the app name, required scopes and loopback callback', () => {
  const f = fixture();
  const url = f.begin();
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'AI Travel WingMan');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  assert.ok(url.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256')
    .update(f.session.attempt.verifier).digest('base64url'));
  assert.notEqual(f.begin().searchParams.get('state'), url.searchParams.get('state'));
});

test('callback rejects unknown state, denial, incomplete registration and code replay', async () => {
  const f = fixture();
  const url = f.begin();
  await assert.rejects(f.auth.finish(f.session, new URLSearchParams({ state: 'wrong' })), /invalid or expired/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.auth.finish(f.session, new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' })), /cancelled/);
  const next = f.begin();
  await assert.rejects(f.auth.finish(f.session, new URLSearchParams({ state: next.searchParams.get('state'), code: 'x' })), /incomplete/);
  const success = await f.finish();
  await assert.rejects(f.auth.finish(f.session, new URLSearchParams({ state: success.searchParams.get('state'), code: 'x' })), /invalid or expired/);
});

for (const [name, modifyClaims] of [
  ['nonce', claims => { claims.nonce = 'wrong'; }],
  ['issuer', claims => { claims.iss = 'https://example.com'; }],
  ['audience', claims => { claims.aud = 'different-client'; }],
  ['expiry', claims => { claims.exp = 1; }],
]) {
  test(`ID tokens with a wrong ${name} are rejected`, async () => {
    const f = fixture({ modifyClaims });
    await assert.rejects(f.finish(), /Could not verify/);
    assert.equal(f.auth.status(f.session).connected, false);
  });
}

test('forged signatures are rejected', async () => {
  await assert.rejects(fixture({ badSignature: true }).finish(), /Could not verify/);
});

test('authorized sign-in and completed inference return text without leaking tokens', async () => {
  const f = fixture();
  await f.finish();
  assert.deepEqual(f.auth.status(f.session), { connected: true, planEnabled: true, email: 'student@example.com', error: '' });
  assert.ok(!JSON.stringify(f.auth.status(f.session)).includes('test-access-token'));
  assert.deepEqual(await f.auth.suggest(f.session, 'San Francisco for two days'), {
    mode: 'chatgpt', reply: 'Day 1: Visit a park.', model: 'Test model',
  });
  const exchange = f.calls.find(call => call.url.endsWith('/oauth/token'));
  assert.equal(exchange.options.body.get('client_id'), 'oaiapp_test');
  const inference = JSON.parse(f.calls.find(call => call.url.endsWith('/responses')).options.body);
  assert.equal(inference.store, false);
  assert.equal(inference.stream, true);
  assert.equal(inference.model, 'test-model');
  assert.equal(inference.tools, undefined);
  const returning = f.begin();
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
});

test('identity-only sign-in cannot consume plan allowance', async () => {
  const f = fixture({ scopes: 'openid email profile' });
  await f.finish();
  assert.equal(f.auth.status(f.session).planEnabled, false);
  await assert.rejects(f.auth.suggest(f.session, 'Trip'), /not authorized/);
  assert.equal(f.calls.some(call => call.url.endsWith('/responses')), false);
});

test('expired access tokens share one refresh and rotate the refresh token', async () => {
  const f = fixture({ refresh: true });
  await f.finish();
  await Promise.all([f.auth.suggest(f.session, 'Trip 1'), f.auth.suggest(f.session, 'Trip 2')]);
  assert.equal(f.refreshCount(), 1);
  assert.equal(f.session.connection.refreshToken, 'rotated-refresh');
});

test('quota errors do not expose upstream details', async () => {
  const f = fixture({ catalogError: 429 });
  await f.finish();
  await assert.rejects(f.auth.suggest(f.session, 'Trip'), error => error.status === 429
    && error.message.includes('usage limit') && !error.message.includes('private'));
});

test('a partial or failed stream cannot be reported as a successful trip', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'Partial text' }],
    [{ type: 'response.output_text.delta', delta: 'Partial text' }, { type: 'response.failed' }],
  ]) {
    const f = fixture({ events });
    await f.finish();
    await assert.rejects(f.auth.suggest(f.session, 'Trip'));
  }
});

function localClient(handler) {
  let cookie = '';
  return async function call(method, url, body, extraHeaders = {}) {
    const req = new PassThrough();
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:3000', cookie,
      'x-requested-with': 'TravelWingMan', origin: 'http://127.0.0.1:3000', ...extraHeaders } });
    const headers = {};
    const res = { setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, values = {}) { this.status = status; Object.entries(values).forEach(([name, value]) => this.setHeader(name, value)); },
      end(data) { this.body = data; },
    };
    const pending = handler(req, res);
    req.end(body === undefined ? undefined : JSON.stringify(body));
    await pending;
    if (headers['set-cookie']) cookie = headers['set-cookie'].split(';')[0];
    return { status: res.status, headers, body: res.body, json: () => JSON.parse(res.body) };
  };
}

test('local routes protect state changes, bind callbacks to a cookie and disconnect', async () => {
  const client = localClient(createApp({ hostId: 'urn:uuid:test-host' }));
  assert.equal((await client('GET', '/')).status, 200);
  assert.equal((await client('GET', '/api/health')).json().status, 'ok');
  assert.equal((await client('GET', '/chatgpt.js')).status, 404);
  assert.equal((await client('GET', '/.local/chatgpt-host-id')).status, 404);
  assert.equal((await client('POST', '/auth/chatgpt/start', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await client('POST', '/auth/chatgpt/start', {}, { 'x-requested-with': '' })).status, 403);
  assert.equal((await client('GET', '/', undefined, { host: 'evil.example' })).status, 400);
  assert.equal((await client('GET', '/', undefined, { host: 'localhost:3000' })).headers.location, 'http://127.0.0.1:3000/');
  assert.equal((await client('GET', '/auth/callback?state=unknown')).status, 400);
  const begun = await client('POST', '/auth/chatgpt/start');
  assert.match(begun.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  const state = new URL(begun.json().url).searchParams.get('state');
  assert.equal((await client('GET', `/auth/callback?state=${state}&error=access_denied`)).status, 303);
  const status = (await client('GET', '/api/auth/status')).json();
  assert.equal(status.connected, false);
  assert.match(status.error, /cancelled/);
  assert.equal((await client('POST', '/api/chat', { message: 'A test trip' })).json().mode, 'demo');
  await client('POST', '/auth/chatgpt/disconnect');
  assert.equal((await client('GET', '/api/auth/status')).json().error, '');
});
