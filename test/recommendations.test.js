const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const Plan = require('../public/itinerary');
const { createApp } = require('../server');
const trip = { destination: 'Test City', startDate: '2027-06-01', endDate: '2027-06-02', budget: 800 };
const url = 'https://hotel.example/rates';
const research = { usedSearch: true, sources: [{ url }], retrievedAt: '2026-11-09T20:00:00.000Z' };
const venue = () => ({ name: 'Test Hotel', address: '10 Test Street, Test City',
  sources: [{ url, title: 'Test rates' }],
  price: { text: 'USD 120-150', basis: 'Per room per night for two adults; tax excluded.',
    dateBasis: 'Indicative published rate; exact travel dates not confirmed.', sourceUrl: url } });

function planWithResearch() {
  const plan = { ...Plan.demoPlan(trip), mode: 'chatgpt' };
  plan.hotels = Plan.normalizeResearch([venue(), { ...venue(), name: 'Second Test Hotel', address: '30 Test Road, Test City' }], research, 'hotel');
  return plan;
}

test('hotel prices require a real search and an exact supporting retrieved source', () => {
  assert.equal(Plan.normalizeResearch([venue()], { ...research, usedSearch: false }, 'hotel').items.length, 0);
  assert.equal(Plan.normalizeResearch([venue()], { ...research, sources: [] }, 'hotel').items.length, 0);
  const valid = Plan.normalizeResearch([venue()], research, 'hotel');
  assert.equal(valid.items[0].price.text, 'USD 120-150');
  assert.equal(valid.items[0].price.dateBasis.includes('not confirmed'), true);
  const invalidPrice = venue();
  invalidPrice.price.sourceUrl = 'https://hotel.example/different-page';
  const missingPrice = Plan.normalizeResearch([invalidPrice], research, 'hotel');
  assert.equal(missingPrice.items.length, 1);
  assert.equal(missingPrice.items[0].price, null);
  const noBasis = venue();
  delete noBasis.price.basis;
  assert.equal(Plan.normalizeResearch([noBasis], research, 'hotel').items[0].price, null);
});

test('unsafe source links cannot enter recommendation cards', () => {
  for (const bad of ['javascript:alert(1)', 'file:///secret', 'http://127.0.0.1/admin', 'https://user:password@example.com/']) {
    assert.equal(Plan.safeUrl(bad), '');
    const candidate = { ...venue(), sources: [{ url: bad }] };
    assert.equal(Plan.normalizeResearch([candidate], { ...research, sources: [{ url: bad }] }).items.length, 0);
  }
});

test('selecting a hotel is exclusive and does not mark physical check-in complete', () => {
  let plan = planWithResearch();
  plan = Plan.selectStay(plan, { hotelId: plan.hotels.items[0].id });
  assert.equal(plan.stay.address, '10 Test Street, Test City');
  assert.equal(plan.days[0].hotel.completed, false);
  plan.nearStay = { ...Plan.normalizeResearch([venue()], research), anchorKey: plan.stay.key, anchorLabel: plan.stay.address };
  plan = Plan.selectStay(plan, { hotelId: plan.hotels.items[1].id });
  assert.equal(plan.stay.address, '30 Test Road, Test City');
  assert.equal(plan.nearStay, null);
  assert.throws(() => Plan.selectStay(plan, { hotelId: 'missing' }), /no longer available/);
});

test('a manually confirmed address persists along with source references and nearby restaurants', () => {
  let plan = Plan.selectStay(planWithResearch(), { address: '  50 Test Avenue, Test City  ' });
  assert.equal(plan.stay.address, '50 Test Avenue, Test City');
  assert.equal(plan.stay.hotelId, null);
  plan.nearStay = { ...Plan.normalizeResearch([venue()], research), anchorKey: plan.stay.key, anchorLabel: plan.stay.address };
  const restored = Plan.restorePlan(JSON.parse(JSON.stringify(plan)));
  assert.ok(restored);
  assert.equal(restored.stay.address, plan.stay.address);
  assert.equal(restored.hotels.items[0].id, plan.hotels.items[0].id);
  assert.equal(restored.nearStay.items[0].price.sourceUrl, url);
  assert.equal(restored.hotels.retrievedAt, research.retrievedAt);
});

test('restaurant anchors use the final sightseeing stop rather than dinner or transit', () => {
  const plan = planWithResearch();
  const day = plan.days[0];
  assert.equal(Plan.lastStop(day).label, 'Visit a museum or park');
  day.activities.push({ id: 'transit', title: 'Take a bus home', kind: 'travel', location: '' });
  assert.equal(Plan.lastStop(day).label, 'Visit a museum or park');
});

test('deleting or moving the last attraction invalidates affected restaurant recommendations', () => {
  const plan = planWithResearch();
  const day = plan.days[0];
  const stop = Plan.lastStop(day);
  day.dining = { ...Plan.normalizeResearch([venue()], research), anchorKey: stop.key, anchorLabel: stop.label };
  const checked = Plan.editPlan(plan, { type: 'toggle', dayId: day.id, activityId: stop.activityId, completed: true });
  assert.equal(checked.days[0].dining.anchorKey, stop.key);
  const deleted = Plan.editPlan(plan, { type: 'delete', dayId: day.id, activityId: stop.activityId });
  assert.equal(deleted.days[0].dining, null);
  const moved = Plan.editPlan(plan, { type: 'move', dayId: day.id, activityId: stop.activityId });
  assert.equal(moved.days[0].dining, null);
  assert.equal(moved.days[1].dining, null);
});

test('stale accommodation restaurant results are discarded on restore', () => {
  const plan = Plan.selectStay(planWithResearch(), { address: '50 Test Avenue, Test City' });
  plan.nearStay = { ...Plan.normalizeResearch([venue()], research), anchorKey: 'old-address' };
  assert.equal(Plan.restorePlan(plan).nearStay, null);
});

test('days without sightseeing stops still restore after all activities are deleted', () => {
  let plan = planWithResearch();
  for (const item of [...plan.days[0].activities]) {
    plan = Plan.editPlan(plan, { type: 'delete', dayId: plan.days[0].id, activityId: item.id });
  }
  const restored = Plan.restorePlan(JSON.parse(JSON.stringify(plan)));
  assert.ok(restored);
  assert.equal(restored.days[0].activities.length, 0);
  assert.equal(restored.days[0].dining, null);
});

async function diningPost(body) {
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', url: '/api/dining', headers: {
    host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-requested-with': 'TravelWingMan',
  } });
  const response = { setHeader() {}, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
  const pending = createApp({ hostId: 'urn:uuid:test' })(req, response);
  req.end(JSON.stringify(body));
  await pending;
  return response;
}

test('restaurant API validates locations and demo mode never fabricates restaurants or prices', async () => {
  const response = await diningPost({ trip, anchor: { kind: 'stay', address: '50 Test Avenue, Test City' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'demo');
  assert.deepEqual(response.body.recommendations.items, []);
  assert.equal((await diningPost({ trip, anchor: { kind: 'stay', address: 'x' } })).status, 400);
  assert.equal((await diningPost({ trip, anchor: { kind: 'day', name: 'A landmark', date: '2027-06-05' } })).status, 400);
});
