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
    if (s.n < 5) continue; // require at least 5 co-appearances for reliability
    const num = s.n * s.sumXY - s.sumX * s.sumY;
    const den = Math.sqrt((s.n * s.sumXX - s.sumX ** 2) * (s.n * s.sumYY - s.sumY ** 2));
    if (den === 0) continue;
    result[key] = Math.max(-1, Math.min(1, num / den));
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

  return {
    mean, std, p10, p25, p50, p75, p90, p95, p99,
    min: results[0],
    max: results[numSims - 1],
    histogram: buildHistogram(results, 30),
    playerStats,
    numSims,
    correlationScore: calcCorrelationScore(corrMatrix)
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

// GPP Score: composite metric for tournament value
function calcGppScore(player, contestSize = 1000) {
  const ceiling = player.ceiling || 0;
  const own = player.own || 0;
  const median = player.median || 0;
  const salary = player.salary || 1;

  // Components
  const ceilingValue = ceiling * 1.3;
  const ownershipEdge = own > 0 ? (1 / (1 + own / 100 * Math.log10(contestSize))) : 1;
  const salaryValue = (ceiling / salary) * 1000 * 0.3;
  const upside = (ceiling - median) * 0.5;

  return (ceilingValue * ownershipEdge + salaryValue + upside);
}

// ── Platoon Split Adjustments ───────────────────────────────────────────────

// Returns multiplier for batter vs pitcher handedness matchup
function platoonMultiplier(batterHand, pitcherHand) {
  if (!batterHand || !pitcherHand) return 1.0;
  const bh = batterHand.toUpperCase().charAt(0);
  const ph = pitcherHand.toUpperCase().charAt(0);

  // Switch hitters get slight advantage
  if (bh === 'S' || bh === 'B') return 1.03;

  // Opposite hand = platoon advantage
  if (bh !== ph) return 1.08;

  // Same hand = platoon disadvantage
  return 0.92;
}

// Apply platoon adjustments to projections
function adjustForPlatoon(batter, pitcherHand) {
  if (rp(batter, 'P')) return batter; // Don't adjust pitchers
  const mult = platoonMultiplier(batter.hand, pitcherHand);
  return {
    ...batter,
    floor: batter.floor * mult,
    median: batter.median * mult,
    ceiling: batter.ceiling * mult,
    platoonAdj: mult
  };
}

// ── Weather Impact Adjustments ──────────────────────────────────────────────

function weatherMultiplier(weather) {
  if (!weather || weather.error) return { hitting: 1.0, pitching: 1.0, label: 'Unknown', risk: 'none' };

  let hitMult = 1.0, pitchMult = 1.0, label = '', risk = 'none';
  const temp = weather.temp_f || 72;
  const wind = weather.wind_mph || 5;
  const precip = weather.precip_chance || 0;

  // Temperature effect on hitting
  if (temp >= 85) { hitMult += 0.06; label = 'Hot'; }
  else if (temp >= 75) { hitMult += 0.03; label = 'Warm'; }
  else if (temp <= 50) { hitMult -= 0.06; label = 'Cold'; }
  else if (temp <= 60) { hitMult -= 0.03; label = 'Cool'; }
  else { label = 'Mild'; }

  // Wind effect (simplified - ideally need direction relative to park)
  if (wind >= 15) {
    hitMult += 0.04; // High wind generally increases scoring variance
    pitchMult -= 0.03;
    label += ' / Windy';
  } else if (wind >= 10) {
    hitMult += 0.02;
    label += ' / Breezy';
  }

  // Precipitation risk
  if (precip >= 50) {
    risk = 'high';
    label += ' / Rain Risk';
  } else if (precip >= 30) {
    risk = 'moderate';
    label += ' / Slight Rain';
  }

  // Pitcher adjustment (cold helps pitchers, hot hurts them)
  pitchMult = 2.0 - hitMult; // Inverse of hitting

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

  // Scale factor: if Vegas implies 5.5 runs vs 4.5 avg = 22% boost
  return impliedTotal / avgImplied;
}

function vegasPitcherAdjustment(pitcher, vegasData) {
  if (!vegasData || !pitcher.opp) return 1.0;

  const oppData = vegasData[pitcher.opp];
  if (!oppData || !oppData.impliedTotal) return 1.0;

  const oppImplied = oppData.impliedTotal;
  // Low opponent implied total = good for pitcher
  // If opp implied 3.5 vs avg 4.5 = pitcher gets boost
  return (9 - oppImplied) / 4.5; // Inverse scale
}

// ── Projection Blending ─────────────────────────────────────────────────────

// Blend multiple projection sources with configurable weights
function blendProjections(sources, weights) {
  // sources: array of { name, players: [{name, floor, median, ceiling, own}] }
  // weights: { sourceName: weight } (should sum to 1.0)
  const playerMap = {};

  sources.forEach((source, si) => {
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

// Optimal lineup exposure boost: rewards players that appear frequently in
// optimizer-generated lineups. Returns a multiplier (1.0 if no data).
// - Cash/Single: gentle boost (up to +10%) for high-exposure players
// - GPP: moderate boost (up to +12%) but tempered — optimizer consensus is
//   less valuable when seeking differentiation
function optimalExposureBoost(p, context, mode) {
  const { optimalExposure } = context;
  if (!optimalExposure || !Object.keys(optimalExposure).length) return 1.0;
  const exp = optimalExposure[p.name];
  // Players absent from optimal lineups get a minimal penalty — not enough to
  // wash out legitimate ceiling plays, just enough to break ties toward chalky picks.
  if (!exp) return 0.98;
  const pct = exp.pct; // 0-100
  if (mode === 'cash') {
    // Cash loves consensus plays — up to +10%
    return 1.0 + Math.min(pct / 100, 1.0) * 0.10;
  } else if (mode === 'single') {
    // Single entry: moderate signal — up to +8%
    return 1.0 + Math.min(pct / 100, 1.0) * 0.08;
  } else {
    // GPP: consensus is a weak signal — use gently as confirmation, not a driver.
    // Absent players get only -2%, preserving their ceiling upside for tournament play.
    return pct > 0 ? 1.0 + Math.min(pct / 100, 1.0) * 0.06 : 0.98;
  }
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
  const fmW = (blendWeights?.['Form (14d)'] ?? 100) / 100;
  const scBoost = isP ? (1.0 + (pitcherStuffBoost(p) - 1.0) * scW) : (1.0 + (statcastCeilingBoost(p) - 1.0) * scW);
  const fmBoost = 1.0 + (formMultiplier(p) - 1.0) * fmW;
  const umpTend = umpireData?.[homeTeam] || null;
  const umpBoost = umpireMultiplier(umpTend, isP);

  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && stadiums && homeTeam) {
    const isDome = stadiums.domes?.includes(homeTeam);
    if (!isDome) {
      const city = stadiums.cities?.[homeTeam];
      if (city && weatherData[city]) wm = weatherMultiplier(weatherData[city]);
    }
  }

  const platoon = p.platoonAdj || 1.0;
  // Common multiplier chain for batters and pitchers
  const batterMult = vegasAdj * pf.run * wm.hitting * platoon * tsAdj.batting * scBoost * fmBoost * umpBoost * bpAdj * cfAdj * ssBoost;
  const pitcherMult = vegasAdj * wm.pitching * tsAdj.pitching * scBoost * fmBoost * umpBoost * bpAdj * cfAdj * ssBoost;
  const hrMult = pf.hr; // GPP batters use hr park factor instead of run

  return { isP, homeTeam, pf, vegasAdj, wm, tsAdj, scBoost, fmBoost, umpBoost, bpAdj, cfAdj, ssBoost, platoon, batterMult, pitcherMult, hrMult };
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

  const orderBonus = p.order > 0 && p.order <= 4 ? (5 - p.order) * 1.5 : 0;
  const variance = (p.ceiling || 0) - (p.floor || 0);
  return ((p.median || 0) * 2.0 + (p.floor || 0) * 1.5 - variance * 0.3 + orderBonus)
    * pc.batterMult * optBoost;
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

  const orderBonus = p.order > 0 && p.order <= 5 ? (6 - p.order) * 0.8 : 0;
  return ((p.median || 0) * 1.2 + (p.ceiling || 0) * 0.6 + value * 0.4 + orderBonus)
    * pc.batterMult * optBoost;
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
  const orderBonus = p.order > 0 && p.order <= 5 ? (6 - p.order) * 0.5 : 0;
  return (gppScore + orderBonus) * pc.hrMult * pc.batterMult / pc.pf.run * optBoost;
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

// ── Enhanced Optimizer ──────────────────────────────────────────────────────

function optimizeLineup(pool, scoreFn, opts = {}) {
  const {
    excludeNames = new Set(),
    requiredSlots = new Array(ROSTER_SIZE).fill(null),
    iterations = 5000,
    stackBonusFn = null,
    exposureLimits = null, // { playerName: maxPct }
    forceInclude = new Set(), // players that must appear in this lineup
    allowBvP = false,      // if false, pitcher and opposing batters cannot share a lineup
    maxBattersPerTeam = 5  // DK rule: max 5 batters from the same team
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

  const lockedNames = new Set();
  let lockedSalary = 0;
  effectiveRequired.forEach(p => {
    if (p) { lockedNames.add(p.name); lockedSalary += p.salary; }
  });

  // Build scored candidate pools per open slot (top 40 eligible per position)
  const candidatePools = DK_SLOTS.map((slot, i) => {
    if (effectiveRequired[i]) return null;
    return pool.filter(p =>
      slot.eligible(p) &&
      !excludeNames.has(p.name) &&
      !lockedNames.has(p.name) &&
      p.salary > 0 &&
      (p.median > 0 || p.ceiling > 0 || p.avgPpg > 0) &&
      (!exposureLimits || !exposureLimits[p.name] || exposureLimits[p.name] > 0)
    ).sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, 40);
  });

  // Fix 1: realistic per-slot reserve — use actual 5th-percentile salary per
  // position rather than the hard-coded $3k floor, so budget headroom is
  // calculated accurately and high-salary players aren't incorrectly filtered.
  const slotMinSalary = DK_SLOTS.map((slot, i) => {
    if (requiredSlots[i]) return 0;
    const eligible = candidatePools[i];
    if (!eligible || !eligible.length) return MIN_SALARY_PER_SLOT;
    const sorted = [...eligible].sort((a, b) => a.salary - b.salary);
    // Use the 10th-percentile salary so we reserve a realistic floor
    const idx = Math.max(0, Math.floor(sorted.length * 0.10));
    return sorted[idx].salary;
  });

  const openSlots = [];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    if (!effectiveRequired[i]) openSlots.push(i);
  }

  let bestLineup = null, bestScore = -Infinity;

  for (let iter = 0; iter < iterations; iter++) {
    const lu = [...effectiveRequired];
    const usedNames = new Set(lockedNames);
    let salaryUsed = lockedSalary, valid = true;

    // Shuffle open slot order
    const order = [...openSlots];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (let oi = 0; oi < order.length; oi++) {
      const si = order[oi];
      const cPool = candidatePools[si];
      if (!cPool || !cPool.length) { valid = false; break; }

      // Fix 1: sum realistic minimums for remaining slots instead of flat $3k
      let reserveForRemaining = 0;
      for (let ri = oi + 1; ri < order.length; ri++) {
        reserveForRemaining += slotMinSalary[order[ri]];
      }
      const budgetForThis = SALARY_CAP - salaryUsed - reserveForRemaining;

      // Dynamic BvP and team-stack constraints based on already-placed players
      const others = lu.filter(Boolean);

      const available = cPool.filter(p => {
        if (usedNames.has(p.name)) return false;
        if (p.salary > budgetForThis) return false;
        if (!validatePlacement(p, others, allowBvP, maxBattersPerTeam)) return false;
        return true;
      });
      if (!available.length) { valid = false; break; }

      // Fix 3: rank-weighted sampling — rank 1 is (topN)x more likely than
      // last rank, distributing probability as 1/rank so top picks win most
      // often while still allowing diversity across iterations.
      const topN = Math.min(available.length, 5 + Math.floor(Math.random() * 6));
      const topCands = available.slice(0, topN);
      const weights = topCands.map((_, k) => 1 / (k + 1));
      const totalW = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * totalW;
      let pick = topCands[topCands.length - 1];
      for (let k = 0; k < topCands.length; k++) {
        r -= weights[k];
        if (r <= 0) { pick = topCands[k]; break; }
      }

      lu[si] = pick;
      usedNames.add(pick.name);
      salaryUsed += pick.salary;
    }

    if (!valid || lu.some(p => !p)) continue;
    if (salaryUsed > SALARY_CAP) continue;

    let total = lu.reduce((s, p) => s + scoreFn(p), 0);
    // Fix 2: meaningful salary efficiency bonus — scales to ~15pts at full cap,
    // which is large enough to consistently prefer $49,800 over $46,000 when
    // player scores are otherwise equal, without overriding score differences.
    total += (salaryUsed / SALARY_CAP) * 15;
    if (stackBonusFn) total += stackBonusFn(lu);

    if (total > bestScore) { bestScore = total; bestLineup = [...lu]; }
  }

  const result = bestLineup || greedyFill(pool, scoreFn, excludeNames, effectiveRequired, allowBvP, maxBattersPerTeam);
  // Post-optimization salary upgrade: push any unused cap into better players
  return result ? upgradeSalary(result, pool, scoreFn, excludeNames, allowBvP, maxBattersPerTeam) : result;
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

// Build a virtual 3-man stack for a team from the player pool when no stacks
// file entry exists for that team. Picks top-3 batters by median score.
function buildVirtualStack(team, pool, excludeNames) {
  const batters = pool.filter(p =>
    p.team === team && !rp(p, 'P') &&
    !excludeNames.has(p.name) &&
    p.salary > 0 && (p.median > 0 || p.avgPpg > 0)
  ).sort((a, b) => (b.median || b.avgPpg || 0) - (a.median || a.avgPpg || 0));

  if (batters.length < 2) return null;
  const chosen = batters.slice(0, 3);
  return {
    id: 'virtual_' + team,
    players: chosen.map(p => p.name),
    team,
    proj: chosen.reduce((s, p) => s + (p.median || 0), 0),
    own: chosen.reduce((s, p) => s + (p.own || 0), 0) / chosen.length,
    isVirtual: true
  };
}

// Try to fit stack players into requiredSlots. Returns true on success.
// Pitchers in user-uploaded stacks are placed as pitchers only; batters from the
// same team are counted against the DK 5-batter-per-team limit.
function tryPlaceStack(stackPlayers, requiredSlots, pool) {
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

function buildPortfolio(pool, opts = {}) {
  const {
    numLineups = 20,
    maxExposure = 0.60,
    maxExposurePitcher = 0.60,
    contestType = 'gpp',
    contestSize = 1000,
    stacks3 = [],
    stacks5 = [],
    maxOverlap = 7,        // max players shared between any two lineups (0 = disabled)
    requireBringBack = false, // GPP: reject lineups without at least one bring-back batter
    lockedTeams = [],      // teams whose stacks are prioritised every lineup
    bannedTeams = [],      // teams fully excluded from the portfolio
    allowBvP = false,      // if false, pitcher and opposing batters cannot share a lineup
    playerOverrides = {},  // { playerName: { min: 0-1, max: 0-1 } } per-player exposure bounds
    stackPct5 = null,      // % of lineups that should target a 5-man stack (null = auto)
    context = {},
    iterations = 5000
  } = opts;

  // Pre-compute stack targeting counts
  const target5ManCount = stackPct5 != null ? Math.round(numLineups * stackPct5 / 100) : null;
  let lineups5ManCount = 0;

  // Pre-compute banned player set — stays constant for the entire portfolio
  const bannedNames = new Set(
    pool.filter(p => bannedTeams.includes(p.team)).map(p => p.name)
  );
  // Also filter stacks that belong to banned teams
  const allowedStacks3 = stacks3.filter(s => !bannedTeams.includes(s.team));
  const allowedStacks5 = stacks5.filter(s => !bannedTeams.includes(s.team));

  // Track which locked teams have no stacks file entry so we can flag them
  const virtualStackTeams = new Set();
  lockedTeams.forEach(t => {
    const hasStack = [...allowedStacks3, ...allowedStacks5].some(s => s.team === t);
    if (!hasStack) virtualStackTeams.add(t);
  });

  const lineups = [];
  const exposureCounts = {};
  const usedStackIds = new Set();

  // Round-robin index for cycling locked teams across lineups
  let lockedTeamIdx = 0;

  for (let i = 0; i < numLineups; i++) {
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

    // Build force-include set: players whose min exposure won't be met unless included now
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

    // Determine stack size preference for this lineup
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
      // Determine which locked team (if any) this lineup should feature
      const targetLockedTeam = lockedTeams.length > 0
        ? lockedTeams[lockedTeamIdx % lockedTeams.length]
        : null;
      if (lockedTeams.length > 0) lockedTeamIdx++;

      lu = generateGppLineup(
        pool, excludeOverExposed, context,
        allowedStacks3, allowedStacks5, usedStackIds,
        iterations, contestSize,
        targetLockedTeam, pool, allowBvP, forceNames, prefer5Man
      );

      // Hard bring-back enforcement: if required and lineup has a stack but no
      // bring-back batter, attempt to swap in the best available bring-back.
      // If no valid swap is found, null out the lineup so it is skipped entirely.
      if (lu && requireBringBack) {
        const players = lu.filter(Boolean);
        const teamCounts = {};
        players.forEach(p => { if (!rp(p, 'P')) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1; });
        const stackTeams = Object.entries(teamCounts).filter(([, c]) => c >= 3).map(([t]) => t);
        if (stackTeams.length > 0) {
          const oppTeams = new Set();
          players.forEach(p => { if (stackTeams.includes(p.team) && p.opp) oppTeams.add(p.opp); });
          const hasBB = players.some(p => !rp(p, 'P') && oppTeams.has(p.team));
          if (!hasBB) {
            // Find best bring-back candidate not already in lineup
            const luNames = new Set(players.map(p => p.name));
            const bbCandidates = pool.filter(p =>
              !rp(p, 'P') && oppTeams.has(p.team) &&
              !luNames.has(p.name) && !excludeOverExposed.has(p.name) && p.salary > 0
            ).sort((a, b) => (b.median || 0) - (a.median || 0));
            let placed = false;
            for (const bb of bbCandidates) {
              // Try replacing the lowest-scoring non-stacked batter
              const swapCandidates = lu.map((p, idx) => ({ p, idx }))
                .filter(({ p }) => p && !rp(p, 'P') && !stackTeams.includes(p?.team))
                .sort((a, b) => (a.p.median || 0) - (b.p.median || 0));
              for (const { idx } of swapCandidates) {
                if (!DK_SLOTS[idx].eligible(bb)) continue;
                const newSalary = lu.reduce((s, p, i) => s + (i === idx ? bb.salary : (p?.salary || 0)), 0);
                if (newSalary <= SALARY_CAP) { lu[idx] = bb; placed = true; break; }
              }
              if (placed) break;
            }
            // No valid bring-back found — discard this lineup rather than emit it
            // without a bring-back. The portfolio loop will attempt another iteration.
            if (!placed) lu = null;
          }
        }
      }
    }

    if (lu && lu.every(Boolean)) {
      // Check maxOverlap: skip if any existing lineup shares too many players
      let tooSimilar = false;
      if (maxOverlap > 0 && lineups.length > 0) {
        const luNames = new Set(lu.filter(Boolean).map(p => p.name));
        for (const existing of lineups) {
          const overlap = existing.filter(p => p && luNames.has(p.name)).length;
          if (overlap > maxOverlap) { tooSimilar = true; break; }
        }
      }
      if (!tooSimilar) {
        lineups.push(lu);
        lu.forEach(p => {
          exposureCounts[p.name] = (exposureCounts[p.name] || 0) + 1;
        });
        // Track 5-man stack usage for stackPct5 targeting
        if (target5ManCount != null) {
          const teamCts = {};
          lu.forEach(p => { if (!rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
          if (Object.values(teamCts).some(c => c >= 5)) lineups5ManCount++;
        }
      }
    }
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

  return {
    lineups, playerExposure, teamExposure,
    totalLineups: lineups.length,
    virtualStackTeams: [...virtualStackTeams],
    pitcherWarnings,
    bannedTeams, lockedTeams
  };
}

function generateCashLineup(pool, excludeNames, context, iterations, allowBvP = false, forceInclude = new Set()) {
  const scoreFn = p => scoreCash(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations, allowBvP, forceInclude });
}

function generateSingleLineup(pool, excludeNames, context, iterations, allowBvP = false, forceInclude = new Set()) {
  const scoreFn = p => scoreSingle(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations, allowBvP, forceInclude });
}

// lockedTeam: if set, this team's stack must be used for this lineup.
// fullPool: the unfiltered pool used for virtual stack synthesis (may differ from pool after exclusions).
function generateGppLineup(pool, excludeNames, context, stacks3, stacks5, usedStackIds, iterations, contestSize, lockedTeam, fullPool, allowBvP = false, forceInclude = new Set(), prefer5Man = null) {
  const requiredSlots = new Array(ROSTER_SIZE).fill(null);
  let usedStackTeam = null;

  // Build ordered candidate stacks. prefer5Man: true = favor 5-man, false = favor 3-man, null = auto.
  const sortByValue = (a, b) => (b.proj - (b.own || 0) * 0.3) - (a.proj - (a.own || 0) * 0.3);
  const buildCandidates = () => {
    const avail5 = stacks5.filter(s => s.proj > 0 && !usedStackIds.has(s.id)).sort(sortByValue);
    const avail3 = stacks3.filter(s => s.proj > 0 && !usedStackIds.has(s.id)).sort(sortByValue);
    // Primary pool gets the first 7 slots in candidate list; secondary fills the rest
    const primary = prefer5Man === false ? avail3 : avail5;
    const secondary = prefer5Man === false ? avail5 : avail3;
    const allAvail = [...primary, ...secondary];
    if (lockedTeam) {
      const forTeam = allAvail.filter(s => s.team === lockedTeam);
      const others = allAvail.filter(s => s.team !== lockedTeam).slice(0, 6);
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

  // If a locked team was requested but no stack was placed yet, build a virtual stack
  if (lockedTeam && !usedStackTeam) {
    const srcPool = fullPool || pool;
    const virtual = buildVirtualStack(lockedTeam, srcPool, excludeNames);
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

  return optimizeLineup(pool, scoreFn, { excludeNames, requiredSlots, iterations, stackBonusFn, allowBvP, forceInclude });
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
  const hitAdjust = directionalBonus - (wind >= 15 ? 0.04 : wind >= 10 ? 0.02 : 0);
  return {
    ...base,
    hitting: Math.max(0.85, base.hitting + hitAdjust),
    pitching: Math.max(0.85, base.pitching - hitAdjust),
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

// ── Recent Form Multiplier ─────────────────────────────────────────────────

function formMultiplier(player) {
  const recentAvg = player.recentAvgDK;
  const projectedMedian = player.median;
  if (!recentAvg || !projectedMedian || projectedMedian <= 0) return 1.0;

  const ratio = recentAvg / projectedMedian;
  if (ratio >= 1.4) return 1.12;
  if (ratio >= 1.2) return 1.07;
  if (ratio >= 1.0) return 1.03;
  if (ratio >= 0.85) return 0.98;
  if (ratio >= 0.70) return 0.94;
  return 0.90;
}

// ── Portfolio Overlap ──────────────────────────────────────────────────────

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

// ── Portfolio Simulation ─────────────────────────────────────────────────────

// Build a synthetic opponent lineup by sampling players from the pool
// weighted by their projected ownership (field proxy).
function buildFieldLineup(pool) {
  const batters = pool.filter(p => !rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  const pitchers = pool.filter(p => rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  if (!batters.length || !pitchers.length) return null;

  const lu = new Array(ROSTER_SIZE).fill(null);
  const usedNames = new Set();

  // Ownership-weighted random pick
  const pickWeighted = (candidates) => {
    const totalOwn = candidates.reduce((s, p) => s + (p.own || 1), 0);
    let r = Math.random() * totalOwn;
    for (const p of candidates) {
      r -= (p.own || 1);
      if (r <= 0) return p;
    }
    return candidates[candidates.length - 1];
  };

  // Fill pitchers first (slots 0,1)
  for (let i = 0; i < 2; i++) {
    const cands = pitchers.filter(p => !usedNames.has(p.name));
    if (!cands.length) break;
    const pick = pickWeighted(cands);
    lu[i] = pick; usedNames.add(pick.name);
  }
  // Fill remaining slots
  for (let i = 2; i < ROSTER_SIZE; i++) {
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
  platoonMultiplier, adjustForPlatoon,
  weatherMultiplier, weatherMultiplierDirectional, parkMultiplier,
  vegasAdjustment, vegasPitcherAdjustment,
  teamScoringAdjustment,
  statcastCeilingBoost, pitcherStuffBoost, bullpenAdjustment, catcherFramingAdjustment, sprintSpeedBoost, formMultiplier, calcPortfolioOverlap, umpireMultiplier,

  // Projection blending
  blendProjections,

  // Optimizer
  optimizeLineup, greedyFill,
  generateCashLineup, generateSingleLineup, generateGppLineup,
  gppStackBonus,

  // Portfolio
  buildPortfolio,

  // Analysis
  analyzeLineup,
  getPitcherMatchupScore,

  // Calibration
  setCalibration,
  getCalibration,
  calibratePool
};

})();
