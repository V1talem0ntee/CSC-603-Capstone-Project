const form = document.querySelector('#trip-form');
const destination = document.querySelector('#destination');
const startDate = document.querySelector('#start-date');
const endDate = document.querySelector('#end-date');
const budget = document.querySelector('#budget');
const button = document.querySelector('#generate-button');
const buttonLabel = document.querySelector('#button-label');
const output = document.querySelector('#output');
const connectButton = document.querySelector('#connect-button');
const disconnectButton = document.querySelector('#disconnect-button');
const accountStatus = document.querySelector('#account-status');
const usageLink = document.querySelector('#usage-link');
const responseMode = document.querySelector('#response-mode');
const outputNote = document.querySelector('#output-note');
let isLoading = false;
let account = { connected: false, planEnabled: false };

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
  connectButton.hidden = account.connected;
  disconnectButton.hidden = !account.connected;
  usageLink.hidden = !account.connected;
  accountStatus.textContent = account.error || (account.connected
    ? `${account.email || 'ChatGPT account'}: ${account.planEnabled ? 'plan usage authorized.' : 'connected, but plan usage was not authorized. Disconnect to try another account or workspace.'}`
    : 'Not connected. You can try the form in demo mode.');
  responseMode.textContent = account.planEnabled ? 'ChatGPT connected' : account.connected ? 'Plan not authorized' : 'Demo mode';
  outputNote.textContent = account.planEnabled
    ? 'New requests use your ChatGPT plan allowance. Costs are estimates; live prices, weather, and opening hours are not verified.'
    : account.connected
      ? 'This account has not authorized plan usage. Disconnect to use demo mode or try another account.'
      : 'Demo responses are shown until you connect an eligible ChatGPT plan. Live web search is not enabled.';
}

async function loadAccount() {
  try {
    const response = await fetch('/api/auth/status', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    account = await response.json();
    showAccount();
    connectButton.disabled = false;
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
    output.textContent = 'Disconnected. Your next request will return a demo response. You can revoke app access in ChatGPT settings.';
    output.classList.remove('is-empty', 'is-error');
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

  destination.setCustomValidity(destination.value.trim() ? '' : 'Please enter a destination.');
  validateDates();
  if (!form.reportValidity()) return;

  const message = [
    `Destination: ${destination.value.trim()}`,
    `Start date: ${startDate.value}`,
    `End date: ${endDate.value}`,
    `Total trip budget: ${Number(budget.value).toFixed(2)} USD`,
    'Please suggest a trip based on these details.',
  ].join('\n');

  isLoading = true;
  connectButton.disabled = true;
  disconnectButton.disabled = true;
  button.disabled = true;
  buttonLabel.textContent = 'Generating...';
  output.classList.remove('is-empty', 'is-error');
  output.setAttribute('aria-busy', 'true');
  output.textContent = 'Putting your trip details together. Please wait...';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TravelWingMan' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to get suggestions. Please try again.');
    if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('empty');
    output.textContent = data.reply;
    responseMode.textContent = data.mode === 'chatgpt' ? 'ChatGPT response' : 'Demo response';
  } catch (error) {
    output.classList.add('is-error');
    output.textContent = error.name === 'AbortError'
      ? 'The request timed out. Please try again.'
      : error instanceof TypeError ? 'Unable to reach the local server. Make sure it is running, then try again.' : error.message;
  } finally {
    clearTimeout(timeout);
    isLoading = false;
    button.disabled = false;
    connectButton.disabled = false;
    disconnectButton.disabled = false;
    buttonLabel.textContent = 'Generate suggestions';
    output.setAttribute('aria-busy', 'false');
  }
});
