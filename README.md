# MLB DFS Tool v2.0

A local web tool for building and analyzing MLB Daily Fantasy Sports lineups. Runs entirely on your machine — no subscription, no cloud, no data leaving your computer.

## Features

### Player Pool

- Upload DraftKings salary CSV + ROO projection export (auto-detected)
- Merged view: salary, projections, ownership, leverage, GPP score, optimal exposure
- Statcast data: barrel rate, hard hit%, xwOBA badges (fetched from Baseball Savant)
- 14-day form: recent DK avg coloring (green = hot, red = cold)
- Confirmed batting orders from MLB Stats API with order badges
- Salary vs median scatter plot — click any dot to add player to lineup
- Position filter, team/game filter, sort by any column

### Stacks

- Upload 3-man and 5-man stack CSV files
- Ranked by projected points, salary, ownership, or optimal frequency
- Click any player chip or "Use" to push stack into lineup builder

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
- Exposure tables with over-cap flagging
- Export all lineups to DraftKings multi-entry CSV
- Save all portfolio lineups to Backtest History in one click

### Monte Carlo Simulator

- Cholesky-decomposed correlated player sampling
- 5k–50k simulations
- Score distribution histogram, P10/P25/P50/P75/P90/P99
- Per-player bust rate, boom rate, std dev

### Backtesting

- Save any lineup to history with contest type, buy-in, slate date
- Load actual DK scores from MLB Stats API (auto-matched by name)
- ROI tracking, projection accuracy, net profit
- Model Analysis: bias, RMSE, Spearman rank correlation, calibration suggestions

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

Navigate to: **http://localhost:3000**

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

## API Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/odds/fetch` | Fetch live Vegas implied totals (The Odds API) |
| `GET /api/weather/batch` | Batch weather for multiple cities |
| `GET /api/park-factors` | All 30 park factors |
| `GET /api/lineups/:date` | Confirmed batting orders from MLB Stats API |
| `GET /api/statcast` | Statcast leaderboard (barrel%, hard hit%, xwOBA) |
| `GET /api/form` | Last-14-day player performance aggregates |
| `GET /api/actuals/:date` | Actual DK scores from completed games |
| `POST /api/actuals/apply` | Auto-populate history entries with actuals |
| `GET /api/history` | Saved lineup history |
| `GET /api/history/summary` | ROI + accuracy summary stats |
| `GET /api/history/analysis` | Projection bias + calibration analysis |

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

1. **Load data** — Upload DK salary CSV and ROO projection export in the Player Pool tab. The tool auto-detects both file formats and merges them.
2. **Fetch live context** — Click "Fetch Vegas Lines" for implied totals and "Fetch Weather" for park conditions. Both update the Game Environment Rankings automatically.
3. **Review the pool** — Sort by GPP Score or Leverage to find underowned value. Statcast badges (barrel%, xwOBA) and batting order badges update after fetching confirmed lineups.
4. **Build stacks** — Upload your 3-man and 5-man stack files or let the engine auto-select via virtual stacks. Review the Stacks tab ranked by projected value.
5. **Generate portfolio** — Go to Portfolio Builder, configure exposure caps and stack settings, then click Generate. The engine builds diversified lineups respecting all constraints.
6. **Simulate** — Click "Simulate Portfolio (Sim ROI)" to run ownership-weighted simulations against the field. Review cash rate and ROI before entering contests.
7. **Export** — Export All Lineups CSV produces DraftKings multi-entry upload format. Save to Backtest History to track accuracy over time.

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
