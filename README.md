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

## Troubleshooting

**Port 3000 in use** — change `const PORT = 3000` in `server.js`

**Statcast fetch fails** — Baseball Savant may be temporarily unavailable; cached data from `data/statcast_cache.json` will be used if present

**Confirmed lineups show 0/N confirmed** — batting orders aren't posted until ~1 hour before first pitch; run again closer to lock

**ROO players not matching DK** — check that team abbreviations match; the tool shows a mismatch warning with match percentage
