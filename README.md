# Pollity

Interactive visualization of German election polls ("Sonntagsfrage") for the
**federal level and all 16 Bundesländer**, with selectable correction of
institute bias (house effects) — inspired by
[dkriesel.com/sonntagsfrage](https://www.dkriesel.com/sonntagsfrage).

**Live site: [ch-sc.github.io/pollity](https://ch-sc.github.io/pollity/)**

Data source: [wahlrecht.de](https://www.wahlrecht.de/umfragen/) (federal
per-institute pages incl. per-legislature archives back to 1998, plus one page
per Bundesland). ~8,900 polls across 17 regions.

## Quickstart

```sh
# 1. Scrape (stdlib-only Python ≥3.10, no dependencies)
python3 scraper/wahlrecht.py

# 2. Serve the site (any static server works)
python3 -m http.server 8642 --directory web
# → http://localhost:8642/
```

## What the site offers

- **Level selector**: Bund (Bundestagswahl) or any of the 16 Länder.
- **Party & institute filters**: click chips to toggle.
- **Time ranges**: since last election / 1 / 2 / 5 years / all time — plus a
  custom range: drag horizontally inside the chart to zoom into a window
  (Grafana-style; double-click resets to the last preset), or set explicit
  von–bis dates next to the presets. Custom ranges are shareable via the URL.
- **Smoothing**: kernel bandwidth control (Fein / Standard / Glatt); the
  bandwidth also adapts to poll density, so sparse state series stay honest.
- **Bias-correction algorithms** (computed live in the browser):
  - *Rohdaten* — Gaussian kernel trend over unadjusted polls.
  - *Mittelwert-Korrektur* — one-shot mean-deviation house effect
    (each institute's average deviation from the cross-institute trend),
    the approach dkriesel.com uses.
  - *Iterative Hauseffekte* — trend and house effects re-estimated
    alternately until convergence; a fixed-point approximation of the
    state-space model in Jackman (2005), *Pooling the Polls Over an Election
    Campaign* (Australian Journal of Political Science 40(4)). Effects are
    poll-count-weighted and centered per party (identifiability), and shrunk
    toward zero for institutes with few polls (n/(n+5)).
  - *Wahl-verankert* — Jackman's anchoring idea: an institute's bias is its
    average final-poll error vs. actual election results (45-day window
    before each election); institutes without pre-election polls fall back
    to the iterative estimate.
- The estimated **house-effect table** (institute × party, in percentage
  points) is shown below the chart.
- Election results appear as diamonds on vertical "Wahl" lines; single polls
  as dots (hover a dot to inspect institute, sample size and raw vs.
  corrected values); a crosshair tooltip reads out every trend at any date.
- Light/dark theme, shareable URL state (`#r=…&a=…&t=…`), table view of all
  polls.

## Repository layout

```
scraper/wahlrecht.py     stdlib-only scraper → web/data/regions/*.json + index.json
web/index.html           the site (vanilla ES modules, no build step)
web/js/algorithms.js     kernel trend + house-effect estimators
web/js/chart.js          canvas chart (scatter, trends, elections, tooltip)
web/js/parties.js        party colors (validated light/dark palettes)
web/js/app.js            state, filters, URL sync, tables
.github/workflows/       daily scrape + commit + GitHub Pages deploy
```

## Deployment

The GitHub Action (`update-data.yml`) runs daily, scrapes wahlrecht.de,
commits changed data and deploys `web/` to GitHub Pages. Enable Pages with
source "GitHub Actions" in the repo settings. Any static host works too —
`web/` is fully self-contained.

## Notes on method & caveats

- House effects are relative: they measure how an institute deviates from the
  *pooled* trend (or from election results), not from the "truth". The
  election-anchored mode is closest to a ground truth but assumes bias is
  stable between elections.
- Bias is estimated within the selected time window, so switching ranges can
  change the corrections (more data → more stable estimates).
- Polls carry ±2–3pp sampling error at typical n≈1,000; corrected trends are
  still snapshots, not forecasts.
- Scraper details: election-result rows are parsed for anchoring; party names
  are normalized across decades (PDS → LINKE etc.); composite "Sonstige"
  cells are summed.
- **Nichtwähler/Unentschlossene**: only Forsa publishes this (federal page,
  weekly since Oct 2013). It is drawn as a dashed slate line. Note the base
  difference: party values are shares of *decided* voters (sum ≈ 100), the
  non-voter share is measured against *all* eligible voters — the lines share
  the % axis but not the denominator.
