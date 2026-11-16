(function () {
  const KEY = 'wingman.itinerary.v1';
  const output = document.querySelector('#output');
  const feedback = document.querySelector('#plan-feedback');
  const badge = document.querySelector('#response-mode');
  let plan = null;
  let report = null;
  let active = 0;
  let undo = null;
  let frame = 0;
  let busy = false;
  let storageAvailable = true;
  let researchRequest = null;
  let addressDraft = null;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function notify(message) {
    feedback.textContent = message;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ plan, active, report })); }
    catch {
      storageAvailable = false;
      const note = output.querySelector('.save-note');
      if (note) note.textContent = 'Changes saved for this visit only';
      notify('Browser storage is unavailable. Your changes will last until this page closes.');
    }
  }

  function progress(day) {
    const tasks = [...day.activities, ...(day.hotel ? [day.hotel] : [])];
    return `${tasks.filter(task => task.completed).length} / ${tasks.length} complete`;
  }

  function dateLabel(date) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${date}T00:00:00Z`));
  }

  function syncNavigation() {
    const track = output.querySelector('.day-track');
    if (!track) return;
    output.querySelectorAll('.day-tab').forEach((tab, index) => {
      tab.classList.toggle('is-active', index === active);
      if (index === active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    output.querySelectorAll('.day-card').forEach((card, index) => {
      card.inert = index !== active;
      card.setAttribute('aria-hidden', String(index !== active));
    });
    output.querySelector('[data-nav="previous"]').disabled = active === 0;
    output.querySelector('[data-nav="next"]').disabled = active === plan.days.length - 1;
    output.querySelector('.day-counter').textContent = `Day ${active + 1} of ${plan.days.length}`;
  }

  function go(index, smooth = true) {
    active = Math.max(0, Math.min(index, plan.days.length - 1));
    const track = output.querySelector('.day-track');
    track.scrollTo({ left: active * track.clientWidth,
      behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
    syncNavigation();
    save();
  }

  function taskRow(day, item, index, hotel = false) {
    const row = el('li', `task-row${item.completed ? ' is-complete' : ''}${hotel ? ' hotel-task' : ''}`);
    if (!hotel && item.transfer) {
      const transfer = item.transfer;
      const previous = day.activities[day.activities.findIndex(activity => activity.id === item.id) - 1];
      const journey = el('div', 'transfer-card');
      journey.append(el('p', 'transfer-time', `Proposed ${transfer.departureTime} - ${transfer.arrivalTime} | ${transfer.mode} | local time`));
      journey.append(el('p', '', `From ${previous?.location || previous?.title || 'previous stop'} to ${item.location || item.title}`));
      journey.append(el('p', '', transfer.reason));
      if (transfer.bufferMinutes !== null) journey.append(el('p', '', `Includes ${transfer.bufferMinutes} min of suggested buffer. This slot is an estimate, not a live ETA.`));
      if (transfer.alternative) journey.append(el('p', '', `Alternative: ${transfer.alternative}`));
      const overlaps = TravelPlan.transferPeakWarnings(plan.traffic, day.date, transfer);
      if (overlaps.length) journey.append(el('p', 'traffic-warning', `This slot overlaps a typical busy period in ${[...new Set(overlaps.map(period => period.area))].join('; ')}. Check whether it affects your route${transfer.mode === 'transit' ? ' or transit service' : ''}.`));
      row.append(journey);
    }
    const label = el('label', 'task-label');
    const checkbox = el('input', 'task-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = item.completed;
    checkbox.disabled = busy;
    checkbox.dataset.action = hotel ? 'hotel' : 'toggle';
    checkbox.dataset.dayId = day.id;
    checkbox.dataset.activityId = item.id;
    const copy = el('span', 'task-copy');
    copy.append(el('span', 'task-time', hotel ? 'ACCOMMODATION' : item.timeOfDay));
    copy.append(el('span', 'task-title', hotel ? 'Check in to your accommodation' : item.title));
    copy.append(el('span', 'task-details', hotel ? 'Your choice of hotel or stay. No specific hotel is required.' : item.details));
    if (item.movedFrom) copy.append(el('span', 'moved-note', `Moved from Day ${item.movedFrom} - review your timing`));
    label.append(checkbox, copy);
    row.append(label);
    if (!hotel) {
      const actions = el('div', 'task-actions');
      const move = el('button', 'text-button', 'Move to next day');
      move.type = 'button';
      move.disabled = busy || item.completed || index === plan.days.length - 1;
      move.title = item.completed ? 'Uncheck this activity before moving it.'
        : index === plan.days.length - 1 ? 'This is the last day of your trip.' : `Move to Day ${index + 2}`;
      move.setAttribute('aria-label', `Move ${item.title} to the next day`);
      const remove = el('button', 'text-button delete-button', 'Delete');
      remove.type = 'button';
      remove.disabled = busy;
      remove.setAttribute('aria-label', `Delete ${item.title}`);
      [move, remove].forEach((button, buttonIndex) => {
        button.dataset.action = buttonIndex === 0 ? 'move' : 'delete';
        button.dataset.dayId = day.id;
        button.dataset.activityId = item.id;
      });
      actions.append(move, remove);
      row.append(actions);
    }
    return row;
  }

  function sourceLink(source) {
    const link = el('a', 'research-source', source.title || new URL(source.url).hostname);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function trafficSection(day) {
    const section = el('section', 'traffic-section');
    section.append(el('h4', '', 'Getting around & peak hours'));
    const traffic = plan.traffic;
    const labels = { driving: 'Driving', transit: 'Public transit', walking: 'Walking', cycling: 'Cycling', mixed: 'Mixed transport' };
    section.append(el('p', 'traffic-meta', `${labels[plan.transportMode] || labels.mixed} | ${traffic.timeZone || 'Destination local time; timezone unverified'}`));
    if (day.trafficNeedsReview) section.append(el('p', 'traffic-warning', 'Your stops or accommodation changed. Previous route advice and transfer slots were cleared. Generate a new plan to reconsider traffic and timing.'));
    else if (day.mobility) section.append(el('p', 'traffic-strategy', day.mobility.strategy));
    const periods = TravelPlan.peakPeriodsForDate(traffic, day.date);
    if (periods.length) {
      const list = el('ul', 'traffic-periods');
      periods.forEach(period => {
        list.append(el('li', '', `${period.label}: ${period.startTime}-${period.endTime} | ${period.area}`));
      });
      section.append(list);
    } else if (traffic.basis === 'sourced_patterns') section.append(el('p', '', 'No verified peak-hour windows for this weekday. This does not mean roads will be clear.'));

    const details = el('details', 'traffic-details');
    details.append(el('summary', '', 'Sources & limitations'));
    details.append(el('p', '', traffic.basis === 'sourced_patterns'
      ? 'Based on published patterns and, when detailed data is limited, recent local community discussion. Community reports are anecdotal context, not live traffic.'
      : traffic.basis === 'assumptions'
        ? 'No source-backed local peak-hour windows were found. Timing and route choices are planning assumptions.'
        : 'Local traffic research is unavailable. Generate a connected plan to research published patterns and recent community context.'));
    periods.forEach(period => {
      details.append(el('p', 'traffic-evidence', `${period.label}: ${period.description}`));
      const links = el('div', 'venue-sources');
      period.sources.forEach(source => links.append(sourceLink(source)));
      details.append(links);
    });
    details.append(el('p', '', 'Weekday patterns may not apply to holidays, events or a specific route. Travel slots and buffers are estimates; check live navigation before departure. The first transfer from your accommodation is not calculated.'));
    if (traffic.retrievedAt) details.append(el('p', 'research-time', `Researched ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(traffic.retrievedAt))}`));
    section.append(details);
    return section;
  }

  function venueCard(venue, kind) {
    const card = el('article', 'venue-card');
    card.append(el('h4', '', venue.name));
    if (venue.address) card.append(el('p', 'venue-address', venue.address));
    const price = venue.price;
    card.append(el('p', 'venue-price', price ? `${price.text} ${kind === 'hotel' ? 'per room / night' : 'per person'}` : 'Price not found in retrieved sources'));
    if (price) {
      card.append(el('span', 'price-kind', price.kind === 'menu_estimate' ? 'Menu-based estimate' : 'Published price reference'));
      card.append(el('p', 'venue-basis', price.basis));
      if (price.dateBasis) card.append(el('p', 'venue-basis', price.dateBasis));
      const source = venue.sources.find(item => item.url === price.sourceUrl);
      card.append(sourceLink({ ...source, title: 'Price source' }));
    }
    if (venue.description) card.append(el('p', 'venue-description', venue.description));
    if (venue.whyKnown) card.append(el('p', 'venue-description', `Known for: ${venue.whyKnown}`));
    if (venue.proximity) card.append(el('p', 'venue-basis', venue.proximity));
    const sources = el('div', 'venue-sources');
    venue.sources.forEach(source => sources.append(sourceLink(source)));
    card.append(sources);
    if (kind === 'hotel') {
      const label = el('label', 'stay-choice');
      const choice = el('input', 'stay-choice-input');
      choice.type = 'checkbox';
      choice.checked = plan.stay?.hotelId === venue.id;
      choice.disabled = busy || !venue.address;
      choice.dataset.hotelId = venue.id;
      choice.setAttribute('aria-label', `Confirm ${venue.name} as your accommodation`);
      label.append(choice, el('span', '', venue.address ? 'I will stay here' : 'Enter an address below to confirm this stay'));
      card.append(label);
    }
    return card;
  }

  function researchResults(research, kind, emptyMessage) {
    const wrapper = el('div', 'research-results');
    if (research?.retrievedAt) wrapper.append(el('p', 'research-time', `Looked up ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(research.retrievedAt))}`));
    if (research?.items?.length) {
      const grid = el('div', 'venue-grid');
      research.items.forEach(venue => grid.append(venueCard(venue, kind)));
      wrapper.append(grid);
    } else wrapper.append(el('p', 'research-empty', emptyMessage));
    return wrapper;
  }

  function diningSection(day) {
    const section = el('section', 'dining-section');
    const stop = day ? TravelPlan.lastStop(day) : null;
    section.append(el('h4', '', day ? 'Famous restaurants near your last stop' : 'Famous restaurants near your accommodation'));
    if (day && !stop) {
      section.append(el('p', 'research-empty', 'No sightseeing stop remains on this day.'));
      return section;
    }
    const anchorKey = day ? stop.key : plan.stay.key;
    section.append(el('p', 'dining-anchor', day ? `Around ${stop.label}${stop.location ? `, ${stop.location}` : ''}` : plan.stay.address));
    const research = day ? day.dining : plan.nearStay;
    const matching = research?.anchorKey === anchorKey ? research : null;
    section.append(researchResults(matching, 'restaurant', matching?.mode === 'web'
      ? 'No source-backed restaurants were found for this location. Try another search or verify the address.'
      : 'Search for nearby restaurants and source-based per-person price references. Demo mode does not retrieve restaurant data.'));
    const queryKey = day ? day.id : 'stay';
    const searching = researchRequest?.key === queryKey;
    const button = el('button', 'secondary-button', searching ? 'Searching the web...' : matching?.items?.length ? 'Refresh restaurant suggestions' : 'Find nearby restaurants');
    button.type = 'button';
    button.disabled = busy || searching;
    button.setAttribute('aria-label', `Find restaurants near ${day ? stop.label : plan.stay.address}`);
    button.addEventListener('click', () => requestDining(day ? day.id : null));
    section.append(button);
    return section;
  }

  function staySection() {
    const section = el('section', 'stay-section');
    section.append(el('h3', '', 'Where will you stay?'));
    section.append(el('p', 'stay-help', 'Choose a suggested hotel or enter your own address. Selection confirms your accommodation choice; it does not book a room or mark you as checked in.'));
    section.append(researchResults(plan.hotels, 'hotel', plan.hotels?.mode === 'web'
      ? 'No source-backed hotel options were found. Enter your own address below, or generate a new plan to search again.'
      : 'Connect ChatGPT with web search and generate a new plan for hotel suggestions with published price references.'));
    const form = el('form', 'stay-form');
    const label = el('label', '', 'Your hotel or accommodation address');
    label.htmlFor = 'stay-address';
    const input = el('input', 'stay-address');
    input.id = 'stay-address';
    input.name = 'stayAddress';
    input.type = 'text';
    input.required = true;
    input.minLength = 5;
    input.maxLength = 500;
    input.placeholder = 'Street address, city, country';
    input.autocomplete = 'off';
    input.value = addressDraft ?? plan.stay?.address ?? '';
    input.disabled = busy;
    input.addEventListener('input', () => { addressDraft = input.value; });
    const confirm = el('button', 'secondary-button', 'Confirm address & find restaurants');
    confirm.type = 'submit';
    confirm.disabled = busy;
    form.append(label, input, el('p', 'address-notice', 'Confirming sends this address to OpenAI to search for nearby restaurants using your ChatGPT plan.'), confirm);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (form.reportValidity()) confirmStay({ address: input.value });
    });
    section.append(form);
    if (plan.stay) {
      section.append(el('p', 'confirmed-stay', `Confirmed stay: ${plan.stay.name} - ${plan.stay.address}`));
      section.append(diningSection(null));
    }
    return section;
  }

  function confirmStay(input) {
    if (!plan || busy) return;
    try {
      cancelResearch();
      undo = { plan: structuredClone(plan), active };
      plan = TravelPlan.selectStay(plan, input);
      addressDraft = plan.stay.address;
      render();
      save();
      requestDining(null);
    } catch (error) { notify(error.message); }
  }

  function cancelResearch() {
    researchRequest?.controller.abort();
    researchRequest = null;
  }

  async function requestDining(dayId) {
    if (!plan || busy) return;
    const day = dayId ? plan.days.find(value => value.id === dayId) : null;
    const stop = day ? TravelPlan.lastStop(day) : null;
    if (dayId && !stop || !dayId && !plan.stay) return;
    cancelResearch();
    const pending = { key: dayId || 'stay', controller: new AbortController(), planId: plan.id,
      anchorKey: day ? stop.key : plan.stay.key };
    researchRequest = pending;
    const anchor = day ? { kind: 'day', name: stop.label, address: stop.location, date: day.date }
      : { kind: 'stay', name: plan.stay.name, address: plan.stay.address };
    render();
    notify('Searching for well-known nearby restaurants and published per-person price references...');
    const timeout = setTimeout(() => pending.controller.abort(), 240000);
    try {
      const response = await fetch('/api/dining', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TravelWingMan' },
        body: JSON.stringify({ trip: TravelPlan.validateTrip(plan), anchor }), signal: pending.controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restaurant search could not be completed.');
      if (researchRequest !== pending || plan.id !== pending.planId) return;
      const currentDay = dayId ? plan.days.find(value => value.id === dayId) : null;
      const currentKey = dayId ? TravelPlan.lastStop(currentDay)?.key : plan.stay?.key;
      if (currentKey !== pending.anchorKey) {
        notify('The location changed while searching. Search again for the updated location.');
        return;
      }
      const research = { ...data.recommendations, anchorKey: pending.anchorKey,
        anchorLabel: day ? stop.label : anchor.address };
      if (currentDay) currentDay.dining = research;
      else plan.nearStay = research;
      notify(data.mode === 'demo' ? 'Demo mode: no live restaurant search was performed. Connect ChatGPT with web search to retrieve recommendations.'
        : research.items?.length ? 'Restaurant suggestions updated. Check menu prices, taxes, tips and opening hours before going.'
          : 'No source-backed restaurant suggestions were returned for this location.');
      save();
    } catch (error) {
      if (researchRequest === pending) notify(error.name === 'AbortError' ? 'Restaurant search timed out. Please try again.' : error.message);
    } finally {
      clearTimeout(timeout);
      if (researchRequest === pending) {
        researchRequest = null;
        render();
      }
    }
  }

  function render() {
    if (!plan) return;
    if (!report) report = TravelPlan.createReport(plan);
    cancelAnimationFrame(frame);
    output.replaceChildren();
    output.classList.remove('is-empty', 'is-error');
    output.classList.add('has-itinerary');
    badge.textContent = plan.mode === 'chatgpt' ? 'ChatGPT itinerary' : 'Demo itinerary';

    const summary = el('div', 'trip-summary');
    summary.append(el('h3', '', plan.destination));
    summary.append(el('p', 'trip-meta', `${dateLabel(plan.startDate)} - ${dateLabel(plan.endDate)} | ${plan.dayCount} ${plan.dayCount === 1 ? 'day' : 'days'} | $${plan.budget.toLocaleString('en-US', { maximumFractionDigits: 2 })} total budget`));
    if (plan.summary) summary.append(el('p', 'trip-description', plan.summary));
    output.append(summary);
    output.append(staySection());

    const navigation = el('div', 'day-navigation');
    const tabs = el('nav', 'day-tabs');
    tabs.setAttribute('aria-label', 'Choose a trip day');
    plan.days.forEach((day, index) => {
      const tab = el('button', 'day-tab', `Day ${index + 1}`);
      tab.type = 'button';
      tab.setAttribute('aria-label', `Show Day ${index + 1}, ${dateLabel(day.date)}`);
      tab.addEventListener('click', () => go(index));
      tabs.append(tab);
    });
    const arrows = el('div', 'day-arrows');
    const previous = el('button', 'arrow-button', '\u2190');
    const next = el('button', 'arrow-button', '\u2192');
    previous.dataset.nav = 'previous';
    next.dataset.nav = 'next';
    previous.setAttribute('aria-label', 'Previous day');
    next.setAttribute('aria-label', 'Next day');
    previous.type = next.type = 'button';
    previous.addEventListener('click', () => go(active - 1));
    next.addEventListener('click', () => go(active + 1));
    arrows.append(previous, next);
    navigation.append(tabs, arrows);
    output.append(navigation);

    const track = el('div', 'day-track');
    track.setAttribute('role', 'region');
    track.setAttribute('aria-roledescription', 'carousel');
    track.setAttribute('aria-label', 'Daily itinerary. Swipe horizontally or use the day buttons.');
    plan.days.forEach((day, index) => {
      const card = el('section', 'day-card');
      card.setAttribute('aria-label', `Day ${index + 1}, ${dateLabel(day.date)}`);
      const heading = el('div', 'day-card-heading');
      const headingCopy = el('div');
      headingCopy.append(el('p', 'day-date', `DAY ${index + 1} / ${dateLabel(day.date)}`));
      headingCopy.append(el('h3', '', day.title));
      heading.append(headingCopy, el('span', 'day-progress', progress(day)));
      card.append(heading);
      card.append(trafficSection(day));
      const list = el('ul', 'task-list');
      if (day.hotel) list.append(taskRow(day, day.hotel, index, true));
      day.activities.forEach(item => list.append(taskRow(day, item, index)));
      card.append(list);
      if (!day.activities.length) card.append(el('p', 'empty-day', 'No activities planned. Enjoy some free time, or move an unfinished activity here from the previous day.'));
      card.append(diningSection(day));
      track.append(card);
    });
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!track.clientWidth) return;
        const index = Math.round(track.scrollLeft / track.clientWidth);
        if (active !== index) {
          active = Math.max(0, Math.min(index, plan.days.length - 1));
          syncNavigation();
          save();
        }
      });
    }, { passive: true });
    track.addEventListener('keydown', event => {
      if (event.target.tagName === 'INPUT') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        go(active + (event.key === 'ArrowRight' ? 1 : -1));
      }
    });
    output.append(track);
    const footer = el('div', 'itinerary-footer');
    footer.append(el('span', 'day-counter'));
    if (report) {
      const download = el('button', 'text-button report-download', 'Download report.json');
      download.type = 'button';
      download.disabled = busy;
      download.title = 'Download a concise summary of this travel plan';
      download.addEventListener('click', () => {
        report = TravelPlan.createReport(plan, report.generated_at);
        save();
        const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'report.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      });
      footer.append(download);
    }
    if (undo) {
      const undoButton = el('button', 'text-button', 'Undo last change');
      undoButton.type = 'button';
      undoButton.disabled = busy;
      undoButton.addEventListener('click', () => {
        ({ plan, active } = undo);
        undo = null;
        render();
        save();
        notify('Last change undone.');
        output.querySelectorAll('.day-tab')[active].focus({ preventScroll: true });
      });
      footer.append(undoButton);
    }
    footer.append(el('span', 'save-note', storageAvailable ? 'Changes saved in this browser' : 'Changes saved for this visit only'));
    output.append(footer);
    if (plan.notes.length) {
      const notes = el('details', 'trip-notes');
      notes.append(el('summary', '', 'Trip notes & assumptions'));
      const list = el('ul');
      plan.notes.forEach(note => list.append(el('li', '', note)));
      notes.append(list);
      output.append(notes);
    }
    syncNavigation();
    // Restore the selected slide after replacing the DOM, without page scrolling.
    track.scrollLeft = active * track.clientWidth;
  }

  function applyAction(target) {
    if (!plan || busy) return;
    const action = { type: target.dataset.action, dayId: target.dataset.dayId,
      activityId: target.dataset.activityId, completed: target.checked };
    const old = { plan: structuredClone(plan), active };
    try {
      plan = TravelPlan.editPlan(plan, action);
      undo = old;
      if (action.type === 'move') active = plan.days.findIndex(day => day.id === action.dayId) + 1;
      render();
      save();
      notify(action.type === 'move' ? `Activity moved to Day ${active + 1}. Check that it fits the day.`
        : action.type === 'delete' ? 'Activity deleted. You can undo this change.'
          : action.completed ? 'Marked complete.' : 'Marked incomplete.');
      const checkbox = [...output.querySelectorAll('.task-checkbox')].find(node => node.dataset.activityId === action.activityId);
      if (checkbox) checkbox.focus({ preventScroll: true });
      else output.querySelectorAll('.day-tab')[active].focus({ preventScroll: true });
    } catch (error) { notify(error.message); }
  }

  output.addEventListener('change', event => {
    if (event.target.matches('.task-checkbox')) applyAction(event.target);
    if (event.target.matches('.stay-choice-input')) {
      if (event.target.checked) confirmStay({ hotelId: event.target.dataset.hotelId });
      else {
        cancelResearch();
        undo = { plan: structuredClone(plan), active };
        plan = TravelPlan.clearStay(plan);
        addressDraft = null;
        render();
        save();
        notify('Accommodation choice cleared. Your check-in checklist is unchanged.');
      }
    }
  });
  output.addEventListener('click', event => {
    const target = event.target.closest('button[data-action]');
    if (target && !target.disabled) applyAction(target);
  });
  let resize;
  window.addEventListener('resize', () => {
    clearTimeout(resize);
    resize = setTimeout(() => { if (plan) go(active, false); }, 100);
  });

  window.itineraryView = {
    hasPlan: () => Boolean(plan),
    getTrip: () => plan ? TravelPlan.validateTrip(plan) : null,
    cancelResearch,
    show(value, reportValue = null) {
      const restored = TravelPlan.restorePlan(value);
      if (!restored) throw new Error('The daily itinerary could not be read. Please generate it again.');
      cancelResearch();
      addressDraft = null;
      plan = restored;
      report = reportValue?.report_type === 'travel_plan_summary'
        ? structuredClone(reportValue) : TravelPlan.createReport(restored);
      active = 0;
      undo = null;
      render();
      save();
      notify('Your daily plan is ready. Swipe between days and tick activities as you go.');
    },
    setBusy(value) {
      if (value) cancelResearch();
      busy = value;
      output.setAttribute('aria-busy', String(value));
      if (plan) render();
    },
    notify,
  };

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    const restored = saved && TravelPlan.restorePlan(saved.plan);
    if (restored) {
      plan = restored;
      report = saved.report?.report_type === 'travel_plan_summary'
        ? saved.report : TravelPlan.createReport(restored);
      active = Number.isInteger(saved.active) ? Math.max(0, Math.min(saved.active, plan.days.length - 1)) : 0;
      render();
      notify('Restored your saved itinerary and progress from this browser.');
    }
  } catch { storageAvailable = false; }
})();
