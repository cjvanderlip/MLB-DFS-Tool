// ═══════════════════════════════════════════════════════════════════════════════
// MLB DFS Analytics Engine v2.0
// Monte Carlo Simulation · Correlation Modeling · Ownership Leverage
// Platoon Splits · Enhanced Optimizer · Portfolio Construction
// ═══════════════════════════════════════════════════════════════════════════════

const Engine = (() => {

// ── Constants ───────────────────────────────────────────────────────────────
const SALARY_CAP = 50000;
const ROSTER_SIZE = 10;
const MIN_SALARY_PER_SLOT = 3000;
const DK_SLOTS = [
  { key: 'P',  label: 'P',  eligible: p => rp(p, 'P') },
  { key: 'P',  label: 'P',  eligible: p => rp(p, 'P') },
  { key: 'C',  label: 'C',  eligible: p => rp(p, 'C') },
  { key: '1B', label: '1B', eligible: p => rp(p, '1B') },
  { key: '2B', label: '2B', eligible: p => rp(p, '2B') },
  { key: '3B', label: '3B', eligible: p => rp(p, '3B') },
  { key: 'SS', label: 'SS', eligible: p => rp(p, 'SS') },
  { key: 'OF', label: 'OF', eligible: p => rp(p, 'OF') },
  { key: 'OF', label: 'OF', eligible: p => rp(p, 'OF') },
  { key: 'OF', label: 'OF', eligible: p => rp(p, 'OF') }
];

function rp(p, slot) {
  return (p.rosterPos || p.dkPos || '').split('/').some(x => x.trim() === slot);
}

// ── Random Number Generators ────────────────────────────────────────────────

// Box-Muller transform for normal distribution
function randNorm(mean = 0, std = 1) {
  let u1 = Math.random(), u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z * std + mean;
}

// Skewed distribution using floor/median/ceiling
// Models right-tail upside (GPP-relevant)
function samplePlayerScore(player, correlationShift = 0) {
  const floor = player.floor || 0;
  const median = player.median || 0;
  const ceiling = player.ceiling || 0;
  if (median <= 0) return 0;

  // Build asymmetric distribution:
  // Left side std = (median - floor) / 1.5
  // Right side std = (ceiling - median) / 1.5
  const leftStd = Math.max((median - floor) / 1.5, 0.5) * _simDiversity;
  const rightStd = Math.max((ceiling - median) / 1.5, 0.5) * _simDiversity;

  // Generate base normal sample shifted by correlation
  const z = randNorm(0, 1) + correlationShift;

  let score;
  if (z <= 0) {
    score = median + z * leftStd;
  } else {
    score = median + z * rightStd;
  }

  // Floor at 0, slight chance of bust (negative DK points rare but possible)
  return Math.max(score, floor * 0.5);
}

// ── Correlation Matrix ──────────────────────────────────────────────────────

// Historical pair correlations — set from saved history actuals.
// Key: "nameA|nameB" (sorted), value: Pearson r computed from co-appearances.
let _pairCorr = {};

// Build pair correlation map from history data.
// historyEntries: array of { playerActuals: { playerName: dkScore }, lineup: [...] }
function buildPairCorrelations(historyEntries) {
  // Accumulate sum-of-products, counts, and individual sums per pair
  const acc = {}; // { key: { sumX, sumY, sumXX, sumYY, sumXY, n } }

  for (const entry of historyEntries) {
    const actuals = entry.playerActuals;
    if (!actuals || Object.keys(actuals).length < 2) continue;
    const players = Object.keys(actuals);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const x = actuals[a], y = actuals[b];
        if (x == null || y == null) continue;
        const key = [a, b].sort().join('|');
        if (!acc[key]) acc[key] = { sumX: 0, sumY: 0, sumXX: 0, sumYY: 0, sumXY: 0, n: 0 };
        const s = acc[key];
        s.sumX += x; s.sumY += y; s.sumXX += x * x;
        s.sumYY += y * y; s.sumXY += x * y; s.n++;
      }
    }
  }

  const result = {};
  for (const [key, s] of Object.entries(acc)) {
    if (s.n < 10) continue; // require 10+ co-appearances minimum
    const num = s.n * s.sumXY - s.sumX * s.sumY;
    const den = Math.sqrt((s.n * s.sumXX - s.sumX ** 2) * (s.n * s.sumYY - s.sumY ** 2));
    if (den === 0) continue;
    const rawR = Math.max(-1, Math.min(1, num / den));
    // Shrink toward 0 at low sample sizes — CI width at n=10 is ±0.63, at n=30 is ±0.37.
    // At n=10 we trust 33% of the computed r; at n=30+ we trust it fully.
    const trust = Math.min(1, s.n / 30);
    result[key] = rawR * trust;
  }
  _pairCorr = result;
  return result;
}

function getPairCorrelation(name1, name2) {
  const key = [name1, name2].sort().join('|');
  return _pairCorr[key] ?? null;
}

// Scaling factors set by user-facing sliders (1.0 = default).
// corrScale: multiplies all non-zero correlations (>1 = more stacking, <1 = less).
// simDiversity: adds jitter to samplePlayerScore (>1 = wider distributions).
let _corrScale = 1.0;
let _simDiversity = 1.0;
function setCorrScale(v) { _corrScale = Math.max(0.1, Math.min(3.0, v)); }
function setSimDiversity(v) { _simDiversity = Math.max(0.5, Math.min(3.0, v)); }
function getCorrScale() { return _corrScale; }
function getSimDiversity() { return _simDiversity; }

// Returns correlation coefficient between two players
// Checks historical pair data first, then falls back to structural rules.
function getCorrelation(p1, p2) {
  const isP1 = rp(p1, 'P'), isP2 = rp(p2, 'P');

  // Historical pair correlation takes priority when available (>=5 co-appearances)
  const hist = getPairCorrelation(p1.name, p2.name);
  if (hist !== null) return hist * _corrScale;

  // Pitcher vs opposing batters: near-zero correlation in DFS.
  // A high-scoring game (pitcher gets Ks + W, batters score runs) benefits both sides.
  // We block pitcher+opposing batter stacks via the BvP rule rather than relying on a
  // negative correlation that would skew simulation results pessimistically.
  if (isP1 && !isP2 && p1.opp === p2.team) return 0.0;
  if (isP2 && !isP1 && p2.opp === p1.team) return 0.0;

  // Same team batters: positive correlation (run scoring is correlated)
  if (!isP1 && !isP2 && p1.team === p2.team) {
    const o1 = p1.order || 9, o2 = p2.order || 9;
    const diff = Math.abs(o1 - o2);
    // Adjacent batters: 0.38, 2-apart: 0.30, etc.
    // Research shows 1-2 combo has highest correlation
    if (diff === 1) return Math.min(0.95, 0.38 * _corrScale);
    if (diff === 2) return Math.min(0.95, 0.30 * _corrScale);
    if (diff === 3) return Math.min(0.95, 0.22 * _corrScale);
    return Math.min(0.95, 0.15 * _corrScale); // Same team, far apart
  }

  // Bring-back: opposing team batter in same game
  if (!isP1 && !isP2 && p1.opp === p2.team && p2.opp === p1.team) {
    return Math.min(0.95, 0.12 * _corrScale);
  }

  // Pitcher and own team batters: slight positive (team wins = pitcher gets W bonus)
  if (isP1 && !isP2 && p1.team === p2.team) return Math.min(0.95, 0.05 * _corrScale);
  if (isP2 && !isP1 && p2.team === p1.team) return Math.min(0.95, 0.05 * _corrScale);

  return 0; // Different games, no correlation
}

// Build full correlation matrix for a lineup
function buildCorrelationMatrix(lineup) {
  const n = lineup.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const corr = getCorrelation(lineup[i], lineup[j]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }
  return matrix;
}

// Cholesky decomposition for correlated sampling
function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const val = matrix[i][i] - sum;
        L[i][j] = val > 0 ? Math.sqrt(val) : 0.001;
      } else {
        L[i][j] = L[j][j] !== 0 ? (matrix[i][j] - sum) / L[j][j] : 0;
      }
    }
  }
  return L;
}

// ── Monte Carlo Simulation ──────────────────────────────────────────────────

function simulateLineup(lineup, numSims = 10000) {
  const players = lineup.filter(Boolean);
  if (!players.length) return null;

  const corrMatrix = buildCorrelationMatrix(players);
  const L = cholesky(corrMatrix);
  const n = players.length;

  const results = [];
  const playerResults = players.map(() => []);

  for (let sim = 0; sim < numSims; sim++) {
    // Generate independent normal samples
    const z = [];
    for (let i = 0; i < n; i++) z.push(randNorm());

    // Apply Cholesky to create correlated samples
    const correlated = [];
    for (let i = 0; i < n; i++) {
      let val = 0;
      for (let j = 0; j <= i; j++) val += L[i][j] * z[j];
      correlated.push(val);
    }

    // Sample player scores using correlated shifts
    let total = 0;
    for (let i = 0; i < n; i++) {
      const score = samplePlayerScore(players[i], correlated[i] * 0.5);
      playerResults[i].push(score);
      total += score;
    }
    results.push(total);
  }

  // Compute statistics
  results.sort((a, b) => a - b);
  const mean = results.reduce((s, v) => s + v, 0) / numSims;
  const std = Math.sqrt(results.reduce((s, v) => s + (v - mean) ** 2, 0) / numSims);
  const p10 = results[Math.floor(numSims * 0.10)];
  const p25 = results[Math.floor(numSims * 0.25)];
  const p50 = results[Math.floor(numSims * 0.50)];
  const p75 = results[Math.floor(numSims * 0.75)];
  const p90 = results[Math.floor(numSims * 0.90)];
  const p95 = results[Math.floor(numSims * 0.95)];
  const p99 = results[Math.floor(numSims * 0.99)];

  // Player-level stats
  const playerStats = players.map((p, i) => {
    const pr = playerResults[i].sort((a, b) => a - b);
    const pmean = pr.reduce((s, v) => s + v, 0) / numSims;
    return {
      name: p.name,
      mean: pmean,
      p10: pr[Math.floor(numSims * 0.10)],
      p50: pr[Math.floor(numSims * 0.50)],
      p90: pr[Math.floor(numSims * 0.90)],
      std: Math.sqrt(pr.reduce((s, v) => s + (v - pmean) ** 2, 0) / numSims),
      bustRate: pr.filter(v => v < p.floor * 0.8).length / numSims,
      boomRate: pr.filter(v => v > p.ceiling * 0.9).length / numSims
    };
  });

  // ── Bootstrap standard error ─────────────────────────────────────────────
  // Split the sim results into B groups and compute the mean of each group.
  // The std-dev of those group means estimates how much the mean estimate
  // would vary if you re-ran the entire simulation — i.e. simulation noise.
  // 95% CI ≈ mean ± 2 * SE.  Wide CI → run more sims; narrow CI → result is stable.
  const B = 20; // number of bootstrap groups
  const groupSize = Math.floor(numSims / B);
  const groupMeans = [];
  const groupP50s  = [];
  for (let b = 0; b < B; b++) {
    const slice = results.slice(b * groupSize, (b + 1) * groupSize).sort((a, c) => a - c);
    groupMeans.push(slice.reduce((s, v) => s + v, 0) / slice.length);
    groupP50s.push(slice[Math.floor(slice.length * 0.50)]);
  }
  const meanSE = parseFloat(Math.sqrt(groupMeans.reduce((s, v) => s + (v - mean) ** 2, 0) / B).toFixed(2));
  const p50SE  = parseFloat(Math.sqrt(groupP50s.reduce((s, v) => s + (v - p50) ** 2, 0)  / B).toFixed(2));

  return {
    mean, std, p10, p25, p50, p75, p90, p95, p99,
    min: results[0],
    max: results[numSims - 1],
    histogram: buildHistogram(results, 30),
    playerStats,
    numSims,
    correlationScore: calcCorrelationScore(corrMatrix),
    // Bootstrap uncertainty estimates — how stable are these numbers?
    // meanSE / p50SE are the standard errors from splitting sims into 20 groups.
    // If meanSE > 1.0, consider running more simulations for reliable estimates.
    meanSE, p50SE,
    meanCI: [parseFloat((mean - 2 * meanSE).toFixed(1)), parseFloat((mean + 2 * meanSE).toFixed(1))],
    p50CI:  [parseFloat((p50  - 2 * p50SE ).toFixed(1)), parseFloat((p50  + 2 * p50SE ).toFixed(1))]
  };
}

function buildHistogram(values, bins) {
  const min = values[0], max = values[values.length - 1];
  const range = max - min || 1;
  const binWidth = range / bins;
  const histogram = [];
  for (let i = 0; i < bins; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    const count = values.filter(v => v >= lo && (i === bins - 1 ? v <= hi : v < hi)).length;
    histogram.push({ lo, hi, count, pct: count / values.length });
  }
  return histogram;
}

function calcCorrelationScore(matrix) {
  let sum = 0, count = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = i + 1; j < matrix.length; j++) {
      if (matrix[i][j] > 0) { sum += matrix[i][j]; count++; }
    }
  }
  return count > 0 ? sum / count : 0;
}

// ── Ownership Leverage ──────────────────────────────────────────────────────

// Calculate tournament leverage score
// Based on: Ceiling potential relative to ownership cost in a field
function calcLeverage(player, contestSize = 1000) {
  const own = player.own || 0;
  const ceiling = player.ceiling || 0;
  const median = player.median || 0;

  if (own <= 0 || ceiling <= 0) return 0;

  // Probability of reaching ceiling (rough estimate from distribution shape)
  const ceilProb = 0.10 + (ceiling - median) / (ceiling * 2);

  // Ownership penalty scales with contest size
  // In bigger fields, being unique matters more
  const fieldFactor = Math.log10(Math.max(contestSize, 10)) / 3;

  // Expected unique edge: how much do we gain by being right when others are wrong?
  // Higher own = more people share the upside, lower own = we capture more
  const uniqueEdge = ceiling * ceilProb * (1 - own / 100) * fieldFactor;

  // Normalize to a readable score
  return uniqueEdge;
}

// ── PA-based batting order multiplier ────────────────────────────────────
// Average plate appearances per game by lineup slot (2019–2024 MLB average).
// Source: FanGraphs PA/G splits by batting order.
// League-average batter gets ~4.25 PA/G. A #1 hitter gets ~4.85, #9 gets ~3.70.
// Multiplier = PA[order] / PA_AVG so that projections scale linearly with PA.
const PA_BY_ORDER = [0, 4.85, 4.72, 4.60, 4.48, 4.35, 4.22, 4.08, 3.93, 3.78];
const PA_AVG = 4.25;
function orderPAMult(order) {
  if (!order || order < 1 || order > 9) return 1.0;
  return PA_BY_ORDER[order] / PA_AVG;
}

// GPP Score: composite metric for tournament value
function calcGppScore(player, contestSize = 1000) {
  const ceiling = player.ceiling || 0;
  const floor = player.floor || 0;
  const own = player.own || 0;
  const median = player.median || 0;
  const salary = player.salary || 1;

  // P90 estimate from asymmetric distribution (same method as sim calibration)
  const rightStd = Math.max((ceiling - median) / 1.5, 0.5);
  const p90 = median + 1.28 * rightStd;

  // Percentile-target blend: weight toward P90 for GPP upside selection
  const targetScore = 0.3 * median + 0.7 * p90;

  // Ownership leverage: fade chalk harder in larger fields
  const ownershipEdge = own > 0 ? (1 / (1 + own / 100 * Math.log10(contestSize))) : 1;

  // Salary efficiency bonus (pts/$1k at ceiling level)
  const salaryValue = (ceiling / salary) * 1000 * 0.25;

  return (targetScore * ownershipEdge + salaryValue);
}

// ── Weather Impact Adjustments ──────────────────────────────────────────────

function weatherMultiplier(weather) {
  if (!weather || weather.error) return { hitting: 1.0, pitching: 1.0, label: 'Unknown', risk: 'none' };

  const temp = weather.temp_f || 72;
  const wind = weather.wind_mph || 5;
  const precip = weather.precip_chance || 0;
  let label = '', risk = 'none';

  // ── Temperature (Alan Nathan air-density model) ──────────────────────────
  // Ball carries ~0.34% farther per °F above 72°F due to lower air density.
  // Run scoring tracks roughly half of the batted-ball effect: ~0.17%/°F.
  // Source: Nathan (2012) "The Physics of Baseball"; FanGraphs environment series.
  // Capped at ±5% — beyond that projection CSVs should already capture extreme days.
  const tempDev = temp - 72;
  const tempHit = Math.max(-0.05, Math.min(0.05, tempDev * 0.0017));

  // Cold hurts pitchers too (grip/spin degradation), but ~40% of the hitting effect.
  // Hot has negligible impact on pitcher effectiveness.
  // Old formula `pitchMult = 2.0 - hitMult` was wrong (exact inverse → 8%+ swings).
  const tempPitch = tempDev < 0 ? tempDev * 0.0007 : 0;

  // ── Wind (direction-agnostic fallback) ───────────────────────────────────
  // Without wind direction the sign is unknown — a 15 mph wind is equally likely
  // to be in or out. High wind does increase overall variance (pop-ups + HRs both
  // rise), so a tiny positive bias is defensible for GPP ceiling modelling.
  // Direction-aware adjustments live in weatherMultiplierDirectional via windEffect.
  const windHit = wind >= 15 ? 0.015 : wind >= 10 ? 0.007 : 0;

  const hitMult  = parseFloat((1.0 + tempHit + windHit).toFixed(4));
  const pitchMult = parseFloat((1.0 + tempPitch).toFixed(4));

  if (temp >= 85) label = 'Hot';
  else if (temp >= 75) label = 'Warm';
  else if (temp <= 50) label = 'Cold';
  else if (temp <= 60) label = 'Cool';
  else label = 'Mild';

  if (wind >= 15) label += ' / Windy';
  else if (wind >= 10) label += ' / Breezy';

  if (precip >= 50) { risk = 'high';     label += ' / Rain Risk'; }
  else if (precip >= 30) { risk = 'moderate'; label += ' / Slight Rain'; }

  return { hitting: hitMult, pitching: pitchMult, label, risk, temp, wind, precip };
}

// ── Park Factor Adjustments ─────────────────────────────────────────────────

function parkMultiplier(team, parkFactors) {
  const pf = parkFactors?.[team];
  if (!pf) return { overall: 1.0, hr: 1.0, run: 1.0 };
  return pf;
}

// ── Vegas Integration ───────────────────────────────────────────────────────

// Adjust projections based on Vegas implied totals
function vegasAdjustment(player, vegasData) {
  if (!vegasData) return 1.0;

  const teamData = vegasData[player.team];
  if (!teamData || !teamData.impliedTotal) return 1.0;

  const impliedTotal = teamData.impliedTotal;
  const avgImplied = 4.5; // League average implied total

  // Scale factor: if Vegas implies 5.5 runs vs 4.5 avg = ~20% boost.
  // Clamped to ±25% so extreme implied totals don't dominate the projection.
  const raw = impliedTotal / avgImplied;
  return Math.max(0.75, Math.min(1.25, raw));
}

function vegasPitcherAdjustment(pitcher, vegasData) {
  if (!vegasData || !pitcher.opp) return 1.0;

  const oppData = vegasData[pitcher.opp];
  if (!oppData || !oppData.impliedTotal) return 1.0;

  const oppImplied = oppData.impliedTotal;
  const avgImplied = 4.5; // League average implied total
  // Linear scale: each run above/below average moves multiplier by ~4.4%.
  // Clamped to ±20% so extreme totals don't produce nonsensical adjustments.
  // (Previous formula "(9 - oppImplied) / 4.5" could return negative values
  // for teams with implied totals > 9, and could exceed 2x for very low totals.)
  const raw = 1.0 + (avgImplied - oppImplied) / avgImplied * 0.20;
  return Math.max(0.80, Math.min(1.20, raw));
}

// ── Projection Blending ─────────────────────────────────────────────────────

// Blend multiple projection sources with configurable weights
function blendProjections(sources, weights) {
  // sources: array of { name, players: [{name, floor, median, ceiling, own}] }
  // weights: { sourceName: weight } (should sum to 1.0)
  const playerMap = {};

  sources.forEach((source) => {
    const w = weights[source.name] || (1 / sources.length);
    source.players.forEach(p => {
      const key = p.name.toLowerCase();
      if (!playerMap[key]) {
        playerMap[key] = {
          name: p.name, team: p.team, opp: p.opp,
          floor: 0, median: 0, ceiling: 0, own: 0,
          sources: [], sourceCount: 0
        };
      }
      const m = playerMap[key];
      m.floor += (p.floor || 0) * w;
      m.median += (p.median || 0) * w;
      m.ceiling += (p.ceiling || 0) * w;
      m.own += (p.own || 0) * w;
      m.sources.push(source.name);
      m.sourceCount++;
    });
  });

  return Object.values(playerMap);
}

// ── Team Scoring Adjustment ─────────────────────────────────────────────────

// Uses team-level scoring percentages to adjust player projections
// avgScore ~3.0-4.5 range, baseline ~3.8; 8+Runs 28-35% range; winPct 30-68%
function teamScoringAdjustment(player, teamScoring) {
  if (!teamScoring) return { batting: 1.0, pitching: 1.0 };
  const ts = teamScoring[player.team];
  if (!ts) return { batting: 1.0, pitching: 1.0 };

  const isP = rp(player, 'P');

  if (isP) {
    // For pitchers, look at the opposing team's scoring data
    const oppTs = teamScoring[player.opp];
    if (!oppTs) return { batting: 1.0, pitching: 1.0 };
    // Low opponent avg score = good matchup for pitcher
    const oppScoreAdj = (3.8 - oppTs.avgScore) * 0.08; // ~±0.03-0.05
    const oppExplosiveAdj = (30 - oppTs.eightPlusRuns) * 0.003; // penalty if opp has high 8+ run %
    return { batting: 1.0, pitching: 1.0 + oppScoreAdj + oppExplosiveAdj };
  }

  // Batters: boost teams with higher avg score and explosive upside
  const scoreAdj = (ts.avgScore - 3.8) * 0.06;         // ~±0.02-0.04
  const explosiveAdj = (ts.eightPlusRuns - 31) * 0.002; // bonus for high 8+ run %
  const winAdj = (ts.winPct - 45) * 0.001;              // slight win probability edge
  return { batting: 1.0 + scoreAdj + explosiveAdj + winAdj, pitching: 1.0 };
}

// ── Enhanced Scoring Functions ───────────────────────────────────────────────

// Optimal lineup exposure boost — REMOVED FROM SCORING to break the circular loop.
// The old implementation read optimalExposure (generated by the optimizer) and fed
// it back into the scoring functions that drive the optimizer → a player appearing
// often scored higher → appeared more → scored higher again, amplifying noise.
//
// optimalExposure is still computed and exposed as a diagnostic (show which players
// appear in N% of generated lineups) but is no longer a scoring input.
// If you want a prior signal, inject it via `context.priorExposure` populated from
// the previous slate's actuals — that would be independent of the current run.
function optimalExposureBoost(_p, _context, _mode) {
  return 1.0; // no-op — circular loop broken
}

function buildPlayerContext(p, context = {}) {
  const { vegasData, parkFactors, weatherData, stadiums, teamScoring, umpireData, blendWeights, bullpenData, framingMap, sprintSpeedData } = context;
  const isP = rp(p, 'P');
  const homeTeam = p.game ? p.game.split('@')[1] : p.team;
  const bpAdj = bullpenAdjustment(p, bullpenData);
  const cfAdj = catcherFramingAdjustment(p, framingMap);
  const ssBoost = sprintSpeedBoost(p, sprintSpeedData);
  const vegasAdj = isP ? vegasPitcherAdjustment(p, vegasData) : vegasAdjustment(p, vegasData);
  const pf = parkMultiplier(homeTeam, parkFactors);
  const tsAdj = teamScoringAdjustment(p, teamScoring);
  const scW = (blendWeights?.Statcast ?? 100) / 100;
  const scBoost = isP ? (1.0 + (pitcherStuffBoost(p) - 1.0) * scW) : (1.0 + (statcastCeilingBoost(p) - 1.0) * scW);
  const umpTend = umpireData?.[homeTeam] || null;
  const umpBoost = umpireMultiplier(umpTend, isP);

  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && homeTeam) {
    const isDome = stadiums?.domes?.includes(homeTeam);
    // Weather is now keyed by team code (from GPS-accurate batch fetch)
    if (!isDome && weatherData[homeTeam]) wm = weatherMultiplier(weatherData[homeTeam]);
  }

  // Composite multiplier chain.
  // Each individual factor is small (±3–10%), but stacking can compound.
  // Cap the final batter/pitcher multiplier to ±35% of neutral (1.0) so that
  // game-environment adjustments remain meaningful without dominating projections.
  const rawBatterMult = vegasAdj * pf.run * wm.hitting * tsAdj.batting * scBoost * umpBoost * bpAdj * cfAdj * ssBoost;
  const rawPitcherMult = vegasAdj * wm.pitching * tsAdj.pitching * scBoost * umpBoost * bpAdj * cfAdj * ssBoost;
  const batterMult = Math.max(0.65, Math.min(1.35, rawBatterMult));
  const pitcherMult = Math.max(0.65, Math.min(1.35, rawPitcherMult));
  const hrMult = pf.hr; // GPP batters use hr park factor instead of run

  return { isP, homeTeam, pf, vegasAdj, wm, tsAdj, scBoost, umpBoost, bpAdj, cfAdj, ssBoost, batterMult, pitcherMult, hrMult, rawBatterMult, rawPitcherMult };
}

function scoreCash(p, context = {}) {
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'cash');

  if (pc.isP) {
    const kBonus = (p.kRate || 0) > 25 ? 2.0 : (p.kRate || 0) > 20 ? 1.0 : 0;
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 2.5 + (p.floor || 0) * 1.5 + matchup * 2 + kBonus + winProb * 3)
      * pc.pitcherMult * optBoost;
  }

  const paMult = orderPAMult(p.order);
  const variance = (p.ceiling || 0) - (p.floor || 0);
  return ((p.median || 0) * 2.0 + (p.floor || 0) * 1.5 - variance * 0.3)
    * paMult * pc.batterMult * optBoost;
}

function scoreSingle(p, context = {}) {
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'single');
  const value = p.salary > 0 ? (p.median || 0) / p.salary * 1000 : 0;

  if (pc.isP) {
    const kBonus = (p.kRate || 0) > 25 ? 1.5 : (p.kRate || 0) > 20 ? 0.7 : 0;
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 1.5 + (p.ceiling || 0) * 0.8 + value * 0.3 + matchup + kBonus)
      * pc.pitcherMult * optBoost;
  }

  const paMult = orderPAMult(p.order);
  return ((p.median || 0) * 1.2 + (p.ceiling || 0) * 0.6 + value * 0.4)
    * paMult * pc.batterMult * optBoost;
}

function scoreGpp(p, context = {}) {
  const { contestSize = 1000 } = context;
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'gpp');

  if (pc.isP) {
    const kBonus = (p.kRate || 0) > 25 ? 2.0 : (p.kRate || 0) > 20 ? 1.0 : 0;
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    const ownPenalty = (p.own || 0) * 0.1 * (Math.log10(Math.max(contestSize, 10)) / 3);
    return ((p.ceiling || 0) * 1.2 + (p.median || 0) * 0.5 + matchup - ownPenalty + kBonus + winProb * 2)
      * pc.pitcherMult * optBoost;
  }

  const gppScore = calcGppScore(p, contestSize);
  const paMult = orderPAMult(p.order);
  return gppScore * paMult * pc.hrMult * pc.batterMult / pc.pf.run * optBoost;
}

function getPitcherMatchupScore(pitcher, context) {
  const { pool } = context;
  if (!pool || !pitcher.opp) return 0;

  const oppBatters = pool.filter(p => p.team === pitcher.opp && !rp(p, 'P') && p.median > 0);
  if (oppBatters.length < 3) return 0;

  const avgMedian = oppBatters.reduce((s, p) => s + p.median, 0) / oppBatters.length;
  const avgCeiling = oppBatters.reduce((s, p) => s + (p.ceiling || 0), 0) / oppBatters.length;

  // Weighted matchup score (lower opponent = better for pitcher)
  if (avgMedian < 5 && avgCeiling < 12) return 3;   // Elite matchup
  if (avgMedian < 6) return 2;                        // Great matchup
  if (avgMedian < 7) return 1;                        // Good matchup
  if (avgMedian > 9) return -2;                       // Terrible matchup
  if (avgMedian > 8) return -1;                       // Bad matchup
  return 0;
}

// ── Placement Validation ──────────────────────────────────────────────────
function validatePlacement(candidate, others, allowBvP, maxBattersPerTeam) {
  if (!allowBvP) {
    if (rp(candidate, 'P')) {
      if (candidate.opp && others.some(p => !rp(p, 'P') && p.team === candidate.opp)) return false;
    } else {
      if (others.some(p => rp(p, 'P') && p.opp === candidate.team)) return false;
    }
  }
  if (!rp(candidate, 'P')) {
    const teamCount = others.filter(p => !rp(p, 'P') && p.team === candidate.team).length;
    if (teamCount >= maxBattersPerTeam) return false;
  }
  return true;
}

// ── Local-Search Optimizer ──────────────────────────────────────────────────
//
// Replaces the previous random-sampling loop with a deterministic greedy
// seed + exhaustive 1-swap local search.
//
// Why this is better than random sampling:
//   • Random sampling over N iterations explores a tiny, biased fraction of
//     the solution space and produces different results on every run.
//   • Local search starts from the greedy-optimal seed (already the best
//     single-pass solution) and then exhaustively tests every possible
//     1-player substitution, accepting any that improve the lineup score.
//   • It repeats until no single swap can improve things — i.e. it finds
//     the true local optimum under the given constraints.
//   • In practice this converges in 3–5 passes and covers the full
//     candidate pool rather than a random subset.
//
// The `iterations` parameter is kept for API compatibility but is unused.

function optimizeLineup(pool, scoreFn, opts = {}) {
  const {
    excludeNames = new Set(),
    requiredSlots = new Array(ROSTER_SIZE).fill(null),
    iterations: _iterations = 5000, // unused — kept so call sites don't need updating
    stackBonusFn = null,
    exposureLimits = null,
    forceInclude = new Set(),
    allowBvP = false,
    maxBattersPerTeam = 5,
    contestType = 'cash'  // 'cash' | 'gpp' | 'single' — controls salary bonus weight
  } = opts;

  // Pre-place forced players into open required slots
  const effectiveRequired = [...requiredSlots];
  if (forceInclude.size) {
    for (const fname of forceInclude) {
      if (effectiveRequired.some(p => p?.name === fname)) continue;
      const fp = pool.find(p => p.name === fname && !excludeNames.has(p.name) && p.salary > 0);
      if (!fp) continue;
      for (let i = 0; i < ROSTER_SIZE; i++) {
        if (!effectiveRequired[i] && DK_SLOTS[i].eligible(fp)) { effectiveRequired[i] = fp; break; }
      }
    }
  }

  // Build the full exclusion set (banned + over-exposed players)
  const excluded = new Set(excludeNames);
  if (exposureLimits) {
    pool.forEach(p => { if ((exposureLimits[p.name] || 1) <= 0) excluded.add(p.name); });
  }
  effectiveRequired.forEach(p => { if (p) excluded.delete(p.name); }); // locked players are never excluded

  // ── Step 1: Greedy seed ──────────────────────────────────────────────────
  let lu = greedyFill(pool, scoreFn, excluded, effectiveRequired, allowBvP, maxBattersPerTeam);
  if (!lu || lu.some(p => !p)) {
    // Greedy couldn't fill — nothing to improve
    return lu;
  }

  // ── Step 2: Cache per-player scores ─────────────────────────────────────
  // scoreFn is pure with respect to lineup composition (context is captured
  // in closure), so we can memoize to avoid redundant calculations.
  const scoreCache = new Map();
  const cachedScore = p => {
    if (!scoreCache.has(p.name)) scoreCache.set(p.name, scoreFn(p));
    return scoreCache.get(p.name);
  };

  // Salary efficiency bonus — scales by contest type.
  // Cash/single: high weight (15) — floor-focused, burning salary is always good.
  // GPP: low weight (5) — ceiling-focused; cheap stacks can beat expensive chalk.
  const salBonus = contestType === 'gpp' ? 5 : contestType === 'single' ? 10 : 15;

  // Composite lineup score: individual scores + salary efficiency bonus + stack bonus
  const lineupTotalScore = lineup => {
    const pts = lineup.reduce((s, p) => s + cachedScore(p), 0);
    const sal = lineup.reduce((s, p) => s + p.salary, 0);
    return pts + (sal / SALARY_CAP) * salBonus + (stackBonusFn ? stackBonusFn(lineup) : 0);
  };

  // ── Step 3: Per-slot candidate pools sorted by individual score ──────────
  // Only built for open (non-locked) slots; excludes banned/over-exposed players.
  const slotPools = DK_SLOTS.map((slot, i) => {
    if (effectiveRequired[i]) return []; // locked — skip
    return pool
      .filter(p =>
        slot.eligible(p) && !excluded.has(p.name) && p.salary > 0 &&
        (p.median > 0 || p.ceiling > 0 || p.avgPpg > 0)
      )
      .sort((a, b) => cachedScore(b) - cachedScore(a));
  });

  // ── Step 4: Exhaustive 1-swap local search ───────────────────────────────
  // Each pass: for every open slot, try every eligible candidate from slotPools.
  // Accept the best-improving swap found in that slot (greedy per slot).
  // Repeat until a full pass produces no improvements (local optimum reached).
  // Safety cap: 15 passes (typically converges in 3–5).
  let improved = true;
  let passes = 0;

  while (improved && passes < 15) {
    improved = false;
    passes++;

    for (let i = 0; i < ROSTER_SIZE; i++) {
      if (effectiveRequired[i]) continue; // don't touch locked players

      const cur = lu[i];
      const others = lu.filter((_, j) => j !== i).filter(Boolean);
      const othersNames = new Set(others.map(p => p.name));
      const othersSalary = others.reduce((s, p) => s + p.salary, 0);
      const othersScore = others.reduce((s, p) => s + cachedScore(p), 0);

      let bestScore = lineupTotalScore(lu); // only accept strict improvements
      let bestPick = null;

      for (const cand of slotPools[i]) {
        if (othersNames.has(cand.name)) continue; // already in another slot
        if (cand.name === cur?.name) continue;     // same player
        if (othersSalary + cand.salary > SALARY_CAP) continue;
        if (!validatePlacement(cand, others, allowBvP, maxBattersPerTeam)) continue;

        // Compute new lineup score without allocating a full array when possible
        const newLu = [...lu]; newLu[i] = cand;
        const newScore = othersScore + cachedScore(cand)
          + ((othersSalary + cand.salary) / SALARY_CAP) * salBonus
          + (stackBonusFn ? stackBonusFn(newLu) : 0);

        if (newScore > bestScore) {
          bestScore = newScore;
          bestPick = cand;
        }
      }

      if (bestPick) {
        lu[i] = bestPick;
        improved = true;
        // Note: we continue to the next slot using the updated lineup, so later
        // slots benefit from swaps made earlier in the same pass.
      }
    }
  }

  // ── Step 5: Salary upgrade pass ─────────────────────────────────────────
  // After local search converges, push any remaining cap headroom into higher-
  // salary alternatives that score within 5% of the current player.
  return upgradeSalary(lu, pool, scoreFn, excluded, allowBvP, maxBattersPerTeam);
}

function greedyFill(pool, scoreFn, excludeNames = new Set(), requiredSlots = new Array(ROSTER_SIZE).fill(null), allowBvP = false, maxBattersPerTeam = 5) {
  const lu = [...requiredSlots];
  const sorted = [...pool].filter(p => !excludeNames.has(p.name) && p.salary > 0)
    .sort((a, b) => scoreFn(b) - scoreFn(a));
  // Precompute realistic minimum per remaining slot (10th-pct of eligible pool)
  const realisticMin = DK_SLOTS.map((slot, i) => {
    if (lu[i]) return 0;
    const eligible = pool.filter(p => slot.eligible(p) && !excludeNames.has(p.name) && p.salary > 0)
      .sort((a, b) => a.salary - b.salary);
    if (!eligible.length) return MIN_SALARY_PER_SLOT;
    return eligible[Math.max(0, Math.floor(eligible.length * 0.10))].salary;
  });
  for (let i = 0; i < ROSTER_SIZE; i++) {
    if (lu[i]) continue;
    for (const p of sorted) {
      if (lu.some(lp => lp && lp.name === p.name)) continue;
      if (!DK_SLOTS[i].eligible(p)) continue;
      const salSoFar = lu.reduce((s, lp) => s + (lp ? lp.salary : 0), 0);
      const reserveRemaining = realisticMin.reduce((s, m, j) => j > i && !lu[j] ? s + m : s, 0);
      if (salSoFar + p.salary > SALARY_CAP - reserveRemaining) continue;
      if (!validatePlacement(p, lu.filter(Boolean), allowBvP, maxBattersPerTeam)) continue;
      lu[i] = p;
      break;
    }
  }
  return lu;
}

// Post-optimization salary upgrade pass: after the main optimizer finds its
// best lineup, sweep each slot and try to replace the player with a higher-
// salary alternative that fits in cap and scores at least 92% as well.
// Repeats until no further upgrades are possible. Directly closes the
// "leaving money on the table" gap without touching diversity mechanics.
function upgradeSalary(lu, pool, scoreFn, excludeNames, allowBvP = false, maxBattersPerTeam = 5) {
  let changed = true;
  while (changed) {
    changed = false;
    const salaryUsed = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    const headroom = SALARY_CAP - salaryUsed;
    if (headroom <= 0) break;
    const luNames = new Set(lu.filter(Boolean).map(p => p.name));
    for (let i = 0; i < ROSTER_SIZE; i++) {
      const cur = lu[i];
      if (!cur) continue;
      const curScore = scoreFn(cur);
      const others = lu.filter((p, j) => p && j !== i);
      const upgrade = pool.filter(p => {
        if (excludeNames.has(p.name)) return false;
        if (luNames.has(p.name)) return false;
        if (p.salary <= cur.salary) return false;
        if (p.salary > cur.salary + headroom) return false;
        if (!DK_SLOTS[i].eligible(p)) return false;
        if (scoreFn(p) < curScore * 0.95) return false;
        if (!validatePlacement(p, others, allowBvP, maxBattersPerTeam)) return false;
        return true;
      }).sort((a, b) => b.salary - a.salary)[0];
      if (upgrade) {
        luNames.delete(cur.name);
        lu[i] = upgrade;
        luNames.add(upgrade.name);
        changed = true;
        break; // restart pass — headroom has changed
      }
    }
  }
  return lu;
}

// ── Stack Bonus Functions ───────────────────────────────────────────────────

function gppStackBonus(lu, usedStackTeam) {
  let bonus = 0;

  // Bring-back bonus
  if (usedStackTeam) {
    const oppTeams = new Set();
    lu.forEach(p => { if (p.team === usedStackTeam && p.opp) oppTeams.add(p.opp); });
    const bringBacks = lu.filter(p => !rp(p, 'P') && oppTeams.has(p.team));
    if (bringBacks.length >= 1) bonus += 4;
    if (bringBacks.length >= 2) bonus += 3;
  }

  // Same-team correlation bonus
  const teamCounts = {};
  lu.forEach(p => { if (!rp(p, 'P')) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1; });
  Object.values(teamCounts).forEach(c => {
    if (c >= 5) bonus += 5;
    else if (c >= 4) bonus += 3;
    else if (c >= 3) bonus += 1.5;
  });

  // Batting order adjacency bonus within stacks
  Object.entries(teamCounts).forEach(([team, count]) => {
    if (count >= 3) {
      const orders = lu.filter(p => p.team === team && !rp(p, 'P') && p.order > 0)
        .map(p => p.order).sort((a, b) => a - b);
      for (let i = 0; i < orders.length - 1; i++) {
        if (orders[i + 1] - orders[i] === 1) bonus += 1.5; // Adjacent order bonus
      }
    }
  });

  return bonus;
}

// ── Portfolio Builder ───────────────────────────────────────────────────────

// Build a virtual stack for a team from the player pool when no stacks
// file entry exists for that team. Picks top-N batters by median score.
function buildVirtualStack(team, pool, excludeNames, size = 3) {
  const batters = pool.filter(p =>
    p.team === team && !rp(p, 'P') &&
    !excludeNames.has(p.name) &&
    p.salary > 0 && (p.median > 0 || p.avgPpg > 0)
  ).sort((a, b) => (b.median || b.avgPpg || 0) - (a.median || a.avgPpg || 0));

  if (batters.length < 2) return null;
  const chosen = batters.slice(0, size);
  return {
    id: `virtual_${team}_${size}`,
    players: chosen.map(p => p.name),
    team,
    proj: chosen.reduce((s, p) => s + (p.median || 0), 0),
    own: chosen.reduce((s, p) => s + (p.own || 0), 0) / chosen.length,
    isVirtual: true
  };
}

// Synthesize N-man virtual stacks for every team present in pool.
// Used when stackSize is set to 4, or as fallback when no stack files are loaded.
function buildAutoStacks(pool, size) {
  const teams = [...new Set(pool.filter(p => !rp(p, 'P') && p.salary > 0).map(p => p.team))];
  return teams.map(team => buildVirtualStack(team, pool, new Set(), size)).filter(Boolean);
}

// Try to fit stack players into requiredSlots. Returns true on success.
// Pitchers in user-uploaded stacks are placed as pitchers only; batters from the
// same team are counted against the DK 5-batter-per-team limit.
function tryPlaceStack(stackPlayers, requiredSlots, _pool) {
  const tempLu = [...requiredSlots];
  let stackSalary = requiredSlots.reduce((s, p) => s + (p ? p.salary : 0), 0);

  // Count batters already locked in requiredSlots per team
  const teamBatterCounts = {};
  requiredSlots.forEach(p => {
    if (p && !rp(p, 'P')) teamBatterCounts[p.team] = (teamBatterCounts[p.team] || 0) + 1;
  });

  for (const sp of stackPlayers) {
    // Enforce 5-batter-per-team cap for batters in the stack
    if (!rp(sp, 'P')) {
      if ((teamBatterCounts[sp.team] || 0) >= 5) return false;
    }
    let placed = false;
    for (let i = 0; i < ROSTER_SIZE; i++) {
      if (tempLu[i]) continue;
      if (!DK_SLOTS[i].eligible(sp)) continue;
      tempLu[i] = sp; stackSalary += sp.salary; placed = true; break;
    }
    if (!placed) return false;
    if (!rp(sp, 'P')) teamBatterCounts[sp.team] = (teamBatterCounts[sp.team] || 0) + 1;
  }
  // Use a realistic per-slot minimum ($3,500) rather than the absolute floor
  // so stacks that would leave no budget for quality fillers are rejected
  const openCount = tempLu.filter(p => !p).length;
  if (stackSalary + openCount * 3500 > SALARY_CAP) return false;
  for (let i = 0; i < ROSTER_SIZE; i++) { if (tempLu[i] !== requiredSlots[i]) requiredSlots[i] = tempLu[i]; }
  return true;
}

async function buildPortfolio(pool, opts = {}, onProgress = null) {
  const {
    numLineups = 20,
    maxExposure = 0.60,
    maxExposurePitcher = 0.60,
    contestType = 'gpp',
    contestSize = 1000,
    stacks3 = [],
    stacks5 = [],
    maxOverlap = 7,        // max players shared between any two lineups (0 = disabled)
    lockedTeams = [],      // teams whose stacks are prioritised every lineup
    bannedTeams = [],      // teams fully excluded from the portfolio
    allowBvP = false,      // if false, pitcher and opposing batters cannot share a lineup
    playerOverrides = {},  // { playerName: { min: 0-1, max: 0-1 } } per-player exposure bounds
    stackPct5 = null,      // % of lineups that should target a 5-man stack (null = auto)
    stackSize = null,      // 3 | 4 | 5 | null — forces all lineups to use this stack size; overrides stackPct5
    teamExposureOverrides = {}, // { teamName: { min: 0-1, max: 0-1 } } per-team stack exposure bounds
    context = {},
    iterations = 5000
  } = opts;

  // Pre-compute stack targeting counts.
  // stackSize takes priority over stackPct5:
  //   stackSize=3 → all 3-man, stackSize=5 → all 5-man, stackSize=4 → auto-synth 4-man
  let target5ManCount;
  if (stackSize === 5) {
    target5ManCount = numLineups;
  } else if (stackSize === 3) {
    target5ManCount = 0;
  } else if (stackSize === 4) {
    target5ManCount = null; // 4-man handled via autoStacks4 pool below
  } else {
    target5ManCount = stackPct5 != null ? Math.round(numLineups * stackPct5 / 100) : null;
  }
  let lineups5ManCount = 0;

  // Pre-compute banned player set — stays constant for the entire portfolio
  const bannedNames = new Set(
    pool.filter(p => bannedTeams.includes(p.team)).map(p => p.name)
  );
  // Also filter stacks that belong to banned teams
  const allowedStacks3 = stacks3.filter(s => !bannedTeams.includes(s.team));
  const allowedStacks5 = stacks5.filter(s => !bannedTeams.includes(s.team));

  // When stackSize=4, synthesize 4-man virtual stacks from pool and use exclusively.
  // For stackSize=3/5, auto-synth is used only as fallback (virtual stack path in generateGppLineup).
  const autoStacks4 = stackSize === 4 ? buildAutoStacks(pool, 4).filter(s => !bannedTeams.includes(s.team)) : [];

  // Effective stacks passed to generateGppLineup
  const effectiveStacks3 = stackSize === 4 ? autoStacks4 : allowedStacks3;
  const effectiveStacks5 = stackSize === 4 ? []           : allowedStacks5;

  const totalAvailableStacks = effectiveStacks3.length + effectiveStacks5.length;

  // Track which locked teams have no stacks file entry so we can flag them
  const virtualStackTeams = new Set();
  lockedTeams.forEach(t => {
    const hasStack = [...allowedStacks3, ...allowedStacks5].some(s => s.team === t);
    if (!hasStack) virtualStackTeams.add(t);
  });

  const lineups = [];
  const exposureCounts = {};
  const usedStackIds = new Set();
  // Tracks how many accepted lineups contain a 3+ batter stack per team
  const teamStackCounts = {};

  // Fix 4: playerName -> Set<lineupIndex> for O(players) overlap checking
  const playerLineupIndex = new Map();

  // Fix 2: Round-robin index for locked teams — only advances on accepted lineups
  let lockedTeamIdx = 0;

  // Fix 1: Loop until numLineups valid lineups are built, with a safety cap on attempts
  const maxAttempts = numLineups * 5;
  let attempts = 0;

  while (lineups.length < numLineups && attempts < maxAttempts) {
    attempts++;

    // Build exclusion set: banned + over-exposed players (respecting per-player max overrides)
    const excludeOverExposed = new Set(bannedNames);
    if (lineups.length > 0) {
      pool.forEach(p => {
        const ov = playerOverrides[p.name];
        const threshold = ov?.max != null ? ov.max : (rp(p, 'P') ? maxExposurePitcher : maxExposure);
        const exposure = (exposureCounts[p.name] || 0) / lineups.length;
        if (exposure >= threshold) excludeOverExposed.add(p.name);
      });
    }

    // Build set of teams whose stack exposure has hit its max — exclude them from stacking.
    // Also build set of teams whose min exposure requires them to be stacked now.
    const bannedStackTeams = new Set();
    const forcedStackTeams = new Set();
    if (Object.keys(teamExposureOverrides).length) {
      const remaining = numLineups - lineups.length;
      for (const [team, ov] of Object.entries(teamExposureOverrides)) {
        const count = teamStackCounts[team] || 0;

        if (ov.max != null) {
          // Hard cap: compute the absolute max lineup count, not a running ratio.
          // Running ratio (count / lineups.length) fires too early — 1/2 = 50% bans a
          // team immediately even if the cap is 30% of 20 lineups = 6 total.
          const hardMax = Math.floor(numLineups * ov.max);
          if (count >= hardMax) {
            bannedStackTeams.add(team);
            // Also exclude individual players from this team so the optimizer can't
            // accidentally create a natural 3-batter cluster that bypasses the ban.
            pool.forEach(p => { if (p.team === team && !rp(p, 'P')) excludeOverExposed.add(p.name); });
          }
        }

        if (ov.min != null) {
          const targetCount = Math.ceil(numLineups * ov.min);
          if (targetCount - count >= remaining) forcedStackTeams.add(team);
        }
      }
    }

    // Build force-include set: players whose min exposure won't be met unless included now.
    // Fix 6: remaining is based on valid lineups still needed (not total attempts made),
    // so the threshold triggers correctly regardless of how many attempts were discarded.
    const forceNames = new Set();
    if (Object.keys(playerOverrides).length) {
      const remaining = numLineups - lineups.length;
      pool.forEach(p => {
        const ov = playerOverrides[p.name];
        if (!ov?.min) return;
        const targetCount = Math.ceil(numLineups * ov.min);
        const currentCount = exposureCounts[p.name] || 0;
        if (targetCount - currentCount >= remaining) {
          forceNames.add(p.name);
          excludeOverExposed.delete(p.name); // can't exclude a forced player
        }
      });
    }

    // Fix 7: prefer5Man is based on accepted lineup count, so discarded attempts don't
    // consume stack variety — the engine keeps targeting 5-man stacks until the quota
    // of accepted lineups with 5-man stacks is actually met.
    let prefer5Man = null;
    if (target5ManCount != null) {
      prefer5Man = lineups5ManCount < target5ManCount;
    }

    let lu;
    if (contestType === 'cash') {
      lu = generateCashLineup(pool, excludeOverExposed, context, iterations, allowBvP, forceNames);
    } else if (contestType === 'single') {
      lu = generateSingleLineup(pool, excludeOverExposed, context, iterations, allowBvP, forceNames);
    } else {
      // Fix 2: Read current locked team before any advance; only advance on acceptance
      const targetLockedTeam = lockedTeams.length > 0
        ? lockedTeams[lockedTeamIdx % lockedTeams.length]
        : null;

      // Fix 3: Recycle stack IDs when all available stacks have been used, so large
      // portfolios maintain stack correlation structure throughout all lineups.
      if (totalAvailableStacks > 0 && usedStackIds.size >= totalAvailableStacks) {
        usedStackIds.clear();
      }

      // Fix 7: Pass a snapshot of usedStackIds so IDs are only committed when the
      // lineup is actually accepted — discarded lineups don't consume stack slots.
      const pendingStackIds = new Set(usedStackIds);

      lu = generateGppLineup(
        pool, excludeOverExposed, context,
        effectiveStacks3, effectiveStacks5, pendingStackIds,
        iterations, contestSize,
        targetLockedTeam, pool, allowBvP, forceNames, prefer5Man,
        bannedStackTeams, forcedStackTeams, stackSize
      );

      // Fix 7: Commit pending stack IDs when lineup is accepted
      if (lu) {
        for (const id of pendingStackIds) {
          if (!usedStackIds.has(id)) usedStackIds.add(id);
        }
      }
    }

    if (lu && lu.every(Boolean)) {
      // Fix 4: Check maxOverlap via the player index — O(players) instead of O(lineups²)
      const luNames = new Set(lu.filter(Boolean).map(p => p.name));
      let tooSimilar = false;
      if (maxOverlap > 0 && lineups.length > 0) {
        const overlapCounts = new Map();
        for (const name of luNames) {
          const indices = playerLineupIndex.get(name);
          if (!indices) continue;
          for (const luIdx of indices) {
            const c = (overlapCounts.get(luIdx) || 0) + 1;
            if (c > maxOverlap) { tooSimilar = true; break; }
            overlapCounts.set(luIdx, c);
          }
          if (tooSimilar) break;
        }
      }
      if (!tooSimilar) {
        const acceptedIdx = lineups.length;
        lineups.push(lu);
        lu.forEach(p => {
          exposureCounts[p.name] = (exposureCounts[p.name] || 0) + 1;
          // Fix 4: Maintain player→lineup index for future overlap checks
          if (!playerLineupIndex.has(p.name)) playerLineupIndex.set(p.name, new Set());
          playerLineupIndex.get(p.name).add(acceptedIdx);
        });
        // Fix 2: Advance locked-team round-robin only when a GPP lineup is accepted
        if (contestType !== 'cash' && contestType !== 'single' && lockedTeams.length > 0) lockedTeamIdx++;
        // Track 5-man stack usage and per-team stack counts
        const teamCts = {};
        lu.forEach(p => { if (!rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
        if (target5ManCount != null && Object.values(teamCts).some(c => c >= 5)) lineups5ManCount++;
        Object.entries(teamCts).forEach(([team, c]) => {
          if (c >= 3) teamStackCounts[team] = (teamStackCounts[team] || 0) + 1;
        });
      }
    }

    // Yield to browser each attempt to prevent "Page Unresponsive"
    if (onProgress) onProgress(attempts, maxAttempts, lineups.length);
    await new Promise(r => setTimeout(r, 0));
  }

  // Calculate portfolio stats
  const playerExposure = {};
  pool.forEach(p => {
    if (exposureCounts[p.name]) {
      playerExposure[p.name] = {
        count: exposureCounts[p.name],
        pct: (exposureCounts[p.name] / lineups.length * 100).toFixed(1),
        isPitcher: rp(p, 'P')
      };
    }
  });

  const teamExposure = {};
  lineups.forEach(lu => {
    const teams = {};
    lu.forEach(p => {
      if (!rp(p, 'P')) teams[p.team] = (teams[p.team] || 0) + 1;
    });
    Object.entries(teams).forEach(([team, count]) => {
      if (count >= 3) teamExposure[team] = (teamExposure[team] || 0) + 1;
    });
  });

  // Pitcher exposure warning: flag if any pitcher exceeded their cap
  const pitcherWarnings = [];
  const pitchers = pool.filter(p => rp(p, 'P') && exposureCounts[p.name]);
  pitchers.forEach(p => {
    const actualPct = exposureCounts[p.name] / lineups.length;
    if (actualPct > maxExposurePitcher + 0.05) {
      pitcherWarnings.push({ name: p.name, pct: (actualPct * 100).toFixed(0) });
    }
  });

  // Team exposure warning: flag teams that exceeded their override cap
  const teamExposureWarnings = [];
  if (lineups.length > 0) {
    for (const [team, ov] of Object.entries(teamExposureOverrides)) {
      const count = teamStackCounts[team] || 0;
      const actualPct = count / lineups.length;
      if (ov.max != null && actualPct > ov.max + 0.05) {
        teamExposureWarnings.push({ team, pct: (actualPct * 100).toFixed(0), cap: (ov.max * 100).toFixed(0) });
      }
    }
  }

  return {
    lineups, playerExposure, teamExposure, teamStackCounts,
    totalLineups: lineups.length,
    virtualStackTeams: [...virtualStackTeams],
    pitcherWarnings, teamExposureWarnings,
    bannedTeams, lockedTeams,
    diversity: computePortfolioDiversity(lineups)
  };
}

function generateCashLineup(pool, excludeNames, context, iterations, allowBvP = false, forceInclude = new Set()) {
  const scoreFn = p => scoreCash(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations, allowBvP, forceInclude, contestType: 'cash' });
}

function generateSingleLineup(pool, excludeNames, context, iterations, allowBvP = false, forceInclude = new Set()) {
  const scoreFn = p => scoreSingle(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations, allowBvP, forceInclude, contestType: 'single' });
}

// lockedTeam: if set, this team's stack must be used for this lineup.
// fullPool: the unfiltered pool used for virtual stack synthesis (may differ from pool after exclusions).
function generateGppLineup(pool, excludeNames, context, stacks3, stacks5, usedStackIds, iterations, contestSize, lockedTeam, fullPool, allowBvP = false, forceInclude = new Set(), prefer5Man = null, bannedStackTeams = new Set(), forcedStackTeams = new Set(), stackSize = null) {
  const requiredSlots = new Array(ROSTER_SIZE).fill(null);
  let usedStackTeam = null;

  // Build ordered candidate stacks. prefer5Man: true = favor 5-man, false = favor 3-man, null = auto.
  // Sort by: (proj * impliedTotal/4.5) - own*0.3 — teams in high run environments rank higher.
  const vegasData = context?.vegasData || {};
  const minImpliedTotal = context?.minImpliedTotal || 0;
  const stackImplied = team => vegasData[team]?.impliedTotal || 4.5;
  const sortByValue = (a, b) => {
    const scoreA = a.proj * (stackImplied(a.team) / 4.5) - (a.own || 0) * 0.3;
    const scoreB = b.proj * (stackImplied(b.team) / 4.5) - (b.own || 0) * 0.3;
    return scoreB - scoreA;
  };
  // Multi-factor game-environment gate for stack selection.
  // Separates "good run environment" from "popular stack" to enable contrarian stacking.
  const hasVegas = Object.keys(vegasData).length > 0;
  const minGameTotal = context?.minGameTotal || 0;
  const maxOppK9 = context?.maxOppK9 || 0;
  const weatherData = context?.weatherData || {};
  const stadiums = context?.stadiums || {};
  const envPool = context?.pool || pool;
  const blockNegWeather = context?.blockNegWeather || false;

  const passesEnvironment = team => {
    // 1. Implied team total
    if (hasVegas && minImpliedTotal > 0) {
      const it = vegasData[team]?.impliedTotal;
      if (it != null && it < minImpliedTotal) return false;
    }
    // 2. Game O/U
    if (hasVegas && minGameTotal > 0) {
      const gt = vegasData[team]?.gameTotal;
      if (gt != null && gt < minGameTotal) return false;
    }
    // 3. Opposing SP K/9 — skip stacking against elite strikeout pitchers
    if (maxOppK9 > 0) {
      const oppSP = envPool.find(p => rp(p, 'P') && p.team !== team && p.opp === team && (p.kRate || p.kPer9 || 0) > 0);
      if (oppSP) {
        const k9 = oppSP.kPer9 || oppSP.kRate || 0;
        if (k9 > maxOppK9) return false;
      }
    }
    // 4. Negative weather — skip if rain risk ≥ 50% or dome (never blocked)
    if (blockNegWeather) {
      const homeTeam = vegasData[team]?.home ? team : (vegasData[team]?.opponent || null);
      if (homeTeam && !stadiums?.domes?.includes(homeTeam)) {
        const w = weatherData[homeTeam];
        if (w && (w.precip_chance || 0) >= 50) return false;
      }
    }
    return true;
  };
  const buildCandidates = () => {
    // Filter out stacks for teams that have hit their exposure max or are below min implied total
    const avail5 = stacks5.filter(s => s.proj > 0 && !usedStackIds.has(s.id) && !bannedStackTeams.has(s.team) && passesEnvironment(s.team)).sort(sortByValue);
    const avail3 = stacks3.filter(s => s.proj > 0 && !usedStackIds.has(s.id) && !bannedStackTeams.has(s.team) && passesEnvironment(s.team)).sort(sortByValue);
    // Primary pool gets the first 7 slots in candidate list; secondary fills the rest
    const primary = prefer5Man === false ? avail3 : avail5;
    const secondary = prefer5Man === false ? avail5 : avail3;
    const allAvail = [...primary, ...secondary];

    // If any teams need to hit their min, force one of them as the target
    const forcedTeam = lockedTeam || (forcedStackTeams.size > 0 ? [...forcedStackTeams][0] : null);

    if (forcedTeam) {
      const forTeam = allAvail.filter(s => s.team === forcedTeam);
      const others = allAvail.filter(s => s.team !== forcedTeam).slice(0, 6);
      for (let i = forTeam.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [forTeam[i], forTeam[j]] = [forTeam[j], forTeam[i]];
      }
      return [...forTeam, ...others];
    }
    const top = [...primary.slice(0, 7), ...secondary.slice(0, 5)];
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j], top[i]];
    }
    return top;
  };

  const candidates = (stacks5.length > 0 || stacks3.length > 0) ? buildCandidates() : [];

  for (const stack of candidates) {
    const stackPlayers = stack.players
      .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase() && !excludeNames.has(p.name)))
      .filter(Boolean);
    if (stackPlayers.length < Math.min(3, stack.players.length)) continue;

    const tempSlots = new Array(ROSTER_SIZE).fill(null);
    if (tryPlaceStack(stackPlayers, tempSlots, pool)) {
      for (let i = 0; i < ROSTER_SIZE; i++) { if (tempSlots[i]) requiredSlots[i] = tempSlots[i]; }
      usedStackTeam = stack.team;
      if (!stack.isVirtual) usedStackIds.add(stack.id);
      break;
    }
  }

  // If a locked/forced team was requested but no stack was placed yet, build a virtual stack
  const requiredTeam = lockedTeam || (forcedStackTeams.size > 0 && !usedStackTeam ? [...forcedStackTeams][0] : null);
  if (requiredTeam && !usedStackTeam) {
    const lockedTeam = requiredTeam; // shadow for the block below
    const srcPool = fullPool || pool;
    const virtual = buildVirtualStack(lockedTeam, srcPool, excludeNames, stackSize || 3);
    if (virtual) {
      const stackPlayers = virtual.players
        .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase() && !excludeNames.has(p.name)))
        .filter(Boolean);
      if (stackPlayers.length >= 2) {
        const tempSlots = new Array(ROSTER_SIZE).fill(null);
        if (tryPlaceStack(stackPlayers, tempSlots, pool)) {
          for (let i = 0; i < ROSTER_SIZE; i++) { if (tempSlots[i]) requiredSlots[i] = tempSlots[i]; }
          usedStackTeam = lockedTeam;
        }
      }
    }
  }

  const scoreFn = p => scoreGpp(p, { ...context, pool, contestSize });
  const stackBonusFn = lu => gppStackBonus(lu, usedStackTeam);

  return optimizeLineup(pool, scoreFn, { excludeNames, requiredSlots, iterations, stackBonusFn, allowBvP, forceInclude, contestType: 'gpp' });
}

// ── Lineup Analysis ─────────────────────────────────────────────────────────

function analyzeLineup(lineup) {
  const players = lineup.filter(Boolean);
  if (!players.length) return null;

  const salary = players.reduce((s, p) => s + p.salary, 0);
  const medianPts = players.reduce((s, p) => s + (p.median || 0), 0);
  const ceilingPts = players.reduce((s, p) => s + (p.ceiling || 0), 0);
  const floorPts = players.reduce((s, p) => s + (p.floor || 0), 0);
  const totalOwn = players.reduce((s, p) => s + (p.own || 0), 0);

  // Stack detection
  const teamCounts = {};
  players.forEach(p => {
    if (!rp(p, 'P')) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
  });
  const stacks = Object.entries(teamCounts).filter(([, c]) => c >= 3);

  // Bring-back detection
  const stackTeams = stacks.map(([t]) => t);
  const bringBacks = players.filter(p =>
    !rp(p, 'P') && !stackTeams.includes(p.team) &&
    players.some(sp => stackTeams.includes(sp.team) && sp.opp === p.team)
  );

  // Correlation score
  const corrMatrix = buildCorrelationMatrix(players);
  const corrScore = calcCorrelationScore(corrMatrix);

  // Batting order quality
  const orderPlayers = players.filter(p => !rp(p, 'P') && p.order > 0);
  const avgOrder = orderPlayers.length > 0
    ? orderPlayers.reduce((s, p) => s + p.order, 0) / orderPlayers.length : 0;

  return {
    salary, medianPts, ceilingPts, floorPts, totalOwn,
    stacks: stacks.map(([t, c]) => ({ team: t, count: c })),
    bringBacks: bringBacks.map(p => ({ name: p.name, team: p.team })),
    correlationScore: corrScore,
    avgBattingOrder: avgOrder,
    salaryEfficiency: (medianPts / salary * 1000).toFixed(2),
    filledSlots: players.length,
    uniqueTeams: [...new Set(players.map(p => p.team))].length,
    uniqueGames: [...new Set(players.map(p => p.game).filter(Boolean))].length
  };
}

// ── Calibration System ──────────────────────────────────────────────────────

// Stored calibration factors — applied to player projections before optimization
let _calibration = { pitcherScale: 1.0, batterScale: 1.0 };

function setCalibration(cal) {
  _calibration = { pitcherScale: 1.0, batterScale: 1.0, ...(cal || {}) };
}

function getCalibration() {
  return { ..._calibration };
}

// Returns a new pool array with projections scaled by calibration factors.
// If both scales are 1.0 returns the original array unchanged (no allocation).
function calibratePool(pool) {
  const { pitcherScale = 1.0, batterScale = 1.0 } = _calibration;
  if (pitcherScale === 1.0 && batterScale === 1.0) return pool;
  return pool.map(p => {
    const scale = rp(p, 'P') ? pitcherScale : batterScale;
    if (scale === 1.0) return p;
    return {
      ...p,
      floor: parseFloat(((p.floor || 0) * scale).toFixed(2)),
      median: parseFloat(((p.median || 0) * scale).toFixed(2)),
      ceiling: parseFloat(((p.ceiling || 0) * scale).toFixed(2))
    };
  });
}

// ── Umpire Multiplier ───────────────────────────────────────────────────────

// tendency.score: -2 (batter-friendly) to +2 (pitcher-friendly)
// For pitchers: positive score = more Ks = ceiling boost
// For batters:  positive score = tighter zone = slight penalty to floor/median
function umpireMultiplier(umpireTendency, isP) {
  if (!umpireTendency || umpireTendency.score === undefined) return 1.0;
  const score = umpireTendency.score; // -2 to +2
  if (isP) {
    // Pitcher ceiling boost: +2 score → +8%, -2 score → -8%
    return 1.0 + score * 0.04;
  } else {
    // Batter: inverse — tight zone (positive) slightly hurts, generous zone helps
    return 1.0 - score * 0.02;
  }
}

// ── Wind Direction Model (park-orientation-aware) ───────────────────────────

function weatherMultiplierDirectional(weather, windEffect) {
  const base = weatherMultiplier(weather);
  if (windEffect === undefined || windEffect === null) return base;
  const wind = weather.wind_mph || 5;
  const windStrength = Math.min(wind / 20, 1);
  const directionalBonus = windEffect * windStrength * 0.06;
  return {
    ...base,
    hitting: Math.max(0.85, base.hitting + directionalBonus),
    pitching: Math.max(0.85, base.pitching - directionalBonus),
    windLabel: windEffect > 0.3 ? 'Wind Out' : windEffect < -0.3 ? 'Wind In' : 'Neutral',
    windEffect
  };
}

// ── Statcast Scoring Boost ─────────────────────────────────────────────────

function statcastCeilingBoost(player) {
  if (!player.barrelRate && !player.hardHitRate) return 1.0;
  let boost = 1.0;
  const br = player.barrelRate || 0;
  const hh = player.hardHitRate || 0;
  const xw = player.xwOBA || 0;

  if (br >= 12) boost += 0.10;
  else if (br >= 8) boost += 0.05;
  else if (br >= 5) boost += 0.02;
  else if (br > 0 && br < 4) boost -= 0.03;

  if (hh >= 50) boost += 0.05;
  else if (hh >= 42) boost += 0.02;
  else if (hh > 0 && hh < 30) boost -= 0.03;

  if (xw >= 0.390) boost += 0.05;
  else if (xw >= 0.340) boost += 0.02;
  else if (xw > 0 && xw < 0.290) boost -= 0.03;

  return Math.max(0.85, Math.min(1.25, boost));
}

// ── Pitcher Stuff Model (Statcast-based) ──────────────────────────────────

function pitcherStuffBoost(player) {
  // Requires at least one pitcher Statcast metric
  if (!player.whiffRate && !player.fastballVelo && !player.xERA) return 1.0;
  let boost = 1.0;
  const whiff = player.whiffRate || 0;   // league avg ~23-25%
  const velo  = player.fastballVelo || 0; // league avg ~93-94 mph
  const hh    = player.hardHitRate || 0;  // league avg ~38-40% (lower = better for pitcher)
  const xera  = player.xERA || 0;         // league avg ~4.00

  // Whiff rate: dominant swing-and-miss stuff (biggest DFS K driver)
  if (whiff >= 30) boost += 0.10;         // elite (Skubal, deGrom tier)
  else if (whiff >= 26) boost += 0.06;    // plus (Cease, Crochet)
  else if (whiff >= 23) boost += 0.02;    // avg
  else if (whiff > 0 && whiff < 18) boost -= 0.05; // poor contact pitcher

  // Fastball velocity: raw stuff indicator
  if (velo >= 96) boost += 0.06;          // elite velo
  else if (velo >= 94) boost += 0.03;     // above avg
  else if (velo >= 92) boost += 0.01;     // avg
  else if (velo > 0 && velo < 90) boost -= 0.04; // soft-tosser penalty

  // Hard hit rate against: quality of contact allowed (lower = better)
  if (hh > 0 && hh <= 33) boost += 0.06; // elite contact suppression
  else if (hh <= 38) boost += 0.03;       // above avg
  else if (hh >= 46) boost -= 0.05;       // gets hit hard
  else if (hh >= 42) boost -= 0.02;       // below avg

  // xERA: Statcast expected ERA (comprehensive quality metric)
  if (xera > 0 && xera <= 3.20) boost += 0.06;  // ace tier
  else if (xera <= 3.70) boost += 0.03;          // solid
  else if (xera >= 4.80) boost -= 0.05;          // hittable
  else if (xera >= 4.30) boost -= 0.02;          // below avg

  return Math.max(0.85, Math.min(1.25, boost));
}

// ── Bullpen Quality Adjustment ────────────────────────────────────────────

function bullpenAdjustment(player, bullpenData) {
  if (!bullpenData) return 1.0;
  const isP = rp(player, 'P');

  if (isP) {
    // Pitcher: own team's bullpen quality affects win probability / QS hold
    // Strong bullpen behind you = leads are protected = more Ws
    const own = bullpenData[player.team];
    if (!own || !own.era) return 1.0;
    // League avg bullpen ERA ~4.00; lower = better
    const diff = 4.00 - own.era;
    // ±3% max: strong pen (+3%), weak pen (-3%)
    return 1.0 + Math.max(-0.03, Math.min(0.03, diff * 0.02));
  }

  // Batter: opposing team's bullpen quality affects late-inning upside
  // Weak opposing bullpen = more runs in 6th-9th innings = ceiling boost
  const opp = bullpenData[player.opp];
  if (!opp || !opp.era) return 1.0;
  // Higher ERA = weaker pen = better for batters
  const diff = opp.era - 4.00;
  // Weak pen boost factors: ERA + WHIP + low K rate
  let adj = diff * 0.015; // ERA component
  if (opp.whip > 1.40) adj += 0.01;       // very leaky pen
  else if (opp.whip < 1.10) adj -= 0.01;  // tight pen
  if (opp.kPer9 < 7.5) adj += 0.01;       // pen can't miss bats
  else if (opp.kPer9 > 10.0) adj -= 0.01; // dominant pen
  // ±5% max
  return 1.0 + Math.max(-0.05, Math.min(0.05, adj));
}

// ── Catcher Framing Adjustment ──────────────────────────────────────────────
// framingMap = { teamAbbr: { framingRunsPerGame } } — built from pool catchers
// Good framing catcher → pitcher boost (more called strikes) / batter penalty
// Bad framing catcher → pitcher penalty / batter boost

function catcherFramingAdjustment(player, framingMap) {
  if (!framingMap) return 1.0;
  const isP = rp(player, 'P');

  if (isP) {
    // Pitcher benefits from own team's good framing catcher
    const own = framingMap[player.team];
    if (!own) return 1.0;
    // framingRunsPerGame ranges ~-0.18 to +0.39
    // Scale: ±3% max for elite/terrible framers
    return 1.0 + Math.max(-0.03, Math.min(0.03, own.framingRunsPerGame * 0.08));
  }

  // Batter: opposing catcher's framing hurts (good framer = more called K's)
  const opp = framingMap[player.opp];
  if (!opp) return 1.0;
  // Good opposing framer → penalty for batter; bad framer → boost
  return 1.0 - Math.max(-0.02, Math.min(0.02, opp.framingRunsPerGame * 0.06));
}

// ── Sprint Speed Boost ──────────────────────────────────────────────────────
// Batter-only: fast runners have SB upside (1 DK point per SB) and extra
// value on singles/doubles (advancing extra bases, beating out infield hits).
// sprintSpeedData = { normalizedName: { sprintSpeed, bolts } }
// League avg sprint speed ~27.0 ft/s. Bolts = runs ≥30 ft/s.

function sprintSpeedBoost(player, sprintSpeedData) {
  if (!sprintSpeedData) return 1.0;
  if (rp(player, 'P')) return 1.0;  // pitchers don't steal
  const key = (player.name || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const sd = sprintSpeedData[key];
  if (!sd || !sd.sprintSpeed) return 1.0;

  const speed = sd.sprintSpeed;
  // Tier system based on sprint speed (ft/s):
  //   Elite ≥30.0: +5% (Turner, Witt Jr — elite SB threats)
  //   Plus  ≥29.0: +3% (above-average runners)
  //   Above ≥28.0: +1.5%
  //   Avg   ≥27.0: 0% (neutral)
  //   Below ≥26.0: -1%
  //   Slow  <26.0: -2% (no SB upside, slow on bases)
  let boost = 0;
  if (speed >= 30.0) boost = 0.05;
  else if (speed >= 29.0) boost = 0.03;
  else if (speed >= 28.0) boost = 0.015;
  else if (speed >= 27.0) boost = 0;
  else if (speed >= 26.0) boost = -0.01;
  else boost = -0.02;

  return 1.0 + boost;
}

// ── Portfolio Overlap & Diversity ──────────────────────────────────────────

function calcPortfolioOverlap(lineups) {
  if (lineups.length < 2) return 0;
  let maxOverlap = 0;
  for (let i = 0; i < lineups.length; i++) {
    const namesI = new Set(lineups[i].filter(Boolean).map(p => p.name));
    for (let j = i + 1; j < lineups.length; j++) {
      const overlap = lineups[j].filter(p => p && namesI.has(p.name)).length;
      if (overlap > maxOverlap) maxOverlap = overlap;
    }
  }
  return maxOverlap;
}

// Full pairwise diversity stats.
// score: 0–100 where 100 = every lineup is completely unique
// distribution: { [sharedCount]: numPairs } histogram of all lineup pairs
function computePortfolioDiversity(lineups) {
  if (lineups.length < 2) return { avgOverlap: 0, maxOverlap: 0, score: 100, distribution: {}, pairs: 0 };

  const dist = {};
  let totalOverlap = 0;
  let maxOv = 0;
  let pairs = 0;

  for (let i = 0; i < lineups.length; i++) {
    const setA = new Set(lineups[i].filter(Boolean).map(p => p.name));
    for (let j = i + 1; j < lineups.length; j++) {
      let overlap = 0;
      for (const p of lineups[j]) if (p && setA.has(p.name)) overlap++;
      totalOverlap += overlap;
      if (overlap > maxOv) maxOv = overlap;
      dist[overlap] = (dist[overlap] || 0) + 1;
      pairs++;
    }
  }

  const avgOverlap = parseFloat((totalOverlap / pairs).toFixed(1));
  const score = Math.round(Math.max(0, (ROSTER_SIZE - avgOverlap) / ROSTER_SIZE * 100));
  return { avgOverlap, maxOverlap: maxOv, score, distribution: dist, pairs };
}

// ── Portfolio Simulation ─────────────────────────────────────────────────────

// Build a synthetic opponent lineup by sampling players from the pool
// weighted by their projected ownership (field proxy).
// Realistic GPP field lineups stack — pick a primary team and lock in 3 batters
// from that team first, then fill remaining slots with ownership-weighted picks.
function buildFieldLineup(pool) {
  const batters = pool.filter(p => !rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  const pitchers = pool.filter(p => rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  if (!batters.length || !pitchers.length) return null;

  const lu = new Array(ROSTER_SIZE).fill(null);
  const usedNames = new Set();

  // Ownership-weighted random pick from a candidate set
  const pickWeighted = (candidates) => {
    const totalOwn = candidates.reduce((s, p) => s + (p.own || 1), 0);
    let r = Math.random() * totalOwn;
    for (const p of candidates) {
      r -= (p.own || 1);
      if (r <= 0) return p;
    }
    return candidates[candidates.length - 1];
  };

  // Pick a primary stack team — weight teams by total ownership of their batters.
  // This mirrors how GPP field constructs: high-own teams get stacked more often.
  const teamOwn = {};
  batters.forEach(p => { teamOwn[p.team] = (teamOwn[p.team] || 0) + (p.own || 1); });
  const teams = Object.keys(teamOwn);
  const totalTeamOwn = teams.reduce((s, t) => s + teamOwn[t], 0);
  let r = Math.random() * totalTeamOwn;
  let stackTeam = teams[teams.length - 1];
  for (const t of teams) { r -= teamOwn[t]; if (r <= 0) { stackTeam = t; break; } }

  // Attempt to fill 3 batter slots from the stack team first
  const stackBatters = batters.filter(p => p.team === stackTeam);
  let stackFilled = 0;
  // Shuffle stack team batters by ownership so we don't always pick the same ones
  const shuffledStack = stackBatters.slice().sort(() => Math.random() - 0.5 + (Math.random() > 0.5 ? 0.2 : -0.2));
  for (let i = 2; i < ROSTER_SIZE && stackFilled < 3; i++) {
    const slot = DK_SLOTS[i];
    const eligible = shuffledStack.filter(p => !usedNames.has(p.name) && slot.eligible(p));
    if (!eligible.length) continue;
    const pick = pickWeighted(eligible);
    lu[i] = pick; usedNames.add(pick.name); stackFilled++;
  }

  // Fill pitchers first (slots 0,1)
  for (let i = 0; i < 2; i++) {
    if (lu[i]) continue;
    const cands = pitchers.filter(p => !usedNames.has(p.name));
    if (!cands.length) break;
    const pick = pickWeighted(cands);
    lu[i] = pick; usedNames.add(pick.name);
  }
  // Fill remaining empty batter slots with ownership-weighted picks
  for (let i = 2; i < ROSTER_SIZE; i++) {
    if (lu[i]) continue;
    const slot = DK_SLOTS[i];
    const cands = batters.filter(p => !usedNames.has(p.name) && slot.eligible(p));
    if (!cands.length) continue;
    const pick = pickWeighted(cands);
    lu[i] = pick; usedNames.add(pick.name);
  }
  return lu.every(Boolean) ? lu : null;
}

// Run per-lineup Monte Carlo across the full portfolio.
// Returns array of per-lineup stats sorted by simROI descending.
// fieldLineups: number of synthetic opponent lineups to simulate (field size proxy).
function simulatePortfolio(lineups, pool, numSims = 2000, contestType = 'gpp', manualCashLine = null, manualWinLine = null, payoutType = 'top20') {
  if (!lineups.length || !pool.length) return [];

  const isCash = contestType === 'cash';

  // Payout config: cashPct = fraction of field that cashes, payoutMultipliers for EV
  const payoutConfig = {
    top20:   { cashPct: 0.20, cashMult: 2.0,  winMult: 10, winPct: 0.005 },
    top10:   { cashPct: 0.10, cashMult: 3.0,  winMult: 15, winPct: 0.002 },
    winner:  { cashPct: 0.01, cashMult: 80.0, winMult: 80, winPct: 0.005 },
    double:  { cashPct: 0.50, cashMult: 1.9,  winMult: 1.9, winPct: 0.50 },
    custom:  { cashPct: 0.20, cashMult: 2.0,  winMult: 10, winPct: 0.005 },
  };
  const pc = (isCash ? { cashPct: 0.50, cashMult: 1.9, winMult: 1.9, winPct: 0.50 }
                     : (payoutConfig[payoutType] || payoutConfig.top20));

  const results = lineups.map(lu => {
    if (!lu || !lu.every(Boolean)) return null;
    const luSim = simulateLineup(lu, numSims);
    if (!luSim) return null;

    // Build field score distribution by running numSims field lineups
    // (re-use pool sampling, not full lineup build — fast approximation)
    const fieldScores = [];
    for (let s = 0; s < numSims; s++) {
      const fieldLu = buildFieldLineup(pool);
      if (!fieldLu) { fieldScores.push(0); continue; }
      let total = 0;
      fieldLu.forEach(p => { if (p) total += samplePlayerScore(p, 0); });
      fieldScores.push(total);
    }
    fieldScores.sort((a, b) => a - b);

    // Cash/win lines: use manual overrides if provided, otherwise derive from field distribution
    const cashCutoffIdx = Math.floor(fieldScores.length * (1 - pc.cashPct));
    const winCutoffIdx = Math.floor(fieldScores.length * (1 - pc.winPct));
    const cashLine = manualCashLine != null ? manualCashLine : (fieldScores[cashCutoffIdx] || 0);
    const winLine = manualWinLine != null ? manualWinLine : (fieldScores[winCutoffIdx] || 0);

    let cashCount = 0, winCount = 0;
    for (let s = 0; s < numSims; s++) {
      const ourScore = lu.reduce((sum, p) => sum + samplePlayerScore(p, 0), 0);
      if (ourScore >= cashLine) cashCount++;
      if (ourScore >= winLine) winCount++;
    }
    const cashRate = cashCount / numSims;
    const winRate = winCount / numSims;

    // Sim ROI using payout config: EV = (cash_rate × cash_mult + win_rate × win_mult) / 2 - 1
    // Divide by 2 to avoid double-counting cash bracket (cash includes win bracket)
    const simROI = (cashRate * pc.cashMult * 0.85 + winRate * pc.winMult * 0.15) - 1;

    return {
      lu,
      p10: luSim.p10,
      p50: luSim.p50,
      p90: luSim.p90,
      mean: luSim.mean,
      cashRate: parseFloat((cashRate * 100).toFixed(1)),
      winRate: parseFloat((winRate * 100).toFixed(2)),
      cashLine: parseFloat(cashLine.toFixed(1)),
      winLine: parseFloat(winLine.toFixed(1)),
      simROI: parseFloat((simROI * 100).toFixed(1))
    };
  }).filter(Boolean);

  results.sort((a, b) => b.simROI - a.simROI);
  return results;
}

// ── Public API ──────────────────────────────────────────────────────────────

return {
  // Constants
  SALARY_CAP, ROSTER_SIZE, MIN_SALARY_PER_SLOT, DK_SLOTS,
  rp,

  // Simulation
  simulateLineup,
  simulatePortfolio,
  samplePlayerScore,

  // Correlation
  getCorrelation,
  buildCorrelationMatrix,
  buildPairCorrelations,
  getPairCorrelation,
  setCorrScale, getCorrScale,
  setSimDiversity, getSimDiversity,

  // Scoring
  scoreCash, scoreSingle, scoreGpp,
  calcLeverage, calcGppScore,
  optimalExposureBoost,

  // Adjustments
  weatherMultiplier, weatherMultiplierDirectional, parkMultiplier,
  vegasAdjustment, vegasPitcherAdjustment,
  teamScoringAdjustment,
  statcastCeilingBoost, pitcherStuffBoost, bullpenAdjustment, catcherFramingAdjustment, sprintSpeedBoost, calcPortfolioOverlap, computePortfolioDiversity, umpireMultiplier,

  // Projection blending
  blendProjections,

  // Optimizer
  optimizeLineup, greedyFill,
  generateCashLineup, generateSingleLineup, generateGppLineup,
  gppStackBonus,

  // Portfolio
  buildPortfolio,

  // Multiplier introspection
  // Returns how far the compound adjustment pushes a player from their raw projection.
  // context = same object passed to scoreCash/scoreGpp (vegasData, parkFactors, etc.)
  // Returns { rawBatterMult, rawPitcherMult, isOver, deviation }
  // isOver = true when |rawMult - 1.0| > 0.25 (multipliers are dominating the projection)
  computeEffectiveMult(p, context = {}) {
    const pc = buildPlayerContext(p, context);
    const raw = pc.isP ? pc.rawPitcherMult : pc.rawBatterMult;
    const deviation = raw - 1.0;
    return {
      rawBatterMult:  parseFloat((pc.rawBatterMult  || 1.0).toFixed(4)),
      rawPitcherMult: parseFloat((pc.rawPitcherMult || 1.0).toFixed(4)),
      isOver: Math.abs(deviation) > 0.25,
      deviation: parseFloat(deviation.toFixed(4))
    };
  },

  // Analysis
  analyzeLineup,
  getPitcherMatchupScore,

  // Calibration
  setCalibration,
  getCalibration,
  calibratePool
};

})();
