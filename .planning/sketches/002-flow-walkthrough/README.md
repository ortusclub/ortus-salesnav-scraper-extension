---
sketch: 002
name: flow-walkthrough
question: "What does every step of the user journey look like in Variant C's language?"
winner: null
tags: [flow, states, onboarding, configure, filters, settings]
---

# Sketch 002: Flow Walkthrough

## Design Question

Variant C (Run-Centric Hero) won the layout debate in sketch 001. Now: drill in. What does *every* step of the journey look like in C's visual language — from first open to all-jobs-done — and where does the **filter-decode panel** live?

## How to View

```
open .planning/sketches/002-flow-walkthrough/index.html
```

Renders nine popups in a 3×3 grid, ordered chronologically. Each popup is at native 400px width.

## Steps

1. **First open** — empty welcome, single ask: paste source sheet.
2. **Connecting** — loading state with spinner and tab count.
3. **Pick a tab** — connected, list of tabs in the sheet with row counts.
4. **Configure** — URL column, row range, destination sheet, output column.
5. **Job preview · Filter decode** — list of jobs with toggle to skip; **expand a job to see the Sales Nav URL decoded into chips** (Title, Geo, Seniority, Company size, etc.).
6. **Running** — hero with live figure (1,275 of 1,884), queue underneath.
7. **Job done — moving on** — quick acknowledgment, next-job countdown, queue updates.
8. **All jobs done** — final summary with total leads in big serif, per-job breakdown.
9. **Settings** — Corner window, Anonymous-lead behavior. (Slow mode is surfaced as a thin strip at the top of every screen, not buried here.)

## What to Look For

- **Step 5 — the filter decode panel**: chips translate `?keywords=vp%20marketing&geoIncluded=…` into "Title: VP Marketing", "Geo: Germany · Austria · Switzerland", "Seniority: VP+", etc. Goal: operator confidence the right search is queued without staring at a URL.
- **Continuity**: same masthead, same footer, same chip vocabulary across all 9 popups. The visual language stays put as the content changes.
- **Anonymous framing throughout**: idle state introduces it neutrally; running state shows it as a calm note; done state mentions it as a footnote, not a problem.
- **Job toggle in step 5**: turning off a job before run is the same control as the Skipped chip in step 6 — operator can preview *and* curate.

## Open questions for the next round

- Should the filter-decode chips be editable in-place (edit a chip → modify the URL → re-build the job), or read-only previews? Current sketch is read-only.
- Does step 7 actually need to be a discrete state, or should the hero just morph in-place from running → done → next?
- Single-mode (when user is already on a Sales Nav search page) isn't sketched here — should be a separate small flow with 3 popups (detected → start → done).
- Empty/error states: sheet permissions denied, malformed URL, no rows found, LinkedIn auth expired — none sketched yet.
