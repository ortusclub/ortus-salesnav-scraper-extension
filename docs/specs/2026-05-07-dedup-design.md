# Cross-run lead deduplication

**Date:** 2026-05-07
**Status:** Design — pending implementation
**Owner:** Antonio Varlese (Ortus)
**Targets:** Sales Nav Batch Scraper v3.12.0

---

## Problem

Colleagues report two related pains when running scrapes:

1. **Messy output.** The same lead (same person, same LinkedIn profile URL) shows up multiple times in the result sheet. Sheets get hand-cleaned before sharing.
2. **Wasted compute.** Re-scraping people who are already in the destination sheet burns LinkedIn rate-limit budget and adds minutes to long batches.

Both are caused by the same root issue: the scraper has no concept of *"already scraped"* across runs. Within a single page it dedupes by URL (`content.js:434`), but across pages, across runs, and across teammates writing to the same sheet, it just appends.

## Goals

- Skip leads whose profile URL is already in the destination sheet, both at extraction time (don't waste compute) and at write time (don't dirty the sheet).
- Allow per-launch override for testing ("re-scrape everything anyway").
- Degrade gracefully when the sheet has neither a Membership ID nor a Bio URL column, or when the dedup-fetch call fails — never block a scrape because dedup couldn't run.
- Surface the dedup outcome to the user mid-run and at completion ("28 already-scraped skipped") so they can see it working.

## Non-goals

- **Per-search-URL dedup.** ("Don't run the same search again.") We're deduping per-lead, not per-query. Same search a week later is allowed and welcome — LinkedIn surfaces new matches.
- **Cross-machine local cache.** No `chrome.storage.local` URL set. The destination sheet is the single source of truth; teammates writing to the same sheet automatically respect each other's prior work without coordinating storage.
- **Soft / fuzzy matching.** No name+company collision detection. Profile URL is the only key.
- **Sheet-level cleanup of pre-existing dupes.** This feature only prevents *new* dupes. Existing dupes in a sheet stay there until manually removed.

---

## Architecture

Four files change. Each change is small and independently reviewable.

| Layer | File | Change |
|---|---|---|
| Apps Script | `SheetCompanion.js.txt` | Add `getKnownProfiles(sheetUrl, tabName)` endpoint that reads the `LinkedIn Membership ID` and `Linkedin Bio` columns of the destination tab. |
| Background | `background.js` | Fetch known set on Start; filter extracted profiles against it; track skipped count. |
| Popup (state) | `popup.js` | Pass the dedup toggle state on Start; render the toggle's count + state. |
| Popup (UI) | `popup.html` | Inline dedup toggle on the three launch screens; mid-run skipped counter. |

## Data flow

### On scrape Start (single OR batch)

1. User clicks Start. The dedup toggle has been shown above the Start CTA for them to flip if they want; default = ON.
2. `popup.js` calls `sendBG('startScrape', {config: {..., dedup: true|false}})`.
3. If `dedup === true`, `background.js` calls Apps Script:
   ```
   POST WEB_APP_URL { action: 'getKnownProfiles', sheetUrl, tabName }
   ```
4. Apps Script reads both the LinkedIn Membership ID column AND the Linkedin Bio column from the destination tab and returns:
   ```json
   {
     ok: true,
     ids: ["109910746", "12658813@linkedinmembership", ...],
     tokens: ["https://www.linkedin.com/in/ACwAAA...", ...],
     hasIdCol: true,
     hasUrlCol: true
   }
   ```
   If neither column exists, both arrays are empty and both flags are `false`.
   If the call fails: `{ ok: false, error: "..." }`.
5. `background.js` normalizes each value (Membership ID → bare digits; Bio URL → URL token), builds `state.knownProfiles = new Set([...prefixedIds, ...prefixedTokens])` where each entry is prefixed (`id:` or `tok:`) to keep the two namespaces separate. Initializes `state.skippedDupes = 0`.
6. Scrape proceeds. If any step fails, dedup silently disables (`state.knownProfiles = null`) and a warning logs to `logs.html` — the scrape never blocks.

### During each page extraction

After `r = await tabMsg(tid, {action:'extractAll'})` resolves with profiles, before the existing `state.allProfiles.concat(r.profiles)` call:

```js
function dedupKeysFor(p) {
  var keys = [];
  var id = normalizeMembershipId(p.membershipId);    // returns digits or null
  if (id) keys.push('id:' + id);
  var tok = tokenFromUrl(p.profileUrl);              // returns lowercase token or null
  if (tok) keys.push('tok:' + tok);
  return keys;
}

var newProfiles = [];
for (var i = 0; i < r.profiles.length; i++) {
  var p = r.profiles[i];
  var keys = dedupKeysFor(p);
  if (keys.length === 0) { newProfiles.push(p); continue; }    // anonymous / unparseable — keep
  if (state.knownProfiles && keys.some(function(k){ return state.knownProfiles.has(k); })) {
    state.skippedDupes++;
    continue;
  }
  if (state.knownProfiles) keys.forEach(function(k){ state.knownProfiles.add(k); });
  newProfiles.push(p);
}
state.allProfiles = state.allProfiles.concat(newProfiles);
```

Each profile contributes up to two keys to the Set (one `id:` and one `tok:`). A scraped profile is a duplicate if **either** of its keys hits the Set — covers the case where the existing sheet has the Bio URL but no Membership ID, or vice-versa.

Effect: `state.allProfiles` only ever contains **new** leads. The existing write-to-sheet path (unchanged) writes only `state.allProfiles`, so the sheet stays clean.

### At end of run

`showDone(st)` and `showBatchDone(st)` read `st.skippedDupes` and render *"312 leads · 28 already-scraped skipped"* in the done view. If `skippedDupes === 0`, the suffix is hidden.

---

## Dedup key extraction

Real-world result sheets (verified 2026-05-07) hold lead identity in **two** columns, not a single "Profile URL" column. The dedup key is the **LinkedIn Membership ID** — a numeric identifier — with a fallback to extracting the same identity from the `Linkedin Bio` URL when the ID column is empty.

### Primary key: LinkedIn Membership ID

Column header (case-insensitive): `LinkedIn Membership ID` (also accept: `Linkedin Membership ID`, `Membership ID`, `LinkedIn ID`).

Stored values are inconsistent — sometimes a bare number, sometimes a number with an `@linkedinmembership` suffix appended by Hubspot enrichment:

| Raw cell value | Normalized key |
|---|---|
| `109910746` | `109910746` |
| `12658813@linkedinmembership` | `12658813` |
| `12658813@linkedinmembership.id` | `12658813` |
| (empty) | `null` (fall back to URL extraction) |

Normalization: regex out the leading digits — `String(v).match(/^\d+/)?.[0] || null`.

### Fallback key: URL token from "Linkedin Bio"

When the Membership ID column is missing or the cell is empty, fall back to the `Linkedin Bio` column. Header (case-insensitive): `Linkedin Bio`, `LinkedIn Bio`, `LinkedIn URL`, `Profile URL`, `Sales Nav URL`.

The Bio column holds public-profile URLs (`https://www.linkedin.com/in/<token>`), not Sales Nav lead URLs. The `<token>` is the same URN-derived identifier the Sales Nav scraper extracts at runtime — so a `/in/<token>` URL and a `/sales/lead/<token>` URL identify the same person.

Extract the token:

```js
function tokenFromUrl(raw) {
  if (!raw) return null;
  var m = String(raw).toLowerCase().match(/\/(?:in|sales\/lead)\/([a-z0-9_-]+)/);
  return m ? m[1] : null;
}
```

| Raw URL | Extracted token |
|---|---|
| `https://www.linkedin.com/in/ACwAAAANGtoBZnDg47zOhi_4KTMSeGDY2-tlPto?x=1` | `acwaaaangtobzndg47zohi_4ktmsegdy2-tlpto` |
| `LinkedIn.com/in/ACwAAAA1/` | `acwaaaa1` |
| `https://www.linkedin.com/sales/lead/ACwAAAA1` | `acwaaaa1` |
| `https://www.linkedin.com/sales/people/anonymous-xyz` | `null` (anonymous; treat as new) |

### Two namespaces, one Set

Membership IDs and URL tokens are different identifier types, so they go into the Set with a prefix to avoid accidental collisions:

```
state.knownProfiles = Set { "id:109910746", "id:12658813", "tok:acwaaaa1", ... }
```

When we extract a profile during scrape:
1. If the scraper extracted a membership ID for it → check `id:<num>`.
2. Otherwise → check `tok:<token>` extracted from its profile URL.
3. No match either way → it's new, write it. Add the appropriate prefixed key.

This is a verification point for implementation: confirm that the existing `content.js` extraction populates a numeric `membershipId` field for new profiles. If not, we extract URL token only (which still works for dedup against existing rows that have either column populated).

These two functions (`normalizeMembershipId`, `tokenFromUrl`) live in `background.js` and are the only places that produce dedup keys.

---

## UI surface

### The override toggle

Sits above the Start CTA on three launch views: `view-single-wrong` (paste-URL flow), `view-single-ready` (current-tab flow), `view-batch-ready` (job-preview).

**State variants** (driven by the result of the Apps Script `getKnownProfiles` call):

| Sheet condition | Toggle text | Toggle visible? |
|---|---|---|
| Empty sheet | — | hidden |
| ≥1 existing leads found | *"Skip leads already in this sheet · 12 found"* | yes, default ON |
| User flips it OFF | *"Re-scrape everything · 12 dupes will be re-added"* | yes, OFF |
| No Membership ID and no Bio URL column | *"Can't dedupe — sheet has no LinkedIn Membership ID or Bio column"* | replaced by a one-line note |
| Apps Script call failed | *"Couldn't check for duplicates · running anyway"* | replaced by a one-line note |

**Persistence:** **per-launch.** Every popup open resets the toggle to ON. Reasoning: testing is bursty work; "stuck OFF" would silently break production runs days later.

### Mid-run counter

`view-batch-running` and `view-single-progress` get a small augmentation to their existing subtitle line:

> Page 4 of 12 · 67 leads collected · **3 already-scraped skipped**

Only shown when `skippedDupes > 0`.

### Done view

`view-single-done` and `view-batch-done` figure-row gets a third meta line:

> Pages **12** / Time **8m 14s** / Errors **0** / **Skipped 28 already-scraped**

Only shown when `skippedDupes > 0`.

---

## Apps Script endpoint

Add to `SheetCompanion.js.txt`:

```js
case 'getKnownProfiles':
  return _ok(getKnownProfiles_(p.sheetUrl, p.tabName));

function getKnownProfiles_(sheetUrl, tabName) {
  var ss = SpreadsheetApp.openByUrl(sheetUrl);
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { ids: [], tokens: [], hasIdCol: false, hasUrlCol: false };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ids: [], tokens: [], hasIdCol: true, hasUrlCol: true };  // empty sheet, columns unknown but irrelevant

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idColIdx = -1, urlColIdx = -1;
  var ID_HEADERS = ['linkedin membership id', 'membership id', 'linkedin id'];
  var URL_HEADERS = ['linkedin bio', 'linkedin url', 'profile url', 'sales nav url'];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim().toLowerCase();
    if (idColIdx === -1 && ID_HEADERS.indexOf(h) !== -1) idColIdx = i;
    if (urlColIdx === -1 && URL_HEADERS.indexOf(h) !== -1) urlColIdx = i;
  }

  var ids = [], tokens = [];
  if (idColIdx !== -1) {
    var idVals = sheet.getRange(2, idColIdx + 1, lastRow - 1, 1).getValues();
    for (var j = 0; j < idVals.length; j++) {
      var v = String(idVals[j][0] || '').trim();
      if (v) ids.push(v);
    }
  }
  if (urlColIdx !== -1) {
    var urlVals = sheet.getRange(2, urlColIdx + 1, lastRow - 1, 1).getValues();
    for (var k = 0; k < urlVals.length; k++) {
      var u = String(urlVals[k][0] || '').trim();
      if (u) tokens.push(u);
    }
  }
  return { ids: ids, tokens: tokens, hasIdCol: idColIdx !== -1, hasUrlCol: urlColIdx !== -1 };
}
```

The endpoint returns **both** raw arrays (Membership IDs and Bio URLs); normalization happens client-side in `background.js`. This keeps Apps Script logic minimal and lets us iterate on normalization rules without re-deploying.

`hasIdCol` and `hasUrlCol` flags let the popup show the right "can't dedupe" message: if **neither** column exists, dedup is impossible and the toggle is replaced with a one-line note. If **at least one** exists, dedup proceeds with whatever it can find.

---

## State persistence (resume-after-interrupt)

`state.knownProfiles` and `state.skippedDupes` need to survive interruption. Two options:

- **(a) Persist them in `saveState()`.** A `Set` becomes a JS array on serialize; back to `Set` on resume. Adds ~50KB to the saved state per 5K known URLs (well under chrome.storage limits). **Chosen.**
- **(b) Re-fetch from Apps Script on resume.** Slower (Apps Script roundtrip on resume), wastes user time, network-dependent. Rejected.

If a resume happens and `state.knownProfiles` is missing from the saved blob (e.g. saved before this feature shipped), we re-fetch — cheap fallback, only happens once per cold-start.

---

## Edge cases & failure modes

| Case | Behavior |
|---|---|
| Apps Script call fails on Start | Log warning, `state.knownProfiles = null`, scrape runs without dedup. UI shows the "Couldn't check for duplicates · running anyway" note. |
| Sheet is fresh (zero rows) | Empty Set, nothing skipped. Toggle hidden. |
| Sheet has rows but neither a Membership ID nor a Bio URL column | `hasIdCol: false, hasUrlCol: false`, scrape runs without dedup. UI shows the "Can't dedupe" note. |
| Sheet has Bio URL column but no Membership ID column (or vice-versa) | Dedup proceeds with whatever's available — `id:` keys for one direction, `tok:` keys for the other. |
| Anonymous profiles (`/sales/people/...`, no Membership ID extracted) | `tokenFromUrl` returns null AND `normalizeMembershipId` returns null → no dedup keys → always treated as new. Never skipped. |
| Batch run with multiple jobs writing to different tabs of the same sheet | Each job fetches its **own** known set on its own start. Cross-tab dedup is **not** applied — each tab is treated as an independent dedup scope. |
| User flips toggle OFF | `state.knownProfiles = null`, `state.skippedDupes = 0`. No dedup, no counter. Same as scrape today. |
| Resume after interrupt | `state.knownProfiles` restored from save; if missing, re-fetch from sheet. |
| Sheet has 50K+ rows | Apps Script reads single column with `getRange(...).getValues()` in one call — measured fast at this size. No pagination needed. |

---

## What's deliberately not in scope

- **Cross-tab dedup within one batch.** If Job 1 writes to "Scrape 1" and Job 2 writes to "Scrape 2" of the same sheet, and a lead appears in both searches, it gets written to both tabs. Each tab is its own scope. Could add later as a `dedupAcrossTabs: true` flag on the batch config.
- **Cleanup of pre-existing dupes.** Out of scope — this feature prevents new ones, doesn't remediate old ones. A "find dupes" Apps Script utility could be added later as a separate feature.
- **Time-decay dedup.** ("Re-scrape someone if I haven't seen them in 90 days.") No. The "rescrape everything" toggle covers the manual variant.
- **Telemetry beyond the on-screen counter.** Not adding any analytics/logging beyond what `addLog()` already does.

---

## Open questions

- **Source of truth = destination sheet** ✅ confirmed
- **Dedup primary key = LinkedIn Membership ID** ✅ confirmed (verified against real sheet 2026-05-07)
- **Dedup fallback key = URL token from Linkedin Bio** ✅ confirmed (verified against real sheet 2026-05-07)
- **Override = inline toggle, per-launch, default ON** ✅ confirmed
- **Cross-tab in batch = per-tab scope** ✅ proposed (revisit if pain emerges)
- **Failure of dedup-fetch = silent fallback to no-dedup** ✅ proposed

**One verification step before code lands:** confirm `content.js` extracts a `membershipId` field for new profiles (numeric, matching the format the existing scraper writes to the sheet). If it only extracts `profileUrl`, the dedup still works via the URL-token fallback — but Membership ID is the cleaner primary key, and we should make sure both are populated on the scraper side. This is a `grep`-and-look check during implementation, not a design change.

---

## Next step

This spec → review by user → implementation plan via `writing-plans`.
