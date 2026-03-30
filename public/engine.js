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
  const leftStd = Math.max((median - floor) / 1.5, 0.5);
  const rightStd = Math.max((ceiling - median) / 1.5, 0.5);

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

// Returns correlation coefficient between two players
// Based on: same team (batting order adjacency), bring-back, same game, pitcher-team
function getCorrelation(p1, p2) {
  const isP1 = rp(p1, 'P'), isP2 = rp(p2, 'P');

  // Pitcher vs own batters: negative correlation (pitcher does well = batters face weaker lineup)
  // Actually in DFS, pitcher doing well doesn't directly hurt own batters
  // Pitcher vs opposing batters: negative correlation
  if (isP1 && !isP2 && p1.opp === p2.team) return -0.15;
  if (isP2 && !isP1 && p2.opp === p1.team) return -0.15;

  // Same team batters: positive correlation (run scoring is correlated)
  if (!isP1 && !isP2 && p1.team === p2.team) {
    const o1 = p1.order || 9, o2 = p2.order || 9;
    const diff = Math.abs(o1 - o2);
    // Adjacent batters: 0.38, 2-apart: 0.30, etc.
    // Research shows 1-2 combo has highest correlation
    if (diff === 1) return 0.38;
    if (diff === 2) return 0.30;
    if (diff === 3) return 0.22;
    return 0.15; // Same team, far apart
  }

  // Bring-back: opposing team batter in same game
  if (!isP1 && !isP2 && p1.opp === p2.team && p2.opp === p1.team) {
    return 0.12; // Slight positive - high scoring games help both sides
  }

  // Pitcher and own team batters: slight positive (team wins = pitcher gets W bonus)
  if (isP1 && !isP2 && p1.team === p2.team) return 0.05;
  if (isP2 && !isP1 && p2.team === p1.team) return 0.05;

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
  if (!exp) return 0.95; // Players NOT in any optimal lineup get a small penalty
  const pct = exp.pct; // 0-100
  if (mode === 'cash') {
    // Cash loves consensus plays — up to +10%
    return 1.0 + Math.min(pct / 100, 1.0) * 0.10;
  } else if (mode === 'single') {
    // Single entry: moderate signal — up to +8%
    return 1.0 + Math.min(pct / 100, 1.0) * 0.08;
  } else {
    // GPP: use as confirmation, not driver — up to +6%
    // But heavily penalise players in 0% of optimals
    return pct > 0 ? 1.0 + Math.min(pct / 100, 1.0) * 0.06 : 0.92;
  }
}

function scoreCash(p, context = {}) {
  const { vegasData, parkFactors, weatherData, stadiums, teamScoring } = context;
  const isP = rp(p, 'P');

  let vegasAdj = 1.0;
  if (isP) {
    vegasAdj = vegasPitcherAdjustment(p, vegasData);
  } else {
    vegasAdj = vegasAdjustment(p, vegasData);
  }

  // Park factor
  const homeTeam = p.game ? p.game.split('@')[1] : p.team;
  const pf = parkMultiplier(homeTeam, parkFactors);

  // Weather (only for outdoor stadiums)
  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && stadiums && homeTeam) {
    const isDome = stadiums.domes?.includes(homeTeam);
    if (!isDome) {
      const city = stadiums.cities?.[homeTeam];
      if (city && weatherData[city]) wm = weatherMultiplier(weatherData[city]);
    }
  }

  // Team scoring adjustment
  const tsAdj = teamScoringAdjustment(p, teamScoring);

  const optBoost = optimalExposureBoost(p, context, 'cash');
  const scBoost = !isP ? statcastCeilingBoost(p) : 1.0;
  const fmBoost = formMultiplier(p);

  if (isP) {
    const kBonus = (p.kRate || 0) > 25 ? 2.0 : (p.kRate || 0) > 20 ? 1.0 : 0;
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 2.5 + (p.floor || 0) * 1.5 + matchup * 2 + kBonus + winProb * 3)
      * vegasAdj * wm.pitching * tsAdj.pitching * optBoost * fmBoost;
  }

  // Batter
  const orderBonus = p.order > 0 && p.order <= 4 ? (5 - p.order) * 1.5 : 0;
  const variance = (p.ceiling || 0) - (p.floor || 0);
  const platoon = p.platoonAdj || 1.0;
  return ((p.median || 0) * 2.0 + (p.floor || 0) * 1.5 - variance * 0.3 + orderBonus)
    * vegasAdj * pf.run * wm.hitting * platoon * tsAdj.batting * optBoost * scBoost * fmBoost;
}

function scoreSingle(p, context = {}) {
  const { vegasData, parkFactors, weatherData, stadiums, teamScoring } = context;
  const isP = rp(p, 'P');

  let vegasAdj = isP ? vegasPitcherAdjustment(p, vegasData) : vegasAdjustment(p, vegasData);
  const homeTeam = p.game ? p.game.split('@')[1] : p.team;
  const pf = parkMultiplier(homeTeam, parkFactors);

  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && stadiums && homeTeam) {
    const isDome = stadiums.domes?.includes(homeTeam);
    if (!isDome) {
      const city = stadiums.cities?.[homeTeam];
      if (city && weatherData[city]) wm = weatherMultiplier(weatherData[city]);
    }
  }

  const tsAdj = teamScoringAdjustment(p, teamScoring);
  const value = p.salary > 0 ? (p.median || 0) / p.salary * 1000 : 0;

  const optBoost = optimalExposureBoost(p, context, 'single');
  const scBoost = !isP ? statcastCeilingBoost(p) : 1.0;
  const fmBoost = formMultiplier(p);

  if (isP) {
    const kBonus = (p.kRate || 0) > 25 ? 1.5 : (p.kRate || 0) > 20 ? 0.7 : 0;
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 1.5 + (p.ceiling || 0) * 0.8 + value * 0.3 + matchup + kBonus)
      * vegasAdj * wm.pitching * tsAdj.pitching * optBoost * fmBoost;
  }

  const orderBonus = p.order > 0 && p.order <= 5 ? (6 - p.order) * 0.8 : 0;
  const platoon = p.platoonAdj || 1.0;
  return ((p.median || 0) * 1.2 + (p.ceiling || 0) * 0.6 + value * 0.4 + orderBonus)
    * vegasAdj * pf.run * wm.hitting * platoon * tsAdj.batting * optBoost * scBoost * fmBoost;
}

function scoreGpp(p, context = {}) {
  const { vegasData, parkFactors, weatherData, stadiums, teamScoring, contestSize = 1000 } = context;
  const isP = rp(p, 'P');

  let vegasAdj = isP ? vegasPitcherAdjustment(p, vegasData) : vegasAdjustment(p, vegasData);
  const homeTeam = p.game ? p.game.split('@')[1] : p.team;
  const pf = parkMultiplier(homeTeam, parkFactors);

  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && stadiums && homeTeam) {
    const isDome = stadiums.domes?.includes(homeTeam);
    if (!isDome) {
      const city = stadiums.cities?.[homeTeam];
      if (city && weatherData[city]) wm = weatherMultiplier(weatherData[city]);
    }
  }

  const tsAdj = teamScoringAdjustment(p, teamScoring);

  const optBoost = optimalExposureBoost(p, context, 'gpp');
  const scBoost = !isP ? statcastCeilingBoost(p) : 1.0;
  const fmBoost = formMultiplier(p);

  if (isP) {
    const kBonus = (p.kRate || 0) > 25 ? 2.0 : (p.kRate || 0) > 20 ? 1.0 : 0;
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    const ownPenalty = (p.own || 0) * 0.1 * (Math.log10(Math.max(contestSize, 10)) / 3);
    return ((p.ceiling || 0) * 1.2 + (p.median || 0) * 0.5 + matchup - ownPenalty + kBonus + winProb * 2)
      * vegasAdj * wm.pitching * tsAdj.pitching * optBoost * fmBoost;
  }

  // GPP batter scoring: ceiling-weighted with ownership leverage
  const gppScore = calcGppScore(p, contestSize);
  const orderBonus = p.order > 0 && p.order <= 5 ? (6 - p.order) * 0.5 : 0;
  const platoon = p.platoonAdj || 1.0;
  return (gppScore + orderBonus) * pf.hr * wm.hitting * platoon * tsAdj.batting * optBoost * scBoost * fmBoost;
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

// ── Enhanced Optimizer ──────────────────────────────────────────────────────

function optimizeLineup(pool, scoreFn, opts = {}) {
  const {
    excludeNames = new Set(),
    requiredSlots = new Array(ROSTER_SIZE).fill(null),
    iterations = 5000,
    stackBonusFn = null,
    exposureLimits = null // { playerName: maxPct }
  } = opts;

  const lockedNames = new Set();
  let lockedSalary = 0;
  requiredSlots.forEach(p => {
    if (p) { lockedNames.add(p.name); lockedSalary += p.salary; }
  });

  // Build scored candidate pools per open slot (top 40 eligible per position)
  const candidatePools = DK_SLOTS.map((slot, i) => {
    if (requiredSlots[i]) return null;
    return pool.filter(p =>
      slot.eligible(p) &&
      !excludeNames.has(p.name) &&
      !lockedNames.has(p.name) &&
      p.salary > 0 &&
      (p.median > 0 || p.ceiling > 0 || p.avgPpg > 0) &&
      (!exposureLimits || !exposureLimits[p.name] || exposureLimits[p.name] > 0)
    ).sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, 40);
  });

  const openSlots = [];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    if (!requiredSlots[i]) openSlots.push(i);
  }

  let bestLineup = null, bestScore = -Infinity;

  for (let iter = 0; iter < iterations; iter++) {
    const lu = [...requiredSlots];
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
      const pool = candidatePools[si];
      if (!pool || !pool.length) { valid = false; break; }

      const slotsLeft = order.length - oi - 1;
      const budgetForThis = SALARY_CAP - salaryUsed - slotsLeft * MIN_SALARY_PER_SLOT;
      const available = pool.filter(p => !usedNames.has(p.name) && p.salary <= budgetForThis);
      if (!available.length) { valid = false; break; }

      // Weighted random from top candidates
      const topN = Math.min(available.length, 5 + Math.floor(Math.random() * 6));
      const pick = available[Math.floor(Math.random() * topN)];
      lu[si] = pick;
      usedNames.add(pick.name);
      salaryUsed += pick.salary;
    }

    if (!valid || lu.some(p => !p)) continue;
    if (salaryUsed > SALARY_CAP) continue;

    let total = lu.reduce((s, p) => s + scoreFn(p), 0);
    // Salary efficiency bonus
    total += (salaryUsed / SALARY_CAP) * 4;
    if (stackBonusFn) total += stackBonusFn(lu);

    if (total > bestScore) { bestScore = total; bestLineup = [...lu]; }
  }

  return bestLineup || greedyFill(pool, scoreFn, excludeNames, requiredSlots);
}

function greedyFill(pool, scoreFn, excludeNames = new Set(), requiredSlots = new Array(ROSTER_SIZE).fill(null)) {
  const lu = [...requiredSlots];
  const sorted = [...pool].filter(p => !excludeNames.has(p.name) && p.salary > 0)
    .sort((a, b) => scoreFn(b) - scoreFn(a));
  for (let i = 0; i < ROSTER_SIZE; i++) {
    if (lu[i]) continue;
    for (const p of sorted) {
      if (lu.some(lp => lp && lp.name === p.name)) continue;
      if (!DK_SLOTS[i].eligible(p)) continue;
      const salSoFar = lu.reduce((s, lp) => s + (lp ? lp.salary : 0), 0);
      const left = DK_SLOTS.filter((_, j) => j > i && !lu[j]).length;
      if (salSoFar + p.salary > SALARY_CAP - left * MIN_SALARY_PER_SLOT) continue;
      lu[i] = p;
      break;
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
    if (c >= 5) bonus += 8;
    else if (c >= 4) bonus += 5;
    else if (c >= 3) bonus += 2;
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
function tryPlaceStack(stackPlayers, requiredSlots, pool) {
  const tempLu = [...requiredSlots];
  let stackSalary = requiredSlots.reduce((s, p) => s + (p ? p.salary : 0), 0);
  for (const sp of stackPlayers) {
    let placed = false;
    for (let i = 0; i < ROSTER_SIZE; i++) {
      if (tempLu[i]) continue;
      if (!DK_SLOTS[i].eligible(sp)) continue;
      tempLu[i] = sp; stackSalary += sp.salary; placed = true; break;
    }
    if (!placed) return false;
  }
  const openCount = tempLu.filter(p => !p).length;
  if (stackSalary + openCount * MIN_SALARY_PER_SLOT > SALARY_CAP) return false;
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
    lockedTeams = [],      // teams whose stacks are prioritised every lineup
    bannedTeams = [],      // teams fully excluded from the portfolio
    context = {},
    iterations = 5000
  } = opts;

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
    // Build exclusion set: banned + over-exposed players
    const excludeOverExposed = new Set(bannedNames);
    if (i > 0) {
      pool.forEach(p => {
        const threshold = rp(p, 'P') ? maxExposurePitcher : maxExposure;
        const exposure = (exposureCounts[p.name] || 0) / i;
        if (exposure >= threshold) excludeOverExposed.add(p.name);
      });
    }

    let lu;
    if (contestType === 'cash') {
      lu = generateCashLineup(pool, excludeOverExposed, context, iterations);
    } else if (contestType === 'single') {
      lu = generateSingleLineup(pool, excludeOverExposed, context, iterations);
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
        targetLockedTeam, pool
      );
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

function generateCashLineup(pool, excludeNames, context, iterations) {
  const scoreFn = p => scoreCash(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations });
}

function generateSingleLineup(pool, excludeNames, context, iterations) {
  const scoreFn = p => scoreSingle(p, { ...context, pool });
  return optimizeLineup(pool, scoreFn, { excludeNames, iterations });
}

// lockedTeam: if set, this team's stack must be used for this lineup.
// fullPool: the unfiltered pool used for virtual stack synthesis (may differ from pool after exclusions).
function generateGppLineup(pool, excludeNames, context, stacks3, stacks5, usedStackIds, iterations, contestSize, lockedTeam, fullPool) {
  const requiredSlots = new Array(ROSTER_SIZE).fill(null);
  let usedStackTeam = null;

  // Build ordered candidate stacks. If a locked team is specified, its stacks
  // go first; everything else follows in the normal priority order.
  const buildCandidates = () => {
    const available = [...stacks5, ...stacks3].filter(s => s.proj > 0 && !usedStackIds.has(s.id));
    if (lockedTeam) {
      const forTeam = available.filter(s => s.team === lockedTeam);
      const others = available.filter(s => s.team !== lockedTeam)
        .sort((a, b) => (b.proj - (b.own || 0) * 0.3) - (a.proj - (a.own || 0) * 0.3));
      // Shuffle the team-specific stacks for variety between lineups
      for (let i = forTeam.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [forTeam[i], forTeam[j]] = [forTeam[j], forTeam[i]];
      }
      return [...forTeam, ...others.slice(0, 6)];
    }
    const top = available.sort((a, b) => (b.proj - (b.own || 0) * 0.3) - (a.proj - (a.own || 0) * 0.3))
      .slice(0, 10);
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j], top[i]];
    }
    return top;
  };

  const candidates = (stacks5.length > 0 || stacks3.length > 0) ? buildCandidates() : [];

  for (const stack of candidates) {
    const stackPlayers = stack.players
      .map(name => pool.find(p => p.name === name && !excludeNames.has(p.name)))
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
        .map(name => pool.find(p => p.name === name && !excludeNames.has(p.name)))
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

  return optimizeLineup(pool, scoreFn, { excludeNames, requiredSlots, iterations, stackBonusFn });
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

// ── Public API ──────────────────────────────────────────────────────────────

return {
  // Constants
  SALARY_CAP, ROSTER_SIZE, MIN_SALARY_PER_SLOT, DK_SLOTS,
  rp,

  // Simulation
  simulateLineup,
  samplePlayerScore,

  // Correlation
  getCorrelation,
  buildCorrelationMatrix,

  // Scoring
  scoreCash, scoreSingle, scoreGpp,
  calcLeverage, calcGppScore,
  optimalExposureBoost,

  // Adjustments
  platoonMultiplier, adjustForPlatoon,
  weatherMultiplier, weatherMultiplierDirectional, parkMultiplier,
  vegasAdjustment, vegasPitcherAdjustment,
  teamScoringAdjustment,
  statcastCeilingBoost, formMultiplier, calcPortfolioOverlap,

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
