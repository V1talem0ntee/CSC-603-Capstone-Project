# AI Travel WingMan

A local travel-planning prototype with an English HTML/CSS/JavaScript frontend
and a dependency-free Node.js backend. No online deployment is required.

## Run locally

Requires Node.js 20 or newer. No npm install is needed.

```sh
npm start
```

Open http://127.0.0.1:3000. Visits to localhost are redirected to 127.0.0.1 so
sign-in cookies and the OAuth callback use the same host. If the server was
already running, stop it with Ctrl+C and start it again after backend changes.
Use `npm run dev` to restart automatically on code changes.
Set `PORT` before starting to use another local port.

## Connect ChatGPT

1. Click **Continue with ChatGPT**.
2. Sign in on the official OpenAI page and choose an account/workspace.
3. Review and authorize ChatGPT plan usage for **AI Travel WingMan**.
4. Return to the app. Check that the connection says **plan usage authorized**.
5. Enter a destination, travel dates, and total USD budget; generate suggestions.

Requests use the connected user's existing eligible ChatGPT plan allowance.
No API key is required for this flow. Login alone does not grant plan usage.
School/Edu availability depends on account eligibility and workspace policies;
the app does not assume it has access. A personal eligible account can be tested
separately. Each person must authorize their own account for their own requests.

The app only sends trip details to OpenAI when the user submits the form while
connected. Tokens stay in backend memory, never in browser storage or Git.
Restarting the server or disconnecting clears the local credentials. The session
expires after eight hours. You can also revoke the app in ChatGPT settings.
A stable, non-secret installation ID is stored in the ignored `.local/` folder.

Disconnected users can still test the form with clearly labeled demo responses.
A connected account without plan permission receives an authorization error.
Actual AI responses are labeled **ChatGPT response**.

Live web search is not enabled. Prices are estimates; current flight/hotel
prices, weather forecasts, and opening hours are not verified by this version.
Available models are discovered from the connected account. Optionally set
`CHATGPT_MODEL` to an available model slug before starting the server.

## Files

| File | Purpose |
| --- | --- |
| `public/index.html` | Travel form, connection controls, output area |
| `public/styles.css` | Responsive page styling |
| `public/app.js` | Form validation, account state, API requests |
| `server.js` | Local HTTP server, session handling, routes |
| `chatgpt.js` | OAuth with PKCE, ID-token verification, renewal, inference |
| `test/chatgpt.test.js` | Offline tests using simulated OpenAI responses |

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server health |
| GET | `/api/auth/status` | Connection and granted plan-usage status |
| POST | `/auth/chatgpt/start` | Start official browser sign-in |
| GET | `/auth/callback` | Process the OAuth callback |
| POST | `/auth/chatgpt/disconnect` | Clear the local session |
| POST | `/api/chat` | Generate a demo or authorized AI response |

POST requests from this frontend include `X-Requested-With: TravelWingMan`.
The app uses a local HttpOnly/SameSite cookie. Cross-origin POSTs are rejected.
Only the three public frontend files are served; backend files stay private.

```js
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Requested-With': 'TravelWingMan',
  },
  body: JSON.stringify({ message: 'Plan two days in San Francisco for $500.' }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error);
output.textContent = data.reply;
```

## Verification

```sh
npm test
```

Tests use signed test tokens and simulated HTTP streams. They do not sign into
real accounts or consume ChatGPT allowance. Live eligibility, OAuth reachability,
and inference still need to be verified by signing in with your own account.

Official integration documentation:
https://developers.openai.com/siwc/token-sharing-open-source/
