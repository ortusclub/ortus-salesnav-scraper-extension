---
sketch: 001
name: dashboard-layout
question: "What information architecture serves the Sales Nav scraper popup best?"
winner: "C"
tags: [layout, dashboard, popup, club-editorial]
---

# Sketch 001: Dashboard Layout

## Design Question

The current popup is a generic dark-utility dashboard — sections stacked, color-coded chips, heavy on chrome. We're moving to the Ortus club-editorial visual language (paper, ink, gold, Newsreader serif) used by the LinkedIn DM Assistant. **Visual direction is settled.** What's open is the *information architecture* — how the operator's workflow maps onto the popup's vertical real estate.

Three approaches, all in the same visual language, differing in how they organize attention.

## How to View

```
open .planning/sketches/001-dashboard-layout/index.html
```

All three variants render side-by-side at native popup width (400px). Use the **State** toggle at the top to flip all three between Idle / Running / Done so you can see how each variant holds up across the run lifecycle.

## Variants

- **A: Linear Stepper** — One concern at a time. Numbered steps (Sheet → Filters → Run → Results) with a top rail. Best for first-time and infrequent users; never makes the operator guess where to look. Trade-off: feels guided, can feel slow once you know the tool.
- **B: Two-Pane Editorial** — Sidebar "ledger" of jobs, main pane is the active run with a live log strip at the bottom. Best for power users who queue multiple searches. Trade-off: 132px sidebar eats popup width; main pane is tighter than A or C.
- **C: Run-Centric Hero** — The current run owns the popup. Big serif numbers, big headline, recent-jobs queue tucked underneath, settings as a footer link. Best when most sessions are one search at a time — feels like a product, not a control panel. Trade-off: less obvious how to manage multiple jobs in flight.

## What to Look For

When comparing:

1. **Running state legibility** — at a glance, can you tell what's happening, how far along, and what's hidden (anonymous count)? This is the most-used state.
2. **The "anonymous" framing** — the per-page anonymized-leads note should feel calm and explanatory, not alarming. Compare how each variant treats it.
3. **Status chip semantics** — Done (green) vs Pending (faint) vs Running (gold) — does the chip carry enough meaning across all three layouts?
4. **Switching between jobs** — Variant B makes this dominant; A treats it as navigation; C tucks it as a list. Which matches how you actually work?
5. **Done state** — Variant A's big "1,882 of 1,884" hero figure vs B's compact stat-strip vs C's hero-replacement. Which one feels rewarding without being loud?
6. **First-run / empty state (Idle)** — A is most explicit (stepper guides you), B requires understanding the ledger, C invites you with a single big input. Which works for a colleague who hasn't seen the new dashboard yet?

## Notes for the next round

- **Width:** sticking with 400px (between current 420 and DM Assistant 390) — easy to revisit.
- **Theme:** lives in `../themes/default.css`, fully derived from the DM Assistant tokens. Any winner can stay anchored to that file.
- **Scope:** this sketch is *layout only*. Once a winner is picked, sub-sketches can drill into details — log treatment, settings panel, error states, multi-account profile selection.
