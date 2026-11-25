const form = document.querySelector('#trip-form');
const traveler = TravelPlan.traveler;
document.querySelector('#traveler-name').textContent = traveler.name;
document.querySelector('#traveler-origin').textContent = traveler.origin;
const destination = document.querySelector('#destination');
const startDate = document.querySelector('#start-date');
const endDate = document.querySelector('#end-date');
const budget = document.querySelector('#budget');
const transportMode = document.querySelector('#transport-mode');
const travelMode = document.querySelector('#travel-mode');
const button = document.querySelector('#generate-button');
const buttonLabel = document.querySelector('#button-label');
const output = document.querySelector('#output');
const connectButton = document.querySelector('#connect-button');
const disconnectButton = document.querySelector('#disconnect-button');
const accountStatus = document.querySelector('#account-status');
const modelField = document.querySelector('#model-field');
const modelSelect = document.querySelector('#chatgpt-model');
const usageLink = document.querySelector('#usage-link');
const responseMode = document.querySelector('#response-mode');
const outputNote = document.querySelector('#output-note');
const personalized = document.body.dataset.personalized === 'true';
const profileText = document.querySelector('#profile-json');
const profileFile = document.querySelector('#profile-file');
const profileStatus = document.querySelector('#profile-status');
if (personalized) {
  profileFile.addEventListener('change', async () => {
    const file = profileFile.files[0];
    if (!file) return;
    if (file.size > 40000) { profileStatus.textContent = 'File is too large. Please use a profile under 30,000 characters.'; profileFile.value = ''; return; }
    try { profileText.value = await file.text(); profileStatus.textContent = 'Profile loaded. Review it below before generating.'; }
    catch { profileStatus.textContent = 'Could not read the file. Please try again or paste the JSON.'; }
  });
}
let isLoading = false;
let account = { connected: false, planEnabled: false };
const savedTrip = itineraryView.getTrip();
if (savedTrip) {
  destination.value = savedTrip.destination;
  startDate.value = savedTrip.startDate;
  endDate.value = savedTrip.endDate;
  endDate.min = savedTrip.startDate;
  budget.value = savedTrip.budget;
  if (transportMode) transportMode.value = savedTrip.transportMode;
  if (travelMode && savedTrip.travelMode) travelMode.value = savedTrip.travelMode;
}

async function localRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TravelWingMan' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function showAccount() {
  modelField.hidden = true;
  modelSelect.replaceChildren();
  connectButton.hidden = account.connected;
  disconnectButton.hidden = !account.connected;
  usageLink.hidden = !account.connected;
  accountStatus.textContent = account.error || (account.connected
    ? `${account.email || 'ChatGPT account'}: ${account.planEnabled ? 'plan usage authorized.' : 'connected, but plan usage was not authorized. Disconnect to try another account or workspace.'}`
    : 'Not connected. You can try the form in demo mode.');
  if (!itineraryView.hasPlan()) responseMode.textContent = account.planEnabled ? 'ChatGPT connected' : account.connected ? 'Plan not authorized' : 'Demo mode';
  outputNote.textContent = account.planEnabled
    ? 'Hotel, dining and traffic research use your ChatGPT plan allowance. Traffic patterns are web references; proposed travel slots are estimates. Check live navigation before leaving and confirm venue prices, hours and availability.'
    : account.connected
      ? 'This account has not authorized plan usage. Disconnect to use demo mode or try another account.'
      : 'Demo plans contain no researched prices or traffic. Connect an eligible ChatGPT plan with web search for hotels, restaurants and local peak-hour planning.';
}

async function loadAccount() {
  try {
    const response = await fetch('/api/auth/status', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    account = await response.json();
    showAccount();
    connectButton.disabled = false;
    if (account.planEnabled) {
      const currentAccount = account;
      try {
        const result = await fetch('/api/models', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
        const catalog = await result.json();
        if (currentAccount !== account) return;
        if (!result.ok) throw new Error(catalog.error);
        for (const model of catalog.models) modelSelect.add(new Option(model.display_name, model.slug));
        modelSelect.value = catalog.defaultSlug;
        if (!modelSelect.value) {
          modelSelect.add(new Option('Choose an available model', ''), 0);
          modelSelect.value = '';
        }
        modelField.hidden = false;
      } catch (error) {
        if (currentAccount === account) accountStatus.textContent = 'Could not load the model picker. Refresh to retry. ' + error.message;
      }
    }
  } catch {
    accountStatus.textContent = 'Could not check the connection. Make sure the local server is running, then refresh.';
  }
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  accountStatus.textContent = 'Opening the official ChatGPT sign-in page...';
  try {
    const data = await localRequest('/auth/chatgpt/start');
    const url = new URL(data.url);
    if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in address.');
    window.location.assign(url.href);
  } catch (error) {
    accountStatus.textContent = error.message;
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener('click', async () => {
  if (isLoading) return;
  disconnectButton.disabled = true;
  try {
    await localRequest('/auth/chatgpt/disconnect');
    account = { connected: false, planEnabled: false };
    showAccount();
    itineraryView.cancelResearch();
    itineraryView.notify('Disconnected. Your saved itinerary is kept. New requests will use demo mode.');
  } catch (error) {
    accountStatus.textContent = error.message;
  } finally {
    disconnectButton.disabled = false;
  }
});

loadAccount();
window.addEventListener('pageshow', event => { if (event.persisted) loadAccount(); });

function validateDates() {
  endDate.min = startDate.value;
  endDate.setCustomValidity(
    startDate.value && endDate.value && endDate.value < startDate.value
      ? 'The end date cannot be before the start date.'
      : '',
  );
}

startDate.addEventListener('input', validateDates);
endDate.addEventListener('input', validateDates);
destination.addEventListener('input', () => destination.setCustomValidity(''));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLoading) return;

  destination.setCustomValidity(personalized || destination.value.trim() ? '' : 'Please enter a destination.');
  validateDates();
  if (!form.reportValidity()) return;

  let trip;
  try {
    trip = TravelPlan.validateTrip({ destination: destination.value, startDate: startDate.value,
      endDate: endDate.value, budget: budget.value, transportMode: transportMode?.value || 'mixed',
      ...(travelMode ? { travelMode: travelMode.value } : {}) }, { destinationOptional: personalized });
  } catch (error) {
    itineraryView.notify(error.message);
    return;
  }

  let personalization;
  if (personalized) {
    try {
      let profile;
      try { profile = JSON.parse(profileText.value); }
      catch { throw new Error('The profile is not valid JSON. Please check or re-export it.'); }
      personalization = Personalization.validate({ profile });
      profileStatus.textContent = 'Profile is ready to use.';
    } catch (error) { profileStatus.textContent = error.message; return; }
  }

  const message = [
    destination.value.trim() ? `Destination: ${destination.value.trim()}` : 'Destination: Recommend one based on my Travel DNA and trip constraints.',
    `Start date: ${startDate.value}`,
    `End date: ${endDate.value}`,
    `Total trip budget: ${Number(budget.value).toFixed(2)} USD`,
    ...(personalized ? [
      `Travel to destination: ${travelMode.options[travelMode.selectedIndex].text}`,
      `Getting around after arrival: ${transportMode.options[transportMode.selectedIndex].text}`,
    ] : [`Getting around: ${transportMode.options[transportMode.selectedIndex].text}`]),
    'Please suggest a trip based on these details.',
  ].join('\n');

  isLoading = true;
  connectButton.disabled = true;
  disconnectButton.disabled = true;
  button.disabled = true;
  buttonLabel.textContent = 'Generating...';
  itineraryView.setBusy(true);
  itineraryView.notify(account.connected ? 'Researching local peak-hour patterns, grouping nearby stops, and looking up hotels and restaurants. Your current plan stays here until the new one is ready.' : 'Generating a demo itinerary. Demo mode does not personalize the plan or research prices and traffic.');
  if (!itineraryView.hasPlan()) {
    output.classList.remove('is-empty', 'is-error');
    output.textContent = 'Putting your trip details together. Please wait...';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TravelWingMan' },
      body: JSON.stringify({ message, trip, model: modelSelect.value || undefined, ...(personalization ? { personalization } : {}) }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to get suggestions. Please try again.');
    if (!data.itinerary) throw new Error('The server did not return a daily plan. Restart the local server and try again.');
    itineraryView.show(data.itinerary, data.report);
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The request timed out. Please try again.'
      : error instanceof TypeError ? 'Unable to reach the local server. Make sure it is running, then try again.' : error.message;
    itineraryView.notify(message);
    if (!itineraryView.hasPlan()) {
      output.classList.add('is-error');
      output.textContent = message;
    }
  } finally {
    clearTimeout(timeout);
    isLoading = false;
    button.disabled = false;
    connectButton.disabled = false;
    disconnectButton.disabled = false;
    buttonLabel.textContent = personalized ? 'Generate personalized plan' : 'Generate suggestions';
    itineraryView.setBusy(false);
  }
});
