# CSC 659 Team 9: Testing Methodology

> **Draft for team meeting.** Section 3 holds two candidate designs. Items tagged **[Option 1]** or **[Option 2]** apply only to that design. Untagged items apply to both. Once we choose, the other option's text gets deleted.

## Decisions for the team meeting

1. **Which design (Section 3)?**
   - **Option 1** (generic vs personalized pairs, AI-picked destinations, optional counterfactual block). Answers whether personalization helps, which is the question in the paper our proposal cites. Simpler to run (2 runs per scenario). Weakness: its counterfactual block is small (16 runs) and has no control rerun, so a plan that changes after an edit cannot be told apart from normal run-to-run variation.
   - **Option 2** (profile counterfactual sets). Tests whether the AI's stated reasons actually drive the plan, measures run-to-run reliability, and removes the difference between the main page and the Personalized page. Weakness: it cannot say whether personalization beats a generic plan, it takes more comparison work per scenario, and the runs in a set are correlated, so the effective sample for PassRate is closer to 40 scenarios than 120 runs.
2. **If Option 2: drop or keep the generic run?** This draft drops it. Dropping loses the generic vs personalized comparison. The paper our proposal cites found that personalization did not always improve constraint satisfaction, and we could no longer check that. Keeping one generic run per set (main page) adds 40 runs (160 in total, more than the proposal's 120) and would bring back the blind preference measure.

Other open items already in this document: the scoring window (Section 5) and whether to keep Climate (Section 6).

## 1. What we are testing

1. **Accuracy.** Is the travel information correct? We use the proposal's four criteria: location, budget, climate, and attractions.
2. **Explainability and trust.** Can a user see why the AI said something, where it came from, and when to doubt it? This has two parts: provenance (are the facts traceable to a source) and faithfulness (is "this fits your profile" true of what actually drove the plan). **[Option 2]** tests faithfulness with a profile counterfactual as the main design. **[Option 1]** tests it only in the optional Block C.
3. **Personalization or reliability.** **[Option 1]** Does using a Travel DNA profile change the results, and does the plan fit the person better? **[Option 2]** Does the same input give the same result? A control rerun measures this, and fit is judged through the counterfactual instead of as a separate aim.

## 2. Setup

- **Testers.** Four members. Each uses their own Travel DNA profile, made from their own AI history, and judges how well plans fit their own profile.
- **Model.** Everyone uses the same model (GPT-6 Luna).
- **Starting city.** Every scenario lists one, entered once the team adds input functionality.
- **Run sheet.** One spreadsheet row per run: run ID, tester, date, scenario ID, block, model, inputs, plan destination, the scores below, evidence URLs, check date, notes. **[Option 2]** Also: set ID, run role (R1, R2 or R3), the profile edit (field, before and after), and the written prediction.
- **Evidence folder.** For every run, save the downloaded report and a screenshot, named by run ID.

## 3. Experiment design

Both designs use the proposal's 120 scored runs (4 members × 30). Option 1 adds 16 optional runs.

### Option 1: Generic vs personalized pairs

| Block | Runs per member | Total | What it is |
|---|---|---|---|
| A. Known destination, paired | 20 | 80 | 10 scenarios, each run twice with the same inputs. Once on the main page (no profile) and once on the Personalized travel page. |
| B. AI picks the destination | 10 | 40 | Personalized page with the destination left blank. |
| C. Profile counterfactual (optional) | 4 | 16 | Rerun an earlier scenario with an edited profile. |

Blocks A and B are the proposal's 120 experiments (4 members × 30). Block C is extra and only scored on profile fit. The main page only asks how you will get around, so in Block A the personalized run also tells the AI whether you drive or fly to the destination. We expect this to matter little because the destination is already chosen. Location is only a real test in Block B, where the AI chooses. In Block A it is marked N/A.

### Option 2: Profile counterfactual sets

Each set is one scenario run three times on the Personalized page, in the same session and with the same model:

| Run | Profile | Purpose |
|---|---|---|
| R1 Baseline | Original | The reference plan. |
| R2 Control | Original, rerun | Measures run-to-run variation. The same input can give different plans, so without this we cannot tell an edit's effect from noise. |
| R3 Edited | Original with one edit | The counterfactual. |

- 10 sets per member, so 40 sets and 120 runs. Every run gets the Section 6 scoring.
- 5 sets per member leave the destination blank (Location is scored, and the profile has the most room to matter). The other 5 fix the destination (Location is N/A, as in Option 1's Block A).
- All runs use the Personalized page, so the main page's different travel-mode question never comes into play. The generic run is dropped in this draft (see Decision 2).
- Edit types per member (starting values, settled in the pilot):

| Edit | Sets per member | Predicted change in R3 |
|---|---|---|
| Remove a top interest | 3 | Fewer items tied to it (soft prediction). |
| Add a dislike for something R1 included | 3 | That item is gone and no disliked item appears (hard prediction). |
| Add or raise an unknown or low-confidence interest | 2 | At least one new item tied to it (soft prediction). |
| Add a dislike that conflicts with a fixed destination | 2 | The destination stays, since trip input takes priority over the profile, and the plan notes the conflict. Fixed-destination sets only. |

- Run R1 first, because some edits depend on what R1 included. Write the predicted change in the run sheet before generating R2 and R3.

## 4. Scenarios

- One shared scenario sheet that everyone draws from, so nobody picks only easy trips.
- A mix of big cities, small towns and international places, short (2 to 3 days) and long (5 to 7 days) trips, and low and mid budgets.
- Dates 1 to 3 months ahead, so prices and opening hours can be checked.
- Some stress cases: winter seasonal closures, holiday weekends, a tight budget, and a place with a recently closed attraction.
- Only the form fields are used. No extra free text.

## 5. Run protocol

1. Confirm you are signed in and the plan badge says "ChatGPT itinerary". The "Demo itinerary" is a template and is never scored.
2. Enter the scenario fields and generate once. **[Option 2]** Run R1, R2 and R3 of a set in the same session, so changes in web search results between runs stay small.
3. If a run fails, log it as invalid and try once more. Failures count toward a reliability rate and are not hidden. If the usage limit is hit, wait and log it.
4. Save the report and a screenshot right away. Check that the generated time is new, because a failed run leaves the previous plan on screen.
5. Score within X(to be discussed) hours, since prices and hours change. Record the check date.

## 6. Scoring

Check a sample picked by a fixed rule, for example the first hotel, the first restaurant on the first and last day, and the first, middle and last activity.

| Criterion | Pass when |
|---|---|
| Location (Block B only) | Travel time from the starting city is within the scenario's limit (for example 5 hours of driving for a 3 day trip). Check with a maps or flights site. |
| Budget | Sampled prices are within about 25% of the official or booking page, and the rough total cost is no more than about 10% over the budget. |
| Attractions | No sampled activity is permanently closed, seasonally closed, or closed that day, unless the plan warns about it. Activities have no sources, so find your own evidence. |
| Climate (optional) | The season is not clearly bad for the plan based on historical climate data, or the plan warns about it. The team decides before the pilot. If dropped, mark N/A everywhere and say so in the report. |

Each criterion is marked **Pass, Fail, N/A, or Can't verify**, with the evidence URL. Can't verify is counted separately and never dropped. The percentages and limits above are starting values and get settled in the pilot.

Every Fail is also tagged with:
- **Type:** made up, outdated, wrong detail, or the cited source does not support the claim.
- **Severity:** minor (a price is off) or major (closed or unreachable).
- **Flagged:** did the plan warn about uncertainty on that item, yes or no.

**[Option 2]** This scoring applies to every run, including the control and edited runs. "Location (Block B only)" then means sets with a blank destination.

## 7. Explainability and trust measures

- **Source support.** For each sampled hotel and restaurant, open the cited page. Does it really show the name, address and price the plan claims? Report supported out of checked.
- **Transparency score (0 to 4).** One point each for giving a reason, showing sources, stating what a price covers, and stating its limits.
- **Confident error rate.** Of all failed items, the share with no warning.
- **Failure mix.** Counts by type and severity. This shows where mistakes happen and how costly they could be for a user.
- **Run-to-run consistency [Option 2].** Share of sets where R1 and R2 get the same Pass or Fail on each criterion. This turns the "same input can give different plans" limit into a measured number.

## 8. Personalization measures

Scored by the profile owner on personalized runs. **[Option 2]** The scorer sees shuffled "Plan 1, 2, 3" labels and is not told which is the control. A teammate holds the key until scoring is done.

- **Coverage.** Percent of days with at least one activity tied to a top interest in the profile. **[Option 2]** R1 only.
- **Overreach.** Activities treated as a sure fit for something the profile marks as low confidence or unknown. **[Option 2]** R1 only.
- **Dislikes.** Violations of stated dislikes (expected to be 0).
- **Reason check.** For each "this matches your interest in X" claim, is X actually in the profile? Count the ones that are not. **[Option 2]** R3 is checked against the edited profile, so a claim citing a removed trait counts as a stale reason.
- **Blind preference (Block A) [Option 1].** The owner sees the generic and personalized plans with shuffled labels and picks the one that fits better. A teammate holds the key until scoring is done.
- **Counterfactual (Block C) [Option 1].** Edit the profile, for example add a dislike for something the first plan included or remove a top interest, then rerun. Did the plan change the way the edit predicts? If not, the AI's stated reasons are not what drives the plan. This block has no control rerun, so ordinary run-to-run variation can look like an effect.
- **AI as judge (optional) [Option 1].** Give an AI the report and the profile summary and ask for a fit score. Use it only for profile fit and never for facts. First compare it with human scores on about 20 plans, and drop it if they disagree often.
- **Item tagging rule [Option 2].** An item is tied to a trait when the plan's own text cites that trait, or when the item is that trait by obvious category (an aviation museum for aviation). The rule is settled in the pilot.
- **Edit response rate [Option 2].** Count the items tied to the edited trait in each run. A set is a hit when R3's count moves in the predicted direction by more than R2's count differs from R1's. Hard predictions (dislikes) must hold exactly.
- **Decorative reasons [Option 2].** Items R1 ties to the edited trait that R3 keeps with no new reason. An item that stays with a different reason that does not cite the trait is consistent.
- **Collateral change [Option 2].** Items that changed between R1 and R3 and are not tied to the edited trait, minus the items that changed between R1 and R2.
- **Noise floor [Option 2].** Share of R1 items that differ in R2. Report it next to every Option 2 result.
- **Conflict handling [Option 2].** In conflict sets, did R3 keep the destination and say the profile conflicts with it?

## 9. Scoring reliability

- Run a small pilot first (3 runs per member) to remove unclear rules and settle the thresholds. **[Option 2]** That is one full set per member, and the pilot also settles the item tagging rule.
- A second person scores about 20% of plans (about 24) without seeing the first score. **[Option 2]** That means about 8 sets (24 runs), and agreement is also reported for the item tagging and the hit or miss call. Rotate so nobody checks their own. Report percent agreement per criterion, discuss disagreements, and tighten the rule.

## 10. Ethics and data handling

- Each person uses only their own profile, with consent and no precise addresses or sensitive details.
- Profile edits (Block C or Option 2 sets) use only ordinary travel interests and dislikes, never sensitive attributes such as health, disability or religion. Edit a copy of the profile. Record the edit (field, before and after) in the run sheet, not the whole profile. Do not edit the home region, since Location depends on it.
- Profiles stay within the team and are left out of any submitted copy.
- All invalid runs and exclusions are logged and reported.
- One walkthrough of the app against the proposal's idea that users keep control. Are sources visible, can plans be edited, and does it say it does not book anything?

## 11. Analysis and limits

- PassRate = (Passed / Total) × 100% for each criterion, shown with the counts. N/A and Can't verify are shown separately.
- Break results down by block, destination type, season and trip length. **[Option 2]** Also by edit type.
- **[Option 1]** Block A: count the pairs where only one version passed, in each direction.
- Explainability and personalization measures are reported as plain counts and percentages.
- **[Option 1]** Margins are about ±9 points at 120 runs and about ±15 at 40. With 40 pairs only large differences will show, so we do not claim small ones.
- **[Option 2]** The unit is the set. Runs in a set share a scenario, so quote margins of about ±15 points (40 sets) rather than ±9. Each edit type has only 8 to 12 sets (about ±30 points), so report edit types descriptively and make no claims between them.
- Limits to state: one model, four profiles from classmates, web data that changes, the same input can give different plans, and we check a sample of claims and not every claim. We test the AI's stated reasons by watching its behavior, not its internals. Account memory could bring in history that is not in the profile.
- Changes from the proposal: the proposal says GPT-5.6 Luna, and we test GPT-6 Luna. **[Option 2]** The four criteria and the 120 runs are kept, and generic vs personalized pairs are replaced by counterfactual sets.
