(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TravelPlan = api;
})(globalThis, function () {
  const DAY = 86400000;
  const traveler = Object.freeze({ name: 'User1', origin: 'San Francisco, CA, USA' });
  const id = () => globalThis.crypto.randomUUID();
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const transportModes = ['driving', 'transit', 'walking', 'cycling', 'mixed'];
  const travelModes = ['driving', 'flying'];
  const clockTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';

  function dateValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const stamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : NaN;
  }

  function validateTrip(input, options = {}) {
    if (!input || typeof input !== 'object') fail('Please enter your trip details.');
    const destination = text(input.destination, 120);
    const start = dateValue(input.startDate);
    const end = dateValue(input.endDate);
    const budget = Number(input.budget);
    if (!destination && !options.destinationOptional) fail('Please enter a destination.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail('Please enter valid start and end dates.');
    const dayCount = (end - start) / DAY + 1;
    if (dayCount > 60) fail('Please plan up to 60 days at a time.');
    if (!Number.isFinite(budget) || budget <= 0) fail('Please enter a budget greater than zero.');
    const transportMode = input.transportMode === undefined ? 'mixed' : input.transportMode;
    if (!transportModes.includes(transportMode)) fail('Please choose a valid way to get around.');
    const travelMode = input.travelMode === undefined ? undefined : input.travelMode;
    if (travelMode !== undefined && !travelModes.includes(travelMode)) fail('Please choose driving or flying as your travel method.');
    return { destination, startDate: input.startDate, endDate: input.endDate, budget, dayCount, transportMode,
      ...(travelMode ? { travelMode } : {}) };
  }

  function normalizePlan(raw, input, research = {}) {
    const trip = validateTrip(input);
    if (!raw || !Array.isArray(raw.days) || raw.days.length !== trip.dayCount) {
      fail('The AI plan did not cover the selected dates. Please generate it again.');
    }
    const plan = {
      version: 1, id: id(), ...trip, summary: text(raw.summary, 2000),
      notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 8).map(note => text(note, 1000)).filter(Boolean) : [],
      days: raw.days.map((day, index) => {
        if (!day || !Array.isArray(day.activities) || day.activities.length > 12) {
          fail('The AI returned an unreadable daily plan. Please generate it again.');
        }
        return {
          id: id(), date: new Date(dateValue(trip.startDate) + index * DAY).toISOString().slice(0, 10),
          title: text(day.title, 160) || 'Explore at your own pace',
          mobility: normalizeMobility(day.mobility),
          trafficNeedsReview: false,
          hotel: index === 0 ? { id: id(), completed: false } : null,
          activities: day.activities.map((activity, activityIndex) => {
            if (!activity || !text(activity.title, 200)) fail('An activity was missing its title. Please generate the plan again.');
            return { id: id(), title: text(activity.title, 200), details: text(activity.details, 1200),
              kind: ['attraction', 'meal', 'travel', 'other'].includes(activity.kind) ? activity.kind : 'attraction',
              location: text(activity.location, 500),
              transfer: activityIndex > 0 && text(day.activities[activityIndex - 1]?.location, 500) && text(activity.location, 500)
                ? normalizeTransfer(activity.transfer, trip.transportMode) : null,
              timeOfDay: text(activity.timeOfDay, 60) || 'Flexible', completed: false, movedFrom: null };
          }),
        };
      }),
    };
    plan.hotels = normalizeResearch(raw.hotels, research, 'hotel');
    plan.traffic = normalizeTraffic(raw.traffic, research);
    plan.days.forEach((day, index) => {
      const stop = lastStop(day);
      day.dining = stop ? { ...normalizeResearch(raw.days[index].restaurants, research, 'restaurant'),
        anchorKey: stop.key, anchorLabel: stop.label } : null;
    });
    return plan;
  }

  function parsePlan(reply, trip, research) {
    let raw;
    try { raw = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { fail('The AI response was not a readable daily plan. Please generate it again.'); }
    const resolvedTrip = trip.destination ? trip : { ...trip, destination: text(raw?.destination, 120) };
    if (!resolvedTrip.destination) fail('The AI did not choose a destination. Please generate the plan again.');
    return normalizePlan(raw, resolvedTrip, research);
  }

  function createReport(plan, generatedAt = new Date().toISOString()) {
    const restored = restorePlan(plan);
    if (!restored) fail('The itinerary could not be summarized.');
    const compactVenue = venue => ({
      name: venue.name,
      ...(venue.address ? { address: venue.address } : {}),
      ...(venue.price?.text ? { price_reference: venue.price.text } : {}),
    });
    return {
      schema_version: '1.0',
      report_type: 'travel_plan_summary',
      generated_at: generatedAt,
      trip: {
        destination: restored.destination,
        start_date: restored.startDate,
        end_date: restored.endDate,
        day_count: restored.dayCount,
        budget_usd: restored.budget,
        transportation: restored.travelMode || restored.transportMode,
      },
      summary: restored.summary,
      daily_plan: restored.days.map(day => ({
        date: day.date,
        title: day.title,
        ...(day.mobility?.strategy ? { getting_around: day.mobility.strategy } : {}),
        activities: day.activities.map(activity => ({
          time: activity.timeOfDay,
          title: activity.title,
          type: activity.kind || 'attraction',
          ...(activity.location ? { location: activity.location } : {}),
          ...(activity.details ? { description: activity.details } : {}),
        })),
        restaurant_suggestions: (day.dining?.items || []).map(compactVenue),
      })),
      accommodation_options: (restored.hotels?.items || []).map(compactVenue),
      notes: restored.notes,
    };
  }

  function demoPlan(input) {
    const trip = validateTrip(input);
    return normalizePlan({
      summary: `A sample ${trip.dayCount}-day checklist for ${trip.destination}. Connect ChatGPT to generate personalized activities.`,
      notes: ['These are sample activities, not researched recommendations.', 'Choose your own accommodation. Moving an activity does not verify opening hours, travel time, or budget.'],
      days: Array.from({ length: trip.dayCount }, (_, index) => ({
        title: index === 0 ? 'Arrive and get to know the area' : 'Discover something new',
        activities: [
          { title: index === 0 ? 'Explore the neighborhood' : 'Visit a local landmark', timeOfDay: 'Morning', details: `Choose a place you would like to explore in ${trip.destination}. Sample activity only.` },
          { title: 'Visit a museum or park', timeOfDay: 'Afternoon', details: 'Pick an attraction that matches your interests. Check its opening hours before going.' },
          { title: 'Try a local restaurant', kind: 'meal', timeOfDay: 'Evening', details: 'Choose a meal within your remaining budget.' },
        ],
      })),
    }, trip);
  }

  function editPlan(plan, action) {
    const next = structuredClone(plan);
    const index = next.days.findIndex(day => day.id === action.dayId);
    if (index < 0) fail('This day is no longer available.');
    const day = next.days[index];
    if (action.type === 'hotel') {
      if (!day.hotel) fail('There is no check-in task on this day.');
      day.hotel.completed = Boolean(action.completed);
      return next;
    }
    const itemIndex = day.activities.findIndex(item => item.id === action.activityId);
    if (itemIndex < 0) fail('This activity is no longer available.');
    const item = day.activities[itemIndex];
    if (action.type === 'toggle') item.completed = Boolean(action.completed);
    else if (action.type === 'delete') day.activities.splice(itemIndex, 1);
    else if (action.type === 'move') {
      if (item.completed) fail('Only unfinished activities can be moved.');
      if (!next.days[index + 1]) fail('There is no next day within your travel dates.');
      if (next.days[index + 1].activities.length >= 500) fail('The next day has too many activities.');
      day.activities.splice(itemIndex, 1);
      item.movedFrom = item.movedFrom || index + 1;
      item.timeOfDay = 'Flexible';
      next.days[index + 1].activities.push(item);
    } else fail('Unknown itinerary action.');
    next.days.forEach((newDay, dayIndex) => {
      if (lastStop(newDay)?.key !== lastStop(plan.days[dayIndex])?.key) newDay.dining = null;
    });
    if (action.type === 'delete' || action.type === 'move') {
      invalidateTraffic(day);
      if (action.type === 'move') invalidateTraffic(next.days[index + 1]);
    }
    return next;
  }

  function normalizeMobility(value) {
    const strategy = text(value?.strategy, 1200);
    return strategy ? { strategy } : null;
  }

  function normalizeTransfer(value, preferredMode = 'mixed') {
    if (!value || !['driving', 'transit', 'walking', 'cycling'].includes(value.mode)
      || preferredMode !== 'mixed' && value.mode !== preferredMode) return null;
    const departureTime = clockTime(value.departureTime);
    const arrivalTime = clockTime(value.arrivalTime);
    // Times describe proposed same-day slots, never measured ETAs.
    if (!departureTime || !arrivalTime || arrivalTime <= departureTime || !text(value.reason, 700)) return null;
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    return { mode: value.mode, departureTime, arrivalTime, reason: text(value.reason, 700),
      alternative: text(value.alternative, 500),
      bufferMinutes: Number.isInteger(value.bufferMinutes) && value.bufferMinutes >= 0
        && value.bufferMinutes <= Math.min(180, minutes(arrivalTime) - minutes(departureTime))
        ? value.bufferMinutes : null };
  }

  function normalizeTraffic(value, research = {}) {
    let timeZone = text(value?.timeZone, 80);
    try { if (!timeZone) throw new Error(); new Intl.DateTimeFormat('en', { timeZone }); }
    catch { timeZone = ''; }
    const allowed = new Set((research.sources || []).map(source => safeUrl(typeof source === 'string' ? source : source?.url)).filter(Boolean));
    const peakPeriods = [];
    if (research.usedSearch === true && timeZone && Array.isArray(value?.peakPeriods)) {
      value.peakPeriods.slice(0, 12).forEach(period => {
        const startTime = clockTime(period?.startTime);
        const endTime = clockTime(period?.endTime);
        const daysOfWeek = Array.isArray(period?.daysOfWeek)
          ? [...new Set(period.daysOfWeek.filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b) : [];
        const sources = (Array.isArray(period?.sources) ? period.sources : []).slice(0, 5)
          .map(source => ({ url: safeUrl(source?.url), title: text(source?.title, 180) || 'Traffic source' }))
          .filter(source => source.url && allowed.has(source.url));
        if (!startTime || !endTime || startTime >= endTime || !daysOfWeek.length || !sources.length
          || !text(period.area, 300) || !text(period.description, 700)) return;
        peakPeriods.push({ label: text(period.label, 120) || 'Typical busy period', startTime, endTime,
          daysOfWeek, area: text(period.area, 300), description: text(period.description, 700), sources });
      });
    }
    return { basis: peakPeriods.length ? 'sourced_patterns' : research.usedSearch === true ? 'assumptions' : 'unavailable',
      timeZone, peakPeriods,
      retrievedAt: research.usedSearch === true && typeof research.retrievedAt === 'string' && Number.isFinite(Date.parse(research.retrievedAt))
        ? research.retrievedAt : null };
  }

  function peakPeriodsForDate(traffic, date) {
    const stamp = dateValue(date);
    if (!Number.isFinite(stamp)) return [];
    const dayOfWeek = new Date(stamp).getUTCDay() || 7;
    return (traffic?.peakPeriods || []).filter(period => period.daysOfWeek.includes(dayOfWeek));
  }

  function transferPeakWarnings(traffic, date, transfer) {
    if (!transfer || !['driving', 'transit'].includes(transfer.mode)) return [];
    return peakPeriodsForDate(traffic, date).filter(period => transfer.departureTime < period.endTime && transfer.arrivalTime > period.startTime);
  }

  function invalidateTraffic(day) {
    day.trafficNeedsReview = true;
    day.mobility = null;
    day.activities.forEach(item => { item.transfer = null; });
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || /^(localhost|127\.|\[::1\])/.test(url.hostname)) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }

  function normalizeResearch(values, research = {}, kind = 'restaurant') {
    const available = research.usedSearch === true;
    const allowed = new Set((research.sources || []).map(source => safeUrl(typeof source === 'string' ? source : source?.url)).filter(Boolean));
    const retrievedAt = typeof research.retrievedAt === 'string' && Number.isFinite(Date.parse(research.retrievedAt)) ? research.retrievedAt : null;
    const items = [];
    if (available && Array.isArray(values)) values.slice(0, 4).forEach(value => {
      if (!value || !text(value.name, 180)) return;
      const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 5)
        .map(source => ({ url: safeUrl(source?.url), title: text(source?.title, 180) || 'Source' }))
        .filter(source => source.url && allowed.has(source.url));
      if (!sources.length) return;
      const priceSource = safeUrl(value.price?.sourceUrl);
      const hasPrice = sources.some(source => source.url === priceSource)
        && text(value.price?.text, 160) && text(value.price?.basis, 500);
      items.push({
        id: research.preserveIds === true && typeof value.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value.id) ? value.id : id(),
        name: text(value.name, 180), address: text(value.address, 500),
        description: text(value.description, 700), whyKnown: text(value.whyKnown, 500),
        proximity: text(value.proximity, 300), sources,
        price: hasPrice ? { text: text(value.price.text, 160), basis: text(value.price.basis, 500),
          sourceUrl: priceSource, dateBasis: text(value.price.dateBasis, 300),
          kind: value.price.kind === 'menu_estimate' && kind === 'restaurant' ? 'menu_estimate' : 'published_reference' } : null,
      });
    });
    return { mode: available ? 'web' : 'unavailable', retrievedAt, items };
  }

  function lastStop(day) {
    if (!day || !Array.isArray(day.activities)) return null;
    const activity = [...day.activities].reverse().find(item => item.kind !== 'meal' && item.kind !== 'travel'
      && (item.kind || !/restaurant|dinner|lunch|breakfast|meal/i.test(item.title)));
    return activity ? { key: JSON.stringify([activity.id, activity.title, activity.location || '']),
      label: activity.title, location: activity.location || '', activityId: activity.id } : null;
  }

  function selectStay(plan, input) {
    const next = structuredClone(plan);
    const option = input.hotelId ? next.hotels?.items.find(item => item.id === input.hotelId) : null;
    if (input.hotelId && !option) fail('This hotel suggestion is no longer available.');
    const address = text(option ? option.address : input.address, 500);
    if (address.length < 5) fail('Please enter a complete hotel address, including its city.');
    const stay = { name: option ? option.name : text(input.name, 180) || 'Your accommodation',
      address, hotelId: option?.id || null };
    stay.key = JSON.stringify([stay.hotelId, stay.address]);
    if (stay.key !== next.stay?.key) {
      next.nearStay = null;
      next.days.forEach(invalidateTraffic);
    }
    next.stay = stay;
    return next;
  }

  function restoreResearch(value, kind) {
    if (!value || !Array.isArray(value.items)) return null;
    return normalizeResearch(value.items, { preserveIds: true, usedSearch: value.mode === 'web', retrievedAt: value.retrievedAt,
      sources: value.items.flatMap(item => Array.isArray(item?.sources) ? item.sources : []) }, kind);
  }

  function clearStay(plan) {
    const next = structuredClone(plan);
    delete next.stay;
    delete next.nearStay;
    next.days.forEach(invalidateTraffic);
    return next;
  }

  function restorePlan(value) {
    try {
      const trip = validateTrip(value);
      if (value.version !== 1 || !['demo', 'chatgpt'].includes(value.mode)
        || value.days.length !== trip.dayCount || typeof value.summary !== 'string'
        || value.summary.length > 2000 || !Array.isArray(value.notes)
        || value.notes.length > 8 || value.notes.some(note => typeof note !== 'string' || note.length > 1000)) return null;
      const ids = new Set();
      function checkId(idValue) {
        if (typeof idValue !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(idValue) || ids.has(idValue)) throw new Error();
        ids.add(idValue);
      }
      checkId(value.id);
      value.days.forEach((day, index) => {
        checkId(day.id);
        if (day.date !== new Date(dateValue(trip.startDate) + index * DAY).toISOString().slice(0, 10)
          || typeof day.title !== 'string' || day.title.length > 160
          || !Array.isArray(day.activities) || day.activities.length > 500) throw new Error();
        if (day.hotel) {
          checkId(day.hotel.id);
          if (index !== 0 || typeof day.hotel.completed !== 'boolean') throw new Error();
        }
        day.activities.forEach(item => {
          checkId(item.id);
          if (typeof item.title !== 'string' || !item.title || item.title.length > 200
            || typeof item.details !== 'string' || item.details.length > 1200
            || typeof item.timeOfDay !== 'string' || item.timeOfDay.length > 60
            || typeof item.completed !== 'boolean'
            || (item.movedFrom !== null && (!Number.isInteger(item.movedFrom) || item.movedFrom < 1 || item.movedFrom > trip.dayCount))) throw new Error();
        });
      });
      const result = structuredClone(value);
      result.transportMode = trip.transportMode;
      const savedTraffic = value.traffic;
      result.traffic = normalizeTraffic(savedTraffic, {
        usedSearch: value.mode === 'chatgpt' && ['sourced_patterns', 'assumptions'].includes(savedTraffic?.basis),
        retrievedAt: savedTraffic?.retrievedAt,
        sources: (Array.isArray(savedTraffic?.peakPeriods) ? savedTraffic.peakPeriods : [])
          .flatMap(period => Array.isArray(period?.sources) ? period.sources : []),
      });
      result.hotels = restoreResearch(value.hotels, 'hotel') || normalizeResearch();
      result.days.forEach(day => {
        day.trafficNeedsReview = day.trafficNeedsReview === true;
        day.mobility = day.trafficNeedsReview || value.mode === 'demo' ? null : normalizeMobility(day.mobility);
        day.activities.forEach((item, index) => {
          item.kind = ['attraction', 'meal', 'travel', 'other'].includes(item.kind) ? item.kind : undefined;
          item.location = text(item.location, 500);
          item.transfer = index > 0 && text(day.activities[index - 1]?.location, 500) && item.location && !day.trafficNeedsReview && value.mode !== 'demo'
            ? normalizeTransfer(item.transfer, trip.transportMode) : null;
        });
        const stop = lastStop(day);
        day.dining = day.dining && stop && day.dining.anchorKey === stop.key
          ? { ...restoreResearch(day.dining, 'restaurant'), anchorKey: stop.key, anchorLabel: stop.label } : null;
      });
      if (value.stay && typeof value.stay.address === 'string') {
        const restored = selectStay(result, { address: value.stay.address, name: value.stay.name });
        if (value.stay.hotelId && result.hotels.items.some(item => item.id === value.stay.hotelId)) {
          restored.stay = selectStay(result, { hotelId: value.stay.hotelId }).stay;
        }
        result.stay = restored.stay;
        result.nearStay = value.nearStay?.anchorKey === result.stay.key
          ? { ...restoreResearch(value.nearStay, 'restaurant'), anchorKey: result.stay.key, anchorLabel: result.stay.address } : null;
      } else { delete result.stay; delete result.nearStay; }
      return result;
    } catch { return null; }
  }

  return { traveler, validateTrip, normalizePlan, parsePlan, createReport, demoPlan, editPlan, restorePlan,
    normalizeResearch, lastStop, selectStay, clearStay, safeUrl, normalizeTraffic, peakPeriodsForDate, transferPeakWarnings };
});
