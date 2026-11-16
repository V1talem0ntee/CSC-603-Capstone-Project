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
  events, catalogError, responsesError, refresh = false, badSignature = false } = {}) {
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
      if (responsesError) return new Response('private upstream details', { status: responsesError });
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

test('trip requests produce validated daily itinerary data from the model response', async () => {
  const { validateTrip } = require('../public/itinerary');
  const trip = validateTrip({ destination: 'San Francisco', startDate: '2027-06-01', endDate: '2027-06-01', budget: 500 });
  const reply = JSON.stringify({ summary: 'A day in the city.', notes: [], days: [
    { title: 'Parks and neighborhoods', activities: [{ title: 'Visit a park', details: 'Allow time for walking.', timeOfDay: 'Morning' }] },
  ] });
  const f = fixture({ events: [{ type: 'response.output_text.delta', delta: reply }, { type: 'response.completed' }] });
  await f.finish();
  const result = await f.auth.suggest(f.session, 'Plan a day in San Francisco.', trip);
  assert.equal(result.itinerary.mode, 'chatgpt');
  assert.equal(result.itinerary.days[0].date, '2027-06-01');
  assert.equal(result.itinerary.days[0].activities[0].title, 'Visit a park');
  assert.equal(result.itinerary.days[0].hotel.completed, false);
  const request = JSON.parse(f.calls.find(call => call.url.endsWith('/responses')).options.body);
  assert.match(request.instructions, /exactly 1 days/);
  assert.match(request.instructions, /Return only valid JSON/);
  assert.deepEqual(request.tools, [{ type: 'web_search' }]);
  assert.equal(request.tool_choice, 'required');
  assert.deepEqual(request.include, ['web_search_call.action.sources']);
});

test('restaurant lookups only keep venues and prices backed by provider search metadata', async () => {
  const sourceUrl = 'https://menu.example/menu';
  const restaurant = { name: 'Test Restaurant', address: '10 Test Street, Test City',
    description: 'A test venue.', whyKnown: 'Test local guide listing.',
    sources: [{ url: sourceUrl, title: 'Test menu' }],
    price: { text: 'USD 20-30', basis: 'Per person, one main and a drink, excluding tax and tips.', sourceUrl, kind: 'menu_estimate' } };
  const f = fixture({ events: [
    { type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: { sources: [{ url: sourceUrl }] } } },
    { type: 'response.output_text.delta', delta: JSON.stringify({ restaurants: [restaurant,
      { ...restaurant, name: 'Unsourced Venue', sources: [{ url: 'https://invented.example/' }] }] }) },
    { type: 'response.completed' },
  ] });
  await f.finish();
  const result = await f.auth.dining(f.session,
    { destination: 'Test City', startDate: '2027-06-01', endDate: '2027-06-02', budget: 500 },
    { kind: 'stay', name: 'My stay', address: '20 Test Avenue, Test City' });
  assert.equal(result.mode, 'web');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price.kind, 'menu_estimate');
  assert.equal(result.items[0].price.sourceUrl, sourceUrl);
  assert.equal(result.retrievedAt, new Date(clock).toISOString());
  const request = JSON.parse(f.calls.find(call => call.url.endsWith('/responses')).options.body);
  assert.ok(request.input[0].content.includes('20 Test Avenue'));
});

test('connected trip planning carries transport preferences and keeps only retrieved traffic windows', async () => {
  const { validateTrip, restorePlan } = require('../public/itinerary');
  const trip = validateTrip({ destination: 'Test City', startDate: '2027-06-01', endDate: '2027-06-01', budget: 500, transportMode: 'driving' });
  const sourceUrl = 'https://transport.example/peak-report';
  const period = { label: 'Test peak', daysOfWeek: [1, 2, 3, 4, 5], startTime: '07:00', endTime: '09:00',
    area: 'Test road', description: 'Synthetic historical test data.', sources: [{ url: sourceUrl, title: 'Test report' }] };
  const raw = { traffic: { timeZone: 'America/Los_Angeles', peakPeriods: [period,
    { ...period, sources: [{ url: 'https://invented.example/' }] }] }, days: [{ title: 'Test day',
    mobility: { strategy: 'Visit nearby stops, then transfer after the typical peak.' }, activities: [
      { title: 'First', location: '1 Test Road, Test City' },
      { title: 'Second', location: '2 Test Road, Test City', transfer: { mode: 'driving', departureTime: '09:30', arrivalTime: '10:00',
        bufferMinutes: 10, reason: 'Planning estimate; leave after the peak.' } },
    ] }] };
  const f = fixture({ events: [
    { type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: { sources: [{ url: sourceUrl }] } } },
    { type: 'response.output_text.delta', delta: JSON.stringify(raw) }, { type: 'response.completed' },
  ] });
  await f.finish();
  const { itinerary } = await f.auth.suggest(f.session, 'Plan my trip.', trip);
  assert.equal(itinerary.transportMode, 'driving');
  assert.equal(itinerary.traffic.basis, 'sourced_patterns');
  assert.equal(itinerary.traffic.peakPeriods.length, 1);
  assert.equal(itinerary.traffic.retrievedAt, new Date(clock).toISOString());
  assert.equal(itinerary.days[0].activities[1].transfer.departureTime, '09:30');
  assert.deepEqual(restorePlan(JSON.parse(JSON.stringify(itinerary))), itinerary);
  const request = JSON.parse(f.calls.find(call => call.url.endsWith('/responses')).options.body);
  assert.equal(JSON.parse(request.input[0].content).trip.transportMode, 'driving');
  assert.equal(request.tool_choice, 'required');
  assert.match(request.instructions, /community discussions published during the current calendar month/);
  assert.match(request.instructions, /anecdotal, qualitative context/);
});

test('connected planning returns a concise report derived from the itinerary', async () => {
  const { validateTrip } = require('../public/itinerary');
  const trip = validateTrip({ destination: 'Paris', startDate: '2027-06-01', endDate: '2027-06-01', budget: 500 });
  const profile = { schema_version: '1.0', profile_type: 'travel_dna',
    interests: [{ specific_interest: 'Street photography' }], unknown_preferences: ['Preferred pace'] };
  const raw = { summary: 'A photography-focused day.',
    days: [{ title: 'Photo day', activities: [{ title: 'Montmartre photo walk', details: 'Photograph neighborhood streets.' }] }] };
  const f = fixture({ events: [{ type: 'response.output_text.delta', delta: JSON.stringify(raw) }, { type: 'response.completed' }] });
  await f.finish();
  const result = await f.auth.suggest(f.session, 'Plan my trip.', trip, { profile });
  assert.equal(result.report.report_type, 'travel_plan_summary');
  assert.equal(result.report.trip.destination, 'Paris');
  assert.equal(result.report.daily_plan[0].activities[0].title, 'Montmartre photo walk');
  assert.equal(Object.hasOwn(result.report, 'signals'), false);
  assert.equal(JSON.stringify(result.report).includes('Street photography'), false);
});

test('restaurant search fails clearly if search does not run or the workspace rejects it', async () => {
  const noSearch = fixture({ events: [
    { type: 'response.output_text.delta', delta: '{"restaurants":[]}' }, { type: 'response.completed' },
  ] });
  await noSearch.finish();
  await assert.rejects(noSearch.auth.dining(noSearch.session, {}, {}), /Web search did not run/);
  const blocked = fixture({ responsesError: 403 });
  await blocked.finish();
  await assert.rejects(blocked.auth.dining(blocked.session, {}, {}), /did not allow web search/);
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
  for (const file of ['/app.js', '/itinerary.js', '/itinerary-view.js']) {
    const asset = await client('GET', file);
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /javascript/);
  }
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
