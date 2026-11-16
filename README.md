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

The app sends trip details to OpenAI when a connected user generates a plan.
Confirming an accommodation address or checking a suggested hotel triggers a
restaurant lookup using that address. Day-end restaurant refresh buttons send
the last sightseeing location and trip context. These actions use the connected
user's plan allowance. Tokens stay in backend memory, never in browser storage or Git.
Restarting the server or disconnecting clears the local credentials. The session
expires after eight hours. You can also revoke the app in ChatGPT settings.
A stable, non-secret installation ID is stored in the ignored `.local/` folder.

Disconnected users can still test the form with clearly labeled demo responses.
A connected account without plan permission receives an authorization error.
Actual AI plans are labeled **ChatGPT itinerary**; sample plans are labeled
**Demo itinerary**.

## Daily itinerary and progress

The trip form returns a separate card for every calendar day, including the
start and end dates (up to 60 days). Swipe or scroll horizontally, select a
Day button, or use the previous/next arrows to change days.

- Day 1 includes a generic accommodation check-in checkbox. The user chooses
  their own hotel or other stay; no specific hotel is assigned.
- Every activity has an independent completion checkbox.
- **Delete** removes an activity; **Undo last change** restores the last edit.
- **Move to next day** transfers an unfinished activity and marks its timing
  as Flexible. The action is disabled for completed items and on the last day.
- Moving a task does not re-optimize the itinerary or verify opening hours,
  travel times, reservations, or costs. Review the target day yourself.
- The current itinerary, checked items, deletions, moved items, and selected
  day are saved in this browser's local storage and restored after refresh.
  This is local browser data, not account synchronization or a cloud backup.
  If browser storage is unavailable, the page says changes last for this visit.
- Generating another itinerary replaces the saved plan only after the new
  response is successfully validated. Failed generation keeps the current plan.

The demo backend returns sample daily cards so these interactions can be tested
without a ChatGPT login. Connected requests ask the model for structured daily
JSON; invalid or incomplete daily responses produce an error instead of a
misleading partial plan.

## Hotels and restaurants

Connected daily-plan requests require OpenAI web search. The model is asked for
2-3 suitable hotels and up to two well-known restaurants near each day's final
sightseeing stop. Meals and transit are excluded when finding that final stop.
No separate paid hotel, restaurant, or mapping API is used.

- Hotel cards show a name, address, reference rate per room/night, assumptions,
  sources, and lookup time when available. An indicative published rate is not
  a quote for the requested dates or a guarantee of availability.
- Select **I will stay here** on a hotel, or enter a street address, city and
  country and choose **Confirm address & find restaurants**. Only one stay is
  selected at a time. This choice is separate from the check-in checkbox.
- After confirmation, a separate search looks for 2-3 well-known restaurants
  around that exact address. Each day also has restaurant suggestions near its
  final sightseeing stop and a button to search/refresh those suggestions.
- Restaurant prices are per-person references. If derived from menu items,
  they are labeled as menu-based estimates, with the calculation/exclusions.
  Hotel occupancy, currency, tax/tip assumptions and date basis are displayed.
- Source URLs must appear in OpenAI's actual web-search metadata/citations.
  A venue without a matching retrieved source is discarded. A price without a
  matching supporting source and stated basis is removed. The model's extracted
  prices are not independently audited; check the linked page before booking.
- No numeric price is substituted when one is unavailable. Demo mode does not
  invent hotels, restaurant names, addresses or prices; it returns empty research.
- Changing the confirmed address clears nearby-stay results. Moving/deleting
  the final attraction invalidates the affected day's restaurant results.
  Stale in-flight results are not attached to a different address or stop.
- Accommodation choices, references, lookup times and restaurant results are
  saved with the itinerary in this browser. Addresses are sent for searches
  only after an explicit accommodation confirmation or lookup action.

Web search must be available to the selected ChatGPT model/account/workspace.
If the provider rejects search, the app reports that failure rather than
silently falling back to invented price references. Account eligibility, live
search, and published-price availability still require testing with a real account.
Available models are discovered from the connected account. Optionally set
`CHATGPT_MODEL` to an available model slug before starting the server.

## Traffic and departure planning

Choose driving, public transit, walking, cycling, or mixed transport in the trip
form. Connected generation uses the existing web search to look up public local
traffic information, such as transport authority guidance and congestion reports.
When detailed official data is unavailable, it also looks for destination-local
community discussions from the current calendar month. These reports are treated
as anecdotal context, preferably corroborated across multiple discussions, rather
than live conditions or precise city-wide forecasts.
No separate paid traffic service or mapping API key is needed.

- The AI is instructed to group nearby stops, reduce backtracking and adjust
  stop order and proposed departures around relevant local peak periods. Each
  day explains its routing decisions and assumptions for the chosen mode.
- Peak windows include the applicable weekdays, area/corridor, destination IANA
  timezone, sources and search timestamp. A window is kept only when its URL
  appears in the provider's actual search metadata. Source content and extracted
  traffic claims are not independently audited; check the linked references.
- Weekday filtering uses each destination calendar date, including dates across
  daylight-saving changes. A weekday pattern is not automatically a holiday or
  event forecast. Missing weekend windows do not mean roads will be clear.
- If no supported local windows are found, route/timing suggestions are labeled
  as planning assumptions. Recent community discussion may inform a qualitative
  caveat, but a single post cannot establish a precise peak window. Demo mode has
  no researched traffic windows.
- Between specific activity locations, cards can show proposed departure and
  arrival slots, an included buffer, a rationale and an alternative. These are
  AI planning estimates, not measured travel times or live navigation ETAs.
  The first transfer from the accommodation is not calculated. Overnight
  transfer slots are not supported. Check a navigation app before departure.
- A road/transit slot overlapping a published busy window shows a possible
  conflict; the UI does not verify whether a corridor or rail service is affected.
- Moving/deleting stops clears route advice and slots on the affected days.
  Changing/clearing accommodation clears them across the trip. Completion
  checkboxes preserve advice; undo restores the prior snapshot. Generate a new
  plan to reconsider changed routes. Preferences and research persist locally.

This feature uses publicly available typical/historical congestion information.
It does not receive live vehicle counts, measured speeds or current incidents,
and it does not guarantee an optimal or congestion-free route.

## Files

| File | Purpose |
| --- | --- |
| `public/index.html` | Travel form, connection controls, output area |
| `public/travel-dna.html` | Copyable prompt for creating a portable Travel DNA profile |
| `public/styles.css` | Responsive page styling |
| `public/app.js` | Form validation, account state, API requests |
| `public/itinerary.js` | Shared trip validation and itinerary state updates |
| `public/itinerary-view.js` | Daily cards, checkboxes, navigation, undo, local saving |
| `server.js` | Local HTTP server, session handling, routes |
| `chatgpt.js` | OAuth with PKCE, ID-token verification, renewal, inference |
| `test/chatgpt.test.js` | Offline tests using simulated OpenAI responses |
| `test/itinerary.test.js` | Dates, edits, persistence, and demo itinerary API tests |
| `test/recommendations.test.js` | Sourced prices, accommodation confirmation, location freshness |
| `test/traffic.test.js` | Traffic sources, weekday windows, proposed transfers, stale advice |

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server health |
| GET | `/api/auth/status` | Connection and granted plan-usage status |
| POST | `/auth/chatgpt/start` | Start official browser sign-in |
| GET | `/auth/callback` | Process the OAuth callback |
| POST | `/auth/chatgpt/disconnect` | Clear the local session |
| POST | `/api/chat` | Generate a demo or authorized AI response |
| POST | `/api/dining` | Search around a confirmed stay or day-end sightseeing stop |

POST requests from this frontend include `X-Requested-With: TravelWingMan`.
The app uses a local HttpOnly/SameSite cookie. Cross-origin POSTs are rejected.
Only explicitly listed public frontend files are served; backend files stay private.

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

To request daily cards, also include a `trip` object with `destination`,
`startDate`, `endDate` (YYYY-MM-DD), and a positive `budget` in USD. Optional
`transportMode` accepts `mixed` (default), `driving`, `transit`, `walking`, or
`cycling`. The response
then includes `itinerary`, containing days, editable activity IDs, generic hotel
check-in, completion state, hotel suggestions, day-end restaurant research,
public traffic patterns, daily mobility advice and proposed transfer slots.
The app renders model text with `textContent` and permits only HTTP(S) source links.

## Verification

```sh
npm test
```

Tests use signed test tokens and simulated HTTP streams. They do not sign into
real accounts or consume ChatGPT allowance. Live eligibility, OAuth reachability,
and inference still need to be verified by signing in with your own account.

Official integration documentation:
https://developers.openai.com/siwc/token-sharing-open-source/

## Personalized travel

Open **Personalized travel** in the navigation. Connect first, then upload a Travel DNA 1.0 JSON file or paste and review its contents, choose dates, budget, whether you will drive or fly to the destination, and how you prefer to get around after arrival (mixed, driving, transit, walking, or cycling). Destination is optional: enter one to plan around it, or leave it blank so ChatGPT can select a destination from the profile and trip constraints. The profile is sent to OpenAI for a connected request; it is kept only in the current page, not saved by the app. Signing in navigates away and clears it, so connect before entering it. Generated plans are saved in browser local storage and can reflect your profile. Generating a new plan replaces the existing saved itinerary after success. Generated plans include a small **Download report.json** test control. The report is a concise summary derived only from the itinerary: trip details, overview, daily activities, restaurant and accommodation suggestions, and notes. It does not contain the original Travel DNA or an alignment score. Demo mode returns an unpersonalized sample when a destination is provided; destination discovery requires a connected ChatGPT account.
