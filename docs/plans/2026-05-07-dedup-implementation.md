# Cross-run Lead Deduplication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip leads already present in the destination Google Sheet (by LinkedIn Membership ID, or URL token from the Linkedin Bio column as a fallback), with a per-launch override toggle for testing. Surface skipped count mid-run and at completion.

**Architecture:** Apps Script gets a new `getKnownProfiles` action that reads two columns from the destination tab and returns raw arrays. `background.js` fetches that on scrape Start, normalizes both columns into a prefixed `Set<string>` (`id:` for membership IDs, `tok:` for URL tokens), filters extracted profiles against it during the existing extraction loop, and tracks a `skippedDupes` counter. The popup gets an inline toggle (defaulting ON) that the user can flip per launch, plus skipped-count surfaces in the progress and done views.

**Tech Stack:** Vanilla JS Chrome MV3 extension, Google Apps Script web app for Sheets I/O. No test framework — verification is manual against a real sheet.

**Spec:** `docs/specs/2026-05-07-dedup-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `SheetCompanion.js.txt` | Apps Script — Sheets I/O | Add `getKnownProfiles` action (~40 lines new) |
| `background.js` | MV3 service worker — orchestrates scrape | Add normalization helpers, dedup fetch on Start, filter logic, persist in saveState |
| `popup.html` | UI markup + CSS | Add `dedup-toggle` to 3 launch views, augment progress/done views with skipped counter |
| `popup.js` | UI logic | Render toggle state, fetch known set on view-show, pass `dedup` flag on Start, render skipped counter |
| `manifest.json` | Extension manifest | Bump version to 3.12.0 |

---

## Task 1: Apps Script — `getKnownProfiles` action

**Files:**
- Modify: `SheetCompanion.js.txt:5-13` (add case to switch in `doPost`)
- Modify: `SheetCompanion.js.txt:17` (add to `doGet` action list)
- Modify: `SheetCompanion.js.txt` end-of-file (add handler function)

- [ ] **Step 1.1: Add the new case to the doPost switch**

Edit `SheetCompanion.js.txt` lines 5-13. Replace:

```js
    switch (p.action) {
      case "writeProfiles": return handleWrite(p);
      case "readTabs": return handleReadTabs(p);
      case "readColumns": return handleReadColumns(p);
      case "readJobs": return handleReadJobs(p);
      case "updateJob": return handleUpdateJob(p);
      case "writeBackLink": return handleWriteBackLink(p);
      case "checkSharing": return handleCheckSharing(p);
      default: return jr({success:false, error:"Unknown: "+p.action});
    }
```

With:

```js
    switch (p.action) {
      case "writeProfiles": return handleWrite(p);
      case "readTabs": return handleReadTabs(p);
      case "readColumns": return handleReadColumns(p);
      case "readJobs": return handleReadJobs(p);
      case "updateJob": return handleUpdateJob(p);
      case "writeBackLink": return handleWriteBackLink(p);
      case "checkSharing": return handleCheckSharing(p);
      case "getKnownProfiles": return handleGetKnownProfiles(p);
      default: return jr({success:false, error:"Unknown: "+p.action});
    }
```

- [ ] **Step 1.2: Update the doGet action list**

Edit line 17. Replace:

```js
function doGet() { return jr({status:"ok",version:"2.3",actions:["writeProfiles","readTabs","readColumns","readJobs","updateJob","writeBackLink","checkSharing"]}); }
```

With:

```js
function doGet() { return jr({status:"ok",version:"2.4",actions:["writeProfiles","readTabs","readColumns","readJobs","updateJob","writeBackLink","checkSharing","getKnownProfiles"]}); }
```

- [ ] **Step 1.3: Add the handler function at end of file**

Append to `SheetCompanion.js.txt`:

```js

/* Read the destination tab's LinkedIn Membership ID + Linkedin Bio columns
 * and return the raw values. Normalization happens client-side so we can
 * iterate on rules without redeploying.
 *
 * Returns: {success, ids:[...], tokens:[...], hasIdCol, hasUrlCol, error?}
 */
function handleGetKnownProfiles(p) {
  if (!p.sheetUrl) return jr({success:false, error:"Missing sheetUrl"});
  if (!p.tabName) return jr({success:false, error:"Missing tabName"});
  try {
    var ss = SpreadsheetApp.openByUrl(p.sheetUrl);
    var sheet = ss.getSheetByName(p.tabName);
    if (!sheet) return jr({success:true, ids:[], tokens:[], hasIdCol:false, hasUrlCol:false, note:"Tab not found — treated as empty"});
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return jr({success:true, ids:[], tokens:[], hasIdCol:false, hasUrlCol:false, note:"Empty tab"});

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var idColIdx = -1, urlColIdx = -1;
    var ID_HEADERS = ["linkedin membership id", "membership id", "linkedin id"];
    var URL_HEADERS = ["linkedin bio", "linkedin url", "profile url", "sales nav url"];
    for (var i = 0; i < headers.length; i++) {
      var h = String(headers[i] || "").trim().toLowerCase();
      if (idColIdx === -1 && ID_HEADERS.indexOf(h) !== -1) idColIdx = i;
      if (urlColIdx === -1 && URL_HEADERS.indexOf(h) !== -1) urlColIdx = i;
    }

    var ids = [], tokens = [];
    if (idColIdx !== -1) {
      var idVals = sheet.getRange(2, idColIdx + 1, lastRow - 1, 1).getValues();
      for (var j = 0; j < idVals.length; j++) {
        var v = String(idVals[j][0] || "").trim();
        if (v) ids.push(v);
      }
    }
    if (urlColIdx !== -1) {
      var urlVals = sheet.getRange(2, urlColIdx + 1, lastRow - 1, 1).getValues();
      for (var k = 0; k < urlVals.length; k++) {
        var u = String(urlVals[k][0] || "").trim();
        if (u) tokens.push(u);
      }
    }
    return jr({success:true, ids:ids, tokens:tokens, hasIdCol:idColIdx !== -1, hasUrlCol:urlColIdx !== -1});
  } catch (e) {
    return jr({success:false, error:String(e.message || e)});
  }
}
```

- [ ] **Step 1.4: Deploy the new Apps Script version**

Open the script at `script.google.com` (the project tied to `WEB_APP_URL` in `background.js:1`). In the editor:
1. **Deploy → Manage deployments → ✏️ Edit (the active web-app deployment)**
2. **Version → New version → Description: "v2.4 — getKnownProfiles"**
3. Click **Deploy**, copy the new web-app URL.
4. **If the URL changed**, update `WEB_APP_URL` in `background.js:1`. (It usually doesn't change on a redeploy of the same script — verify before editing.)

- [ ] **Step 1.5: Verify the endpoint works**

In a terminal:

```bash
curl -X POST 'https://script.google.com/macros/s/AKfycbyW3i2O8ZOCO1mpGmUnu2sLeCXWI9n0HrFCE8ZZ2dzf27SRVNELKL85vxpKLM0-b3_k/exec' \
  -H 'Content-Type: text/plain' \
  -d '{"action":"getKnownProfiles","sheetUrl":"<a real shared sheet URL>","tabName":"<a real tab name>"}'
```

Expected response shape:

```json
{
  "success": true,
  "ids": ["109910746", "12658813@linkedinmembership", ...],
  "tokens": ["https://www.linkedin.com/in/ACwAA...", ...],
  "hasIdCol": true,
  "hasUrlCol": true
}
```

If `success: false` — check the deployment, the sheet sharing, the tab name spelling.

- [ ] **Step 1.6: Commit**

```bash
git add "Sales Nav Scraper/SheetCompanion.js.txt"
git commit -m "feat(apps-script): add getKnownProfiles action for cross-run dedup"
```

---

## Task 2: `background.js` — normalization helpers

**Files:**
- Modify: `background.js` — add three pure functions near the top (after `WEB_APP_URL`)

- [ ] **Step 2.1: Add normalization helpers**

Find the line `var WEB_APP_URL = "..."` near the top of `background.js`. Add immediately after it:

```js

/* ─── Dedup key extraction ────────────────────────────────────────────
 * Two-namespace Set: 'id:' for LinkedIn Membership IDs, 'tok:' for URL
 * tokens. A scraped profile is a dup if either of its keys hits the Set. */

function normalizeMembershipId(v) {
  if (v == null) return null;
  var m = String(v).match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

function tokenFromUrl(raw) {
  if (!raw) return null;
  var m = String(raw).toLowerCase().match(/\/(?:in|sales\/lead)\/([a-z0-9_-]+)/);
  return m ? m[1] : null;
}

function dedupKeysForProfile(p) {
  var keys = [];
  if (!p) return keys;
  var id = normalizeMembershipId(p.membershipId);
  if (id) keys.push("id:" + id);
  var tok = tokenFromUrl(p.profileUrl);
  if (tok) keys.push("tok:" + tok);
  return keys;
}
```

- [ ] **Step 2.2: Smoke-test the helpers in the SW console**

Reload the extension at `chrome://extensions`. Open the **service worker** dev-tools (the "service worker" link on the extension card → "Inspect"). In its Console tab, run:

```js
normalizeMembershipId("109910746");                    // "109910746"
normalizeMembershipId("12658813@linkedinmembership");  // "12658813"
normalizeMembershipId("");                             // null
normalizeMembershipId(null);                           // null

tokenFromUrl("https://www.linkedin.com/in/ACwAAA1?abc=def");  // "acwaaa1"
tokenFromUrl("https://www.linkedin.com/sales/lead/ACwAAA1");  // "acwaaa1"
tokenFromUrl("https://www.linkedin.com/sales/people/foo");    // null

dedupKeysForProfile({membershipId:"109910746", profileUrl:"https://www.linkedin.com/in/ACwAAA1"});
// ["id:109910746", "tok:acwaaa1"]
```

Each line should produce the comment's expected value. If any are wrong, fix the regex and rerun.

- [ ] **Step 2.3: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): add normalizeMembershipId, tokenFromUrl, dedupKeysForProfile helpers"
```

---

## Task 3: `background.js` — fetch known profiles helper

**Files:**
- Modify: `background.js` — add `buildKnownProfilesSet` near the existing `fetch(WEB_APP_URL, ...)` calls.

- [ ] **Step 3.1: Add the fetch helper**

Find a place near the bottom of `background.js` (after the existing `WEB_APP_URL` fetch helpers around line 916). Add:

```js

/* Fetch known profiles from the destination sheet and build a Set<string>
 * keyed with 'id:<digits>' or 'tok:<url-token>' prefixes.
 * Returns: { set, hasIdCol, hasUrlCol, error? } — set is null on failure
 * so the caller can run without dedup. */
async function buildKnownProfilesSet(sheetUrl, tabName) {
  if (!sheetUrl || !tabName) {
    addLog("warn", "Dedup: missing sheetUrl or tabName — skipping dedup");
    return { set: null, hasIdCol: false, hasUrlCol: false };
  }
  try {
    var payload = { action: "getKnownProfiles", sheetUrl: sheetUrl, tabName: tabName };
    var resp = await fetch(WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload)
    });
    var data = await resp.json();
    if (!data.success) throw new Error(data.error || "getKnownProfiles failed");

    var set = new Set();
    (data.ids || []).forEach(function(v) {
      var k = normalizeMembershipId(v);
      if (k) set.add("id:" + k);
    });
    (data.tokens || []).forEach(function(v) {
      var k = tokenFromUrl(v);
      if (k) set.add("tok:" + k);
    });
    addLog("info", "Dedup: loaded " + set.size + " known keys from '" + tabName + "' (ids:" + (data.ids||[]).length + ", tokens:" + (data.tokens||[]).length + ")");
    return { set: set, hasIdCol: !!data.hasIdCol, hasUrlCol: !!data.hasUrlCol };
  } catch (e) {
    addLog("warn", "Dedup: getKnownProfiles failed — running without dedup. " + (e.message || e));
    return { set: null, hasIdCol: false, hasUrlCol: false, error: String(e.message || e) };
  }
}
```

- [ ] **Step 3.2: Smoke-test in the SW console**

Reload the extension. In the SW console:

```js
buildKnownProfilesSet("<a real shared sheet URL>", "<a tab with leads>").then(r => console.log(r));
```

Expected: console logs an object like `{ set: Set(312), hasIdCol: true, hasUrlCol: true }`. The number 312 should match the number of populated rows in that tab.

If `set: null` → check `addLog` output above for the warning line.

- [ ] **Step 3.3: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): add buildKnownProfilesSet — fetch+normalize known leads from sheet"
```

---

## Task 4: `background.js` — wire dedup state into single-mode startScrape

**Files:**
- Modify: `background.js` — find `startScrape` and the `state` declaration; add `knownProfiles`, `skippedDupes`, `dedupOn` fields and the fetch call before the scrape loop begins.

- [ ] **Step 4.1: Add fields to the initial state object**

Find the `state` declaration in `background.js` (around line 91, the object with `mode: null, isRunning: false, ...`). Find the line:

```js
var state = {
  mode: null, isRunning: false, isPaused: false, recoverRequested: false, retryQueue: [],
  tabId: null, currentPage: 0, totalPages: 0, totalResults: 0,
  profilesScraped: 0, allProfiles: [], errors: [],
```

Add three fields to this object (insert them on a new line right after `errors: [],`):

```js
  knownProfiles: null, skippedDupes: 0, dedupOn: false,
```

The full updated declaration prefix should look like:

```js
var state = {
  mode: null, isRunning: false, isPaused: false, recoverRequested: false, retryQueue: [],
  tabId: null, currentPage: 0, totalPages: 0, totalResults: 0,
  profilesScraped: 0, allProfiles: [], errors: [],
  knownProfiles: null, skippedDupes: 0, dedupOn: false,
  /* ...remaining existing fields... */
```

Find the `state = { ... }` reset object lower in the file (around line 207) and add the same three fields there for state reset consistency.

- [ ] **Step 4.2: Initialize dedup at single-scrape start**

Find `case 'startScrape'` in the message dispatch (around line 175). Locate the corresponding handler — likely a function `startScrape(cfg)` or the inline body. Find the section that initializes `state.tabId`, `state.currentPage`, `state.allProfiles = []`, etc. Right after `state.allProfiles = []`, add:

```js
  /* Dedup setup — read existing leads from destination sheet unless user opted out */
  state.dedupOn = cfg.dedup !== false;
  state.skippedDupes = 0;
  state.knownProfiles = null;
  if (state.dedupOn && cfg.sheetUrl && cfg.sheetName) {
    var known = await buildKnownProfilesSet(cfg.sheetUrl, cfg.sheetName);
    state.knownProfiles = known.set;  // null if fetch failed
  }
```

(`cfg` is the config object passed in from popup.js. The config already has `sheetUrl` and `sheetName` per `popup.js:678`.)

- [ ] **Step 4.3: Smoke-test single-mode dedup setup**

Reload extension. Open the SW console. Start a single-mode scrape against a sheet you've scraped before. In the SW console you should see:

```
Dedup: loaded N known keys from '<TabName>' (ids:N, tokens:N)
```

If N matches the number of existing rows in the destination tab, dedup is correctly initialized. The scrape will still run normally — the filter step lands in Task 6.

- [ ] **Step 4.4: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): initialize dedup state in single-mode startScrape"
```

---

## Task 5: `background.js` — wire dedup state into batch jobs

**Files:**
- Modify: `background.js` — the per-job init in the batch loop.

- [ ] **Step 5.1: Find the batch per-job initialization**

In `background.js`, search for the batch scrape loop. There should be a section that iterates `state.jobs` and per-job sets `state.salesNavUrl`, `state.tabId`, etc. (around line 558-600 area, look for `state.currentJobIndex` increments and `job.salesNavUrl`).

Find the per-job init block — typically right after `var job = state.jobs[state.currentJobIndex];` and before the page-1 navigation. Add:

```js
    /* Per-job dedup setup — each job's destination tab has its own known set */
    state.skippedDupes = 0;
    state.knownProfiles = null;
    if (state.dedupOn && job.resultSheetUrl && job.tabName) {
      var jobKnown = await buildKnownProfilesSet(job.resultSheetUrl, job.tabName);
      state.knownProfiles = jobKnown.set;
    }
```

(Confirm the job's destination sheet URL field — likely `job.resultSheetUrl` or `job.destSheetUrl`. Adjust based on what `setJobs` payload contains. Check the dispatch of `setJobs` and the `state.jobs[i]` shape.)

- [ ] **Step 5.2: Initialize `state.dedupOn` from setJobs config**

Find the `setJobs` message handler (search `case 'setJobs'` in `background.js`). After the existing job-array assignment, add:

```js
    state.dedupOn = msg.dedup !== false;
```

(`msg` is the message payload — adjust the variable name to match the local handler scope.)

- [ ] **Step 5.3: Smoke-test batch dedup setup**

Reload extension. Run a small batch (2 jobs) against sheets you've scraped before. In SW console you should see TWO separate dedup loads:

```
Dedup: loaded 18 known keys from 'Scrape 1' (...)
Dedup: loaded 0 known keys from 'Scrape 2' (...)
```

(The second is 0 because Scrape 2 is fresh.)

- [ ] **Step 5.4: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): initialize dedup state per-job in batch mode"
```

---

## Task 6: `background.js` — filter scraped profiles against known set

**Files:**
- Modify: `background.js` — the existing extraction loop where `r.profiles` is concatenated into `state.allProfiles`.

- [ ] **Step 6.1: Find the extraction merge point**

In `background.js`, search for `state.allProfiles=state.allProfiles.concat(r.profiles)` and `state.allProfiles.concat(r.profiles)`. There should be 1-2 occurrences, both for single and batch modes (verified at line 383 and around line 600).

- [ ] **Step 6.2: Replace each concat with a filtered version**

For each occurrence, replace:

```js
state.allProfiles=state.allProfiles.concat(r.profiles);state.profilesScraped+=r.profiles.length;
```

With:

```js
var __dedupResult = applyDedupFilter(r.profiles);
state.allProfiles = state.allProfiles.concat(__dedupResult.kept);
state.profilesScraped += __dedupResult.kept.length;
state.skippedDupes += __dedupResult.skipped;
```

- [ ] **Step 6.3: Add the `applyDedupFilter` helper near the dedup helpers from Task 2**

In `background.js`, after the `dedupKeysForProfile` function from Task 2.1, add:

```js

/* Filter a freshly-extracted profile array against state.knownProfiles.
 * Returns { kept:[...new only...], skipped:N }. Each kept profile's keys
 * are added to the known set so within-run dupes are also caught. */
function applyDedupFilter(profiles) {
  if (!state.knownProfiles) return { kept: profiles, skipped: 0 };
  var kept = [];
  var skipped = 0;
  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    var keys = dedupKeysForProfile(p);
    if (keys.length === 0) { kept.push(p); continue; }   // anonymous — keep
    var isDupe = false;
    for (var j = 0; j < keys.length; j++) {
      if (state.knownProfiles.has(keys[j])) { isDupe = true; break; }
    }
    if (isDupe) { skipped++; continue; }
    for (var k = 0; k < keys.length; k++) state.knownProfiles.add(keys[k]);
    kept.push(p);
  }
  return { kept: kept, skipped: skipped };
}
```

- [ ] **Step 6.4: Smoke-test filtering**

Reload extension. Run a single-mode scrape against a sheet that already has, say, 18 rows from a prior scrape of the same search.

After page 1 finishes, in the SW console:

```js
chrome.runtime.sendMessage({action:'getState'}, console.log)
```

Verify the response has `skippedDupes > 0` and `allProfiles.length` is less than `(currentPage * 25)`. The skipped count should be roughly the overlap with the existing sheet.

Then check the destination sheet: it should NOT have new duplicate rows for the people who were already there.

- [ ] **Step 6.5: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): filter extracted profiles against known set; track skippedDupes"
```

---

## Task 7: `background.js` — persist dedup state across resume

**Files:**
- Modify: `background.js` — the `saveState` and resume code paths.

- [ ] **Step 7.1: Persist Set as Array in saveState**

In `background.js`, find `async function saveState()` (around line 255). The function body builds an object literal with `mode, currentPage, totalPages, totalResults, profilesScraped, ...`. Add to that object:

```js
    knownProfilesArr: state.knownProfiles ? Array.from(state.knownProfiles) : null,
    skippedDupes: state.skippedDupes || 0,
    dedupOn: !!state.dedupOn,
```

- [ ] **Step 7.2: Restore Set from Array on resume**

Find the resume code in `background.js` — search for `s.profilesScraped=s.profilesScraped` or `state.currentPage=s.currentPage||1`. Around line 295-305 there's a single-mode resume; around line 320-330 there's a batch resume. In both, after the existing assignments, add:

```js
      state.skippedDupes = s.skippedDupes || 0;
      state.dedupOn = s.dedupOn !== false;
      state.knownProfiles = (s.knownProfilesArr && Array.isArray(s.knownProfilesArr)) ? new Set(s.knownProfilesArr) : null;
      /* If resuming from before this feature shipped, knownProfiles will be null —
         re-fetch from the sheet so dedup still works on the resumed run. */
      if (state.dedupOn && state.knownProfiles === null && state.sheetUrl && state.sheetName) {
        var __resumeKnown = await buildKnownProfilesSet(state.sheetUrl, state.sheetName);
        state.knownProfiles = __resumeKnown.set;
      }
```

(For the batch resume, replace `state.sheetUrl` / `state.sheetName` with the per-job equivalents — `state.jobs[state.currentJobIndex].resultSheetUrl` and `.tabName`.)

- [ ] **Step 7.3: Smoke-test resume preserves dedup**

1. Start a single-mode scrape against a sheet you've scraped before. Wait until page 2 completes.
2. Reload the extension at `chrome://extensions` (this kills the SW and forces a save+restore cycle).
3. Open the popup → should land on `view-single-interrupted`. In SW console:

   ```js
   chrome.runtime.sendMessage({action:'getState'}, console.log)
   ```

   Verify `skippedDupes` is preserved (matches what it was before reload) and `knownProfilesArr.length > 0` after `getState`.

4. Click Resume. Scrape continues. New leads on page 3 are still dedupe-checked (no dupes appear in sheet).

- [ ] **Step 7.4: Commit**

```bash
git add "Sales Nav Scraper/background.js"
git commit -m "feat(bg): persist dedup state in saveState; restore (or re-fetch) on resume"
```

---

## Task 8: `popup.html` + CSS — dedup toggle component

**Files:**
- Modify: `popup.html` — add CSS block for `.dedup-toggle`, add the toggle to 3 launch views

- [ ] **Step 8.1: Add CSS for the dedup toggle**

In `popup.html`, find the existing `.preflight` CSS block (search `/* ─── Preflight banner`). After that block ends (just before `/* ─── Mode toggle (Quick / Batch)`), insert:

```css
/* ─── Dedup toggle (above Start CTAs on launch views) ─── */
.dedup-toggle{
  margin:0 0 14px; padding:12px 14px;
  border-radius:10px;
  background:var(--paper-2); border:1px solid var(--rule);
  display:grid; grid-template-columns:auto 1fr auto; gap:12px; align-items:center;
}
.dedup-toggle .switch{
  width:36px; height:20px; border-radius:999px; background:var(--rule-2); position:relative;
  cursor:pointer; flex-shrink:0; transition:background 200ms var(--ease);
}
.dedup-toggle .switch.on{background:var(--ok);}
.dedup-toggle .switch::after{
  content:""; position:absolute; top:2px; left:2px; width:16px; height:16px;
  border-radius:50%; background:var(--paper); transition:left 200ms var(--ease);
}
.dedup-toggle .switch.on::after{left:18px;}
.dedup-toggle .label{
  font-family:var(--sans); font-size:12.5px; color:var(--ink-2); line-height:1.4;
}
.dedup-toggle .label strong{color:var(--ink); font-weight:600;}
.dedup-toggle .count{
  font-family:var(--mono); font-size:10.5px; letter-spacing:0.04em;
  color:var(--ink-faint); white-space:nowrap;
}
.dedup-toggle.off{background:rgba(139,58,46,0.04); border-color:rgba(139,58,46,0.25);}
.dedup-toggle.off .label{color:var(--err);}
.dedup-toggle.off .label strong{color:var(--err);}
.dedup-note{
  margin:0 0 14px; padding:11px 14px;
  border-radius:10px;
  background:var(--paper-2); border:1px solid var(--rule);
  font-family:var(--sans); font-size:12px; color:var(--ink-soft); line-height:1.5;
  font-style:italic;
}
```

- [ ] **Step 8.2: Add the toggle to view-single-wrong (paste flow)**

In `popup.html`, find `view-single-wrong`. Inside its `.hero` div, find the line with `<button class="cta" id="btn-paste-start"`. Insert right BEFORE the `.actions` div containing that button:

```html
      <div class="dedup-toggle hidden" id="dedup-toggle-paste" role="group" aria-label="Skip already-scraped leads">
        <button class="switch on" id="dedup-switch-paste" type="button" aria-pressed="true" aria-label="Skip leads already in this sheet"></button>
        <span class="label" id="dedup-label-paste"><strong>Skip leads already in this sheet</strong></span>
        <span class="count" id="dedup-count-paste"></span>
      </div>
      <div class="dedup-note hidden" id="dedup-note-paste"></div>
```

- [ ] **Step 8.3: Add the toggle to view-single-ready (current-tab flow)**

In `popup.html`, find `view-single-ready`. Find the `.actions` div with `<button class="cta" id="btn-start"`. Insert right before it:

```html
      <div class="dedup-toggle hidden" id="dedup-toggle-single" role="group" aria-label="Skip already-scraped leads">
        <button class="switch on" id="dedup-switch-single" type="button" aria-pressed="true" aria-label="Skip leads already in this sheet"></button>
        <span class="label" id="dedup-label-single"><strong>Skip leads already in this sheet</strong></span>
        <span class="count" id="dedup-count-single"></span>
      </div>
      <div class="dedup-note hidden" id="dedup-note-single"></div>
```

- [ ] **Step 8.4: Add the toggle to view-batch-ready**

In `popup.html`, find `view-batch-ready`. Find the `.actions.between` div with `<button class="cta" id="btn-start-batch"`. Insert right before it (same level as the existing preflight banner):

```html
      <div class="dedup-toggle hidden" id="dedup-toggle-batch" role="group" aria-label="Skip already-scraped leads">
        <button class="switch on" id="dedup-switch-batch" type="button" aria-pressed="true" aria-label="Skip leads already in destination sheets"></button>
        <span class="label" id="dedup-label-batch"><strong>Skip leads already in destination sheets</strong></span>
        <span class="count" id="dedup-count-batch"></span>
      </div>
      <div class="dedup-note hidden" id="dedup-note-batch"></div>
```

- [ ] **Step 8.5: Smoke-test markup**

Reload extension. Open popup → walk to each of the 3 launch views. The toggle elements exist in the DOM but are hidden (`.hidden`). Confirm via DevTools → Inspect → search for `dedup-toggle-`. Three should be present. Wiring lands in Task 9.

- [ ] **Step 8.6: Commit**

```bash
git add "Sales Nav Scraper/popup.html"
git commit -m "feat(ui): add dedup-toggle markup + CSS to 3 launch views"
```

---

## Task 9: `popup.js` — dedup toggle wiring + Start config

**Files:**
- Modify: `popup.js` — add toggle state, fetch known set on view-show, render UI, pass `dedup` flag to background.

- [ ] **Step 9.1: Add the dedup state and helpers near the top of the DOMContentLoaded body**

In `popup.js`, find the line `document.addEventListener('DOMContentLoaded', function(){` near the top. Inside that handler (so the helper closes over `$`), and after the existing `paintPreflights` helper from Task 2 in the prior phase, add:

```js
  /* ── Dedup toggle state — per-launch, default ON ── */
  var dedupState = {
    paste: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null },
    single: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null },
    batch: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null }
  };

  function renderDedupToggle(which) {
    var s = dedupState[which];
    var toggle = $('dedup-toggle-' + which);
    var note = $('dedup-note-' + which);
    var sw = $('dedup-switch-' + which);
    var label = $('dedup-label-' + which);
    var count = $('dedup-count-' + which);
    if (!toggle || !note) return;
    /* Failure / no columns / no count → show note OR hide entirely */
    if (s.error) {
      toggle.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = "Couldn't check for duplicates · running anyway";
      return;
    }
    if (!s.hasIdCol && !s.hasUrlCol && s.count === 0) {
      /* Sheet is empty OR has no relevant columns. Don't surface the toggle. */
      toggle.classList.add('hidden');
      note.classList.add('hidden');
      return;
    }
    if (!s.hasIdCol && !s.hasUrlCol) {
      toggle.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = "Can't dedupe — sheet has no LinkedIn Membership ID or Bio column";
      return;
    }
    if (s.count === 0) {
      /* Has columns but no rows yet. No point showing the toggle. */
      toggle.classList.add('hidden');
      note.classList.add('hidden');
      return;
    }
    toggle.classList.remove('hidden');
    note.classList.add('hidden');
    toggle.classList.toggle('off', !s.on);
    if (sw) {
      sw.classList.toggle('on', s.on);
      sw.setAttribute('aria-pressed', s.on ? 'true' : 'false');
      sw.setAttribute('aria-label', s.on ? 'Skip leads already in this sheet — currently on' : 'Re-scrape everything — currently off');
    }
    if (label) {
      label.innerHTML = s.on
        ? '<strong>Skip leads already in this sheet</strong>'
        : '<strong>Re-scrape everything</strong> — dupes will be re-added';
    }
    if (count) {
      count.textContent = s.count.toLocaleString() + ' found';
    }
  }
  function wireDedupSwitch(which) {
    var sw = $('dedup-switch-' + which);
    if (!sw) return;
    sw.addEventListener('click', function() {
      dedupState[which].on = !dedupState[which].on;
      renderDedupToggle(which);
    });
  }
  ['paste','single','batch'].forEach(wireDedupSwitch);

  /* Ask background.js to check the destination sheet for known leads. The
     popup doesn't talk to Apps Script directly — background does. */
  async function refreshDedupForView(which, sheetUrl, tabName) {
    if (!sheetUrl || !tabName) {
      dedupState[which] = { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null };
      renderDedupToggle(which);
      return;
    }
    var r = await sendBG('previewDedup', { sheetUrl: sheetUrl, tabName: tabName });
    if (!r || !r.ok) {
      dedupState[which] = { on: dedupState[which].on, count: 0, hasIdCol: false, hasUrlCol: false, error: (r && r.error) || 'fetch failed' };
    } else {
      dedupState[which] = {
        on: dedupState[which].on,
        count: r.count || 0,
        hasIdCol: !!r.hasIdCol,
        hasUrlCol: !!r.hasUrlCol,
        error: null
      };
    }
    renderDedupToggle(which);
  }
```

- [ ] **Step 9.2: Trigger the dedup preview when each launch view is shown**

In `popup.js`, find `function showInterrupted(saved)` (around line 683). Above it, find or add hooks for the three launch views:

For **view-single-wrong** (paste flow): the paste-start handler in `popup.js` already exists. Find the `Open and scrape` flow added in v3.10.1. Right after the user fills in the sheet URL+tab name fields, the toggle should refresh. Add a debounced refresh: in `popup.js`, find the `input-paste-sheet-url` and `input-paste-sheet-name` setup. After they're created/wired in the DOM, add:

```js
  /* Refresh paste-view dedup preview when sheet URL or tab name changes */
  var pastePreviewTimer = null;
  function pastePreview() {
    var sheet = $('input-paste-sheet-url') ? $('input-paste-sheet-url').value.trim() : '';
    var tab = ($('input-paste-sheet-name') ? $('input-paste-sheet-name').value.trim() : '') || 'Sales Nav Scrape';
    if (sheet.indexOf('docs.google.com/spreadsheets') === -1) {
      dedupState.paste = { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null };
      renderDedupToggle('paste');
      return;
    }
    refreshDedupForView('paste', sheet, tab);
  }
  ['input-paste-sheet-url','input-paste-sheet-name'].forEach(function(id) {
    var el = $(id);
    if (el) el.addEventListener('input', function() {
      if (pastePreviewTimer) clearTimeout(pastePreviewTimer);
      pastePreviewTimer = setTimeout(pastePreview, 600);
    });
  });
```

For **view-single-ready** (current-tab flow): find the `initSingle()` function. After the existing `chrome.storage.sync.get({lastSheetUrl, lastSheetName}` block (around line 661-664), add:

```js
  /* Wire result-sheet inputs to refresh dedup preview */
  var singlePreviewTimer = null;
  function singlePreview() {
    var sheet = $('input-sheet-url') ? $('input-sheet-url').value.trim() : '';
    var tab = ($('input-sheet-name') ? $('input-sheet-name').value.trim() : '') || 'Sales Nav Scrape';
    if (sheet.indexOf('docs.google.com/spreadsheets') === -1) {
      dedupState.single = { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null };
      renderDedupToggle('single');
      return;
    }
    refreshDedupForView('single', sheet, tab);
  }
  ['input-sheet-url','input-sheet-name'].forEach(function(id) {
    var el = $(id);
    if (el) {
      /* Avoid double-binding if initSingle is called twice */
      el.removeEventListener('input', el._dedupListener || function(){});
      el._dedupListener = function() {
        if (singlePreviewTimer) clearTimeout(singlePreviewTimer);
        singlePreviewTimer = setTimeout(singlePreview, 600);
      };
      el.addEventListener('input', el._dedupListener);
    }
  });
  setTimeout(singlePreview, 200); /* fire once immediately for restored values */
```

For **view-batch-ready**: find `function confirmBatchConfig()` (around line 890+) — it's the function that builds `jobs` and calls `setJobs`, then transitions to `view-batch-ready`. After that transition, add:

```js
  /* Preview dedup against the FIRST job's destination tab as a representative.
     Each job has its own dedup at runtime — this preview is informational. */
  if (jobs.length > 0) {
    refreshDedupForView('batch', jobs[0].resultSheetUrl, jobs[0].tabName);
  }
```

(`jobs` is the local array built in that function. Verify the field names match — likely `resultSheetUrl` and `tabName` based on the spec.)

- [ ] **Step 9.3: Pass the dedup flag on Start**

Find the existing single-mode `startScrape` function in `popup.js` (around line 667). Find the line that builds `cfg`:

```js
  var cfg = {
    tabId: tabId,
    startPage: pageInfo ? pageInfo.currentPage : 1,
    totalPages: pageInfo ? pageInfo.totalPages : 0,
    totalResults: pageInfo ? pageInfo.totalResults : 0,
    sheetUrl: u, sheetName: nm
  };
```

Replace with:

```js
  var cfg = {
    tabId: tabId,
    startPage: pageInfo ? pageInfo.currentPage : 1,
    totalPages: pageInfo ? pageInfo.totalPages : 0,
    totalResults: pageInfo ? pageInfo.totalResults : 0,
    sheetUrl: u, sheetName: nm,
    dedup: dedupState.single.on
  };
```

Find the **paste-flow Start handler** (the `pasteBtn.addEventListener('click', ...)` block from v3.10.1). Find its `var cfg = ...` and add:

```js
        var cfg = { tabId: newTab.id, startPage: 1, totalPages: 0, totalResults: 0, sheetUrl: sheet, sheetName: name, dedup: dedupState.paste.on };
```

Find the **batch Start handler** — `function startBatch()` or wherever `setJobs` is dispatched. Find the `sendBG('setJobs', ...)` or `sendBG('startBatch', ...)` call. Add `dedup: dedupState.batch.on` to its payload:

```js
  var r = await sendBG('startBatch', { dedup: dedupState.batch.on });
```

(Adjust based on the actual current shape of the startBatch payload — append the field, don't replace anything.)

- [ ] **Step 9.4: Add the `previewDedup` background message handler**

In `background.js`, find the `chrome.runtime.onMessage.addListener` switch (around line 162). Add a new case:

```js
      case 'previewDedup':
        (async function() {
          var k = await buildKnownProfilesSet(msg.sheetUrl, msg.tabName);
          if (k.error) sendResponse({ ok: false, error: k.error });
          else sendResponse({ ok: true, count: k.set ? k.set.size : 0, hasIdCol: k.hasIdCol, hasUrlCol: k.hasUrlCol });
        })();
        return true;
```

(Make sure `return true` is present — required for async sendResponse.)

- [ ] **Step 9.5: Smoke-test the toggle UI**

Reload extension. Open popup, fill in the sheet URL on each of the 3 launch views (paste, single, batch). Within ~1s of typing, the toggle should appear with a count, e.g. *"Skip leads already in this sheet · 312 found"*. Click the switch — the toggle flips visually to off, label changes to *"Re-scrape everything — dupes will be re-added"*, background turns subtle red. Click again to flip back.

For batch: connect a sheet, load tab, configure, click "Build jobs". On the batch-ready view, the toggle should appear with a count from the FIRST job's destination tab.

Now click Start (single or batch). In SW console, observe the dedup state:

```
Dedup: loaded 312 known keys from 'Scrape 1' (...)
```

Flip the toggle OFF, click Start. SW console should NOT log the dedup load message — `state.knownProfiles` stays null and the scrape runs without dedup (every lead written, even dupes).

- [ ] **Step 9.6: Commit**

```bash
git add "Sales Nav Scraper/popup.js" "Sales Nav Scraper/background.js"
git commit -m "feat(ui): wire dedup toggle — preview count, off/on switch, pass dedup flag on Start"
```

---

## Task 10: Mid-run + done-view skipped counter

**Files:**
- Modify: `popup.html` — add a `<span>` for the counter to progress + done view subtitles
- Modify: `popup.js` — populate the counter in `updateProgress`, `updateBatchView`, `showDone`, `showBatchDone`

- [ ] **Step 10.1: Add the counter span in HTML — single progress view**

In `popup.html`, find `view-single-progress`. Find the existing line with `<span style="color:var(--ink-faint)" id="prog-eta">Estimating…</span>`. Just below the existing `figure-meta` div's closing tag, insert:

```html
        <div class="figure-meta" id="prog-skipped-row" style="display:none; margin-top:6px;">
          <span style="color:var(--ok); font-weight:600;" id="prog-skipped-count">0</span>
          <span style="color:var(--ink-faint);"> already-scraped skipped</span>
        </div>
```

- [ ] **Step 10.2: Add the counter span in HTML — batch running view**

In `popup.html`, find `view-batch-running`. Find the existing line `<span style="color:var(--ink-faint)" id="bp-eta"></span>` inside `.figure-meta`. Just below that `figure-meta` div's closing tag, insert:

```html
        <div class="figure-meta" id="bp-skipped-row" style="display:none; margin-top:6px;">
          <span style="color:var(--ok); font-weight:600;" id="bp-skipped-count">0</span>
          <span style="color:var(--ink-faint);"> already-scraped skipped this job</span>
        </div>
```

- [ ] **Step 10.3: Add the counter to single-done and batch-done**

Find `view-single-done`. Inside its `.figure-meta` (the one with `Pages`, `Time`, `Errors`), add a fourth line:

```html
          <span id="done-skipped-row" style="display:none;">Skipped <strong id="done-skipped-count">0</strong></span>
```

Find `view-batch-done`. Just before the closing `</section>`, add a small additional summary block (next to the existing `<ul id="batch-done-list">`):

```html
    <div class="figure-meta" id="batch-done-skipped-row" style="display:none; padding:0 22px 14px;">
      <span style="color:var(--ok); font-weight:600;" id="batch-done-skipped-count">0</span>
      <span style="color:var(--ink-faint);"> already-scraped skipped across all jobs</span>
    </div>
```

- [ ] **Step 10.4: Populate the counter in popup.js**

In `popup.js`, find `async function updateProgress()`. After the existing `$('prog-pct').textContent = pct + '%'` line, add:

```js
  if (st.skippedDupes && st.skippedDupes > 0) {
    $('prog-skipped-row').style.display = '';
    $('prog-skipped-count').textContent = st.skippedDupes.toLocaleString();
  } else {
    $('prog-skipped-row').style.display = 'none';
  }
```

In `popup.js`, find `function updateBatchView(st)`. Locate the section that updates the existing `.figure-meta` (around line 750+). Add:

```js
  if (st.skippedDupes && st.skippedDupes > 0) {
    $('bp-skipped-row').style.display = '';
    $('bp-skipped-count').textContent = st.skippedDupes.toLocaleString();
  } else {
    $('bp-skipped-row').style.display = 'none';
  }
```

In `popup.js`, find `function showDone(st)` (around line 739). After the existing `$('done-errors').textContent = ...` line, add:

```js
  if (st.skippedDupes && st.skippedDupes > 0) {
    $('done-skipped-row').style.display = '';
    $('done-skipped-count').textContent = st.skippedDupes.toLocaleString();
  } else {
    $('done-skipped-row').style.display = 'none';
  }
```

In `popup.js`, find `function showBatchDone(st)`. After the existing summary rendering, add:

```js
  /* Sum skippedDupes across all completed jobs (batch sums per-job into st.totalSkippedDupes if provided, else use state.skippedDupes from the last job) */
  var total = st.totalSkippedDupes || st.skippedDupes || 0;
  if (total > 0) {
    $('batch-done-skipped-row').style.display = '';
    $('batch-done-skipped-count').textContent = total.toLocaleString();
  } else {
    $('batch-done-skipped-row').style.display = 'none';
  }
```

- [ ] **Step 10.5: Have background.js track totalSkippedDupes across jobs**

In `background.js`, find the state initialization. Add:

```js
  totalSkippedDupes: 0,
```

(In both the initial declaration and the reset block.)

Find the per-job init (Task 5.1). When a job completes, before incrementing `currentJobIndex`, add:

```js
    state.totalSkippedDupes = (state.totalSkippedDupes || 0) + (state.skippedDupes || 0);
```

(Place this where the per-job result is finalized — search for `job.status='Done'` or similar.)

In the `getState` response (search `case 'getState'` around line 200), make sure `totalSkippedDupes` is included alongside `skippedDupes` in the response object.

- [ ] **Step 10.6: Smoke-test counters**

Reload extension. Run a single-mode scrape against a sheet with 18 existing leads from a prior scrape of the same search.

- During scrape: progress view's subtitle area shows *"3 already-scraped skipped"* (or similar) once skips begin. Hidden when 0.
- After completion: done view shows the same count in the figure-meta block.

For batch: run a 2-job batch with overlapping prior runs. After all jobs complete, batch-done view shows *"X already-scraped skipped across all jobs"* — sum across jobs.

- [ ] **Step 10.7: Commit**

```bash
git add "Sales Nav Scraper/popup.html" "Sales Nav Scraper/popup.js" "Sales Nav Scraper/background.js"
git commit -m "feat(ui): show skipped-dupes count in progress and done views"
```

---

## Task 11: Manifest bump + integration smoke test

**Files:**
- Modify: `manifest.json`

- [ ] **Step 11.1: Bump version**

Edit `manifest.json` lines 3-5. Replace:

```json
  "version": "3.11.0",
  "description": "Combine Single/Batch toggle and Slow toggle into one control strip (B-1): mode left, Slow pill + 'old PC / VM' hint right. Hides on inner views.",
```

With:

```json
  "version": "3.12.0",
  "description": "Cross-run lead deduplication: skip leads already in destination sheet by LinkedIn Membership ID or Bio URL; per-launch override toggle; skipped count surfaced in progress and done views.",
```

- [ ] **Step 11.2: End-to-end smoke test against a real sheet**

Reload extension at `chrome://extensions` (should show **v3.12.0**).

Set up a test scenario:

1. Pick a Sales Nav search URL.
2. Run it once into Sheet A (single mode). Note: 312 leads written, 0 skipped.
3. Reload the extension.
4. Run the same Sales Nav URL again into Sheet A. Expected: toggle shows *"Skip leads already in this sheet · 312 found"*. Default ON.
5. Click Start. Watch the progress: *"X collected · ~Y already-scraped skipped"*. Sheet A should NOT grow (or grow only by genuinely new people if LinkedIn surfaced any).
6. Reload extension again, run a third time. This time, click the dedup toggle to OFF before Start. Watch: no skip count, sheet A doubles.
7. Verify each step's behavior matches the expected outcome.

If any step fails, capture the SW console output and revisit the corresponding task.

- [ ] **Step 11.3: Commit**

```bash
git add "Sales Nav Scraper/manifest.json"
git commit -m "chore: bump to v3.12.0 — cross-run lead dedup"
```

---

## Self-review notes

**Spec coverage:**
- Goals (skip extraction + skip writes + override toggle + degrade gracefully + UI counter) → Tasks 4-10 ✓
- Apps Script endpoint → Task 1 ✓
- Normalization helpers + dedup keys → Task 2 ✓
- Fetch on Start (single + batch) → Tasks 4, 5 ✓
- Filter during extraction → Task 6 ✓
- State persistence on resume → Task 7 ✓
- UI toggle (3 views, 5 state variants) → Tasks 8, 9 ✓
- Mid-run + done counter → Task 10 ✓
- Edge cases (empty sheet, no columns, fetch fail, anonymous, batch per-tab) → covered in Task 6 (anonymous), Task 9.1 (empty/no-columns/fetch-fail), Task 5 (per-tab) ✓
- Manifest bump → Task 11 ✓

**Type / name consistency:**
- `dedupKeysForProfile` (Task 2.1) and `applyDedupFilter` (Task 6.3) — consistent
- `state.knownProfiles` (Task 4.1) — used identically in Tasks 5, 6, 7
- `state.skippedDupes` and `state.totalSkippedDupes` distinguished in Task 10.5
- `dedupState[which]` (Task 9.1) — three keys: `paste`, `single`, `batch`. Used consistently in Task 9.2, 9.3
- HTML IDs `dedup-toggle-{paste|single|batch}` etc. — match between Task 8 (markup) and Task 9 (wiring)
- Apps Script returns `{success, ids, tokens, hasIdCol, hasUrlCol, error?}` (Task 1.3); background reads `data.success`, `data.ids`, `data.tokens` (Task 3.1) — matches

**Placeholders:** scanned for "TBD", "implement later", "similar to". None present.

**One acknowledged gap:** Task 5.1 says "confirm `state.jobs[i]` shape" — engineer needs to grep for the exact field names (`job.resultSheetUrl` vs `job.destSheetUrl`). Not a placeholder per se — the field is in the existing code, just not explicitly documented in this plan's pseudocode. Engineer must verify before edit.

---
