# MLB DFS Tool — Complete User Guide

### From Theory to Lineup to Edge
*Local-only · No subscription · No cloud · Your data never leaves your machine*

---

## Table of Contents

1. [Why DFS Is a Skill Game](#1-why-dfs-is-a-skill-game)
2. [The Daily Workflow](#2-the-daily-workflow)
3. [Every Setting — What It Does and What to Set It To](#3-every-setting--what-it-does-and-what-to-set-it-to)
4. [Understanding Simulation Results](#4-understanding-simulation-results)
5. [The GPP Paradox — High Cash Rate, Negative ROI](#5-the-gpp-paradox--high-cash-rate-negative-roi)
6. [Fixing Your Construction](#6-fixing-your-construction)
7. [Performance Benchmarks](#7-performance-benchmarks)
8. [Contest Selection and Bankroll Management](#8-contest-selection-and-bankroll-management)
9. [Advanced Features Reference](#9-advanced-features-reference)
10. [Quick Reference Cheat Sheets](#10-quick-reference-cheat-sheets)
11. [Setup and Troubleshooting](#11-setup-and-troubleshooting)

---

## 1. Why DFS Is a Skill Game

Daily Fantasy Sports is not a lottery. It is a portfolio optimization problem played against a field of opponents whose behavior is predictable and exploitable. Understanding the theory behind that statement is what separates consistent winners from casual participants.

### 1.1 The Field Is Your Opponent, Not the Platform

In a GPP tournament, you are not trying to score the most possible points — you are trying to finish higher than the other lineups in the contest. This distinction matters enormously for construction. A lineup that scores 180 points when the field median is 175 cashes. The same lineup that scores 180 when the field median is 185 does not. Your edge comes from understanding what the field will do and building differently enough to capture finish position when outcomes diverge from expectations.

### 1.2 Where the Money Actually Comes From

Academic research consistently shows that roughly 90% of DFS profit is earned by fewer than 2% of players. The separation is not luck — it is process. The winning 2% do three things the field does not:

- **Model opponent behavior.** They estimate ownership, anticipate chalk concentrations, and deliberately differentiate.
- **Manage variance deliberately.** They size entries, diversify constructions, and accept losing slates as part of a positive expected-value process.
- **Measure everything.** They track ROI by contest type, calibrate their projection model against actuals, and adjust.

This tool is built to support all three. The workflow, simulation engine, and backtesting system exist specifically to give you the information professional players use.

### 1.3 Expected Value, Variance, and the Long Run

Every DFS decision should be evaluated on **expected value (EV)** — the average outcome of that decision repeated across hundreds of slates — not on the outcome of any single contest. A +EV lineup that loses tonight is still a correct decision. A -EV lineup that wins tonight was still a mistake.

Variance is the distance between what your lineups score on a given night and what they are expected to score. Cash games reward minimizing variance (consistent floor). GPP tournaments require embracing variance (ceiling upside) because only the top of the distribution pays. These two contests demand almost opposite construction logic, which is why the tool separates them completely.

### 1.4 Cash Games vs. GPPs — The Fundamental Divide

| | Cash Games (50/50s, Double-ups) | GPP Tournaments |
|---|---|---|
| **Goal** | Finish above median | Finish in the top 1–5% |
| **Payout** | Flat (1.9× entry) | Top-heavy (up to 100×+) |
| **Optimal play** | Chalk, high floor, consistency | Leverage, ceiling, differentiation |
| **Stacking** | 3-man or none | 5-man preferred |
| **Ownership** | Own what the field owns | Deliberately fade some chalk |
| **Variance** | Minimize it | Embrace it |

The most common mistake in DFS is building cash-game lineups and entering them in GPPs. The second most common mistake is building GPP lineups and entering them in cash games. The tool enforces different scoring logic for each contest type — use it.

---

## 2. The Daily Workflow

Every winning slate starts well before lineup lock. This is the end-to-end sequence that ensures nothing gets missed and every decision is backed by the freshest available information.

### Phase 1 — Morning Research (3–5 hours before lock)

#### Step 1 — Load Your Data

Upload two files in the **Player Pool** tab: your DraftKings salary CSV and your ROO projection export. The tool auto-detects both formats by header structure and merges them into a unified player pool. Every player then displays salary, floor/median/ceiling projections, ownership estimates, leverage scores, and GPP value ratings.

**File format requirements:**

| File | Required Headers |
|---|---|
| DraftKings Salaries | Name+ID, TeamAbbrev, Roster Position, Salary |
| ROO Projections | Floor, Median, Ceiling, Position |
| 3-Man Stacks | B1, B2, B3, Salary |
| 5-Man Stacks | B1–B5, Salary |
| Team Scoring | OppSP, AvgScore, 8+Runs, WinPercentage |
| Optimal Lineups | SP1, SP2, C, 1B, 2B, 3B, SS, OF1–OF3, Stack |

If headers do not match, the tool displays a mismatch warning with a match percentage. Check team abbreviation alignment if ROO players are not matching DraftKings names.

**If using multiple projection sources:** Upload each as a separate file and set source weights. Weight the source with the better historical Spearman rank correlation (visible in Analyze Projections) higher. A 70/30 blend typically outperforms equal weighting when one source is demonstrably more accurate. Never blend evenly without checking calibration first. The **Source Quality panel** in the Backtesting tab shows your historical accuracy by source based on saved actuals — use it to make this decision with data.

#### Step 2 — Fetch Live Context

**Order matters.** Fetch in this sequence:

1. **Fetch Vegas Lines** — implied team totals drive game environment rankings and stack filtering
2. **Fetch Weather** — wind direction and temperature affect ceiling projections for outdoor parks
3. **Fetch Confirmed Lineups** — batting orders become available ~1 hour before first pitch; fetch as close to lock as possible
4. **Fetch Statcast / 14-Day Form** — underlying quality metrics; cache is used if the live feed is unavailable

Once Vegas and weather are loaded, the **Game Environment Rankings** update automatically, showing every game ranked by scoring potential. This is your primary stack-targeting surface — not gut instinct, not Twitter.

#### Step 3 — Review the Player Pool

Sort by **GPP Score** to find high-upside plays. Sort by **Leverage** to find players the field is systematically undervaluing relative to their projection. Check these visual indicators on each player row:

- **Statcast badge** (barrel rate, hard-hit %, xwOBA) — quality floor check independent of recent sample noise
- **DVP badge** — how many fantasy points the opposing defense allows at this player's position (rank among all teams)
- **14-day form coloring** — recency signal for hot/cold streaks
- **⚠ adj±X% badge** — warns when multiple compound adjustments (park, Vegas, weather, Statcast) push the player more than 25% from their raw projection, which may indicate double-counting if your projection CSV already prices in those factors

Use the **salary vs. median scatter plot** to identify value visually. Any dot above the trend line represents a player whose projection outpaces their price — these are your building blocks. Click a dot to push that player directly into the lineup builder.

#### Step 4 — Check the Best Plays Tab

Navigate to the **Best Plays** tab for a pre-built play sheet derived from your loaded data. This is not a manual sorting exercise — the engine runs the full scoring model and surfaces its recommendations in two columns:

##### Single Entry column

- Top pitcher picks filtered by K% ≥ 22%, opponent implied total < 4.0, and win probability > 50%
- Best hitter stack (2–3 batters from the top implied team, batting orders 1–5)
- Top 5 value plays by median/salary ratio

##### GPP column

- Chalk warning — teams in the top-2 by implied total that will be over-owned by the field
- Contrarian stack — teams ranked #3–#6 by implied total with the lowest average projected ownership
- Bring-back plays — 2–3 hitters from the opposing team in the same game, creating correlated upside via a game stack
- Top leverage plays — ranked by ceiling / ownership ratio
- Boom/bust candidates — under-12% ownership players with ceiling > 25 and high ceiling/median ratio

Players in the Best Plays tab are clickable — click any name to add directly to the lineup builder.

> **Research basis:** 64.5% of GPP tournament winners used a 5-man stack. 83.8% had 4 or more from one team. The average ownership per player in a winning lineup is 10–12%. Teams ranked #1 and #2 in implied total are consistently over-chalked — the Best Plays tab flags these explicitly so you can make an informed decision about fading or playing them.

---

### Phase 2 — Final Prep (60–90 minutes before lock)

#### Step 5 — Fetch Confirmed Lineups

Re-fetch confirmed lineups 60–90 minutes before first pitch, when the most batting orders are official. The **Confirmed** badge in the player pool updates to show each batter's confirmed order position. Players with an unconfirmed status from a team that has posted a batting order are filtered in calibrated pool scoring.

**Immediately after confirming lineups: activate the Late-Scratch Monitor.**

Click **Monitor Scratches** in the Player Pool tab. The monitor polls confirmed batting orders every 10 minutes and fires a visible alert if any player who was previously confirmed is now absent — meaning a late scratch. This gives you time to swap players before lock rather than discovering the scratch after you have already submitted lineups. Dismiss individual alerts once reviewed.

#### Step 6 — Build Stacks

Upload 3-man and 5-man stack CSV files in the **Stacks** tab, or let the engine construct virtual stacks from the merged pool. Stacks are ranked by projected points, salary efficiency, ownership, or optimal frequency. Click any player chip or the "Use" button to push a stack into the lineup builder.

**Stack selection principle:** Target games that rank #2 or #3 in the Game Environment Rankings, not #1. The field concentrates on the highest-total game automatically. The scoring difference between the top game and the second-best game is often small, but the ownership difference is large — that gap is leverage.

**Stack quality filters** in the Portfolio Builder further tighten stack selection:

- **Min Implied Total** — removes stacks from teams with insufficient run-scoring potential
- **Min Game O/U** — removes stacks from low-total games
- **Max Opp SP K/9** — removes stacks facing elite strikeout arms
- **Block Negative Weather** — removes stacks from rain-risk games (≥50% precipitation)

---

### Phase 3 — Build and Submit (30–60 minutes before lock)

#### Step 7 — Generate Your Portfolio

Navigate to **Portfolio Builder**. Set lineup count to match your actual entry count (more lineups than entries dilutes focus). Configure the settings below, then click Generate. See [Section 3](#3-every-setting--what-it-does-and-what-to-set-it-to) for detailed guidance on every setting.

**Key decisions at this stage:**

*Stack size:* Choose Mix, 3-man, 4-man, or 5-man only. For most GPP slates, Mix is correct — the engine splits lineups between 3-man and 5-man stacks based on the **5-Man Stack %** setting. For blowout-candidate slates with one dominant team, raising 5-man % to 50–60% captures more correlated upside. For thin slates or cash games, 3-man only reduces variance.

*Team exposure overrides:* If you already know you want at least 30% of your lineups on Team A, or want to cap Team B at 40%, set those constraints in the **Team Exposure** table before generating. This is faster and more precise than regenerating and manually checking the exposure table.

*Sim ROI Filter:* Enable for GPP lineups. The filter generates Overflow % extra candidates, simulates each one, and keeps only the top N by simulated ROI. This catches lineups that look good on paper but simulate poorly against a realistic ownership-weighted field. Leave off for cash — the optimizer already ranks by floor/median.

#### Step 8 — Review Portfolio Stats

After generating, check these outputs before submitting anything:

| Output | What to look for |
|---|---|
| **Diversity score** | 50%+ = good. Below 35% = too correlated — tighten overlap or add team cap |
| **Overlap histogram** | Most pairs should be at 4–6 shared players. Many pairs at 8+ = construction problem |
| **Stack exposure table** | No single team above 50% in GPP. If one team dominates, add an exposure cap and regenerate |
| **Player exposure table** | No chalk pitcher above 60–65%. Any batter at 30%+ field own appearing in 60%+ of your lineups is a leverage drain |
| **Sim ROI filter report** | If backfilled > 25%, widen ROI band or increase Overflow % |

#### Step 9 — Simulate and Verify

Run **Simulate Portfolio (Sim ROI)** for a final quality check. Compare results to the benchmarks in [Section 7](#7-performance-benchmarks). If cash rate is high but simROI is negative, your construction is too chalk-heavy — return to Step 7, add leverage, and regenerate.

#### Step 10 — Export and Save

**Export All Lineups CSV** produces a file in DraftKings multi-entry upload format (Name+ID columns). **Save to History** in one click — this enables projection calibration and ROI tracking over time. Do not skip this step.

---

### Phase 4 — Post-Slate Calibration (next morning)

#### Step 11 — Load Actuals

After games complete, use **Load Actuals** in the Backtesting tab to auto-populate player scores from the MLB Stats API. The tool matches players by name and computes lineup totals automatically.

#### Step 12 — Run Projection Analysis

Run **Analyze Projections** in the Backtesting tab. Review:

- Spearman ρ by projection source — which source was more accurate
- Position bias — which positions are systematically over/under-projected
- Ownership calibration — whether your ownership projections are running high or low
- Simulation tail calibration — whether your ceiling/floor parameters match observed score distributions

Apply position scales when you reach medium or higher confidence (40+ player actuals across 3+ slates). The **Source Quality panel** updates after each actuals load — use it to adjust your source blend weights for the next slate.

---

## 3. Every Setting — What It Does and What to Set It To

### Pre-Slate / One-Time Setup

| Setting | What It Does | Suggestion |
|---|---|---|
| **Projection Source Weights** | Blends multiple CSV sources before any score is computed | Single source: 100/0/0. Two sources: weight the one with better Spearman ρ heavier (e.g., 70/30). Never split evenly without checking calibration. |
| **Calibration** (Analyze Projections) | Scales all projections to correct systematic bias | Run after 3+ slates with actuals loaded. Apply position scales when confidence is "medium" or higher. Leave at 1.0 with insufficient data — bad calibration is worse than no calibration. |
| **History Settings** (max slates / strip pool) | Bounds lineup history file size | 30 slates max, strip pool after 5. Data older than 60 slates reflects different pitcher populations and degrades analysis. |

### Slate Prep (Each Slate)

| Setting | What It Does | Suggestion |
|---|---|---|
| **Min Vegas Implied Total** | Cuts stacks from low-run-environment teams | **3.5–4.0.** Below 3.5 = genuinely bad offenses. Don't stack pitchers' opponents. |
| **Min Game O/U** | Cuts games with low expected total run environment | **8.0–8.5.** Drop to 7.5 on thin slates (6 games). Raise to 8.5 on full slates (15 games). |
| **Max Opponent K/9** | Blocks stacks facing elite strikeout arms | **10.0.** SPs above 10 K/9 reduce batter ceiling. Set to 0 (disable) on thin slates. |
| **Block Negative Weather** | Excludes rain and high-wind games | **On** whenever weather data is loaded. A rained-out player scores 0 — this is a catastrophic outcome, not bad luck. |
| **Confirmed Lineup Filter** | Shows only players with a confirmed batting order | **On for cash** (only confirmed order matters). **Off for GPP scouting** (you want to see all options, but confirmed status is noted). |

### Portfolio Settings (Each Slate)

| Setting | What It Does | Suggestion |
|---|---|---|
| **Num Lineups** | How many lineups to generate | Match your actual entry count exactly. Extra lineups create false diversification. |
| **Contest Type** | Changes the optimizer's scoring function | Match your actual contest. The GPP and cash scoring engines are fundamentally different. |
| **Payout Type** | Controls how simROI is calculated | **top20** for standard GPPs. **double** for 50/50s and double-ups. **winner** for winner-take-all only. Wrong payout type inflates simROI for the wrong lineup shape. |
| **Contest Size** | Scales ownership leverage in the simulation | Match your actual field size. 1,000 for mid-stakes GPPs. 50,000+ for massive tournaments. 50 for small leagues. |
| **Batter Exposure Cap** | Max % of lineups a batter can appear in | **50% for GPP.** **70% for cash.** Never exceed 70% in GPP — if one batter is obvious to you, he's obvious to the field. |
| **Pitcher Exposure Cap** | Max % of lineups a pitcher can appear in | **60–70% for GPP.** **80–100% for cash.** In cash, a locked-in SP can go in every lineup. In GPP, >70% on one arm is a single point of failure. |
| **Max Overlap** | Max shared players between any two lineups | **5–6 for GPP.** **3 for large-field tournaments (10,000+ entries).** **Off (0) for cash** — similarity does not hurt in cash. |
| **Stack Size** | Forces 3-man, 4-man, 5-man, or a mix | **Mix for GPP.** 3-man only for cash and thin slates. 5-man only with high conviction on one team. 4-man is available for slates where you want more than a 3-man but cannot justify locking a 5th batter. |
| **5-Man Stack %** | What fraction of GPP lineups uses 5-man stacks when Stack Size = Mix | **30–40% default.** Raise to 50–60% on blowout-candidate slates with one dominant high-total game. Lower to 15–25% on balanced slates. |
| **Team Exposure Overrides** | Per-team minimum and maximum exposure floors/ceilings | Set a min to guarantee coverage of a team you want in every third lineup. Set a max to cap a chalk team even if the engine wants to use them more. Leave blank to let the engine decide. |
| **Allow BvP** | Allows pitchers and their opposing batters to share a lineup | **Off by default.** Keeping a pitcher and one of his opponents in the same lineup is a natural hedge against the pitcher's bad game — but it also reduces ceiling. Enable only when you have high conviction on both and are deliberately hedging. |

### Stack Quality Filters (Portfolio Builder)

| Setting | What It Does | Suggestion |
|---|---|---|
| **Min Implied Total** | Only stacks teams whose Vegas implied run total meets this threshold | **3.5–4.0.** Prevents stacking terrible offenses. 0 = no filter. |
| **Min Game O/U** | Only stacks games with O/U ≥ this value | **8.0+** on full slates. Drop to 7.5 on thin slates. 0 = no filter. |
| **Max Opp SP K/9** | Skip stacking against SPs with K/9 above this | **10.0.** SPs above this threshold dramatically limit batter ceiling. 0 = no filter. |
| **Block Negative Weather** | Removes stacks from games with ≥ 50% precipitation | **On** whenever weather data has been fetched. |

### Sim ROI Filter

| Setting | What It Does | Suggestion |
|---|---|---|
| **Enable Filter** | Generates overflow lineups and trims by simROI | **On for GPP.** **Off for cash.** The filter rewards ceiling — exactly what GPP needs. For cash, the optimizer already ranks by floor/median. |
| **Overflow %** | How many extra candidates to generate before trimming | **50–75%.** Below 30% the filter has too little to choose from. Above 100% is slow with diminishing returns. |
| **Sims Per Lineup** | Accuracy of the ranking pass | **1,500 (default).** Below 500 rankings become noisy. Increase to 3,000 for small final portfolios (≤20 lineups) where accuracy matters more than speed. |
| **ROI Band Min** | Lower bound — cut lineups below this simROI | **Leave blank in most cases.** Only use if you want to explicitly exclude lineups the optimizer considers low-quality. |
| **ROI Band Max** | Upper bound — cut lineups above this simROI | **Only for leverage portfolios** where you want to force contrarian builds by capping out high-simROI chalk lineups. Set around +5%. If the portfolio result shows >25% backfilled, the band is too tight — widen it or increase Overflow %. |

> **Band filter transparency:** After generating, the portfolio result shows how many candidates were generated, how many met your ROI band, and how many were backfilled from outside it. A warning appears if more than 25% were backfilled — that means your band is unreachable with the current player pool.

### Simulator

| Setting | What It Does | Suggestion |
|---|---|---|
| **Sim Count** | Monte Carlo iterations | **10,000 standard.** 25,000 before a final cash lineup decision. 5,000 for quick gut-checks during research. |
| **Correlation Scale** | How tightly stacked players move together | **1.0 default.** Increase to 1.3–1.5 for 5-man stacks in blowout-candidate games. Decrease toward 0.7 for a diversified cash lineup. |
| **Score Diversity** | Width of each player's score distribution | **1.0 default.** Increase to 1.2–1.5 for GPP ceiling analysis. Decrease to 0.8 for cash floor estimation. Do not exceed 1.5 unless Sim Tail Calibration says "tails too tight." |

---

## 4. Understanding Simulation Results

The Monte Carlo simulator generates correlated player outcomes using Cholesky-decomposed sampling, runs thousands of simulated contests, and measures how your lineup or portfolio performs against an ownership-weighted field model. Two numbers drive every construction decision.

### Cash Rate

Cash rate is the percentage of simulated contests where your lineup finishes in the money. In a typical large-field GPP, roughly 20–22% of entries cash. Consistently above 27% means your projection model is outscoring the field median regularly — a strong signal. But cash rate alone does not measure profitability.

### Average Simulated ROI

SimROI is the number that determines long-term profitability. Break-even is 0%. DraftKings' rake typically costs 10–15%, so a positive simROI means your lineups are projected to beat both the field and the house. **Negative simROI does not necessarily mean your lineups are bad** — it may mean they need construction adjustment, not projection adjustment.

### Reading the Full Simulation Output

The score distribution histogram shows percentile markers at P10, P25, P50, P75, P90, and P99. Use these to evaluate:

- **P50 (median)** — what your lineup scores on a typical night
- **P90** — your realistic ceiling; this is what you need to be competitive in GPP finals
- **P10** — your floor; if this is below your cash line, your cash lineup is too risky
- **Bust rate** — percentage of simulations where a player scores below 80% of their floor projection
- **Boom rate** — percentage of simulations where a player exceeds 90% of their ceiling

### What the Sim ROI Filter Is Actually Doing

When the Sim ROI Filter is enabled, the engine generates more lineups than your target count (controlled by Overflow %), scores each candidate with a simulation, then keeps the top lineups by simROI. This means your final portfolio is not the first N lineups the optimizer builds — it is the highest-quality N lineups from a larger candidate pool. The filter catches lineups that look good on paper but simulate poorly against a realistic field.

### The Portfolio Diversity Histogram

After generating, the overlap histogram shows how many lineup pairs share 0, 1, 2 … 10 players. A healthy GPP portfolio looks like a roughly bell-shaped distribution centered around 4–6 shared players, with few pairs at 8+. If the histogram is skewed right (many pairs at 8–10), your Max Overlap setting is too loose or your exposure caps are too high.

---

## 5. The GPP Paradox — High Cash Rate, Negative ROI

High cash rate with negative ROI is the single most common pattern in GPP portfolio analysis, and the most frequently misdiagnosed. Understanding why it happens — and how to fix it — is the difference between a player who grinds even and one who builds a bankroll.

### Why It Happens

GPP payouts are radically top-heavy. Cashing at 1.5× your entry fee 30% of the time barely covers the 70% of lineups that earn nothing. **Positive GPP ROI comes from hitting 10× to 100× payouts, not from grinding near the cash line.** When your lineups correlate with the field — same popular stacks, same chalk pitchers — they score well at the same time as everyone else. This pushes your finish position toward the median rather than the top 1–5%, because your good nights are everyone's good nights.

This is a game theory problem. If you own the same top-10 players as 30% of the field, and they all perform well, you finish in the same cluster as 30% of all entries. The payout for finishing 15th percentile in a 100,000-person field is identical to finishing dead last — zero. The only outcomes that matter are finishes in the top 1–2%.

### How to Diagnose the Problem

The tool gives you three diagnostic views:

**1. Stack Exposure Table**
Open the Stack Exposure table in portfolio results. If 60% or more of your lineups share the same one or two teams, you are heavily correlated with the field. The field gravitates toward the highest-implied-total game automatically — if your portfolio does too, your upside is capped.

**2. Batter Exposure Table**
Any player at 30%+ field ownership who also appears in 50%+ of your portfolio lineups is a chalk sink. You are owning them at a higher rate than the field does, which gives you zero leverage. When those players perform well, everyone benefits equally — you gain no positional advantage.

**3. Pitcher Selection**
The most popular GPP pitcher on any slate is typically owned by 25–40% of the field. If that same pitcher appears in 60% of your portfolio, you lose finish position every time he performs well — you are sharing that outcome with a third of all entries.

### The Structural Reason Five-Man Stacks Win GPPs

When a team has a big inning — six runs on eight hits — every batter in that lineup who participated in the rally scores fantasy points simultaneously. A 5-man stack from that team captures correlated upside that a 3-man stack only partially captures. The field tends to use 3-man stacks because they are "safer." That is precisely why 5-man stacks win large-field GPPs disproportionately — they are structurally differentiated from how most of the field is built.

---

## 6. Fixing Your Construction

Once you have diagnosed field correlation as the issue, these levers will move your simROI in the right direction.

### Lever 1 — Cap Your Top Stack

If one team appears in 70% of your lineups, cap it at 40–50% using the Portfolio Builder's **Team Exposure Overrides** table. Force the engine to distribute offensive exposure across two or three correlated games instead of concentrating in one. The override table lets you set both a floor (minimum %) and a ceiling (maximum %) per team — useful when you want to guarantee some coverage of a secondary game without letting the engine over-concentrate there.

### Lever 2 — Increase Five-Man Stack Usage

Raise the **5-Man Stack %** setting. Five-man stacks are structurally rarer in the field and produce higher score variance — exactly the kind of outcome distribution that GPP ROI requires. Three-man stacks are safer but less differentiating. Consider 4-man stacks as a middle ground on slates where you are not fully convinced on a fifth batter but want more correlated upside than a 3-man provides.

### Lever 3 — Use Contrarian Pitcher Pivots

In the Player Pool, sort by ownership. Find a pitcher projected similarly to the chalk option but owned at 8–15% instead of 25–40%. Use that pitcher in 30–40% of your portfolio lineups. When the contrarian pitcher matches the chalk arm's output, your finish position improves dramatically because fewer entries share the outcome.

This is the single highest-leverage construction adjustment available in MLB DFS. Pitcher ownership is the axis along which the most field correlation concentrates. A successful contrarian pitcher pivot in a large field can move a lineup from cashing to a top-10 finish.

Use the **Best Plays tab** to identify contrarian pitcher candidates automatically — the GPP column surfaces pitchers with favorable matchups who are projected below their chalk counterparts in ownership.

### Lever 4 — Tighten Lineup Overlap

Reduce Max Overlap from 7 to 5. Tighter overlap forces more structural diversity across your portfolio, which reduces field correlation at the aggregate level. Each lineup covers a wider range of possible outcomes.

### Lever 5 — Exploit Secondary Game Environments

Check the Game Environment Rankings. If your highest-owned stacks come from the slate's most popular game — highest O/U, best weather, lowest park factor — you are building exactly like the field. The Game Environment Rankings show every game scored by total run environment. Target the #2 or #3 game. The scoring upside is comparable; the ownership differential is substantial.

### Lever 6 — Use DVP to Differentiate at Scarce Positions

The **DVP (Defense vs. Position)** scoring factor adjusts player projections based on how many fantasy points the opposing team's defense has been giving up to that position. A second baseman facing a team that allows the most 2B production in the league gets a boost; a shortstop facing the tightest SS defense gets a reduction. This creates differentiation at positions where projections would otherwise be similar — exactly the kind of edge that moves the needle in large fields without requiring you to make a gut call.

---

## 7. Performance Benchmarks

Use this table to evaluate your portfolio's construction quality before entering contests.

| Metric | Neutral | Good | Strong |
|---|---|---|---|
| Cash Rate | 22–26% | 27–32% | 33%+ |
| Avg Sim ROI | -30% to -15% | -15% to 0% | 0%+ |
| Top Stack Exposure | < 55% | < 45% | < 35% |
| Unique Players in Portfolio | < 20 | 20–28 | 28+ |

**The key insight:** A cash rate above 29% with negative simROI is not a failure. It means your projection model is working but your construction is too chalk-heavy. Adjust leverage first — reduce top stack exposure, increase contrarian pitcher usage, tighten overlap — then re-simulate. The model is doing its job. The portfolio needs to be restructured around it.

---

## 8. Contest Selection and Bankroll Management

### 8.1 Choosing the Right Contest

Contest selection is as important as lineup construction. The right contest for a given lineup is determined by four factors:

**Field size:** Larger fields require more differentiation and produce higher variance. A 100-person field is a fundamentally different game than a 100,000-person field. In small fields, chalk often wins because the distribution of skill is narrow. In massive fields, only genuinely differentiated lineups can reach the top.

**Payout structure:** Top-heavy payouts (top 1% win 50× or more) require ceiling construction. Flatter payouts (50/50s, double-ups) reward floor construction. Use the Payout Type setting to match your simulation to your actual contest structure.

**Entry limits:** Single-entry and 3-max contests level the playing field against professional mass-entry operators who run hundreds of lineups. If you are building one or a few lineups, these formats are where your construction advantage matters most.

**Opponent skill level:** Seek contests with more casual participants. Tournaments with "Beginner" or "Regular" designations on DraftKings have more casual entrants — your edge is higher there than in contests with no entry restrictions that attract professional players.

### 8.2 Bankroll Rules

- **Risk 1–5% of your total bankroll per day** across all entries. Professional players who survive downswings keep per-day exposure below 3%.
- **Allocate by contest type:** A reasonable starting split is 60–70% of daily entries into cash games (low variance, consistent results) and 30–40% into GPPs (high variance, high upside). As your cash game win rate improves, you can shift more toward GPPs.
- **Never chase losses.** Increasing entry size after a losing slate to "make it back" is the fastest path to going broke. The correct response to a losing slate is to review the process, not to increase stake.
- **Track every entry.** The tool's history system exists for this purpose — use it. Twelve slates of clean data is enough to begin meaningful calibration analysis.

### 8.3 Position on Variance

Every DFS player will have losing weeks, losing months, and occasionally losing quarters. This is not evidence of a broken strategy — it is variance behaving as mathematics says it should. The only question that matters is whether your process generates positive expected value over a large sample. That is what the Analyze Projections tool and ROI tracker measure. Build a process you can measure, measure it consistently, and adjust based on evidence, not emotions.

---

## 9. Advanced Features Reference

### Best Plays Tab

The Best Plays tab surfaces the exact plays to make for each contest type, grounded in the full scoring model and your loaded data. It is not a filtered view of the player pool — it is a structured play sheet with separate Single Entry and GPP columns.

**When to use it:** After loading projections and Vegas lines, before building stacks. Use the Best Plays tab to identify your anchor plays for each contest type, then build your stacks around those anchors.

**Single Entry logic:** Pitchers are scored by strikeout rate, matchup quality, and floor. Hitter stacks are built from the top implied team's 1–5 hitters by avg slot score. Value plays are sorted by median/salary.

**GPP logic:** The chalk warning shows which teams are over-represented in projected field ownership — useful for deciding how much of your GPP portfolio to allocate there. The contrarian stack surfaces teams with comparable run environment but lower field ownership. Bring-backs identify the top 2–3 hitters from the opposing team in the contrarian game — these create correlated upside without owning the same team the field is stacking. Leverage plays and boom/bust candidates help you fill the remaining slots.

**Clicking players:** Every player row in the Best Plays tab is clickable. Clicking adds the player directly to the lineup builder, the same as clicking "+" in the player pool table.

### DVP — Defense vs. Position

DVP measures how many fantasy points each MLB team's defense has been allowing to hitters at each roster position (C, 1B, 2B, 3B, SS, OF). It is fetched fresh each session and is used as a multiplicative factor in the scoring model alongside Vegas, park factors, weather, and Statcast.

**In the player pool:** A DVP badge appears on each batter showing their opponent team's rank among all 30 teams for allowing production at that position. A top-5 rank (weak defense at that position) is a green badge; bottom-5 (strong defense) is a red badge.

**In portfolio construction:** The DVP factor biases the optimizer toward batters in favorable matchups at each position, creating natural differentiation at positions where projections are otherwise similar.

**What it does not replace:** DVP is a sample-based metric and can be noisy early in the season. Cross-reference with Statcast quality metrics and Vegas implied totals — a batter with a great DVP matchup against a team with a low implied total is not as valuable as DVP alone suggests.

### Platoon Multiplier

The engine now applies a platoon-direction adjustment to each batter's projection based on their handedness versus the opposing starting pitcher's handedness. Right-handed batters facing left-handed pitchers (and vice versa) receive a boost; same-hand matchups receive a reduction. This adjustment is applied after all other multipliers and is separate from BvP — it adjusts how good the batter's matchup is, not whether the batter and pitcher can share a lineup.

**In practice:** When confirmed lineups are loaded and pitcher handedness is available, platoon multipliers update automatically. No manual configuration is required.

### Compound Multiplier Deviation Badge

The **⚠ adj±X%** badge appears in the player pool when multiple scoring multipliers (Vegas, park factors, weather, Statcast, DVP) stack in the same direction and push a player's effective projection more than 25% above or below their raw CSV projection.

**Why this matters:** If your ROO projection CSV already prices in park factors and Vegas — as most do — and the tool then applies additional park and Vegas adjustments on top, the player's score can be doubled-counted upward. The badge is a flag to review, not an automatic exclusion. If you know your projection source is raw (no park/Vegas built in), the badge is informational but not a concern.

**What to do when you see it:** Check the player's raw CSV projection against the adjusted score. If the gap looks implausible given your projection source, reduce Score Diversity or disable the overlapping adjustment for that player.

### Late-Scratch Monitor

The **Monitor Scratches** button in the Player Pool tab starts a background poll that checks confirmed batting orders every 10 minutes. If any player who was previously in a confirmed batting order is now absent from that team's order, a visible alert fires immediately.

**When to use it:** Activate after fetching confirmed lineups with 60–90 minutes until lock. Leave it running until you have submitted all entries. Dismiss individual alerts after reviewing — dismissing does not re-add the player, it just clears the alert from the display.

**What triggers an alert:** A player appearing in a confirmed order in one poll cycle who is absent from that team's order in the next poll cycle. This catches late scratches, batting order reshuffles that drop a player from the lineup entirely, and pitching changes announced after the initial order is posted.

### BvP — Batter vs. Pitcher

The BvP rule (off by default) controls whether a pitcher and one of the opposing team's batters can share a lineup. With BvP off, the optimizer treats this as an invalid construction — if your SP is pitching against Team A, no Team A batter can appear in the same lineup. With BvP on, this constraint is removed.

**When to enable:** If you are deliberately building a hedge lineup — a pitcher with high floor who may have a quiet start, plus one of his opposing batters as insurance if the batter's team wins the game and scores runs. This is a deliberate construction strategy, not a convenience toggle. For standard lineup building, keep it off.

**Effect on salary utilization:** Disabling the BvP constraint opens up more salary combinations, which occasionally allows the optimizer to use salary more efficiently. For most slates this is a minor effect; on thin slates with limited pitching options, it can matter more.

### Stack Size — 4-Man Stacks

The Stack Size setting now includes a **4-man only** option in addition to 3-man, 5-man, and Mix. Four-man stacks are a middle construction strategy: more correlated upside than a 3-man, less exposure than a 5-man. Use them when:

- You are highly confident in 4 specific hitters from a team but cannot justify a 5th
- The slate has high-total games but no single team has 5 clear options above projection
- You want to target the bring-back slot (the opposing team's batter) in a game stack without committing to a 5-man from the primary team

In Mix mode, the engine uses 5-Man Stack % to determine what fraction of lineups use 5-man stacks and fills the remainder with 3-man stacks. 4-man only mode forces every GPP lineup to use exactly 4 hitters from one team.

### Source Quality Panel

The **Source Quality panel** in the Backtesting tab shows historical Spearman ρ accuracy by projection source, computed from your saved lineup history actuals. It updates automatically each time you load actuals for a completed slate.

**How to read it:** Higher ρ = better rank ordering of players. A source with ρ = 0.55 consistently ranks the actual top performers higher than a source at ρ = 0.38. Use the ρ values to weight your source blends: if Source A has ρ = 0.55 and Source B has ρ = 0.40, a 60/40 or 70/30 split favoring Source A is defensible. Equal weighting is rarely optimal once you have enough data.

**Minimum sample:** The panel shows confidence levels. At low confidence (< 20 player actuals), the ρ is noisy enough that source weights should not be adjusted. At medium confidence (20–60 actuals), suggested adjustments are reasonable. At high confidence (60+ actuals), the signal is reliable.

### Analyze Projections

After loading actuals for completed slates, run **Analyze Projections** from the Backtesting tab. The output shows:

- **Spearman rank correlation (ρ):** How well your projections rank players relative to their actual scores. A ρ above 0.5 is strong. Below 0.3, your projection source needs evaluation.
- **Bias by position:** Whether specific positions are systematically over- or under-projected. Use the Apply Position Scales button to correct this — the calibration adjusts projections before the optimizer runs, not after.
- **Simulation tail calibration:** Checks whether your sim's ceiling/floor parameters match observed score distributions. If "tails too fat" is reported, actual scores exceed the ceiling too rarely — tighten ceiling estimates or reduce Score Diversity. If "tails too tight," increase Score Diversity.
- **Ownership calibration:** Compares projected ownership to actual ownership. If under-projecting ownership, your "contrarian" plays may not be as contrarian as you think. If over-projecting, you may be over-fading popular plays.

> Apply position scales when you have **medium or higher confidence** (typically 40+ player actuals across 3+ slates). With fewer samples, the suggested scales are noisy and could make projections less accurate.

### Monte Carlo Simulator

The simulator uses Cholesky-decomposed correlated sampling — players on the same team are not simulated independently. Correlation coefficients increase with batting order proximity, meaning a 3-4-5 hitter stack is correctly modeled as more correlated than a 1-5-9 stack. You can run 5,000 to 50,000 simulations. Output includes a full score distribution histogram and per-player bust rate, boom rate, and standard deviation.

### Statcast Integration

Barrel rate, hard-hit %, and xwOBA are fetched from Baseball Savant and badge players in the pool view. These metrics identify underlying contact quality independent of recent results — a batter hitting .200 on bad luck but barreling 15% of balls in play is a better GPP target than his batting average suggests. Cached data is used if the live feed is unavailable.

### Vegas and Weather

Implied team totals from The Odds API and live weather from wttr.in produce the Game Environment Rankings. The wind model is park-orientation-aware — a 12 mph wind blowing out at Wrigley Field is fundamentally different from the same wind at Dodger Stadium. Conditions are classified as blowing out (positive for hitters), blowing in (negative for hitters), or neutral. This affects ceiling projections for home run upside plays specifically.

### Backtesting and ROI Tracking

Save any lineup to history with contest type, buy-in, and slate date. After games complete, use **Load Actuals** to auto-populate player scores from the MLB Stats API. The tool matches players by name and computes lineup totals automatically. Track ROI over time by contest type and review model analysis for calibration signals. This feedback loop — save → fetch actuals → analyze → calibrate → repeat — is what compounds your edge over time.

---

## 10. Quick Reference Cheat Sheets

### GPP vs. Cash Settings

| Setting | GPP | Cash |
|---|---|---|
| Contest Type | gpp | cash |
| Payout Type | top20 or top10 | double |
| Batter Exposure Cap | 40–50% | 65–75% |
| Pitcher Exposure Cap | 55–65% | 80–100% |
| Max Overlap | 5–6 | off (0) |
| Stack Size | mix | 3-man only |
| 5-Man Stack % | 30–40% (raise on blowout slate) | — |
| Sim ROI Filter | On, 50–75% overflow | Off |
| Score Diversity | 1.1–1.3 | 0.9–1.0 |
| Correlation Scale | 1.0–1.3 | 0.8–1.0 |
| Allow BvP | Off (unless deliberate hedge) | Off |

### Full Slate-Day Decision Sequence

```
MORNING (3–5 hours before lock)
──────────────────────────────────────────────────────────────
1.  Load DK salaries + ROO projections
2.  Set source weights (check Source Quality panel if data available)
3.  Fetch Vegas → Weather → Statcast/Form
4.  Review Game Environment Rankings — identify top 3 games by scoring potential
5.  Check Best Plays tab — note SE pitcher picks and GPP chalk/contrarian breakdown
6.  Review Player Pool — sort by GPP Score, then Leverage
    └── Watch for ⚠ adj±% badges on players with stacked multipliers
    └── Use DVP badges to differentiate similar projections
7.  Select primary stack (target #2 or #3 game for main GPP exposure)
8.  Configure Portfolio settings:
    └── Stack Size: Mix (30–40% 5-man for standard, 50–60% on blowout slate)
    └── Stack filters: Min Implied, Min O/U, Max K/9, Block Weather
    └── Team Exposure Overrides: set any floors/ceilings you want enforced
    └── Enable Sim ROI Filter (50–75% overflow, 1,500 sims)

FINAL PREP (60–90 minutes before lock)
──────────────────────────────────────────────────────────────
9.  Fetch Confirmed Lineups (re-fetch as close to lock as possible)
10. Activate Monitor Scratches — leave running until entries are submitted
11. Review updated Best Plays tab with confirmed orders loaded
12. Generate portfolio
13. Check: top stack exposure (<50% GPP), diversity score (≥50%), overlap histogram
14. If top stack > 50%: add team exposure cap → regenerate
15. Simulate portfolio — compare to benchmarks
16. Export to DraftKings + Save to History

POST-SLATE (next morning)
──────────────────────────────────────────────────────────────
17. Load Actuals for completed slate
18. Run Analyze Projections — review ρ, position bias, ownership calibration
19. Update source weights if Source Quality panel shows clear leader
20. Apply position scales if medium+ confidence on actuals sample
```

### Diagnosing Construction Problems

| Symptom | Likely Cause | Fix |
|---|---|---|
| High cash rate + negative ROI | Too chalky / field-correlated | Lower top stack exposure, pivot pitcher, tighten overlap |
| Low cash rate + negative ROI | Projection model issue or very thin slate | Check Spearman ρ in Analyze Projections; review calibration |
| Low unique player count (<20) | Exposure caps too high | Lower batter/pitcher exposure caps, increase overlap diversity |
| High diversity score but low sim ROI | Contrarian plays are too low-projection | Balance leverage with projection quality; don't fade chalk for its own sake |
| SimROI filter backfilled > 25% | ROI band too tight for current pool | Widen the band or increase Overflow % |
| ⚠ adj badge on high-owned plays | Compound multipliers stacking with projection CSV | Verify projection source doesn't already price in park/Vegas; consider reducing adjustments |
| Scratch monitor fires late | Player confirmed then removed from order | Swap immediately; do not submit a lineup with a known scratch |
| Best Plays shows chalk warning | Top-2 implied teams are highly over-chalked | Pivot to contrarian stack (teams #3–6) for at least 50% of GPP lineups |

### Performance Benchmarks

| Metric | Neutral | Good | Strong |
|---|---|---|---|
| Cash Rate | 22–26% | 27–32% | 33%+ |
| Avg Sim ROI | -30% to -15% | -15% to 0% | 0%+ |
| Top Stack Exposure | < 55% | < 45% | < 35% |
| Unique Players | < 20 | 20–28 | 28+ |
| Spearman ρ (Projection Accuracy) | < 0.3 | 0.3–0.5 | 0.5+ |

---

## 11. Setup and Troubleshooting

### Installation

Navigate to your MLB DFS Tool directory in a terminal or PowerShell window:

```
npm install      # install dependencies (first run only)
npm start        # start the server
```

The tool launches at **http://localhost:3000**. Alternatively, double-click `start.bat` or run `.\start.ps1` for automatic launch. To stop the server, run `.\stop.ps1`.

### Troubleshooting

| Issue | Solution |
|---|---|
| Port 3000 in use | Change `const PORT = 3000` in `server.js` to another port (e.g., 3001) |
| Statcast fetch fails | Cached data from `statcast_cache.json` will be used automatically |
| 0/N confirmed lineups | Batting orders post ~1 hour before first pitch; retry closer to lock |
| ROO players not matching | Check team abbreviation alignment; tool shows mismatch warnings with match percentage |
| Vegas fetch returns no data | Verify your API key in `.env`; The Odds API has a free-tier request limit |
| Weather fetch fails | `wttr.in` is occasionally unavailable; check back in a few minutes |
| DVP data missing | DVP is fetched from an external source; if unavailable the multiplier defaults to 1.0 (no effect) |
| "Generate" produces fewer lineups than requested | Pitcher exposure cap may be too low for the slate size; increase to 70%+ or reduce lineup count |
| History analysis shows insufficient data | Need at least 5 player actuals; load actuals for completed slates first |
| Scratch monitor shows no alerts but player is gone | Monitor must be active before the confirmed lineup is first fetched; it tracks changes from its baseline, not from zero |
| ⚠ adj badge appears on most players | Your projection source already prices in park/Vegas — consider disabling park or Vegas adjustments in the scoring model |
| Best Plays tab is empty | Load DK salaries + ROO projections first; Best Plays requires a populated player pool with projections |

### Data Files Reference

All persistent data is stored in the `/data` directory and never leaves your machine:

| File | Contents |
|---|---|
| `lineup_history.json` | Saved lineups, actuals, and ROI history |
| `calibration.json` | Active projection calibration scales |
| `slate_actuals.json` | Per-date player actual scores (last 60 dates) |
| `vegas.json` | Vegas implied totals and line movement history |
| `statcast_cache.json` | Statcast leaderboard data (12-hour cache) |
| `dvp_cache.json` | Defense vs. Position data by team and position |
| `park_factors.json` | Static park factor data for all 30 teams |
| `form_cache.json` | 14-day rolling form data per player |
| `bullpen_cache.json` | Bullpen quality metrics per team |
| `framing_cache.json` | Catcher framing data |
| `sprint_cache.json` | Sprint speed data |

---

*MLB DFS Tool v2.0 · 2026 Season Edition*
*Local-only · No subscription · No cloud · Your data never leaves your machine*
