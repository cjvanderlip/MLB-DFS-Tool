# MLB DFS Tool — TODO

Last updated: 2026-04-02

---

## Critical Bug Fixes ✅ (completed this session)
- [x] Exposure denominator used iteration index instead of `lineups.length`
- [x] Stack name matching was case-sensitive — stacks silently failed to place
- [x] Uploaded stacks could bypass 5-batter-per-team DK cap
- [x] Odds API key hardcoded in source (`server.js:12`)
- [x] CSV exports had no field quoting — commas in names broke DK upload
- [x] Export allowed empty lineup slots through to DK CSV

## High Priority Bug Fixes ✅ (completed this session)
- [x] Pitcher-batter correlation was -0.15 (wrong sign — should be ~0)
- [x] Slate mismatch warning threshold too low (50% → 80%)
- [x] Weather API returned fake defaults silently when wttr.in was down
- [x] Session restore missing: allowBvP checkboxes, exposure label spans

## Medium Priority Bug Fixes ✅ (completed this session)
- [x] Bring-back failure was silent — lineup emitted without bring-back
- [x] `upgradeSalary` threshold too loose (92% → 95%)
- [x] 5-man stack bonus inflated (+8 → +5, proportional scaling)
- [x] optBoost absent-player penalty too harsh (-5%/-8% → -2%)
- [x] Vegas concurrent write race condition

---

## Feature Gaps — Priority Order

### P1 — High Impact, Low-Medium Effort

- [x] **Contest payout structure input**
  Added "Cash Line", "Win Line", and "Payout Structure" selector (Top-20%, Top-10%, Winner-Take-All, 50/50, Custom) to Portfolio Builder config. Lines auto-derive from field simulation but can be manually overridden. Payout structure drives Sim ROI formula with correct cash/win multipliers. Persisted in session.

- [x] **Per-player min/max exposure ranges**
  Added collapsible "Player Exposure Overrides" section in Portfolio Builder. Search any player, set per-player min% (guarantee appearances) and max% (cap below global). Engine enforces min via forceInclude mechanism; max overrides the global cap. Persisted in session.

- [x] **Stack type % targeting**
  Added "5-Man Stack %" config input (0–100, default 50) to Portfolio Builder. Engine pre-computes a target count and passes `prefer5Man` flag to lineup generators, which sort 5-man stacks first or last accordingly. Tracks actual 5-man usage per generated lineup. Persisted in session.

- [x] **Ownership projection editor**
  Own% column in Player Pool table is now an editable number input. Editing updates the player's `own` value in POOL directly and recomputes leverage score. Color-coded by ownership level. No re-render on input to avoid losing focus.

- [x] **No Batter vs Pitcher (BvP) — show visual warning in lineup display**
  Lineup slots now turn red (border + background) and show a "BvP" badge when a batter faces your pitcher and Allow BvP is off. Warning text also added to the lineup warning box naming conflicting players.

---

### P2 — High Impact, Higher Effort

- [ ] **Showdown / Captain mode optimizer**
  DraftKings runs showdown slates daily. Completely different roster construction:
  1 CPT (1.5× points, higher salary), 5 FLEX (standard).
  Salary cap differs. No position requirements — any player can go anywhere.
  This is a full separate optimizer mode.

- [ ] **Late swap mode**
  When players are scratched after lock:
  - Lock confirmed/valid slots in existing portfolio lineups
  - Identify which slots contain scratched players
  - Generate valid replacements with salary/score impact shown per swap
  - Show "before vs after" lineup comparison

- [x] **Per-lineup Monte Carlo scoring (portfolio simulation)**
  "Simulate Portfolio (Sim ROI)" button added below portfolio results. Runs 2,000 correlated sims per lineup showing P10/P50/P90. Each lineup gets a cash rate %, win rate %, and Sim ROI column.

- [x] **Field ownership model / Sim ROI**
  `simulatePortfolio()` builds a synthetic field of opponent lineups sampled proportionally by projected ownership. Each of your lineups is scored against the field to compute cash rate, win rate, and Sim ROI (expected net return). Results sorted by Sim ROI descending with a portfolio avg shown.

---

### P3 — Medium Impact

- [x] **DvP (Defense vs. Position) data integration**
  New `/api/dvp` endpoint aggregates last-14-day boxscore data by defending team and position. "Fetch DvP Data" button on Vegas tab renders a ranked table (green = easy, red = tough). DvP badges (easy/mid/tough) appear inline on each player row in the pool table based on the opponent's rank at that position. Cached 4 hours.

- [ ] **Multi-source projection blending (3 CSVs)**
  Currently accepts one ROO file. DraftDime lets you upload 3 projection CSVs and blend
  them at custom % weights (e.g. 40% Stokastic / 40% THE BAT X / 20% own).
  Sharp players always triangulate across multiple projection sources.

- [x] **Historical player-pair correlation data**
  Added `buildPairCorrelations()` / `getPairCorrelation()` to engine. Computed Pearson r from co-appearing player actuals in saved history (requires ≥5 co-appearances). Loaded automatically when Backtest tab is opened. `getCorrelation()` checks historical pairs first, falls back to structural rules. Both structural and historical values scaled by `_corrScale`.

- [x] **Correlation and diversity sliders (user-facing)**
  Added "Correlation Strength" (0.2–2.0×) and "Score Diversity" (0.5–2.5×) range sliders to Simulator tab. Correlation slider scales all pair correlations globally; diversity slider widens/narrows player score distributions in Monte Carlo. Status bar shows how many historical slates are powering correlations. Mobile-safe flex layout.

- [x] **Contest Flashback / post-slate profitability analysis**
  New "Contest Flashback" section in Backtest tab. Re-simulates each saved lineup 500× against an ownership-weighted synthetic field. Shows P50, cash rate %, Sim ROI, and actual ROI side-by-side. Filter by contest type. Portfolio avg Sim ROI and cash rate shown at top. Requires player actuals loaded.

---

### P4 — Lower Priority / Polish

- [ ] **Salary cap warning when manually adding players**
  Silent failure when clicking "+" and salary cap would be exceeded.
  Should show a toast: "Cannot add — would exceed cap by $X."

- [ ] **Visual BvP indicator on lineup slots**
  If a user manually builds a lineup with pitcher + opposing batter, highlight the conflicting slots in red with a warning label.

- [ ] **Player search result count**
  Filter box shows results but doesn't say "Showing 23 of 304 players" — users assume the filter is broken.

- [ ] **Undo for removed lineup players**
  Clicking × on a lineup slot is instant with no undo. Show a 3-second undo toast.

- [x] **Exposure label display on Portfolio Builder mobile**
  Range sliders now use a flex row wrapper with `flex:1;min-width:0` on the input and `flex-shrink:0;width:32px` on the label span. Applied to all portfolio and simulator sliders. No more clipping on narrow screens.

- [ ] **DK upload — line movement badges on Vegas tab**
  Show whether a team's implied total has moved up or down since open (line movement arrows).
  Data is stored (`openTotal` vs `impliedTotal`) but not surfaced visually in the game environment table.

- [ ] **README — document ODDS_API_KEY env var setup**
  After removing the hardcoded key fallback, first-time users will get a 503 with no explanation.
  Add setup instructions to README.

---

## Data / Infrastructure

- [ ] **ODDS_API_KEY env var documentation**
  Document in README and add a startup check that prints a clear warning if unset.

- [ ] **Statcast cache staleness handling**
  `statcast_cache.json` is used as fallback but has no max-age. Could serve 3-week-old data silently.
  Add a cache timestamp and warn in UI if data is >48h old.

- [ ] **lineup_history.json growth**
  No pruning. Will grow unbounded. Add a "keep last N slates" setting or archive older entries.

---

## Completed This Session (2026-04-02)
- Fixed all 6 critical bugs
- Fixed all 4 high priority bugs
- Fixed all 5 medium priority bugs
- Added BvP constraint (no batter vs pitcher, off by default with checkbox override)
- Added 5-batter-per-team hard cap (DraftKings rule)
- Fixed injury feed HTML parse error
- Improved mismatch warning messaging
