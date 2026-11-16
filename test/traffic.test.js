const { test } = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../public/itinerary');

// Synthetic transport data exercises behavior without asserting real local peaks.
const url = 'https://transport.example/commute-report';
const research = { usedSearch: true, sources: [{ url }], retrievedAt: '2026-11-09T20:00:00Z' };
const trip = { destination: 'Test City', startDate: '2027-03-12', endDate: '2027-03-15', budget: 900, transportMode: 'driving' };
const traffic = () => ({ timeZone: 'America/Los_Angeles', peakPeriods: [{
  label: 'Test weekday peak', daysOfWeek: [1, 2, 3, 4, 5], startTime: '07:00', endTime: '09:00',
  area: 'Test road, inbound', description: 'Synthetic historical window for tests only.', sources: [{ url, title: 'Test report' }],
}] });
const transfer = () => ({ mode: 'driving', departureTime: '08:30', arrivalTime: '09:15', bufferMinutes: 15,
  reason: 'Planning estimate. A timed visit requires this departure.', alternative: 'Move the visit and depart after the peak.' });
function plan() {
  return { ...Plan.normalizePlan({ traffic: traffic(), days: Array.from({ length: 4 }, () => ({
    title: 'Nearby stops', mobility: { strategy: 'Keep nearby visits together; allow extra time for the timed visit.' },
    activities: [{ title: 'First stop', location: '1 Test Road, Test City' },
      { title: 'Second stop', location: '2 Test Road, Test City', transfer: transfer() }],
  })) }, trip, research), mode: 'chatgpt' };
}

test('transport preferences default compatibly and reject unknown modes', () => {
  assert.equal(Plan.validateTrip({ ...trip, transportMode: undefined }).transportMode, 'mixed');
  for (const mode of ['mixed', 'driving', 'transit', 'walking', 'cycling']) {
    assert.equal(Plan.validateTrip({ ...trip, transportMode: mode }).transportMode, mode);
  }
  assert.throws(() => Plan.validateTrip({ ...trip, transportMode: 'flying' }), /way to get around/);
});

test('traffic windows require search, exact retrieved sources, valid clocks and timezone', () => {
  assert.equal(Plan.normalizeTraffic(traffic(), research).basis, 'sourced_patterns');
  assert.equal(Plan.normalizeTraffic(traffic(), { ...research, sources: [] }).basis, 'assumptions');
  assert.equal(Plan.normalizeTraffic(traffic(), { ...research, usedSearch: false }).basis, 'unavailable');
  for (const patch of [{ startTime: '25:00' }, { endTime: '06:00' }, { daysOfWeek: [0, 8] },
    { sources: [{ url: 'https://invented.example/' }] }, { sources: [{ url: 'javascript:alert(1)' }] }]) {
    const raw = traffic();
    Object.assign(raw.peakPeriods[0], patch);
    assert.equal(Plan.normalizeTraffic(raw, research).peakPeriods.length, 0);
  }
  assert.equal(Plan.normalizeTraffic({ ...traffic(), timeZone: 'Made/Up' }, research).peakPeriods.length, 0);
  assert.equal(Plan.normalizeTraffic({ ...traffic(), basis: 'live' }, research).basis, 'sourced_patterns');
});

test('weekday peaks use destination dates across DST and do not spill into weekends', () => {
  const value = plan();
  assert.deepEqual(value.days.map(day => Plan.peakPeriodsForDate(value.traffic, day.date).length), [1, 0, 0, 1]);
  assert.equal(Plan.peakPeriodsForDate(value.traffic, '2027-02-30').length, 0);
  const sunday = traffic();
  sunday.peakPeriods[0].daysOfWeek = [7];
  assert.equal(Plan.peakPeriodsForDate(Plan.normalizeTraffic(sunday, research), '2027-03-14').length, 1);
});

test('possible peak conflicts include travel spanning the window and respect boundaries and modes', () => {
  const patterns = plan().traffic;
  const count = slot => Plan.transferPeakWarnings(patterns, trip.startDate, slot).length;
  assert.equal(count(transfer()), 1);
  assert.equal(count({ ...transfer(), departureTime: '06:30', arrivalTime: '09:30' }), 1);
  assert.equal(count({ ...transfer(), departureTime: '09:00' }), 0);
  assert.equal(count({ ...transfer(), departureTime: '06:30', arrivalTime: '07:00' }), 0);
  assert.equal(count({ ...transfer(), mode: 'walking' }), 0);
  assert.equal(count({ ...transfer(), mode: 'cycling' }), 0);
  assert.equal(count({ ...transfer(), mode: 'transit' }), 1);
});

test('transfer slots require real endpoints, respect preference and reject invalid same-day clocks', () => {
  const generate = (slot, options = {}) => Plan.normalizePlan({ days: [{ title: 'Test', activities: [
    { title: 'First', location: options.missingOrigin ? '' : '1 Test Road', transfer: slot },
    { title: 'Second', location: '2 Test Road', transfer: slot },
  ] }] }, { ...trip, endDate: trip.startDate, transportMode: options.mode || 'driving' });
  for (const patch of [{ departureTime: '24:01' }, { arrivalTime: '08:00' }, { arrivalTime: '08:30' },
    { mode: 'walking' }, { reason: '' }]) assert.equal(generate({ ...transfer(), ...patch }).days[0].activities[1].transfer, null);
  assert.equal(generate(transfer(), { missingOrigin: true }).days[0].activities[1].transfer, null);
  assert.equal(generate(transfer()).days[0].activities[0].transfer, null);
  assert.equal(generate({ ...transfer(), bufferMinutes: 100 }).days[0].activities[1].transfer.bufferMinutes, null);
  assert.equal(generate({ ...transfer(), mode: 'walking' }, { mode: 'mixed' }).days[0].activities[1].transfer.mode, 'walking');
});

test('stop edits clear affected routes; checkboxes preserve routes; stay changes clear all routes', () => {
  const value = plan();
  const day = value.days[0];
  const checked = Plan.editPlan(value, { type: 'toggle', dayId: day.id, activityId: day.activities[0].id, completed: true });
  assert.deepEqual(checked.days[0].mobility, day.mobility);
  assert.deepEqual(checked.days[0].activities[1].transfer, day.activities[1].transfer);
  const deleted = Plan.editPlan(value, { type: 'delete', dayId: day.id, activityId: day.activities[0].id });
  assert.equal(deleted.days[0].mobility, null);
  assert.equal(deleted.days[0].activities[0].transfer, null);
  assert.equal(deleted.days[1].trafficNeedsReview, false);
  const moved = Plan.editPlan(value, { type: 'move', dayId: day.id, activityId: day.activities[1].id });
  assert.equal(moved.days[0].trafficNeedsReview, true);
  assert.equal(moved.days[1].trafficNeedsReview, true);
  assert.equal(moved.days[1].activities.every(item => item.transfer === null), true);
  const withStay = Plan.selectStay(value, { address: '50 Test Avenue, Test City' });
  assert.equal(withStay.days.every(day => day.trafficNeedsReview && !day.mobility), true);
  assert.equal(Plan.clearStay(value).days.every(day => day.trafficNeedsReview), true);
});

test('traffic preferences, sources and route advice survive restore, including older saved plans', () => {
  const value = plan();
  assert.deepEqual(Plan.restorePlan(JSON.parse(JSON.stringify(value))), value);
  const old = structuredClone(value);
  delete old.transportMode;
  delete old.traffic;
  old.days.forEach(day => { delete day.mobility; delete day.trafficNeedsReview; day.activities.forEach(item => delete item.transfer); });
  const restored = Plan.restorePlan(old);
  assert.ok(restored);
  assert.equal(restored.transportMode, 'mixed');
  assert.equal(restored.traffic.basis, 'unavailable');
  const sample = Plan.restorePlan({ ...Plan.demoPlan(trip), mode: 'demo' });
  assert.equal(sample.traffic.basis, 'unavailable');
  assert.deepEqual(sample.traffic.peakPeriods, []);
});
