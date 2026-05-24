# MLB DFS Tool v2.0

A local web tool for building and analyzing MLB Daily Fantasy Sports lineups. Runs entirely on your machine — no subscription, no cloud, no data leaving your computer.

## Features

### Player Pool

- Upload DraftKings salary CSV + ROO projection export (auto-detected)
- Merged view: salary, projections, ownership, leverage, GPP score, optimal exposure
- Statcast data: barrel rate, hard hit%, xwOBA badges (fetched from Baseball Savant)
- 14-day form: recent DK avg coloring (green = hot, red = cold)
- Confirmed batting orders from MLB Stats API with order badges
- **DVP badge** — opposing defense rank at each position with sample-size annotation (`DvP:easy N=22`); thin samples (<15 games) are dimmed so users discount the signal
- **Platoon multiplier** — applies handedness-based batter adjustments when confirmed lineups and pitcher hands are loaded
- **Compound multiplier ⚠ badge** — fires when stacked multipliers (Vegas × park × weather × Statcast etc.) push effective projection more than 25% from the raw CSV value
- **Source-aware flags** — checkboxes for "source includes park factors" and "source includes Vegas implied totals". When checked (default for ROO), those multipliers are suppressed in scoring to prevent double-counting
- **Late-Scratch Monitor** — polls confirmed lineups + weather every 10 min after fetch. Fires scratch alerts for missing rostered players AND late-rain alerts when precip jumps above 50%
- Salary vs median scatter plot — click any dot to add player to lineup
- Position filter, team/game filter, sort by any column

### Stacks

- Upload 3-man and 5-man stack CSV files
- Ranked by projected points, salary, ownership, or optimal frequency
- Click any player chip or "Use" to push stack into lineup builder
- **4-man stack mode** (in Portfolio Builder) — middle-ground construction between 3 and 5; auto-synthesized from pool when no upload file exists

### Best Plays Tab

- **Single-entry column** — top pitchers filtered by K% ≥22, opp implied <4.0, win prob >50; best hitter stack from the highest-total team's 1–5 batting orders; top value plays by median/salary
- **GPP column** — chalk warning (#1–2 implied teams), contrarian stack (slate-aware: targets #3–6 on full slates, #2–5 on shorter slates), bring-back recommendations, leverage plays (ceiling/own), boom/bust candidates
- Every player row is clickable to add directly to the lineup builder

### Vegas & Weather

- Auto-fetch implied team totals via The Odds API
- Live weather via wttr.in for all outdoor parks
- Park-orientation-aware wind model (blowing out / in / neutral)
- Game Environment Rankings: O/U, implied totals, park factor, wind, rain risk ranked by scoring environment
- Park factors table (all 30 teams)
- Team scoring percentages upload (avg score, 8+ run%, win%)

### Lineup Builder

- Manual and auto-fill (Cash / Single Entry / GPP modes)
- Salary cap enforcement with remaining budget display
- Position scarcity alerts when thin positions drop below viable threshold
- One-click: Generate Cash + Single + GPP lineup set
- DraftKings upload format export (Name+ID)

### Portfolio Builder

- Generate 1–150 lineups with configurable exposure caps (batters + pitchers separately)
- Max lineup overlap enforcement (no two lineups share more than N players)
- Lock teams (rotated across lineups) / Ban teams (fully excluded)
- **Team Exposure Overrides** — set per-team floors and ceilings (e.g. "NYY between 30% and 50%")
- **Sim ROI Filter** — generate overflow lineups, simulate against ownership-weighted field, keep top-N by simROI (with optional ROI band)
- **Auto-relaxation banner** — when exposure/overlap/game caps get auto-raised to fill the target lineup count, the result panel surfaces which specific players exceeded their stated cap and by how much (no more silent constraint violations)
- **Custom payout structure** — for accurate simROI, enter your actual contest's cash percentage and payout multipliers instead of the generic Top-20 / Top-10 templates
- **Auto-update contest size** — when you import a DK contest results CSV, the contest size field auto-updates to match the largest field from the most recent imported slate
- Exposure tables with over-cap flagging
- Export all lineups to DraftKings multi-entry CSV
- Save all portfolio lineups to Backtest History in one click

### Sim Results Drill-Down

The "Simulate Portfolio (Sim ROI)" table is fully interactive — every lineup is identifiable, comparable, and exportable without leaving the sim view.

- **Expandable rows** — click any row to inline-expand the full roster with position, salary, projected median, projected ownership, and your portfolio-level exposure for each player
- **Sortable columns** — click any header (P50, P10, P90, Cash%, Win%, Sim ROI, Fit, Stack, ID) to sort asc/desc
- **Stable 2-char fingerprint** — every lineup gets a deterministic 2-char ID (e.g. `4M`) so you can identify the same lineup across sim re-runs and re-sorts
- **Rich stack signature** — primary stack + secondary mini-stack + bring-back indicator (`NYY 5 ↩ PIT 2`) replaces the old single team count
- **Contest fit suggestion** — each lineup is auto-classified as `Cash`, `Sm GPP`, `Lg GPP`, or `Skip` based on its score distribution shape and average ownership
- **Filter chips** — filter visible rows by stack team and ROI band (`All / + / +5%↑ / −`); export and sort apply only to the visible subset
- **Color-coded ranking** — top-3 ROI rows tinted green, bottom-3 tinted red; top-3 P90 (ceiling) lineups get a ⭐
- **Compare panel** — check 2–4 lineups → side-by-side modal showing shared players, unique players per lineup, salary/cash/ROI deltas
- **Export filtered subset** — ship only your best N lineups (e.g. sort by ROI desc, filter to `+5%↑`, export 5 to DK CSV)
- **Per-lineup confidence intervals** — ROI shown as `+8.2% ± 1.4%` so high-noise estimates are visible
- **Cash-rate / Sim-ROI paradox alert** — when cash rate >27% but ROI <-15% (the most common GPP failure mode), the table surfaces the specific team and pitcher driving the chalk concentration with one-line remediation

### Monte Carlo Simulator

- Cholesky-decomposed correlated player sampling
- **Context-sensitive correlations** — same-team correlations scale with game O/U; high-total games tighten within-team correlations, pitcher-duel games loosen them
- 5k–50k simulations
- Score distribution histogram, P10/P25/P50/P75/P90/P99
- Per-player bust rate, boom rate, std dev
- **Bootstrap standard error** on cash rate and median — the sim filter ranks lineups by ROI lower-confidence bound (penalizes noisy estimates) so you don't ship "lucky" outliers

### Calibration Safety

- **Hard block at low confidence** — applying calibration scales below 20 player actuals is blocked outright; 20–40 actuals requires a confirm prompt
- **Before/after preview modal** — before any calibration is committed, see exactly how the top 20 players' projections will change (e.g. `Aaron Judge: 9.2 → 10.1 (+9.8%)`)
- **Bayesian shrinkage** — position-level calibration factors shrink toward 1.0 at low sample sizes (n=10 → 25% trust, n=40+ → full trust)

### Debug Mode

For troubleshooting and verbose logging.

**Server-side** (request logging, fetch tracing, cache events):

```powershell
.\start.ps1 -DebugMode
# or set DEBUG=true before npm start
```

**Client-side** (portfolio diagnostics, constraint snapshots, order-shift detail):

```js
// In the browser DevTools console:
toggleDebug()   // → "[mlbdfs] debug mode ON"
```

Persists via localStorage; survives reloads.

### Backtesting

- Save any lineup to history with contest type, buy-in, slate date
- Load actual DK scores from MLB Stats API (auto-matched by name)
- **Failed-game surfacing** — when fetching actuals, per-game failures are now reported (e.g. "Loaded 13/15 games — 2 failed: gamePk 745432, 745438") instead of silently presenting partial data as complete
- ROI tracking, projection accuracy, net profit
- Model Analysis: bias, RMSE, Spearman rank correlation, calibration suggestions
- **Source Quality panel** — historical Spearman ρ accuracy by projection source so you can weight sources by demonstrated rank-ordering quality
- **Separate form weights** for batters and pitchers (default 0 for pitchers since 14-day ERA over 4–5 starts is noise; opt in if you've validated it)
- **DK contest CSV import** — paste your DK My Contests export to auto-match results to saved lineups, create stubs for past contests, and update finish/winnings

## Quick Start

### 1. Install Dependencies

```bash
cd "c:\Users\cjevi\MLB DFS Tool"
npm install
```

### 2. Start the Server

```bash
npm start
```

Output:

```text
MLB DFS Tool v2.0 running on http://localhost:3000
```

### 3. Open in Browser

Navigate to: **<http://localhost:3000>**

Or double-click `start.bat` / run `start.ps1` to launch automatically.

## File Types Accepted

| File | Headers detected |
| --- | --- |
| DraftKings Salaries | `Name + ID`, `TeamAbbrev`, `Roster Position`, `Salary` |
| ROO Projection Export | `Floor`, `Median`, `Ceiling`, `Position` |
| 3-man Stack file | `B1`–`B3` columns + `Salary` |
| 5-man Stack file | `B1`–`B5` columns + `Salary` |
| Team Scoring | `OppSP`, `AvgScore`, `8+Runs`, `WinPercentage` |
| Optimal Lineups | `SP1`, `SP2`, `C`, `1B`, `2B`, `3B`, `SS`, `OF1`–`OF3`, `Stack` |
| DK Contest Export | `Contest ID`, `Points`, `Place`, `Entries`, `Winnings`, `Sport`, `Start Date` (DK My Contests CSV — auto-imports results to history) |

## API Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/odds/fetch` | Fetch live Vegas implied totals (The Odds API) |
| `POST /api/weather/batch` | Batch weather for multiple teams (by coordinates) |
| `GET /api/park-factors` | All 30 park factors |
| `GET /api/lineups/:date` | Confirmed batting orders from MLB Stats API |
| `GET /api/statcast` | Statcast leaderboard (barrel%, hard hit%, xwOBA) |
| `GET /api/form` | Last-14-day player performance aggregates |
| `GET /api/dvp` | Defense vs Position rankings (per team, per position, with sample size) |
| `GET /api/pitcher-hands` | Throwing/batting hands for platoon split lookup |
| `GET /api/actuals/:date` | Actual DK scores from completed games (returns `failedGames` + `loadedGameCount`) |
| `POST /api/actuals/apply` | Auto-populate history entries with actuals (returns `failedGames`) |
| `POST /api/contests/import-csv` | Import DK My Contests CSV; returns `suggestedContestSize` for auto-update |
| `GET /api/contests/:contestId` | Fetch DK contest metadata + standings |
| `GET /api/history` | Saved lineup history |
| `GET /api/history/summary` | ROI + accuracy summary stats with rake-adjusted break-even thresholds |
| `GET /api/history/analysis` | Projection bias + calibration analysis (with recency decay) |
| `GET /api/history/score-benchmarks` | Score percentiles, cash/win line estimates, simDiversity + ownershipLambda calibration suggestions |
| `GET /api/source-quality` | Historical Spearman ρ accuracy by projection source |

## Project Structure

```text
MLB DFS Tool/
├── server.js           # Express API server
├── package.json
├── public/
│   ├── index.html      # UI shell + styles
│   ├── engine.js       # Analytics engine (Monte Carlo, optimizer, scoring)
│   └── app.js          # UI layer (state, rendering, data loading)
├── data/               # Persisted data (vegas, history, statcast cache)
├── uploads/            # Uploaded CSV files
├── start.bat
└── start.ps1
```

## Workflow Guide

### Daily Workflow

1. **Load data** — Upload DK salary CSV and ROO projection export in the Player Pool tab. The tool auto-detects both file formats and merges them. Verify the "Projection source already includes" checkboxes match your CSV (default assumes ROO includes park + Vegas).
2. **Fetch live context** — Click "Fetch Vegas Lines" for implied totals and "Fetch Weather" for park conditions. Both update the Game Environment Rankings automatically.
3. **Check Best Plays tab** — auto-surfaced single-entry pitchers, hitter stacks, and GPP chalk/contrarian recommendations driven by the full scoring model.
4. **Review the pool** — Sort by GPP Score or Leverage to find underowned value. Statcast badges (barrel%, xwOBA), DVP badges (with sample size), and batting order badges update after fetching confirmed lineups.
5. **Build stacks** — Upload your 3-man and 5-man stack files or let the engine auto-select via virtual stacks. Review the Stacks tab ranked by projected value.
6. **Generate portfolio** — Go to Portfolio Builder, configure exposure caps and stack settings, then click Generate. The engine builds diversified lineups respecting all constraints. For accurate simROI later, set Payout Structure to "★ Custom" and enter your actual contest's cash% and payout multipliers.
7. **Activate the Late-Scratch Monitor** — once confirmed lineups are fetched (60–90 min before lock), click Monitor Scratches. Polls every 10 minutes for batting-order changes AND rain alerts.
8. **Simulate** — Click "Simulate Portfolio (Sim ROI)" to run ownership-weighted simulations against the field. Use the new sim drill-down: sort by ROI, expand rows to see player ownership, compare 2–4 finalists, export your best N to DK CSV.
9. **Export** — Export All Lineups CSV (or the filtered subset from the sim table) produces DraftKings multi-entry upload format. Save to Backtest History to track accuracy over time.
10. **Post-slate (next morning)** — Load Actuals, run Analyze Projections. The Source Quality panel updates automatically; apply calibration only if confidence is medium+ (40+ actuals).

---

### Reading Sim Results

The simulator runs Monte Carlo against an ownership-weighted field to estimate contest outcomes. Two key numbers:

**Cash rate** — percentage of simulated contests your lineups finish in the money. A large-field GPP cashes roughly 20–22% of entries. Anything above ~27% indicates your lineups are consistently outscoring the field median.

**Avg Sim ROI** — net return on investment across all simulations. This is the number that actually matters for profitability. Break-even is 0%; the rake alone typically costs 10–15%.

---

### High Cash Rate + Negative ROI

This is the most common pattern and the most misread one. It means your lineups score above the field median often, but you're not winning big enough when it counts.

**Why it happens:**

GPP payouts are top-heavy. Cashing at 1.5x entry fee 30% of the time barely covers the 70% of lineups that earn nothing. Positive GPP ROI comes from hitting 10x–100x payouts, not from grinding near the cash line. If your lineups correlate with the field — same popular stacks, same chalk pitchers — then when they score well, so does everyone else, and your finish position is median rather than top 1–5%.

**How to diagnose:**

1. Open the Stack Exposure table in portfolio results. If 60%+ of your lineups share the same 1–2 teams, you are heavily correlated with the typical field construction.
2. Check the Batter Exposure table. Players at 30%+ ownership showing 50%+ portfolio exposure are chalk sinks — you own them more than the field does, which gives zero leverage.
3. Look at your pitcher selection. The most popular GPP pitcher on a slate is often owned 25–40% by the field. Using that pitcher in 60% of lineups costs you finish position every time he scores well, because everyone else also has him.

**Fixes to improve ROI:**

- **Lower your most-used stack team's exposure.** If one team appears in 70% of lineups, cap it at 40–50% in the Portfolio Builder's lock/ban controls. Force the engine to distribute across 2–3 correlated games.
- **Increase 5-man stack %** via the Stack % (5-man) setting. Five-man stacks are rarer in the field and produce higher score variance — exactly what GPP ROI requires.
- **Use contrarian pitcher pivots.** In the Player Pool, sort by Own%. Find a pitcher projected similarly to the chalk option but owned 8–15% instead of 25–40%. Use him as your primary pitcher in 30–40% of lineups.
- **Check lineup overlap.** Reduce Max Overlap from 7 to 5. Tighter overlap forces more structural diversity, which reduces field correlation at the portfolio level.
- **Review the Game Environment Rankings.** If your highest-owned stacks are from the slate's most popular game (highest O/U, best weather), you are building like the field. Pivot to the second-best game environment where fewer players will be stacked.

**Target benchmarks for GPP ROI improvement:**

| Metric | Neutral | Good | Strong |
| ------ | ------- | ---- | ------ |
| Cash rate | 22–26% | 27–32% | 33%+ |
| Avg Sim ROI | -30% to -15% | -15% to 0% | 0%+ |
| Top team stack exposure | <55% | <45% | <35% |
| Portfolio unique players | <20 | 20–28 | 28+ |

A cash rate above 29% with negative ROI is not a failure state — it means the projection model is working but the construction is too chalk. Adjust leverage first, then re-simulate before entering.

---

## Troubleshooting

**Port 3000 in use** — change `const PORT = 3000` in `server.js`

**Statcast fetch fails** — Baseball Savant may be temporarily unavailable; cached data from `data/statcast_cache.json` will be used if present

**Confirmed lineups show 0/N confirmed** — batting orders aren't posted until ~1 hour before first pitch; run again closer to lock

**ROO players not matching DK** — check that team abbreviations match; the tool shows a mismatch warning with match percentage

**⚠ adj badge appears on most players** — your projection source already prices in park/Vegas. Check the "source includes" boxes in the blend controls to suppress those multipliers and prevent double-counting

**Portfolio result shows "Exposure caps were relaxed"** — the engine auto-raised your cap to fill the lineup target. Either reduce lineup count, add more stacks, or accept the listed players going over cap. The banner names the specific over-cap players

**"Cash-rate / Sim-ROI paradox detected" alert** — high cash rate with negative ROI means construction is too field-correlated. The alert names the top-exposure team and pitcher to cap

**Calibration "blocked at low confidence"** — you have fewer than 20 player actuals. The suggested scales are noise at that sample size; load more slate actuals first

**Sim table shows `#NaN` or expand-one-expands-all** — fixed in current build. Was caused by Web Worker structural clone breaking reference equality; resolved via content-key matching

**Need verbose logs** — set `DEBUG=true` env var (or run `.\start.ps1 -DebugMode`) for server logs; run `toggleDebug()` in DevTools for client logs. See [Debug Mode](#debug-mode)
