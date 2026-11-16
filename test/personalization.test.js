const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { validate } = require('../public/personalization');
const { createApp } = require('../server');
const profile = { schema_version: '1.0', profile_type: 'travel_dna', interests: [{ specific_interest: 'photography' }] };
const personalization = { profile };
const trip = { destination: 'Paris', startDate: '2027-01-01', endDate: '2027-01-02', budget: 900 };
async function post(body, auth) {
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', url: '/api/chat', headers: { host: '127.0.0.1:3000', 'x-requested-with': 'TravelWingMan' } });
  const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
  const pending = createApp({ auth })(req, res);
  req.end(JSON.stringify(body));
  await pending;
  return res;
}
async function get(url) {
  const req = new PassThrough();
  Object.assign(req, { method: 'GET', url, headers: { host: '127.0.0.1:3000' } });
  const res = { setHeader() {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = value?.toString() || ''; } };
  const pending = createApp({ auth: { status: () => ({ connected: false }) } })(req, res);
  req.end();
  await pending;
  return res;
}
test('Travel DNA profile is validated without a daily time window', () => {
  assert.deepEqual(validate(personalization), personalization);
  assert.throws(() => validate({ ...personalization, profile: {} }), /Travel DNA/);
  assert.deepEqual(validate({ ...personalization, dailyStart: '20:00', dailyEnd: '08:00' }), personalization);
  assert.throws(() => validate({ ...personalization, profile: { ...profile, extra: 'x'.repeat(30001) } }), /too large/);
});
test('connected personalized requests accept an optional destination and pass the profile to the planner', async () => {
  let captured;
  const auth = { status: () => ({ connected: true, planEnabled: true }), suggest: async (...args) => { captured = args; return { mode: 'chatgpt' }; } };
  const res = await post({ message: 'Plan', trip, personalization }, auth);
  assert.equal(res.status, 200);
  assert.deepEqual(captured[3], personalization);
  const openTrip = { ...trip, destination: '', travelMode: 'flying' };
  assert.equal((await post({ message: 'Choose a destination', trip: openTrip, personalization }, auth)).status, 200);
  assert.equal(captured[2].destination, '');
  assert.equal(captured[2].travelMode, 'flying');
  assert.equal((await post({ message: 'Plan', personalization }, auth)).status, 400);
});
test('destination discovery requires ChatGPT and validates the travel method', async () => {
  const openTrip = { ...trip, destination: '', travelMode: 'driving' };
  const disconnected = { status: () => ({ connected: false }) };
  const res = await post({ message: 'Choose', trip: openTrip, personalization }, disconnected);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Connect ChatGPT/);
  assert.equal((await post({ message: 'Choose', trip: { ...openTrip, travelMode: 'train' }, personalization }, disconnected)).status, 400);
});
test('demo mode explicitly identifies the sample as unpersonalized', async () => {
  const res = await post({ message: 'Plan', trip, personalization }, { status: () => ({ connected: false }) });
  assert.equal(res.body.mode, 'demo');
  assert.match(res.body.reply, /not personalized/);
});
test('Travel DNA prompt page is served with a copyable profile prompt', async () => {
  const page = await get('/travel-dna');
  const script = await get('/travel-dna.js');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="travel-dna-prompt"/);
  assert.match(page.body, /"profile_type": "travel_dna"/);
  assert.match(page.body, /id="copy-prompt"/);
  assert.equal(script.status, 200);
  assert.match(script.body, /clipboard\.writeText/);
});
test('personalized planning offers both destination travel and local transport choices', async () => {
  const page = await get('/personalized');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="travel-mode"/);
  assert.match(page.body, /id="transport-mode"/);
  for (const mode of ['mixed', 'driving', 'transit', 'walking', 'cycling']) {
    assert.match(page.body, new RegExp(`value="${mode}"`));
  }
});
