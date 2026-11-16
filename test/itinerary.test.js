const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const Plan = require('../public/itinerary');
const { createApp } = require('../server');

const trip = { destination: 'San Francisco', startDate: '2027-03-13', endDate: '2027-03-15', budget: 900 };
const demo = input => ({ ...Plan.demoPlan(input || trip), mode: 'demo' });

test('daily plans cover every travel date across a daylight-saving boundary', () => {
  const plan = demo();
  assert.equal(plan.dayCount, 3);
  assert.deepEqual(plan.days.map(day => day.date), ['2027-03-13', '2027-03-14', '2027-03-15']);
  assert.deepEqual(plan.days.map(day => Boolean(day.hotel)), [true, false, false]);
  assert.equal(plan.days[0].hotel.completed, false);
  assert.equal(Object.hasOwn(plan.days[0].hotel, 'hotelName'), false);
});

test('invalid dates, reversed dates, overlong trips, and invalid budgets are rejected', () => {
  for (const changes of [
    { startDate: '2027-02-30' }, { endDate: '2027-03-12' }, { budget: 0 },
    { budget: Infinity }, { destination: '   ' }, { endDate: '2028-03-15' },
  ]) assert.throws(() => Plan.validateTrip({ ...trip, ...changes }));
  assert.equal(demo({ ...trip, endDate: trip.startDate }).days.length, 1);
});

test('hotel and activity completion can be checked and unchecked independently', () => {
  const plan = demo();
  const day = plan.days[0];
  const checked = Plan.editPlan(plan, { type: 'hotel', dayId: day.id, completed: true });
  assert.equal(checked.days[0].hotel.completed, true);
  assert.equal(plan.days[0].hotel.completed, false);
  assert.equal(checked.days[0].activities[0].completed, false);
  const complete = Plan.editPlan(checked, { type: 'toggle', dayId: day.id, activityId: day.activities[0].id, completed: true });
  assert.equal(complete.days[0].activities[0].completed, true);
  const undone = Plan.editPlan(complete, { type: 'toggle', dayId: day.id, activityId: day.activities[0].id, completed: false });
  assert.equal(undone.days[0].activities[0].completed, false);
  assert.equal(undone.days[0].hotel.completed, true);
});

test('moving an unfinished activity removes it from day one and adds the same item to day two', () => {
  const plan = demo();
  const day = plan.days[0];
  const item = day.activities[0];
  const next = Plan.editPlan(plan, { type: 'move', dayId: day.id, activityId: item.id });
  assert.equal(next.days[0].activities.some(activity => activity.id === item.id), false);
  const moved = next.days[1].activities.find(activity => activity.id === item.id);
  assert.equal(moved.title, item.title);
  assert.equal(moved.completed, false);
  assert.equal(moved.timeOfDay, 'Flexible');
  assert.equal(moved.movedFrom, 1);
  assert.equal(plan.days[0].activities.length, 3);
  const again = Plan.editPlan(next, { type: 'move', dayId: next.days[1].id, activityId: item.id });
  assert.equal(again.days[2].activities.at(-1).movedFrom, 1);
});

test('completed activities and last-day activities cannot move to the next day', () => {
  const plan = demo();
  const first = plan.days[0];
  const checked = Plan.editPlan(plan, { type: 'toggle', dayId: first.id, activityId: first.activities[0].id, completed: true });
  assert.throws(() => Plan.editPlan(checked, { type: 'move', dayId: first.id, activityId: first.activities[0].id }), /unfinished/);
  const last = plan.days.at(-1);
  assert.throws(() => Plan.editPlan(plan, { type: 'move', dayId: last.id, activityId: last.activities[0].id }), /no next day/);
});

test('deleting activities leaves the day and hotel task intact; snapshots support undo', () => {
  const original = demo();
  let edited = original;
  for (const item of original.days[0].activities) {
    edited = Plan.editPlan(edited, { type: 'delete', dayId: original.days[0].id, activityId: item.id });
  }
  assert.equal(edited.days[0].activities.length, 0);
  assert.deepEqual(edited.days[0].hotel, original.days[0].hotel);
  assert.equal(edited.days.length, 3);
  assert.equal(original.days[0].activities.length, 3);
  assert.deepEqual(Plan.restorePlan(JSON.parse(JSON.stringify(original))), original);
});

test('checked, deleted, and moved activities survive saving and restoring', () => {
  let plan = demo();
  plan = Plan.editPlan(plan, { type: 'hotel', dayId: plan.days[0].id, completed: true });
  plan = Plan.editPlan(plan, { type: 'toggle', dayId: plan.days[0].id, activityId: plan.days[0].activities[0].id, completed: true });
  plan = Plan.editPlan(plan, { type: 'move', dayId: plan.days[0].id, activityId: plan.days[0].activities[1].id });
  plan = Plan.editPlan(plan, { type: 'delete', dayId: plan.days[1].id, activityId: plan.days[1].activities[0].id });
  assert.deepEqual(Plan.restorePlan(JSON.parse(JSON.stringify(plan))), plan);
  const corrupt = structuredClone(plan);
  corrupt.days[1].activities[0].id = corrupt.days[0].activities[0].id;
  assert.equal(Plan.restorePlan(corrupt), null);
  assert.equal(Plan.restorePlan({}), null);
});

test('structured AI output is parsed safely and mismatched day counts are rejected', () => {
  const raw = { summary: 'A city break.', notes: ['Estimated costs only.'], days: [
    { title: 'Explore', activities: [{ title: 'Visit a park', details: '<script>alert(1)</script>', timeOfDay: 'Morning' }] },
  ] };
  const oneDayTrip = { ...trip, endDate: trip.startDate };
  const plan = Plan.parsePlan('```json\n' + JSON.stringify(raw) + '\n```', oneDayTrip);
  assert.equal(plan.days[0].activities[0].details, '<script>alert(1)</script>');
  assert.throws(() => Plan.parsePlan(JSON.stringify(raw), trip), /selected dates/);
  assert.throws(() => Plan.parsePlan('Not JSON', oneDayTrip), /not a readable/);
});

test('an AI-selected destination becomes part of a personalized itinerary', () => {
  const openTrip = { ...trip, destination: '', endDate: trip.startDate, travelMode: 'flying' };
  const raw = { destination: 'Santa Fe, New Mexico', summary: 'Chosen for art and food.', days: [
    { title: 'Explore Santa Fe', activities: [{ title: 'Visit the Plaza', location: 'Santa Fe Plaza, Santa Fe, NM' }] },
  ] };
  const plan = Plan.parsePlan(JSON.stringify(raw), openTrip);
  assert.equal(plan.destination, 'Santa Fe, New Mexico');
  assert.equal(plan.travelMode, 'flying');
  assert.throws(() => Plan.parsePlan(JSON.stringify({ ...raw, destination: '' }), openTrip), /did not choose a destination/);
});

async function postTrip(input) {
  const handler = createApp({ hostId: 'urn:uuid:itinerary-test' });
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', url: '/api/chat', headers: {
    host: '127.0.0.1:3000', 'x-requested-with': 'TravelWingMan', origin: 'http://127.0.0.1:3000',
  } });
  const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const pending = handler(req, res);
  req.end(JSON.stringify({ message: 'A sample trip', trip: input }));
  await pending;
  return res;
}

test('the demo API returns editable daily data and rejects bad trips before generation', async () => {
  const response = await postTrip(trip);
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'demo');
  assert.equal(response.body.itinerary.days.length, 3);
  assert.ok(Plan.restorePlan(response.body.itinerary));
  assert.equal(response.body.report.report_type, 'travel_plan_summary');
  assert.equal(response.body.report.trip.destination, trip.destination);
  assert.equal(response.body.report.daily_plan.length, 3);
  assert.equal(Object.hasOwn(response.body.report, 'profile'), false);
  assert.equal((await postTrip({ ...trip, budget: -1 })).status, 400);
});
