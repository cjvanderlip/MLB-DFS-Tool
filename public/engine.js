// ═══════════════════════════════════════════════════════════════════════════════
// MLB DFS Analytics Engine v2.0
// Monte Carlo Simulation · Correlation Modeling · Ownership Leverage
// Platoon Splits · Enhanced Optimizer · Portfolio Construction
// ═══════════════════════════════════════════════════════════════════════════════

const Engine = (() => {

// ── Debug logging ───────────────────────────────────────────────────────────
// When _debug is false (default), dlog is a no-op so engine console output stays
// quiet during normal use. Toggled via Engine.setDebug(bool) — typically wired by
// app.js to a STATE.debug flag the user controls via window.toggleDebug() or
// localStorage. Warnings and errors are intentionally NOT gated — only the chatty
// per-attempt diagnostic logs that previously fired unconditionally.
let _debug = false;
function setDebug(v) { _debug = !!v; }
function getDebug() { return _debug; }
function dlog(...args) { if (_debug) console.log(...args); }

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

// ── Showdown Constants ──────────────────────────────────────────────────────
const SHOWDOWN_SALARY_CAP = 50000;
const SHOWDOWN_ROSTER_SIZE = 6;
const SHOWDOWN_SLOTS = [
  { key: 'CPT',  label: 'CPT',  eligible: p => p.isCpt === true },
  { key: 'FLEX', label: 'FLEX', eligible: p => p.isFlex === true },
  { key: 'FLEX', label: 'FLEX', eligible: p => p.isFlex === true },
  { key: 'FLEX', label: 'FLEX', eligible: p => p.isFlex === true },
  { key: 'FLEX', label: 'FLEX', eligible: p => p.isFlex === true },
  { key: 'FLEX', label: 'FLEX', eligible: p => p.isFlex === true },
];

function rp(p, slot) {
  return (p.rosterPos || p.dkPos || '').split('/').some(x => x.trim() === slot);
}

// ── Random Number Generators ────────────────────────────────────────────────

// Box-Muller transform for normal distribution.
// Box-Muller produces TWO independent standard normals per pair of uniforms
// (the cos and sin companions). The cos branch is returned immediately and the
// sin companion is cached so the next call is a near-free array read instead of
// a fresh log/sqrt/trig evaluation — halving the transcendental cost across the
// 15–30M calls a portfolio sim makes. Output is statistically identical (the
// stream is unseeded), only the pairing of consecutive draws changes.
let _spareNorm = null;
function randNorm(mean = 0, std = 1) {
  if (_spareNorm !== null) { const z = _spareNorm; _spareNorm = null; return z * std + mean; }
  let u1 = Math.random(); const u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  const r = Math.sqrt(-2.0 * Math.log(u1)), theta = 2.0 * Math.PI * u2;
  _spareNorm = r * Math.sin(theta); // cache the companion for the next call
  return (r * Math.cos(theta)) * std + mean;
}

// ── Per-player sampling profile cache ─────────────────────────────────────────
// samplePlayerScore is the hottest function in the codebase (~7.5M calls per
// sim-filter pass). Everything that depends only on the player's static fields
// and the _simDiversity global — position parsing, the ceiling/floor multiplier
// ladders, effectiveFloor/effectiveCeiling, and leftStd/rightStd — is invariant
// across the thousands of sims a single player is sampled in. Computing it once
// per (player, _simDiversity) and caching it on the player object eliminates the
// per-call string allocation and branch ladders. _profileVersion is bumped
// whenever _simDiversity changes so stale widths are never reused.
let _profileVersion = 0;
function getSampleProfile(player) {
  let sp = player._sp;
  if (sp !== undefined && sp.v === _profileVersion) return sp;

  const median = player.median || 0;
  const pos = (player.pos || player.dkPos || player.rosterPos || '').toUpperCase();
  const isSP = pos.includes('SP') || (pos.includes('P') && !pos.includes('RP') && !pos.includes('C'));
  const order = player.order || 0;

  // ── Position-aware ceiling minimum ──────────────────────────────────────────
  // Projection CSVs often use fixed multipliers that compress the right tail:
  //   order-9 batters get ceiling = median (zero upside), mid-order get ×1.12–1.25.
  // These minimums represent the realistic boom scenario for each tier based on
  // PA volume, HR/SB upside, and RBI opportunity.
  let minCeilingMult;
  if (isSP) {
    minCeilingMult = 1.85; // ace can dominate: 10-K QS + W = 40+ DK
  } else if (order >= 1 && order <= 2) {
    minCeilingMult = 1.65; // leadoff/#2: most PAs, SB upside, HR ceiling
  } else if (order >= 3 && order <= 5) {
    minCeilingMult = 1.55; // middle order: HR + multi-RBI games
  } else if (order >= 6 && order <= 7) {
    minCeilingMult = 1.45; // lower-mid: meaningful but less PA upside
  } else if (order >= 8) {
    minCeilingMult = 1.35; // bottom order: fewer PAs but can still boom
  } else {
    minCeilingMult = 1.50; // unknown batting order
  }
  const effectiveCeiling = Math.max(player.ceiling || 0, median * minCeilingMult);

  // ── Position-aware floor minimum ────────────────────────────────────────────
  // CSV floors of Median × 0.10 are mechanically too tight and compress leftStd
  // to a width that implies 10% chance of nearly-zero output even for leadoff bats.
  // Top-order batters have meaningfully higher floors due to guaranteed PA volume.
  let minFloorMult;
  if (isSP) {
    minFloorMult = 0.15; // early exit / 1st-inning blow-up is modeled separately above
  } else if (order >= 1 && order <= 4) {
    minFloorMult = 0.28; // top-order: 4+ PAs guaranteed, floor via walks/single
  } else if (order >= 5 && order <= 7) {
    minFloorMult = 0.22; // mid-order: ~3.5 PAs average
  } else if (order >= 8) {
    minFloorMult = 0.18; // bottom-order: fewest PAs
  } else {
    minFloorMult = 0.22; // unknown order
  }
  const effectiveFloor = Math.max(player.floor || 0, median * minFloorMult);

  // Build asymmetric distribution treating effectiveFloor = P10, effectiveCeiling = P90.
  // z = 1.28 is the 90th-percentile of a standard normal (P(z > 1.28) ≈ 10%).
  const SIGMA_P90 = 1.28;
  sp = {
    v: _profileVersion,
    median,
    isSP,
    effectiveCeiling,
    leftStd:  Math.max((median - effectiveFloor) / SIGMA_P90, 0.5) * _simDiversity,
    rightStd: Math.max((effectiveCeiling - median) / SIGMA_P90, 0.5) * _simDiversity,
    floorClamp: effectiveFloor * 0.5, // final score is floored at effectiveFloor × 0.5
  };
  // Non-enumerable so the cached profile never leaks into JSON/spread copies of
  // the player (e.g. calibratePool's `{...p}`), which would carry a stale version.
  Object.defineProperty(player, '_sp', { value: sp, writable: true, configurable: true, enumerable: false });
  return sp;
}

// Skewed distribution using floor/median/ceiling
// Models right-tail upside (GPP-relevant), SP early-exit busts, and batter blowups.
function samplePlayerScore(player, correlationShift = 0) {
  const prof = getSampleProfile(player);
  const median = prof.median;
  if (median <= 0) return 0;

  const isSP = prof.isSP;
  const effectiveCeiling = prof.effectiveCeiling;
  const leftStd = prof.leftStd;
  const rightStd = prof.rightStd;

  // ── SP early-exit bust scenario (~4% of starts) ─────────────────────────────
  // Models injury pulls, 1st-inning blow-ups, and early hooks that produce large
  // negative DK scores (e.g. Crochet −24). These outcomes are not captured by any
  // floor field because projection sources define floor as the P10 of a *normal* start.
  // Sampled independently of the correlation shift (a pitcher bust is idiosyncratic,
  // not a symptom of the whole lineup underperforming together).
  if (isSP && Math.random() < _bustRate) {
    return Math.max(-30, randNorm(-2, 9));
  }

  // Generate base normal sample shifted by correlation
  const z = randNorm(0, 1) + correlationShift;

  let score;
  if (z <= 0) {
    score = median + z * leftStd;
  } else {
    // ── Batter boom scenario (correlation-aware) ──────────────────────────────
    // Models multi-HR / bases-loaded / stolen-base games that blow through the
    // stated ceiling. Observed examples: Jake Burger 4.4× ceiling, Jose Caballero
    // 2.2× ceiling, Jeremiah Jackson 16× stated ceiling. Base rate ~3% per PA-game.
    //
    // Fix #2: the boom PROBABILITY now scales with the positive correlation shift so
    // a stack whose correlated z spikes booms TOGETHER — the "whole-stack-erupts-for-60"
    // outcome that actually wins GPPs. Previously the boom fired on an independent
    // Math.random() roll that discarded correlationShift, so each teammate could boom
    // but never in a coordinated way, systematically thinning the joint right tail of a
    // stack (exactly the tail GPP ROI lives on). A +1.0 shift ≈1.7×s the boom rate,
    // +2.0 ≈2.4×s it; capped at 12%. SP excluded (pitcher booms aren't a stack effect).
    const boomProb = !isSP
      ? Math.min(_boomRate * 4, _boomRate * (1 + Math.max(0, correlationShift) * 0.7))
      : 0;
    if (boomProb > 0 && Math.random() < boomProb) {
      // Boom magnitude also rides the correlation shift: a more strongly co-moving
      // stack booms bigger, not just more often. Shift adds up to ~0.5σ of extra ceiling.
      const boomCenter = effectiveCeiling * 1.50 + Math.max(0, correlationShift) * rightStd * 0.5;
      score = randNorm(boomCenter, rightStd * 1.50);
    } else {
      score = median + z * rightStd;
    }
  }

  // Floor at 0, slight chance of bust (negative DK points rare but possible)
  return Math.max(score, prof.floorClamp);
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
  invalidateCorrCache(); // pair history feeds getCorrelation — drop memoized values
  return result;
}

function getPairCorrelation(name1, name2) {
  const key = [name1, name2].sort().join('|');
  return _pairCorr[key] ?? null;
}

// Scaling factors set by user-facing sliders (1.0 = default).
// corrScale: multiplies all non-zero correlations (>1 = more stacking, <1 = less).
// simDiversity: adds jitter to samplePlayerScore (>1 = wider distributions).
// corrDampener: fraction of Cholesky z-score applied to player score sampling.
//   1.0 = full correlation (mathematically correct). Lower values dampen correlated
//   variance if simulation results feel too extreme. Was hardcoded to 0.5 previously.
let _corrScale = 1.0;
let _simDiversity = 1.0;
let _corrDampener = 1.0;
function setCorrScale(v) { _corrScale = Math.max(0.1, Math.min(3.0, v)); invalidateCorrCache(); }
function setSimDiversity(v) { _simDiversity = Math.max(0.5, Math.min(3.0, v)); _profileVersion++; }
function setCorrDampener(v) { _corrDampener = Math.max(0.1, Math.min(1.0, v)); }
function getCorrScale() { return _corrScale; }
function getSimDiversity() { return _simDiversity; }
function getCorrDampener() { return _corrDampener; }

// ── Calibratable tail-event rates (Fix #3) ───────────────────────────────────
// _boomRate: base per-game probability a batter blows through his stated ceiling
//            (multi-HR / bases-loaded / SB games). Scaled up by correlation in
//            samplePlayerScore so stacks boom together.
// _bustRate: per-start probability an SP suffers an early-exit / blow-up that
//            produces a large negative DK score.
// Defaults (3% / 4%) match the historical hardcoded values; computeTailRatesFromHistory
// fits them to actuals so the simulator's tails reflect this slate-pool's real outcomes
// rather than fixed guesses.
const DEFAULT_BOOM_RATE = 0.03;
const DEFAULT_BUST_RATE = 0.04;
let _boomRate = DEFAULT_BOOM_RATE;
let _bustRate = DEFAULT_BUST_RATE;
function setTailRates(rates = {}) {
  const { boomRate, bustRate } = rates || {};
  if (boomRate != null && isFinite(boomRate)) _boomRate = Math.max(0.005, Math.min(0.10, boomRate));
  if (bustRate != null && isFinite(bustRate)) _bustRate = Math.max(0.005, Math.min(0.12, bustRate));
}
function getTailRates() { return { boomRate: _boomRate, bustRate: _bustRate }; }

// Estimate boom/bust rates from historical actuals.
// A batter "boom" = an actual DK score at or above the player's stated ceiling.
// An SP "bust"    = a negative DK score, or one below 20% of the projected median.
// Rates are shrunk toward the defaults at low sample (full trust at 200 batter / 100 SP
// observations) and clamped by setTailRates. Returns the fitted rates plus the raw
// sample counts so the UI can report confidence.
function computeTailRatesFromHistory(historyEntries, pool) {
  const playerMap = {};
  for (const p of (pool || [])) playerMap[(p.name || '').toLowerCase()] = p;

  let batterObs = 0, batterBooms = 0, spObs = 0, spBusts = 0;
  for (const entry of (historyEntries || [])) {
    const actuals = entry.playerActuals;
    if (!actuals) continue;
    for (const [name, raw] of Object.entries(actuals)) {
      const actual = parseFloat(raw);
      if (isNaN(actual)) continue;
      const p = playerMap[name.toLowerCase()];
      if (!p) continue;
      if (rp(p, 'P')) {
        spObs++;
        if (actual < 0 || (p.median > 0 && actual < p.median * 0.20)) spBusts++;
      } else {
        const ceil = p.ceiling || (p.median > 0 ? p.median * 1.5 : 0);
        if (ceil > 0) { batterObs++; if (actual >= ceil) batterBooms++; }
      }
    }
  }

  const boomTrust = Math.min(1, batterObs / 200);
  const bustTrust = Math.min(1, spObs / 100);
  const rawBoom = batterObs > 0 ? batterBooms / batterObs : DEFAULT_BOOM_RATE;
  const rawBust = spObs > 0 ? spBusts / spObs : DEFAULT_BUST_RATE;
  const boomRate = parseFloat((DEFAULT_BOOM_RATE * (1 - boomTrust) + rawBoom * boomTrust).toFixed(4));
  const bustRate = parseFloat((DEFAULT_BUST_RATE * (1 - bustTrust) + rawBust * bustTrust).toFixed(4));
  return { boomRate, bustRate, batterSample: batterObs, spSample: spObs, batterBooms, spBusts };
}

// Game-environment correlation scaler.
// Higher O/U games produce stronger same-team and same-game correlations because
// run scoring concentrates in fewer high-scoring innings — when one batter in a
// stack scores, his teammates are more likely to share that inning's run-chain.
// Conversely, pitcher-duel games (low O/U) produce weaker correlations because
// the limited runs are more spread out and less inning-clustered.
//
// Baseline: 9.0 O/U → 1.0× (no adjustment). Scale ±20% across realistic O/U range.
// 7.0 O/U → ~0.92× (compressed); 12.0 O/U → ~1.12× (amplified).
// Requires both players in the same game and vegasData passed via _vegasContext.
let _vegasContext = null;
function setVegasContext(v) { _vegasContext = v; invalidateCorrCache(); }
function gameEnvCorrScale(p1, p2) {
  if (!_vegasContext || !p1.game || p1.game !== p2.game) return 1.0;
  const t1 = _vegasContext[p1.team]?.impliedTotal || 4.5;
  const t2 = _vegasContext[p2.team]?.impliedTotal || 4.5;
  if (t1 < 1.5 || t2 < 1.5) return 1.0; // postponed/bad data guard
  const ou = t1 + t2;
  // Linear scale anchored at 9.0 O/U baseline; 0.04 slope per run.
  // 7.0 → 0.92, 9.0 → 1.00, 12.0 → 1.12. Clamped to ±15%.
  return Math.max(0.85, Math.min(1.15, 1.0 + (ou - 9.0) * 0.04));
}

// Returns correlation coefficient between two players
// Checks historical pair data first, then falls back to structural rules.
// Pairwise correlations are static for a slate — they depend only on the two
// players' fixed fields (team/opp/order/name) plus the _corrScale, _vegasContext
// and _pairCorr globals. buildCorrelationMatrix calls this n²/2 times per lineup
// and the field path rebuilds a matrix every sim, so the same pair is recomputed
// hundreds of thousands of times — each doing a string sort/join key and Vegas
// lookups. Memoize by sorted-name key and clear the cache whenever a dependent
// global changes (see invalidateCorrCache callers).
const _corrCache = new Map();
function invalidateCorrCache() { _corrCache.clear(); }
function getCorrelation(p1, p2) {
  const key = p1.name < p2.name ? p1.name + '|' + p2.name : p2.name + '|' + p1.name;
  const cached = _corrCache.get(key);
  if (cached !== undefined) return cached;
  const val = _computeCorrelation(p1, p2);
  _corrCache.set(key, val);
  return val;
}

function _computeCorrelation(p1, p2) {
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
    // Apply game-environment scaler: blowout-candidate games amplify same-team
    // correlations because runs cluster in fewer big innings.
    const envScale = gameEnvCorrScale(p1, p2);
    // Inning-burst multiplier: top-order batters (order <= 4) share inning-level
    // run-chain effects. Add +4% when both are top-order for GPP ceiling upside.
    const inningBurstMult = (o1 <= 4 && o2 <= 4) ? 1.04 : 1.0;
    // Adjacent batters: 0.38, 2-apart: 0.30, etc.
    // Research shows 1-2 combo has highest correlation
    if (diff === 1) return Math.min(0.95, 0.38 * _corrScale * envScale * inningBurstMult);
    if (diff === 2) return Math.min(0.95, 0.30 * _corrScale * envScale * inningBurstMult);
    if (diff === 3) return Math.min(0.95, 0.22 * _corrScale * envScale * inningBurstMult);
    return Math.min(0.95, 0.15 * _corrScale * envScale * inningBurstMult); // Same team, far apart
  }

  // Pitcher and own team batters: positive correlation — an ace's quality start requires
  // his offense to score runs, and wins are correlated. Empirical range 0.10–0.14.
  if (isP1 && !isP2 && p1.team === p2.team) return Math.min(0.95, 0.11 * _corrScale);
  if (isP2 && !isP1 && p2.team === p1.team) return Math.min(0.95, 0.11 * _corrScale);

  // Same game, different teams: both offenses benefit when a game goes high-scoring.
  // Captures the correlation between a primary stack and its bring-back players.
  // Game-environment scaler applies — high-O/U games strengthen this signal.
  // Base of 0.07; _corrScale lets users amplify or dampen. Capped at 0.15.
  if (!isP1 && !isP2 && p1.opp === p2.team && p1.team === p2.opp) {
    const envScale = gameEnvCorrScale(p1, p2);
    return Math.min(0.15, 0.07 * _corrScale * envScale);
  }

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

// Cholesky decomposition for correlated sampling.
// Uses a small epsilon (1e-10) on the diagonal to guard against floating-point
// cancellation producing a tiny negative value on an otherwise PSD matrix.
// This keeps L well-formed without silently corrupting the correlation structure
// the way the old 0.001 fallback did (which set L[i][i] = 0.001 regardless of
// scale, producing rows that were wildly out of proportion).
function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        // Clamp to tiny positive value — prevents NaN from floating-point underflow
        // without materially changing any correlation (1e-10 << typical diagonal ≈ 1)
        L[i][j] = Math.sqrt(Math.max(matrix[i][i] - sum, 1e-10));
      } else {
        // Guard division by near-zero diagonal (degenerate player with no variance)
        L[i][j] = L[j][j] > 1e-10 ? (matrix[i][j] - sum) / L[j][j] : 0;
      }
    }
  }
  return L;
}

// ── Monte Carlo Simulation ──────────────────────────────────────────────────

// Cholesky decomposition cache — keyed by sorted player names.
// Cholesky is deterministic for a given player set and O(n³); caching eliminates
// redundant work when the same lineup is simulated multiple times (e.g. portfolio sim
// vs. sim-filter pass). Capped at 500 entries to bound memory use.
const _choleskyCache = new Map();
function getCachedCholesky(players) {
  const key = players.map(p => p.name).slice().sort().join('|');
  if (_choleskyCache.has(key)) return _choleskyCache.get(key);
  const L = cholesky(buildCorrelationMatrix(players));
  _choleskyCache.set(key, L);
  if (_choleskyCache.size > 500) _choleskyCache.delete(_choleskyCache.keys().next().value);
  return L;
}

function simulateLineup(lineup, numSims = 10000) {
  const players = lineup.filter(Boolean);
  if (!players.length) return null;

  const corrMatrix = buildCorrelationMatrix(players);
  const L = getCachedCholesky(players);
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
      const score = samplePlayerScore(players[i], correlated[i] * _corrDampener);
      playerResults[i].push(score);
      total += score;
    }
    results.push(total);
  }

  // Compute statistics on a sorted COPY so `results` retains its draw order —
  // simulatePortfolio reuses the draw-order totals for its tier/ROI counting
  // (the bootstrap there partitions sims into contiguous groups, which must be
  // random subsamples, not score-ordered slices).
  const sorted = results.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / numSims;
  const std = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / numSims);
  const p10 = sorted[Math.floor(numSims * 0.10)];
  const p25 = sorted[Math.floor(numSims * 0.25)];
  const p50 = sorted[Math.floor(numSims * 0.50)];
  const p75 = sorted[Math.floor(numSims * 0.75)];
  const p90 = sorted[Math.floor(numSims * 0.90)];
  const p95 = sorted[Math.floor(numSims * 0.95)];
  const p99 = sorted[Math.floor(numSims * 0.99)];

  // Player-level stats.
  // Sort is required for the percentiles; everything else (mean, std, bust/boom
  // counts) is folded into two linear passes instead of the previous four
  // (two reduces + two Array.filter calls that each allocated a throwaway array).
  const playerStats = players.map((p, i) => {
    const pr = playerResults[i].sort((a, b) => a - b);
    let sum = 0;
    for (let k = 0; k < numSims; k++) sum += pr[k];
    const pmean = sum / numSims;
    const bustThresh = p.floor * 0.8, boomThresh = p.ceiling * 0.9;
    let sqDev = 0, bust = 0, boom = 0;
    for (let k = 0; k < numSims; k++) {
      const v = pr[k];
      sqDev += (v - pmean) ** 2;
      if (v < bustThresh) bust++;
      if (v > boomThresh) boom++;
    }
    return {
      name: p.name,
      mean: pmean,
      p10: pr[Math.floor(numSims * 0.10)],
      p50: pr[Math.floor(numSims * 0.50)],
      p90: pr[Math.floor(numSims * 0.90)],
      std: Math.sqrt(sqDev / numSims),
      bustRate: bust / numSims,
      boomRate: boom / numSims
    };
  });

  // ── Bootstrap standard error ─────────────────────────────────────────────
  // Split the sim results into B equal-sized groups, compute the mean/median of
  // each group, then estimate the standard error of the overall mean/median as
  //   SE = sample_SD(group estimators) / sqrt(B)
  //
  // The previous code reported sample_SD(group estimators) WITHOUT the /sqrt(B)
  // factor — that's the spread *across* groups, not the precision of the overall
  // estimate. It overestimated SE by sqrt(20) ≈ 4.47× (matches the bug already
  // patched in simulatePortfolio). At 10k sims and mean ≈ 130, the corrected SE
  // is typically 0.5–1.5 pts, not 30+. 95% CI ≈ mean ± 2 * SE.
  //
  // Groups MUST be formed from the draw-order `results`, not the score-sorted
  // `sorted`: bootstrap groups have to be random subsamples. Slicing the sorted
  // array put the lowest 5% of scores in group 0 and the highest in group 19, so
  // the group means spanned the whole distribution and inflated the SE by ~the
  // distribution's own spread (this is why meanSE read ~9 instead of ~1). The
  // sibling simulatePortfolio already groups by draw order for exactly this reason.
  const B = 20; // number of bootstrap groups
  const groupSize = Math.floor(numSims / B);
  const groupMeans = [];
  const groupP50s  = [];
  for (let b = 0; b < B; b++) {
    const slice = results.slice(b * groupSize, (b + 1) * groupSize).sort((a, c) => a - c);
    groupMeans.push(slice.reduce((s, v) => s + v, 0) / slice.length);
    groupP50s.push(slice[Math.floor(slice.length * 0.50)]);
  }
  // Use Bessel-corrected sample SD (divide by B-1) and divide by sqrt(B) to get the
  // SE of the overall estimate.
  const meanGroupSD = Math.sqrt(groupMeans.reduce((s, v) => s + (v - mean) ** 2, 0) / (B - 1));
  const p50GroupSD  = Math.sqrt(groupP50s.reduce((s, v) => s + (v - p50)  ** 2, 0) / (B - 1));
  const meanSE = parseFloat((meanGroupSD / Math.sqrt(B)).toFixed(2));
  const p50SE  = parseFloat((p50GroupSD  / Math.sqrt(B)).toFixed(2));

  return {
    mean, std, p10, p25, p50, p75, p90, p95, p99,
    min: sorted[0],
    max: sorted[numSims - 1],
    histogram: buildHistogram(sorted, 30),
    rawTotals: results, // draw-order per-sim totals; reused by simulatePortfolio for tiering
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

// Compute cash/top-10/win rates from raw simulation totals.
// Each line is a score threshold; pass null to skip that rate.
function computeLineupRates(rawTotals, cashLine, top10Line, winLine) {
  if (!rawTotals || !rawTotals.length) return { cashPct: null, top10Pct: null, winPct: null };
  const n = rawTotals.length;
  return {
    cashPct:  cashLine  != null ? rawTotals.filter(s => s >= cashLine).length  / n : null,
    top10Pct: top10Line != null ? rawTotals.filter(s => s >= top10Line).length / n : null,
    winPct:   winLine   != null ? rawTotals.filter(s => s >= winLine).length   / n : null,
  };
}

// values MUST be sorted ascending (callers pass results.sort(...)). A single
// linear walk fills the bins in O(n) instead of the old O(bins × n) — the
// previous version ran one full Array.filter pass (plus a throwaway array) per
// bin, i.e. 30 passes over every lineup's sim results.
function buildHistogram(values, bins) {
  const n = values.length;
  const min = values[0], max = values[n - 1];
  const range = max - min || 1;
  const binWidth = range / bins;
  const histogram = [];
  for (let i = 0; i < bins; i++) {
    const lo = min + i * binWidth;
    histogram.push({ lo, hi: lo + binWidth, count: 0, pct: 0 });
  }
  let bi = 0;
  for (let k = 0; k < n; k++) {
    const v = values[k];
    // Advance to the bin whose [lo, hi) contains v; the last bin is closed [lo, hi].
    while (bi < bins - 1 && v >= histogram[bi].hi) bi++;
    histogram[bi].count++;
  }
  for (let i = 0; i < bins; i++) histogram[i].pct = histogram[i].count / n;
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

// ── Analytical Stack P90 ────────────────────────────────────────────────────
//
// Estimates a stack's P90 lineup total using the correlation structure rather
// than assuming independence. Replaces "stack ceiling = 2× median" with a
// real upside estimate: sum_medians + 1.28 × sqrt(correlated variance).
//
// Correlated variance for N players:
//   Var = Σ σ_i² + 2 Σ_{i<j} ρ_ij × σ_i × σ_j
//
// σ_i = rightStd of player i (their P90 upside width); ρ_ij from getCorrelation().
// The result is used to rank stacks in generateGppLineup so tightly-correlated
// (adjacent batting order) stacks are preferred over spread-out same-team picks.
function calcAnalyticalStackP90(players) {
  if (!players || players.length < 2) return 0;
  const n = players.length;

  // Use the same effectiveCeiling/floor logic as samplePlayerScore, but simplified
  // here to avoid circular dependency — we just need the upside std per player.
  const rightStds = players.map(p => {
    const median  = p.median || 0;
    if (median <= 0) return 0.5;
    const order   = p.order || 5;
    const pos     = (p.pos || p.dkPos || p.rosterPos || '').toUpperCase();
    const isSP    = pos.includes('SP') || (pos.includes('P') && !pos.includes('RP') && !pos.includes('C'));
    let minMult   = isSP ? 1.85 : order <= 2 ? 1.65 : order <= 5 ? 1.55 : order <= 7 ? 1.45 : 1.35;
    const effCeil = Math.max(p.ceiling || 0, median * minMult);
    return Math.max((effCeil - median) / 1.28, 0.5);
  });

  const medianSum = players.reduce((s, p) => s + (p.median || 0), 0);

  // Correlated variance
  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += rightStds[i] ** 2;
    for (let j = i + 1; j < n; j++) {
      const rho = getCorrelation(players[i], players[j]);
      variance += 2 * rho * rightStds[i] * rightStds[j];
    }
  }

  return medianSum + 1.28 * Math.sqrt(Math.max(variance, 0));
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

// Fix 1 — Positional ownership default.
// When a player has no ownership projection (own=0/null), substituting 0 makes
// them appear completely unique to the optimizer, causing systematic over-rostering.
// Use positional league-average ownership instead. Pitchers run highest (ace chalk
// is routinely 30–40%); catchers are typically the lowest-owned position.
function positionalOwnDefault(player) {
  if (rp(player, 'P')) return 28;
  const pos = (player.dkPos || player.rosterPos || '').split('/')[0].trim().toUpperCase();
  if (pos === 'C') return 12;
  if (pos === 'OF') return 16;
  return 15; // 1B, 2B, 3B, SS
}

// Returns effective ownership for scoring: player's own if set, else positional default.
function effectiveOwn(player) {
  return player.own > 0 ? player.own : positionalOwnDefault(player);
}

// ── Internal Projection Engine ────────────────────────────────────────────────
// Builds median/ceiling/floor estimates from season rate stats when no external
// ROO CSV is provided. Uses the same DK scoring formula as fetchGameActuals() so
// the numbers are directly comparable to actuals tracked in slate_actuals.json.

// Expected PA per batting order slot in a 9-inning game (well-established MLB averages).
const _ORDER_PA = [0, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 3.7, 3.6];

function estimateBatterPA(player, vegasData) {
  const order = player.order || 0;
  const base = (order >= 1 && order <= 9) ? _ORDER_PA[order] : 4.0;
  // Vegas: each 1-run above league avg (4.5) adds ~3% more plate appearances
  const it = vegasData?.[player.team]?.impliedTotal;
  const vegasMult = it != null ? (1 + (it - 4.5) * 0.03) : 1.0;
  return base * Math.max(0.85, Math.min(1.15, vegasMult));
}

function buildInternalBatterProjection(player, seasonStats, vegasData) {
  const key = (player.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const s = seasonStats?.batters?.[key];
  if (!s || s.pa < 20) return null;

  const pa = estimateBatterPA(player, vegasData);
  const r = (v) => v / s.pa; // per-PA rate helper

  const singles = Math.max(0, s.h - s.doubles - s.triples - s.hr);
  const median =
    r(singles) * pa * 3 +
    r(s.doubles) * pa * 5 +
    r(s.triples) * pa * 8 +
    r(s.hr) * pa * 10 +
    r(s.rbi) * pa * 2 +
    r(s.runs) * pa * 2 +
    (r(s.bb) + r(s.hbp || 0)) * pa * 2 +
    (s.sb / Math.max(s.g, 1)) * 5; // SB per game × 5 pts (DK scoring)

  if (median <= 0.5) return null;

  // Ceiling/floor multipliers informed by batting-order position variance
  const order = player.order || 5;
  const floorMult = order <= 4 ? 0.28 : order <= 7 ? 0.22 : 0.18;
  const ceilMult  = order <= 2 ? 1.65 : order <= 4 ? 1.55 : order <= 6 ? 1.45 : 1.35;

  return {
    median:  parseFloat(median.toFixed(2)),
    ceiling: parseFloat((median * ceilMult).toFixed(2)),
    floor:   parseFloat((median * floorMult).toFixed(2)),
  };
}

function buildInternalPitcherProjection(player, seasonStats, vegasData) {
  const key = (player.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const s = seasonStats?.pitchers?.[key];
  if (!s || s.ip < 1) return null;

  // For SPs use IP/GS; for relievers use IP/G. Fallback to 5.0 if gs=0.
  const ipPerApp = s.gs >= 1 ? (s.ip / s.gs) : (s.ip / Math.max(s.g, 1));
  if (ipPerApp < 0.5) return null;

  // Expected start: typical depth, capped at 6 IP for median scenario
  const expectedIp = Math.min(ipPerApp, 6.0);
  const expectedOuts = expectedIp * 3;

  // Per-inning rates from season totals
  const kPerIp   = s.k  / s.ip;
  const erPerIp  = s.er / s.ip;
  const hPerIp   = s.h  / s.ip;
  const bbPerIp  = s.bb / s.ip;
  const hbpPerIp = (s.hbp || 0) / s.ip;

  const winProb = vegasData?.[player.team]?.winProb != null
    ? (vegasData[player.team].winProb / 100) : 0.5;

  const median =
    expectedOuts * 0.75 +
    kPerIp   * expectedIp * 2 +
    winProb  * 4 +
    erPerIp  * expectedIp * -2 +
    hPerIp   * expectedIp * -0.6 +
    (bbPerIp + hbpPerIp) * expectedIp * -0.6;

  if (median <= 0) return null;

  // Ceiling: ace scenario — 7 IP, elevated K rate, fewer ER, win bonus guaranteed
  const ceilIp   = Math.min(7.0, ipPerApp * 1.3);
  const ceilOuts = ceilIp * 3;
  const ceiling  = Math.max(median * 1.85,
    ceilOuts * 0.75 +
    kPerIp   * ceilIp * 2 * 1.15 +     // +15% Ks in a dominant start
    4 +                                  // guaranteed win in ceiling scenario
    erPerIp  * ceilIp * -2 * 0.55 +    // 45% fewer ER
    hPerIp   * ceilIp * -0.6 * 0.7);   // fewer hits allowed

  // Floor: early hook — 3 IP max, no win, elevated damage
  const floorIp   = Math.min(3.0, ipPerApp * 0.6);
  const floorOuts = floorIp * 3;
  const floor = Math.max(0,
    floorOuts * 0.75 +
    kPerIp  * floorIp * 2 +
    erPerIp * floorIp * -2 * 1.4 +
    hPerIp  * floorIp * -0.6 * 1.3);

  return {
    median:  parseFloat(median.toFixed(2)),
    ceiling: parseFloat(ceiling.toFixed(2)),
    floor:   parseFloat(Math.max(0, floor).toFixed(2)),
  };
}

// Apply internal projections to the pool, but only for players that have no external
// ROO data (hasRoo=false) or whose median is still 0. This keeps the CSV-sourced
// projections as the primary anchor and uses the internal model only as a fallback.
function buildInternalProjections(pool, seasonStats, vegasData) {
  return pool.map(p => {
    if (p.hasRoo && (p.median || 0) > 0) return p;
    const isP = rp(p, 'P');
    const proj = isP
      ? buildInternalPitcherProjection(p, seasonStats, vegasData)
      : buildInternalBatterProjection(p, seasonStats, vegasData);
    if (!proj) return p;
    return { ...p, ...proj, hasInternalProj: true };
  });
}

// ── Ownership Projection & Input-Sanity Layer (Fix #1) ────────────────────────
//
// The whole leverage / field / simROI stack is downstream of the `own` numbers the
// user uploads. Nothing previously validated that input — a stale or wrong ROO
// ownership column produced confidently-wrong leverage and ROI. This layer builds an
// INTERNAL ownership estimate from the same signals the field actually responds to
// (projected value, salary, Vegas implied total, batting order, position) so we can
//   (a) fill missing ownership with a per-player estimate instead of a flat positional
//       constant, and
//   (b) flag uploaded numbers that deviate hard from expectation (probable staleness).
//
// Method: within each roster-slot position group, players' "appeal" (value × Vegas ×
// PA-order for batters; value × win-prob for pitchers) is softmax-normalised over a
// fixed ownership budget = (slot count × 100%). This mirrors the structural fact that
// summed ownership across a position equals the number of lineup slots it fills. It is a
// heuristic, not a trained model — but it correlates ownership with value/salary/Vegas,
// which is exactly the sanity check that was missing.
const _OWN_SLOTS = { P: 2, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3 };
function _ownPrimaryPos(p) {
  if (rp(p, 'P')) return 'P';
  const pos = (p.dkPos || p.rosterPos || '').split('/')[0].trim().toUpperCase();
  return _OWN_SLOTS[pos] != null ? pos : 'OF';
}

function projectOwnership(pool, context = {}) {
  const { vegasData = null } = context;

  // ── Salary-rank penalty: DFS players systematically under-own the most expensive
  // players relative to their value because "everyone knows" top salaries are good
  // and the field chases cheaper upside. Within each position group, top-quartile
  // earners get a -8% appeal haircut and bottom-half earners get a +3% boost.
  // This narrows chalk concentration without changing rank ordering.
  const _salaryPenalty = new Map();
  const _salGroups = {};
  for (const p of pool) {
    if (!(p.salary > 0) || rp(p, 'P')) continue; // pitchers excluded — salary/ownership is less linear
    const pos = _ownPrimaryPos(p);
    (_salGroups[pos] = _salGroups[pos] || []).push(p);
  }
  for (const players of Object.values(_salGroups)) {
    const sorted = [...players].sort((a, b) => (b.salary || 0) - (a.salary || 0));
    const q1 = Math.ceil(sorted.length * 0.25);
    const q2 = Math.ceil(sorted.length * 0.50);
    sorted.forEach((p, i) => {
      _salaryPenalty.set(p, i < q1 ? 0.92 : i >= q2 ? 1.03 : 1.0);
    });
  }

  // ── Team concentration bonus: the top-3 teams by implied total attract disproportionate
  // field ownership due to recency bias and narrative stacking. Add a 5% boost to all
  // batters from those teams so the ownership model mirrors that crowding effect.
  const _teamConcentration = new Map();
  if (vegasData) {
    const teamTotals = Object.entries(vegasData)
      .filter(([, v]) => v?.impliedTotal > 0)
      .sort((a, b) => (b[1].impliedTotal || 0) - (a[1].impliedTotal || 0))
      .slice(0, 3)
      .map(([team]) => team);
    for (const p of pool) {
      if (!rp(p, 'P') && teamTotals.includes(p.team)) _teamConcentration.set(p, 1.05);
    }
  }

  // Appeal score per player — the raw driver of field ownership.
  const appeal = new Map();
  for (const p of pool) {
    if (!(p.salary > 0) || !((p.median || 0) > 0)) { appeal.set(p, 0); continue; }
    if (rp(p, 'P')) {
      // Pitchers: pure value (median/salary) + win probability boost.
      let a = (p.median / p.salary) * 1000;
      if (p.winProb != null) a *= (1 + (p.winProb - 0.5) * 0.4);
      appeal.set(p, Math.max(0, a));
    } else {
      // Batters: blend median (55%) and ceiling (45%) so high-ceiling stars like power
      // hitters are modelled closer to their actual field ownership. Pure median/salary
      // underestimates boom-or-bust stars who the field chases for their upside, not value.
      const blendedPts = (p.median || 0) * 0.55 + (p.ceiling || 0) * 0.45;
      let a = (blendedPts / p.salary) * 1000;
      const it = vegasData?.[p.team]?.impliedTotal;
      if (it != null && it > 1.5) a *= (it / 4.5);
      a *= orderPAMult(p.order || 5);
      a *= (_salaryPenalty.get(p) ?? 1.0);
      a *= (_teamConcentration.get(p) ?? 1.0);
      appeal.set(p, Math.max(0, a));
    }
  }

  // Group by primary position and allocate each position's ownership budget across its
  // players with a scale-free power law: weight ∝ appeal^GAMMA. This is intentionally NOT
  // a z-score softmax — dividing by the group's SD would amplify tiny value differences
  // into huge ownership gaps even when every player is essentially equal value. The power
  // law keeps ownership near-uniform when value is flat and only concentrates when a player
  // is genuinely higher value, which is how the field actually behaves.
  const groups = {};
  for (const p of pool) {
    const pos = _ownPrimaryPos(p);
    (groups[pos] = groups[pos] || []).push(p);
  }

  const GAMMA = 2.5;   // value sensitivity — higher = more concentration on top plays
  const OWN_CAP = 50;  // single-player ownership ceiling (a realistic chalk max)
  const out = [];
  for (const [pos, players] of Object.entries(groups)) {
    const budget = (_OWN_SLOTS[pos] ?? 1) * 100;
    const weights = players.map(p => {
      const a = appeal.get(p) || 0;
      return a > 0 ? Math.pow(a, GAMMA) : 0;
    });
    const sumW = weights.reduce((s, v) => s + v, 0) || 1;
    // Proportional allocation of the position's ownership budget.
    const proj = weights.map(w => budget * (w / sumW));
    // Redistribute capped excess to the uncapped players so the group still sums to the
    // budget. Without this, clipping at OWN_CAP leaks budget and biases every projection
    // LOW — which made uploaded ownership look uniformly "too high" and over-fired the audit.
    for (let iter = 0; iter < 6; iter++) {
      let excess = 0;
      const uncapped = [];
      for (let i = 0; i < proj.length; i++) {
        if (proj[i] > OWN_CAP) { excess += proj[i] - OWN_CAP; proj[i] = OWN_CAP; }
        else if (proj[i] > 0 && proj[i] < OWN_CAP - 1e-6) uncapped.push(i);
      }
      if (excess <= 0.05 || !uncapped.length) break;
      const uncSum = uncapped.reduce((s, i) => s + proj[i], 0) || 1;
      uncapped.forEach(i => { proj[i] = Math.min(OWN_CAP, proj[i] + excess * (proj[i] / uncSum)); });
    }
    players.forEach((p, i) => {
      out.push({
        name: p.name, team: p.team, pos,
        projectedOwn: parseFloat(Math.max(0, proj[i]).toFixed(1)),
        uploadedOwn: p.own || 0,
      });
    });
  }
  return out;
}

// Compare uploaded ownership against the internal projection and flag SUSPECT numbers.
//
// The projection is a deliberately crude value-based heuristic, so it will routinely
// disagree with a good ROO export by 10–15 points on individual players — that is NOT a
// data-quality problem and must not be flagged, or the banner cries wolf and gets ignored.
// We therefore flag only the one pattern that genuinely signals stale/wrong data:
//   an uploaded ownership that is implausibly HIGH for how little value the player offers.
// Concretely a flag requires ALL of:
//   • uploaded ≥ OWN_FLAG_MIN              — ignore noise on low-owned players
//   • uploaded ≥ projected × OWN_FLAG_RATIO — far more owned than any value justifies
//   • uploaded − projected ≥ OWN_FLAG_GAP   — a large absolute gap, not a rounding nit
// The "lower than model" direction is intentionally never flagged: a player owned less
// than expected is ordinary field/leverage behaviour, not an error.
const OWN_FLAG_MIN = 20;    // minimum uploaded ownership to even consider flagging
const OWN_FLAG_RATIO = 2.5; // uploaded must be ≥ this multiple of the projection
const OWN_FLAG_GAP = 15;    // …and at least this many points above it
function auditOwnership(pool, context = {}) {
  const projections = projectOwnership(pool, context);
  const flags = [];
  for (const r of projections) {
    if (r.uploadedOwn <= 0) continue; // missing ownership is handled by fill, not flagged
    const delta = parseFloat((r.uploadedOwn - r.projectedOwn).toFixed(1));
    const ratio = r.uploadedOwn / Math.max(r.projectedOwn, 0.5);
    if (r.uploadedOwn >= OWN_FLAG_MIN && ratio >= OWN_FLAG_RATIO && delta >= OWN_FLAG_GAP) {
      flags.push({
        name: r.name, team: r.team, pos: r.pos,
        uploadedOwn: r.uploadedOwn, projectedOwn: r.projectedOwn,
        delta, direction: 'higher',
      });
    }
  }
  flags.sort((a, b) => b.delta - a.delta);
  return { projections, flags };
}

// Return a pool copy with ownership filled from the projection.
// fillMissingOnly (default true): only players with own<=0 are populated — uploaded
// numbers are left untouched. Set false to overwrite all ownership with the projection
// (useful when no ownership file was uploaded at all). Populated values are marked with
// ownProjected=true so the UI can distinguish modelled ownership from uploaded ownership.
function applyOwnershipProjection(pool, context = {}, fillMissingOnly = true) {
  const projByName = new Map(projectOwnership(pool, context).map(r => [r.name, r.projectedOwn]));
  return pool.map(p => {
    const proj = projByName.get(p.name);
    if (proj == null) return p;
    if (fillMissingOnly && p.own > 0) return p;
    return { ...p, own: proj, ownProjected: true };
  });
}

// GPP Score: composite metric for tournament value
function calcGppScore(player, contestSize = 1000) {
  const ceiling = player.ceiling || 0;
  const floor = player.floor || 0;
  const rawOwn = effectiveOwn(player);
  // In DK Showdown CPT mode, captain-slot ownership diverges from FLEX ownership.
  // High-projection players (FLEX own ≥20%) are over-captained (~1.25× FLEX rate);
  // low-own players (<10%) are rarely captained (~0.75× FLEX rate), creating leverage CPT
  // opportunities the ownership penalty would otherwise under-penalise or over-penalise.
  const own = player.isCpt
    ? (rawOwn >= 20 ? rawOwn * 1.25 : rawOwn < 10 ? rawOwn * 0.75 : rawOwn)
    : rawOwn;
  const median = player.median || 0;
  const salary = player.salary || 1;

  // P90 estimate — ceiling IS the P90 (same SIGMA_P90=1.28 convention as samplePlayerScore)
  // so p90 = ceiling directly; the rightStd path is kept for the 0.5 floor clamp edge case.
  const rightStd = Math.max((ceiling - median) / 1.28, 0.5);
  const p90 = median + 1.28 * rightStd;

  // Percentile-target blend: ceiling-weighted for GPP upside selection
  const targetScore = 0.3 * median + 0.7 * p90;

  // Ownership leverage: full fade — differentiate from chalk in large fields
  const ownershipEdge = 1 / (1 + own / 100 * Math.log10(contestSize));

  // Leverage premium (10% weight): rewards high-ceiling, low-ownership players
  // beyond what the simple ownership edge captures. calcLeverage is also used as a
  // display metric; wiring it here ensures construction and display are aligned.
  // 0.08 coefficient keeps the premium in tiebreaker territory (~0.4–1.2 pts).
  const leverageBonus = calcLeverage(player, contestSize) * 0.08;

  return targetScore * ownershipEdge + leverageBonus;
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
  // Cap raised to ±8%: extreme heat (90°F+) or cold (38°F) combined with wind can
  // compound beyond the ±5% cap — projection CSVs rarely price in full environment
  // on day-of slate builds, so the wider cap captures genuine edge at the extremes.
  const tempDev = temp - 72;
  const tempHit = Math.max(-0.08, Math.min(0.08, tempDev * 0.0017));

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
// Maximum plausible single-session line movement. Legitimate sharp-money moves
// rarely exceed 1.0 run; 1.5 is a conservative ceiling that catches feed artifacts
// (e.g. a double-count of the same refresh) while allowing real large moves through.
// When the guard fires, the effective implied total is clamped to open ± this cap
// so the base multiplier isn't distorted — the lineMovBonus still reflects the
// capped movement, keeping the directional signal intact.
const MAX_LINE_MOVE = 1.5;

function vegasAdjustment(player, vegasData, opts = {}) {
  if (!vegasData) return 1.0;

  const teamData = vegasData[player.team];
  if (!teamData || !teamData.impliedTotal) return 1.0;

  let impliedTotal = teamData.impliedTotal;

  // Guard: values below 1.5 indicate a cancelled/postponed game or stale/bad data.
  // Without this, a sentinel like 0.32 (HOU) produces a 0.071x multiplier that
  // crushes all HOU batters based on a data artifact rather than real game info.
  if (impliedTotal < 1.5) return 1.0;

  const avgImplied = 4.5; // League average implied total

  // Anomaly guard: clamp the effective implied total when line movement exceeds
  // MAX_LINE_MOVE. A +2.56 run move in one session (e.g. LAD 5.29 → 7.85) is
  // almost certainly a feed artifact. We preserve the directional signal but prevent
  // the distorted value from pinning the base multiplier at the ±25% cap.
  if (teamData.openTotal > 0 && Math.abs(impliedTotal - teamData.openTotal) > MAX_LINE_MOVE) {
    impliedTotal = teamData.openTotal + Math.sign(impliedTotal - teamData.openTotal) * MAX_LINE_MOVE;
  }

  // Base scale: 4.5 avg → 1.0x; 5.5 → 1.22x; 3.5 → 0.78x.
  // Clamped to ±25% so extreme implied totals don't dominate.
  // When opts.lineMovOnly is true (projection source already priced in Vegas),
  // suppress the base scale to 1.0 — only the post-open line movement is kept as
  // a residual sharp-money signal not yet in the projection.
  const raw = opts.lineMovOnly ? 1.0 : impliedTotal / avgImplied;

  // Line movement signal: sharp money direction (openTotal → impliedTotal delta).
  // Each 1-run move adds/subtracts ~2% — e.g. +1.5 run move = +3% batter boost.
  // Capped at ±6% so it supplements the base adjustment without overwhelming it.
  let lineMovBonus = 0;
  if (teamData.openTotal > 0 && teamData.openTotal !== impliedTotal) {
    const movement = impliedTotal - teamData.openTotal;
    lineMovBonus = Math.max(-0.06, Math.min(0.06, movement * 0.02));
  }

  return Math.max(0.75, Math.min(1.25, raw + lineMovBonus));
}

function vegasPitcherAdjustment(pitcher, vegasData, opts = {}) {
  if (!vegasData || !pitcher.opp) return 1.0;

  const oppData = vegasData[pitcher.opp];
  if (!oppData || !oppData.impliedTotal) return 1.0;

  let oppImplied = oppData.impliedTotal;

  // Guard: cancelled/postponed game sentinel — treat as neutral environment.
  if (oppImplied < 1.5) return 1.0;

  // Anomaly guard: same logic as batter-side — clamp effective implied when movement
  // exceeds MAX_LINE_MOVE so the pitcher's multiplier isn't driven by feed errors.
  if (oppData.openTotal > 0 && Math.abs(oppImplied - oppData.openTotal) > MAX_LINE_MOVE) {
    oppImplied = oppData.openTotal + Math.sign(oppImplied - oppData.openTotal) * MAX_LINE_MOVE;
  }

  const avgImplied = 4.5; // League average implied total
  // Linear scale: each run above/below average moves multiplier by ~4.4%.
  // Clamped to ±20% so extreme totals don't produce nonsensical adjustments.
  // opts.lineMovOnly suppresses the base scale to 1.0 (source-already-includes-Vegas case).
  const raw = opts.lineMovOnly ? 1.0 : 1.0 + (avgImplied - oppImplied) / avgImplied * 0.20;

  // Line movement signal for pitchers: opponent scoring line moving up = worse
  // environment; moving down = better. Capped at ±4%.
  let lineMovBonus = 0;
  if (oppData.openTotal > 0 && oppData.openTotal !== oppImplied) {
    const movement = oppImplied - oppData.openTotal;
    // Movement up = more expected runs against pitcher = negative bonus
    lineMovBonus = Math.max(-0.04, Math.min(0.04, -movement * 0.015));
  }

  return Math.max(0.80, Math.min(1.20, raw + lineMovBonus));
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

// Portfolio diversity analysis: examine play classifications in generated lineups
function analyzePortfolioDiversity(lineups, bestPlaysContext = null) {
  if (!bestPlaysContext || !lineups.length) {
    return {
      total: lineups.length,
      withLeverage: 0,
      withContrarian: 0,
      withBringBack: 0,
      withChalk: 0,
      avgLeverageCount: 0,
      avgChalkCount: 0,
      avgContrarianCount: 0,
      avgBringBackCount: 0
    };
  }

  let luWithLeverage = 0, luWithContrarian = 0, luWithBringBack = 0, luWithChalk = 0;
  let totalLeverage = 0, totalChalk = 0, totalContrarian = 0, totalBringBack = 0;

  lineups.forEach(lu => {
    const luNames = new Set((lu || []).map(p => p?.name).filter(Boolean));
    let hasLeverage = false, hasContrarian = false, hasBringBack = false, hasChalk = false;
    let leverageCount = 0, chalkCount = 0, contrarianCount = 0, bringBackCount = 0;

    luNames.forEach(name => {
      if (bestPlaysContext.leveragePlays?.has(name)) {
        hasLeverage = true;
        leverageCount++;
      }
      if (bestPlaysContext.contrarianPlayers?.has(name)) {
        hasContrarian = true;
        contrarianCount++;
      }
      if (bestPlaysContext.bringBackPlayers?.has(name)) {
        hasBringBack = true;
        bringBackCount++;
      }
      if (bestPlaysContext.chalkPlayers?.has(name)) {
        hasChalk = true;
        chalkCount++;
      }
    });

    if (hasLeverage) luWithLeverage++;
    if (hasContrarian) luWithContrarian++;
    if (hasBringBack) luWithBringBack++;
    if (hasChalk) luWithChalk++;

    totalLeverage += leverageCount;
    totalChalk += chalkCount;
    totalContrarian += contrarianCount;
    totalBringBack += bringBackCount;
  });

  return {
    total: lineups.length,
    withLeverage: luWithLeverage,
    withContrarian: luWithContrarian,
    withBringBack: luWithBringBack,
    withChalk: luWithChalk,
    avgLeverageCount: (totalLeverage / lineups.length).toFixed(2),
    avgChalkCount: (totalChalk / lineups.length).toFixed(2),
    avgContrarianCount: (totalContrarian / lineups.length).toFixed(2),
    avgBringBackCount: (totalBringBack / lineups.length).toFixed(2),
    leveragePct: Math.round(luWithLeverage / lineups.length * 100),
    contrarianPct: Math.round(luWithContrarian / lineups.length * 100),
    bringBackPct: Math.round(luWithBringBack / lineups.length * 100),
    chalkPct: Math.round(luWithChalk / lineups.length * 100)
  };
}

// Enforce contrarian stack in a lineup by replacing low-score batters with contrarian players
function enforceContrarianStack(lineup, contrarianTeam, contrarianPlayers, pool, context = {}) {
  if (!contrarianTeam || !contrarianPlayers?.length) return lineup;

  const result = [...lineup];
  const contrarianNames = new Set(contrarianPlayers.map(p => typeof p === 'string' ? p : p.name));
  const contrarianInLineup = new Set();

  // Count contrarian players already in lineup
  result.forEach(p => {
    if (p && contrarianNames.has(p.name)) contrarianInLineup.add(p.name);
  });

  // Try to add missing contrarian players (up to the available count)
  const missingNames = [...contrarianNames].filter(n => !contrarianInLineup.has(n));
  if (missingNames.length === 0) return result; // All contrarian already in lineup

  // Find replaceable slots (lowest-scoring non-pitcher, non-contrarian batters)
  const scoreFn = context.scoreFn || ((p) => p.median || 0);
  const replaceableBatters = result
    .map((p, i) => ({
      idx: i,
      p,
      score: p && !contrarianNames.has(p.name) && !rp(p, 'P') ? scoreFn(p, context) : Infinity
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(3, missingNames.length)); // Replace up to 3 low-score batters

  // Swap in contrarian players — verify salary cap is maintained AND position is valid.
  const SALARY_CAP_LOCAL = 50000;
  missingNames.slice(0, replaceableBatters.length).forEach((name, i) => {
    const replacement = pool.find(p => p.name === name);
    const targetIdx = replaceableBatters[i]?.idx;
    if (!replacement || targetIdx == null || targetIdx < 0) return;
    // Reject if the replacement isn't eligible for the target slot (position mismatch).
    if (!DK_SLOTS[targetIdx]?.eligible(replacement)) {
      // Try to find any open batter slot the replacement IS eligible for.
      const altIdx = result.findIndex((p, si) =>
        p && !rp(p, 'P') && !contrarianNames.has(p.name) &&
        DK_SLOTS[si]?.eligible(replacement)
      );
      if (altIdx < 0) return; // no compatible slot — skip this contrarian player
      replaceableBatters[i] = { ...replaceableBatters[i], idx: altIdx };
    }
    const swapIdx = replaceableBatters[i].idx;
    const oldPlayer = result[swapIdx];
    const currentTotal = result.reduce((s, p) => s + (p?.salary || 0), 0);
    const newTotal = currentTotal - (oldPlayer?.salary || 0) + replacement.salary;
    if (newTotal <= SALARY_CAP_LOCAL) {
      result[swapIdx] = replacement;
    }
  });

  return result;
}

// Ensure a minimum % of lineups contain specific play classifications
function enforcePlayInclusionTarget(lineups, playNames, targetPct = 0.5, pool = []) {
  if (!lineups.length || !playNames?.length || targetPct <= 0) return lineups;

  const targetCount = Math.ceil(lineups.length * targetPct);
  const playSet = new Set(playNames.map(p => typeof p === 'string' ? p : p.name));
  const SALARY_CAP_LOCAL = 50000; // ensure we have access to the cap

  // Count lineups that already have at least one play
  let linesWithPlay = 0;
  const needPlay = [];
  lineups.forEach((lu, idx) => {
    const hasPlay = (lu || []).some(p => p && playSet.has(p.name));
    if (hasPlay) {
      linesWithPlay++;
    } else {
      needPlay.push(idx);
    }
  });

  // If target already met, return as-is
  if (linesWithPlay >= targetCount) return lineups;

  // Otherwise, inject plays into lowest-scoring lineups
  const linesToUpdate = needPlay.slice(0, targetCount - linesWithPlay);
  linesToUpdate.forEach(idx => {
    const lu = lineups[idx];
    if (!lu) return;

    // Find lowest-scoring non-pitcher to replace
    const lowestIdx = lu.reduce((min, p, i) => {
      if (!p || rp(p, 'P')) return min;
      const score = p.median || 0;
      return score < ((lu[min] && (lu[min].median || 0)) || Infinity) ? i : min;
    }, -1);

    if (lowestIdx >= 0 && lowestIdx < lu.length) {
      const oldPlayer = lu[lowestIdx];
      const replacement = pool.find(p => 
        playSet.has(p.name) && !lu.some(x => x?.name === p.name)
      );
      if (replacement && oldPlayer) {
        // Find the slot the replacement is actually eligible for (may differ from lowestIdx).
        let swapIdx = DK_SLOTS[lowestIdx]?.eligible(replacement) ? lowestIdx : -1;
        if (swapIdx < 0) {
          // Try any other non-pitcher slot the replacement can fill.
          swapIdx = lu.findIndex((p, si) =>
            p && !rp(p, 'P') && !playSet.has(p.name) && DK_SLOTS[si]?.eligible(replacement)
          );
        }
        if (swapIdx < 0) return; // no compatible slot — skip injection for this lineup
        const swapTarget = lu[swapIdx];
        const currentTotal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
        const newTotal = currentTotal - (swapTarget?.salary || 0) + replacement.salary;
        if (newTotal <= SALARY_CAP_LOCAL) {
          lineups[idx][swapIdx] = replacement;
        }
      }
    }
  });

  return lineups;
}

// Best plays weighting: apply bonuses/penalties based on play classifications
function bestPlaysWeighting(p, context = {}, contestType = 'single') {
  const { bestPlaysContext = null, useBestPlaysWeighting = false } = context;
  if (!useBestPlaysWeighting || !bestPlaysContext) return 1.0;

  const pName = p.name;
  let multiplier = 1.0;

  // Leverage plays: +2.5% across all contest types
  if (bestPlaysContext.leveragePlays?.has(pName)) {
    multiplier *= 1.025;
  }

  // Bring-back plays: +1.5% across all contest types
  if (bestPlaysContext.bringBackPlayers?.has(pName)) {
    multiplier *= 1.015;
  }

  // Contrarian plays: +3% boost for GPP, +1.5% for others
  if (bestPlaysContext.contrarianPlayers?.has(pName)) {
    multiplier *= contestType === 'gpp' ? 1.03 : 1.015;
  }

  // Chalk plays: -2.5% penalty across all contest types (especially bad for GPP)
  // GPP gets extra penalty for chalk (-3% instead of -2.5%)
  if (bestPlaysContext.chalkPlayers?.has(pName)) {
    multiplier *= contestType === 'gpp' ? 0.97 : 0.975;
  }

  return multiplier;
}

function optimalExposureBoost(_p, _context, _mode) {
  return 1.0; // no-op — circular loop broken
}

function buildPlayerContext(p, context = {}) {
  const { vegasData, parkFactors, weatherData, stadiums, teamScoring, umpireData, blendWeights, bullpenData, framingMap, sprintSpeedData, dvpData, pool,
    sourceIncludesPark, sourceIncludesVegas } = context;
  const isP = rp(p, 'P');
  const homeTeam = p.game ? p.game.split('@')[1] : p.team;
  const bpAdj = bullpenAdjustment(p, bullpenData);
  const cfAdj = catcherFramingAdjustment(p, framingMap);
  const ssBoost = sprintSpeedBoost(p, sprintSpeedData);
  // When sourceIncludesVegas is true, the projection CSV already prices in Vegas implied totals.
  // We suppress the base scale and keep only the post-open line-movement signal (residual sharp money).
  const vegasOpts = { lineMovOnly: !!sourceIncludesVegas };
  const vegasAdj = isP ? vegasPitcherAdjustment(p, vegasData, vegasOpts) : vegasAdjustment(p, vegasData, vegasOpts);
  // When sourceIncludesPark is true, the projection CSV already prices in park factors.
  // Skip the park multiplier entirely — using 1.0 prevents double-counting park effects.
  const pf = sourceIncludesPark ? { overall: 1.0, hr: 1.0, run: 1.0 } : parkMultiplier(homeTeam, parkFactors);
  const tsAdj = teamScoringAdjustment(p, teamScoring);
  const scW = (blendWeights?.Statcast ?? 100) / 100;
  const scBoost = isP ? (1.0 + (pitcherStuffBoost(p) - 1.0) * scW) : (1.0 + (statcastCeilingBoost(p) - 1.0) * scW);
  const umpTend = umpireData?.[homeTeam] || null;
  const umpBoost = umpireMultiplier(umpTend, isP);

  let wm = { hitting: 1.0, pitching: 1.0 };
  if (weatherData && homeTeam) {
    const isDome = stadiums?.domes?.includes(homeTeam);
    if (!isDome && weatherData[homeTeam]) wm = weatherMultiplier(weatherData[homeTeam]);
  }

  // ── Platoon split: find opposing SP in pool, compare hands ─────────────────
  // Only applied to batters with known hand vs. a pitcher with known hand.
  // Pitchers skip — platoon direction is the batter-side effect, not pitcher-side.
  let platoonMult = 1.0;
  if (!isP && p.hand && pool) {
    // Prefer confirmed SP, then fall back to highest-salary pitcher facing this team
    const oppPitchers = pool.filter(q => rp(q, 'P') && q.opp === p.team && q.hand);
    const oppSP = oppPitchers.find(q => q.isConfirmed) || oppPitchers.sort((a, b) => (b.salary || 0) - (a.salary || 0))[0];
    if (oppSP?.hand) {
      // Fix #5: PA-weight the starter platoon edge and account for the bullpen share.
      // bullpenData[opp].rhpShare (if present) supplies the pen's L/R innings mix;
      // otherwise the bullpen portion regresses to neutral.
      const oppBullpen = bullpenData?.[p.opp] || null;
      platoonMult = platoonMultiplierPAWeighted(p.hand, oppSP.hand, oppBullpen);
    }
  }

  // ── DvP: how many DK pts the opposing team allows to this position ──────────
  const dvpMult = dvpMultiplier(p, dvpData);

  // ── 14-day form: hot/cold streak adjustment ──────────────────────────────────
  // Separate weights for batters and pitchers — 14-day pitcher ERA over 4-5 starts
  // is weak signal (small sample, ace variance), while 14-day batter performance is
  // meaningfully more reliable. Default pitcher weight to 0 unless user opts in.
  // Falls back to legacy 'Form (14d)' weight for backward compatibility.
  const legacyFormW = blendWeights?.['Form (14d)'] ?? 0;
  const batterFormW = blendWeights?.['Form (14d) Batters'] ?? legacyFormW;
  const pitcherFormW = blendWeights?.['Form (14d) Pitchers'] ?? 0;
  const formW = isP ? pitcherFormW : batterFormW;
  const formMult = formMultiplier(p, formW);

  // ── Unconfirmed lineup penalty ──────────────────────────────────────────────
  const unconfMult = unconfirmedMultiplier(p, context);

  // Composite multiplier chain.
  // Each factor is small (±3–12%), stacking compounds. Cap at ±35% so no single
  // adjustment dominates the projection. Platoon and DvP are batter-only.
  const rawBatterMult = vegasAdj * pf.run * wm.hitting * tsAdj.batting * scBoost * umpBoost * bpAdj * cfAdj * ssBoost * platoonMult * dvpMult * formMult * unconfMult;
  const rawPitcherMult = vegasAdj * wm.pitching * tsAdj.pitching * scBoost * umpBoost * bpAdj * cfAdj * ssBoost * formMult * unconfMult;
  const batterMult = Math.max(0.65, Math.min(1.35, rawBatterMult));
  const pitcherMult = Math.max(0.65, Math.min(1.35, rawPitcherMult));
  const hrMult = pf.hr; // GPP batters use hr park factor instead of run

  return { isP, homeTeam, pf, vegasAdj, wm, tsAdj, scBoost, umpBoost, bpAdj, cfAdj, ssBoost, platoonMult, dvpMult, formMult, unconfMult, batterMult, pitcherMult, hrMult, rawBatterMult, rawPitcherMult };
}

function scoreCash(p, context = {}) {
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'cash');
  const bestPlaysBoost = bestPlaysWeighting(p, context, 'cash');

  if (pc.isP) {
    // Fix 4: opener/bulk reliever — 1-inning ceiling capped at 1.25× median, no matchup signal
    if (p.isOpener) {
      const cappedCeiling = Math.min(p.ceiling || 0, (p.median || 0) * 1.25);
      return ((p.median || 0) * 2.5 + (p.floor || 0) * 1.5 + cappedCeiling * 0.2)
        * 0.60 * pc.pitcherMult * optBoost * bestPlaysBoost;
    }
    const kBonus = Math.max(0, ((p.kRate || 0) - 15) * 0.18);
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 2.5 + (p.floor || 0) * 1.5 + matchup * 2 + kBonus + winProb * 3)
      * pc.pitcherMult * optBoost * bestPlaysBoost;
  }

  const paMult = orderPAMult(p.order);
  // Flat order bonus for top-4 hitters on top of the PA multiplier.
  // Ensures early-order players rank meaningfully higher for cash floor builds.
  const orderBonus = p.order > 0 && p.order <= 4 ? (5 - p.order) * 0.8 : 0;
  const variance = (p.ceiling || 0) - (p.floor || 0);
  return ((p.median || 0) * 2.0 + (p.floor || 0) * 1.5 - variance * 0.3 + orderBonus)
    * paMult * pc.batterMult * optBoost * bestPlaysBoost;
}

function scoreSingle(p, context = {}) {
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'single');
  const bestPlaysBoost = bestPlaysWeighting(p, context, 'single');
  const value = p.salary > 0 ? (p.median || 0) / p.salary * 1000 : 0;

  if (pc.isP) {
    // Fix 4: opener penalty — capped ceiling, no K-bonus, no matchup
    if (p.isOpener) {
      const cappedCeiling = Math.min(p.ceiling || 0, (p.median || 0) * 1.25);
      return ((p.median || 0) * 1.5 + cappedCeiling * 0.4 + value * 0.2)
        * 0.65 * pc.pitcherMult * optBoost * bestPlaysBoost;
    }
    const kBonus = Math.max(0, ((p.kRate || 0) - 15) * 0.135);
    const matchup = getPitcherMatchupScore(p, context);
    return ((p.median || 0) * 1.5 + (p.ceiling || 0) * 0.8 + value * 0.3 + matchup + kBonus)
      * pc.pitcherMult * optBoost * bestPlaysBoost;
  }

  const paMult = orderPAMult(p.order);
  return ((p.median || 0) * 1.2 + (p.ceiling || 0) * 0.6 + value * 0.4)
    * paMult * pc.batterMult * optBoost * bestPlaysBoost;
}

function scoreGpp(p, context = {}) {
  const { contestSize = 1000, primaryStackTeam, bringBackTeam, secondaryStackTeam, primaryStackOrders = [] } = context;
  const pc = buildPlayerContext(p, context);
  const optBoost = optimalExposureBoost(p, context, 'gpp');
  const bestPlaysBoost = bestPlaysWeighting(p, context, 'gpp');

  // CPT multiplier: DK showdown captain slot scores 1.5× points, so optimizer must
  // value CPT candidates proportionally higher to select the right player to captain.
  const cptMult = p.isCpt ? 1.5 : 1.0;

  if (pc.isP) {
    // Fix 4: opener/bulk reliever — suppress K-bonus, matchup, and winProb; cap ceiling
    if (p.isOpener) {
      const cappedCeiling = Math.min(p.ceiling || 0, (p.median || 0) * 1.25);
      const ownPenalty = effectiveOwn(p) * 0.08 * (Math.log10(Math.max(contestSize, 10)) / 3);
      return (cappedCeiling * 0.5 + (p.median || 0) * 0.5 - ownPenalty)
        * 0.60 * pc.pitcherMult * optBoost * bestPlaysBoost * cptMult;
    }
    const kBonus = Math.max(0, ((p.kRate || 0) - 15) * 0.18);
    const winProb = p.winProb || 0.5;
    const matchup = getPitcherMatchupScore(p, context);
    const ownPenalty = effectiveOwn(p) * 0.08 * (Math.log10(Math.max(contestSize, 10)) / 3);  // Fix 1
    return ((p.ceiling || 0) * 0.8 + (p.median || 0) * 1.0 + matchup - ownPenalty + kBonus + winProb * 2)
      * pc.pitcherMult * optBoost * bestPlaysBoost * cptMult;
  }

  const gppScore = calcGppScore(p, contestSize);
  const paMult = orderPAMult(p.order);

  // Stack depth bonus: batters from the primary stack team get a boost to encourage
  // completing the stack over picking equivalent players from another game.
  // Adjacency-aware: a batter whose batting order is within 2 spots of already-placed
  // stack members gets +10% (they're in the same rally sequence); non-adjacent stack team
  // members get +5% (still preferred over other teams, but less so). Falls back to +7%
  // when no confirmed batting order data is available.
  // Pitchers are excluded — this is purely a batter correlation effect.
  const stackDepthBoost = (primaryStackTeam && p.team === primaryStackTeam)
    ? (primaryStackOrders.length > 0 && p.order > 0
        ? (primaryStackOrders.some(o => Math.abs(o - p.order) <= 2) ? 1.10 : 1.05)
        : 1.07)
    : 1.0;

  // Bring-back depth bonus: batters from the bring-back team get a +4% boost so the
  // optimizer naturally deepens the bring-back to a 2-man secondary cluster when
  // projections support it. Smaller than primaryStackTeam to preserve hierarchy.
  const bbDepthBoost = (bringBackTeam && p.team === bringBackTeam && p.team !== primaryStackTeam) ? 1.04 : 1.0;

  // Secondary-stack depth bonus: batters from the cross-game secondary stack team get a
  // +5% boost so the fill/1-swap keeps the cluster intact and can grow a 2-man into a
  // 3-man when projections support it. Sits between the primary (+7%) and bring-back
  // (+4%) so the structural hierarchy primary > secondary > bring-back is preserved.
  const secDepthBoost = (secondaryStackTeam && p.team === secondaryStackTeam
    && p.team !== primaryStackTeam && p.team !== bringBackTeam) ? 1.05 : 1.0;

  return gppScore * paMult * pc.hrMult * pc.batterMult / pc.pf.run * optBoost * stackDepthBoost * bbDepthBoost * secDepthBoost * cptMult;
}

// Slate-relative average batter median, memoized per pool array.
// Fix #5: getPitcherMatchupScore previously anchored "league-average opponent" at a
// hardcoded 7.0 DK median, which drifts with whatever scale the projection source uses
// (different sites/seasons scale ROO medians differently). Computing the anchor from the
// actual pool keeps the matchup signal centered regardless of projection scale.
const _slateBatterBaselineCache = new WeakMap();
function slateBatterMedianBaseline(pool) {
  if (_slateBatterBaselineCache.has(pool)) return _slateBatterBaselineCache.get(pool);
  const batters = pool.filter(p => !rp(p, 'P') && p.median > 0 && (p.isConfirmed || p.order > 0));
  const src = batters.length >= 20 ? batters : pool.filter(p => !rp(p, 'P') && p.median > 0);
  // Fall back to the historical 7.0 anchor when the pool is too thin to be representative.
  const baseline = src.length >= 8
    ? src.reduce((s, p) => s + p.median, 0) / src.length
    : 7.0;
  _slateBatterBaselineCache.set(pool, baseline);
  return baseline;
}

function getPitcherMatchupScore(pitcher, context) {
  const { pool } = context;
  if (!pool || !pitcher.opp) return 0;

  const allOppBatters = pool.filter(p => p.team === pitcher.opp && !rp(p, 'P') && p.median > 0);
  if (allOppBatters.length < 3) return 0;

  // Prefer confirmed starters (batting order set) over unconfirmed players.
  // Unconfirmed backups and platoon options dilute matchup quality when included.
  const confirmed = allOppBatters.filter(p => p.isConfirmed || p.order > 0);
  const src = confirmed.length >= 3 ? confirmed : allOppBatters;

  const avgMedian = src.reduce((s, p) => s + p.median, 0) / src.length;

  // Continuous linear scale anchored at the slate's own average batter median (Fix #5),
  // so the matchup signal is centered regardless of the projection source's scale.
  // Each 1-point below the slate average = +0.75, each 1-point above = −0.75. Capped at ±3.
  const anchor = slateBatterMedianBaseline(pool);
  return Math.max(-3, Math.min(3, (anchor - avgMedian) * 0.75));
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
    contestType = 'cash',  // 'cash' | 'gpp' | 'single' — controls salary bonus weight
    ownershipLambda = 0,   // GPP ownership diversity: subtract λ × sumOwnership from lineup score
    diversityMode = false, // when true, upgradeSalary samples randomly among top-3 candidates
  } = opts;

  // Pre-place forced players into open required slots
  const effectiveRequired = [...requiredSlots];
  if (forceInclude.size) {
    for (const fname of forceInclude) {
      if (effectiveRequired.some(p => p?.name === fname)) continue;
      const fp = pool.find(p => p.name === fname && !excludeNames.has(p.name) && p.salary > 0);
      if (!fp) continue;
      for (let i = 0; i < ROSTER_SIZE; i++) {
        if (!effectiveRequired[i] && DK_SLOTS[i].eligible(fp)) {
          // Budget feasibility check: after placing fp, can remaining open slots be filled?
          // Use slot-type-aware minimums: $5500 per open pitcher slot, $3000 per open batter slot.
          const salAfter = effectiveRequired.reduce((s, p) => s + (p ? p.salary : 0), 0) + fp.salary;
          const minRemaining = DK_SLOTS.reduce((m, slot, si) => {
            if (si === i || effectiveRequired[si]) return m;
            return m + (slot.key === 'P' ? 5500 : MIN_SALARY_PER_SLOT);
          }, 0);
          if (salAfter + minRemaining > SALARY_CAP) break; // skip this forced player — would blow budget
          effectiveRequired[i] = fp;
          break;
        }
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
  // Cash: high weight (15) — floor-focused, burning salary is always good.
  // GPP: 15 — per-player salary efficiency was removed from calcGppScore, so this
  //      is the only salary pressure. A $3k salary difference = 0.9 pts, enough to
  //      push lineups toward cap without overriding genuine projection advantages.
  // Single: midpoint (13).
  const salBonus = contestType === 'gpp' ? 15 : contestType === 'single' ? 13 : 15;

  // Composite lineup score: individual scores + salary efficiency bonus + stack bonus
  // - ownershipLambda: GPP ownership penalty subtracts λ × total ownership % so the
  //   optimizer prefers lower-owned combinations when projections are otherwise equal.
  //   λ=0.05 → a lineup with 200% total ownership scores 10 pts lower than one with 100%.
  const lineupTotalScore = lineup => {
    const pts = lineup.reduce((s, p) => s + cachedScore(p), 0);
    const sal = lineup.reduce((s, p) => s + p.salary, 0);
    const ownPenalty = ownershipLambda > 0 ? ownershipLambda * lineup.reduce((s, p) => s + (p.own || 0), 0) : 0;
    return pts + (sal / SALARY_CAP) * salBonus + (stackBonusFn ? stackBonusFn(lineup) : 0) - ownPenalty;
  };

  // ── Step 3: Per-slot candidate pools sorted by individual score ──────────
  // Only built for open (non-locked) slots; excludes banned/over-exposed players.
  const slotPools = DK_SLOTS.map((slot, i) => {
    if (effectiveRequired[i]) return []; // locked — skip
    return pool
      .filter(p =>
        slot.eligible(p) && !excluded.has(p.name) && p.salary > 0 &&
        (p.median > 0 || p.ceiling > 0)
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
      // Pre-sum ownership of the 9 non-swapped players so candidate evaluation is apples-to-apples
      // with lineupTotalScore(lu) which subtracts ownershipLambda × totalOwn from the baseline.
      const othersOwn = ownershipLambda > 0 ? others.reduce((s, p) => s + (p.own || 0), 0) : 0;

      let bestScore = lineupTotalScore(lu); // only accept strict improvements
      let bestPick = null;

      for (const cand of slotPools[i]) {
        if (othersNames.has(cand.name)) continue; // already in another slot
        if (cand.name === cur?.name) continue;     // same player
        if (othersSalary + cand.salary > SALARY_CAP) continue;
        if (!validatePlacement(cand, others, allowBvP, maxBattersPerTeam)) continue;

        // Compute new lineup score without allocating a full array when possible.
        // Ownership penalty must match lineupTotalScore — omitting it biases the swap
        // toward high-ownership candidates (opposite of GPP intent when lambda > 0).
        const newLu = [...lu]; newLu[i] = cand;
        const ownPenalty = ownershipLambda > 0 ? ownershipLambda * (othersOwn + (cand.own || 0)) : 0;
        const newScore = othersScore + cachedScore(cand)
          + ((othersSalary + cand.salary) / SALARY_CAP) * salBonus
          + (stackBonusFn ? stackBonusFn(newLu) : 0)
          - ownPenalty;

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
  // salary alternatives that score within a quality threshold of the current player.
  // GPP uses a tight threshold so lineup ceiling is never sacrificed for salary.
  return upgradeSalary(lu, pool, scoreFn, excluded, allowBvP, maxBattersPerTeam, effectiveRequired, contestType, diversityMode);
}

// ── Exact Branch-and-Bound Optimal Lineup Solver ─────────────────────────────
// Finds the provably highest-scoring lineup within the salary cap via integer
// branch-and-bound with a greedy warm-start and per-node LP upper bound.
// Typical MLB slate: < 200ms; 2.5 s hard timeout returns best-found with a flag.
//
// Returns { lineup, score, warmScore, nodesExplored, solveMs, optimal }
//   lineup     — player array in DK_SLOTS order (compatible with STATE.lineup)
//   score      — total scored pts of returned lineup
//   warmScore  — greedy baseline score (null if greedy failed)
//   optimal    — true iff B&B completed before time limit
function solveOptimal(pool, scoreFn, opts = {}) {
  const {
    allowBvP      = false,
    timeLimit     = 2500,
    slots         = DK_SLOTS,
    salaryCap     = SALARY_CAP,
    requiredSlots = null,
  } = opts;

  const t0 = Date.now();
  const n  = slots.length;

  // Pre-placed locked players — slots where req[i] is non-null are skipped by B&B
  const req      = requiredSlots || new Array(n).fill(null);
  const preNames = new Set(req.filter(Boolean).map(p => p.name));

  // Pre-score all eligible players once
  const sc = (() => {
    const cache = new Map();
    return p => { if (!cache.has(p.name)) cache.set(p.name, scoreFn(p)); return cache.get(p.name); };
  })();

  const players = pool.filter(p =>
    p.salary > 0 && (p.median > 0 || p.avgPpg > 0) &&
    p.dkStatus !== 'O' && p.dkStatus !== 'D' &&
    p.injuryType !== 'IL' && p.injuryType !== 'DL'
  );
  players.forEach(p => sc(p)); // fill cache before branching

  // Salary and score committed by pre-placed locked players
  const preSalary = req.filter(Boolean).reduce((s, p) => s + p.salary, 0);
  const preScore  = req.filter(Boolean).reduce((s, p) => s + sc(p), 0);

  // Per-slot candidate lists — locked slots get empty lists (skipped by B&B)
  const openIdxs = slots.map((_, i) => i).filter(i => !req[i]);
  const slotCands = slots.map((slot, i) =>
    req[i] ? [] : players.filter(p => slot.eligible(p) && !preNames.has(p.name)).sort((a, b) => sc(b) - sc(a))
  );

  // Solve order over open slots only: pitcher open slots first,
  // then remaining by candidate-count ascending (most constrained = tighter pruning).
  const pIdxs  = openIdxs.filter(i => slots[i].key === 'P');
  const bIdxs  = openIdxs.filter(i => slots[i].key !== 'P')
    .sort((a, b) => slotCands[a].length - slotCands[b].length);
  const solveOrder = [...pIdxs, ...bIdxs];
  const ordered    = solveOrder.map(i => slotCands[i]);
  const nOpen      = solveOrder.length;

  // Warm-start: greedy lower bound tightens pruning from the first leaf
  const warmLu = greedyFill(players, scoreFn, preNames, [...req], allowBvP);
  const warmOk = warmLu && warmLu.every(Boolean);
  let bestScore    = warmOk ? warmLu.reduce((s, p) => s + sc(p), 0) : -Infinity;
  const warmScore  = warmOk ? bestScore : null;

  let bestLuSolve  = null; // in solve order; null until B&B improves on warm start
  let nodes        = 0;
  let timedOut     = false;
  const pitcherOpps = {}; // [team] → count of placed pitchers opposing that team

  // Pre-register any locked pitchers so BvP filters work correctly from the first branch
  req.forEach((p, i) => { if (p && slots[i].key === 'P' && p.opp) pitcherOpps[p.opp] = (pitcherOpps[p.opp] || 0) + 1; });

  // Upper bound: for remaining open slots greedily pick the best unused, budget-feasible player.
  // Returns -Infinity when any slot is infeasible (triggers immediate prune).
  function ub(from, usedNames, salLeft) {
    let score = 0, budget = salLeft;
    for (let i = from; i < nOpen; i++) {
      let found = false;
      for (const p of ordered[i]) {
        if (!usedNames.has(p.name) && p.salary <= budget) {
          score += sc(p); budget -= p.salary; found = true; break;
        }
      }
      if (!found) return -Infinity;
    }
    return score;
  }

  function branch(from, lu, curScore, usedNames, salLeft) {
    if (timedOut) return;
    if (++nodes % 2000 === 0 && Date.now() - t0 > timeLimit) { timedOut = true; return; }

    if (from === nOpen) {
      if (preScore + curScore > bestScore) { bestScore = preScore + curScore; bestLuSolve = [...lu]; }
      return;
    }

    // Prune: pre-placed score + open so far + best reachable upper bound cannot beat incumbent
    if (preScore + curScore + ub(from, usedNames, salLeft) <= bestScore) return;

    const origIdx  = solveOrder[from];
    const isP      = slots[origIdx].key === 'P';
    const remSlots = nOpen - from - 1;

    for (const p of ordered[from]) {
      if (usedNames.has(p.name)) continue;
      if (p.salary > salLeft) continue;
      // Fast feasibility cut: remaining budget must cover minimum salary per open slot
      if (salLeft - p.salary < remSlots * MIN_SALARY_PER_SLOT) continue;
      // BvP: skip batters whose team any placed pitcher is opposing
      if (!allowBvP && !isP && (pitcherOpps[p.team] || 0) > 0) continue;

      if (isP && p.opp) pitcherOpps[p.opp] = (pitcherOpps[p.opp] || 0) + 1;
      usedNames.add(p.name);
      lu.push(p);

      branch(from + 1, lu, curScore + sc(p), usedNames, salLeft - p.salary);

      lu.pop();
      usedNames.delete(p.name);
      if (isP && p.opp) pitcherOpps[p.opp]--;
    }
  }

  branch(0, [], 0, new Set(preNames), salaryCap - preSalary);

  // Reconstruct lineup in original DK_SLOTS order, merging locked + B&B results
  let lineup = null;
  if (bestLuSolve) {
    lineup = [...req];
    for (let i = 0; i < nOpen; i++) lineup[solveOrder[i]] = bestLuSolve[i];
  } else if (warmOk) {
    lineup = warmLu; // warm start already in original slot order
  }

  return { lineup, score: bestScore > -Infinity ? bestScore : null, warmScore, nodesExplored: nodes, solveMs: Date.now() - t0, optimal: !timedOut };
}

function greedyFill(pool, scoreFn, excludeNames = new Set(), requiredSlots = new Array(ROSTER_SIZE).fill(null), allowBvP = false, maxBattersPerTeam = 5) {
  const lu = [...requiredSlots];
  // Pre-score once per player so the sort comparator never calls scoreFn twice per comparison.
  const eligible = pool.filter(p =>
    !excludeNames.has(p.name) && p.salary > 0 &&
    (p.median > 0 || p.ceiling > 0) &&
    p.dkStatus !== 'O' && p.dkStatus !== 'D' &&
    p.injuryType !== 'IL' && p.injuryType !== 'DL' && !(p.injuryFlag && !p.injuryType)
  );
  const scoreOnce = new Map(eligible.map(p => [p.name, scoreFn(p)]));
  const sorted = eligible.slice().sort((a, b) => scoreOnce.get(b.name) - scoreOnce.get(a.name));
  // Helper: returns true if the slot's position is the player's primary (first-listed) position.
  // Used to deprioritise multi-position players when a slot-native candidate is available,
  // preventing a '2B/SS' from consuming the 2B slot when a dedicated 2B could fill it.
  const isPrimaryPos = (p, slotKey) =>
    (p.rosterPos || p.dkPos || '').split('/')[0].trim().toUpperCase() === slotKey.toUpperCase();
  // Precompute minimum salary reserve per remaining slot. Use the 3rd-percentile
  // (near absolute minimum) rather than 10th-percentile so early picks aren't forced
  // cheap by an overly conservative buffer — the upgrade pass handles salary allocation.
  // IMPORTANT: use the same projection filter as the actual eligible pool so the reserve
  // reflects what a real projected player costs, not a $2k no-projection placeholder.
  // Mismatching these caused early slots to overspend — the greedy fill budgeted $2k per
  // remaining OF (based on cheap pool entries) but the cheapest projected OF was $2.6k,
  // leaving the last slot with $400 and no way to add anyone.
  // For duplicate slot types (two P slots, three OF slots, etc.), each open slot needs a
  // DISTINCT player. The Nth open slot of a given type must reserve for the Nth cheapest
  // eligible player — not the cheapest — because earlier slots of the same type will consume
  // the cheaper options first. Without this, P0 takes the cheapest pitcher and P1 is left
  // budgeted for that same player, which is now used, starving P1.
  //
  // Also exclude players already pre-placed in lu (via requiredSlots): a multi-position player
  // (e.g., 2B/SS) locked into the SS slot by the stack builder appears eligible for the 2B
  // realisticMin even though they'll be in usedNames at 2B fill time, causing a false low floor.
  const preplacedNames = new Set(lu.filter(Boolean).map(p => p.name));
  const openSlotRankByKey = {};
  const realisticMin = DK_SLOTS.map((slot, i) => {
    if (lu[i]) return 0;
    if (!openSlotRankByKey[slot.key]) openSlotRankByKey[slot.key] = 0;
    const rank = openSlotRankByKey[slot.key]++;           // 0 for first open P, 1 for second, etc.
    const eligible = pool.filter(p =>
      slot.eligible(p) && !excludeNames.has(p.name) && !preplacedNames.has(p.name) &&
      p.salary > 0 && (p.median > 0 || p.ceiling > 0) &&
      p.dkStatus !== 'O' && p.dkStatus !== 'D' &&
      p.injuryType !== 'IL' && p.injuryType !== 'DL' && !(p.injuryFlag && !p.injuryType)
    ).sort((a, b) => a.salary - b.salary);
    if (!eligible.length) return MIN_SALARY_PER_SLOT;
    const baseIdx = Math.max(0, Math.floor(eligible.length * 0.03));
    return eligible[Math.min(baseIdx + rank, eligible.length - 1)].salary;
  });
  dlog('[greedyFill] pool=%d eligible=%d sorted=%d', pool.length, eligible.length, sorted.length);
  const slotKey = i => DK_SLOTS[i].key;
  for (let i = 0; i < ROSTER_SIZE; i++) {
    if (lu[i]) { dlog('[greedyFill] slot %d (%s) pre-filled: %s', i, DK_SLOTS[i].key, lu[i].name); continue; }
    const salSoFar = () => lu.reduce((s, lp) => s + (lp ? lp.salary : 0), 0);
    const reserveRemaining = realisticMin.reduce((s, m, j) => j > i && !lu[j] ? s + m : s, 0);
    const usedNames = new Set(lu.filter(Boolean).map(p => p.name));
    const budgetAvail = SALARY_CAP - salSoFar() - reserveRemaining;
    let rejSalary = 0, rejPos = 0, rejUsed = 0, rejBvP = 0;
    for (const primaryOnly of [true, false]) {
      for (const p of sorted) {
        if (usedNames.has(p.name))                              { rejUsed++;   continue; }
        if (!DK_SLOTS[i].eligible(p))                          { rejPos++;    continue; }
        if (primaryOnly && !isPrimaryPos(p, slotKey(i)))        { continue; }
        if (salSoFar() + p.salary > SALARY_CAP - reserveRemaining) { rejSalary++; continue; }
        if (!validatePlacement(p, lu.filter(Boolean), allowBvP, maxBattersPerTeam)) { rejBvP++; continue; }
        lu[i] = p;
        usedNames.add(p.name);
        break;
      }
      if (lu[i]) break;
    }
    // Last-resort pass: if the slot is still empty AND at least one player passed the
    // salary check but was blocked only by BvP/cap, relax BvP for this slot.
    // This avoids an INCOMPLETE lineup when the only affordable player happens to be
    // on the same team as a rostered pitcher — a real but rare constraint collision.
    if (!lu[i] && rejBvP > 0) {
      for (const p of sorted) {
        if (usedNames.has(p.name))                              continue;
        if (!DK_SLOTS[i].eligible(p))                          continue;
        if (salSoFar() + p.salary > SALARY_CAP - reserveRemaining) continue;
        lu[i] = p; usedNames.add(p.name);
        dlog('[greedyFill] slot %d (%s) BvP-relaxed fallback → %s $%d', i, DK_SLOTS[i].key, p.name, p.salary);
        break;
      }
    }
    if (lu[i]) {
      dlog('[greedyFill] slot %d (%s) → %s $%d (budget avail $%d)', i, DK_SLOTS[i].key, lu[i].name, lu[i].salary, budgetAvail);
    } else {
      console.warn('[greedyFill] slot %d (%s) UNFILLED — budget $%d rejections: pos=%d salary=%d used=%d bvp/cap=%d', i, DK_SLOTS[i].key, budgetAvail, rejPos, rejSalary, rejUsed, rejBvP);
    }
  }
  const totalSal = lu.reduce((s, p) => s + (p ? p.salary : 0), 0);
  const nullSlots = lu.filter(p => !p).length;
  if (nullSlots) console.warn('[greedyFill] INCOMPLETE: %d/%d slots empty — salary used $%d', nullSlots, ROSTER_SIZE, totalSal);
  else dlog('[greedyFill] complete — salary $%d/%d', totalSal, SALARY_CAP);
  return lu;
}

// Post-optimization salary upgrade pass: after the main optimizer finds its
// best lineup, sweep each slot and try to replace the player with a higher-
// salary alternative that fits in cap and scores within a quality threshold.
// Repeats until no further upgrades are possible.
//
// Quality is evaluated using raw projection (median + ceiling blend), NOT the
// GPP score. The GPP score penalizes high-ownership players, which are often the
// higher-salary options — using it here causes upgrades to be incorrectly rejected,
// leaving $3–4k on the table. Ownership was already factored in during greedy
// selection; upgrade decisions should be purely projection-based.
function upgradeSalary(lu, pool, scoreFn, excludeNames, allowBvP = false, maxBattersPerTeam = 5, lockedSlots = null, contestType = 'cash', diversityMode = false) {
  // Raw projection quality: 40% median + 60% ceiling (ceiling-weighted for GPP upside).
  // Cash/Single: 50/50 blend — floor matters more, so lean less on ceiling.
  const rawQuality = contestType === 'gpp'
    ? p => (p.median || 0) * 0.40 + (p.ceiling || 0) * 0.60
    : p => (p.median || 0) * 0.55 + (p.ceiling || 0) * 0.45;

  // Threshold: the candidate must project at least this fraction of the current
  // player's raw quality. Generous (0.88) because we're spending up — a $6k player
  // projecting 88% as well as a $4k value play is still a correct salary allocation.
  const qualityFloor = 0.88;

  let changed = true;
  while (changed) {
    changed = false;
    const salaryUsed = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    const headroom = SALARY_CAP - salaryUsed;
    if (headroom <= 0) break;
    const luNames = new Set(lu.filter(Boolean).map(p => p.name));
    for (let i = 0; i < ROSTER_SIZE; i++) {
      if (lockedSlots && lockedSlots[i]) continue;
      const cur = lu[i];
      if (!cur) continue;
      const curRaw = rawQuality(cur);
      const others = lu.filter((p, j) => p && j !== i);
      const upgradeCandidates = pool.filter(p => {
        if (excludeNames.has(p.name)) return false;
        if (luNames.has(p.name)) return false;
        if (p.salary <= cur.salary) return false;
        if (p.salary > cur.salary + headroom) return false;
        if (!DK_SLOTS[i].eligible(p)) return false;
        if (rawQuality(p) < curRaw * qualityFloor) return false;
        if (!validatePlacement(p, others, allowBvP, maxBattersPerTeam)) return false;
        return true;
      // Sort by ownership-penalised salary: prefer spending into underowned players.
      // At 0% own → pure salary; at 30% own → effective salary reduced ~31%.
      }).sort((a, b) => (b.salary / (1 + (b.own || 0) * 0.015)) - (a.salary / (1 + (a.own || 0) * 0.015)));
      // In diversity mode (recycle phase): randomly sample among the top-3 by salary
      // so the upgrade pass doesn't always normalize jitter-based lineups back to the
      // same chalk picks, allowing the duplicate-checker to see unique fingerprints.
      let upgrade;
      if (diversityMode && upgradeCandidates.length > 1) {
        upgrade = upgradeCandidates[Math.floor(Math.random() * Math.min(3, upgradeCandidates.length))];
      } else {
        upgrade = upgradeCandidates[0];
      }
      if (upgrade) {
        luNames.delete(cur.name);
        lu[i] = upgrade;
        luNames.add(upgrade.name);
        changed = true;
        break;
      }
    }
  }
  return lu;
}

// ── Stack Adjacency Scoring ──────────────────────────────────────────────────
// Measures how tightly clustered a group of players is in the batting order.
// Returns 0–1: 1.0 = all consecutive (gap ≤ 1), 0 = spread out or no order data.
// Stacks with adjacent orders generate meaningful inning-by-inning run correlation —
// a 3-4-5 stack can chain singles into multi-run innings; a 1-4-8 stack cannot.
function computeStackAdjacency(stackPlayers) {
  const withOrder = stackPlayers.filter(p => p && p.order > 0)
    .sort((a, b) => a.order - b.order);
  if (withOrder.length < 2) return 0; // need at least 2 confirmed orders to evaluate

  let maxGap = 0, totalGap = 0;
  for (let i = 1; i < withOrder.length; i++) {
    const gap = withOrder[i].order - withOrder[i - 1].order;
    maxGap = Math.max(maxGap, gap);
    totalGap += gap;
  }
  const avgGap = totalGap / (withOrder.length - 1);

  if (maxGap <= 1) return 1.00;                          // perfectly consecutive  e.g. 2-3-4
  if (maxGap <= 2 && avgGap <= 1.5) return 0.75;        // one small gap e.g. 2-3-5
  if (maxGap <= 2) return 0.50;                          // all gaps ≤ 2 e.g. 1-3-5
  if (maxGap <= 3 && avgGap <= 2.0) return 0.25;        // tolerable spread
  return 0.00;                                            // too spread out
}

// Resolve stack player names against pool, then compute adjacency.
function computeStackAdjacencyFromPool(playerNames, pool) {
  const players = playerNames
    .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  return computeStackAdjacency(players);
}

// ── Stack Bonus Functions ───────────────────────────────────────────────────

// payoutType controls how aggressively stacking is rewarded:
//   winner / top10  — high-variance contests; big stacks win or bust → heavy bonus
//   top20 (default) — standard large-field GPP; balanced stacking
//   double / cash   — floor-focused; stacking less important → light bonus
const STACK_BONUS_WEIGHT = {
  winner: 2.0,
  top10:  1.5,
  top20:  1.0,
  double: 0.6,
  cash:   0.4,
};

function gppStackBonus(lu, usedStackTeam, payoutType = 'top20') {
  const weight = STACK_BONUS_WEIGHT[payoutType] ?? 1.0;
  let bonus = 0;

  // Same-team correlation bonus
  const teamCounts = {};
  lu.forEach(p => { if (!rp(p, 'P')) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1; });
  Object.values(teamCounts).forEach(c => {
    if (c >= 5) bonus += 3;
    else if (c >= 4) bonus += 2;
    else if (c >= 3) bonus += 1;
  });

  // Secondary-stack structure bonus.
  // The two biggest batter clusters define the lineup's structure. Reward a genuine
  // two-stack so the 1-swap search prefers "primary + secondary" over "primary + scattered":
  //   • a SECONDARY 2-man cluster (2nd team with exactly 2) → +0.5 — the only credit a
  //     2-stack gets (the per-team loop above only rewards 3+), nudging mini-stacks to form.
  //   • a DOUBLE stack (two teams each 3+) → +1.5 on top of the per-team bonuses, since two
  //     independent correlated ceiling sources is the winning large-field GPP shape.
  const sortedCounts = Object.values(teamCounts).sort((a, b) => b - a);
  if (sortedCounts[1] === 2) bonus += 0.5;
  if (sortedCounts[0] >= 3 && sortedCounts[1] >= 3) bonus += 1.5;

  // Batting order adjacency bonus within stacks.
  // gap=1: perfectly adjacent pair (+1.0) — highest run-chain correlation.
  // gap=2: one batter between them (+0.5) — still meaningful, e.g. 3-5 with #4 batting around them.
  // gap≥3: no bonus — too far apart in the order to share inning benefits reliably.
  Object.entries(teamCounts).forEach(([team, count]) => {
    if (count >= 3) {
      const ordered = lu.filter(p => p.team === team && !rp(p, 'P') && p.order > 0)
        .sort((a, b) => a.order - b.order);
      for (let i = 0; i < ordered.length - 1; i++) {
        const gap = ordered[i + 1].order - ordered[i].order;
        if (gap === 1) bonus += 1.0;
        else if (gap === 2) bonus += 0.5;
      }
    }
  });

  return bonus * weight;
}

// ── Portfolio Builder ───────────────────────────────────────────────────────

// Build a virtual stack for a team from the player pool when no stacks
// file entry exists for that team.
//
// Selection strategy — order of preference:
//   1. Slide a window of `size` through batters sorted by confirmed batting order,
//      scoring each window as (sum of vegas-adjusted medians) + (adjacency score × 3).
//      The 3-pt adjacency bonus favours a tight cluster unless a non-adjacent window
//      projects 3+ more total points — projection still wins when the gap is large.
//   2. Fallback when fewer than `size` batters have confirmed orders: pick top-N by
//      vegas-adjusted median (original behaviour).
function buildVirtualStack(team, pool, excludeNames, size = 3, vegasData = {}) {
  const impliedTotal = vegasData[team]?.impliedTotal || 4.5;
  const vegasScale = impliedTotal / 4.5;

  const batters = pool.filter(p =>
    p.team === team && !rp(p, 'P') &&
    !excludeNames.has(p.name) &&
    p.salary > 0 && (p.median > 0 || p.avgPpg > 0)
  );

  if (batters.length < size) return null;

  // ── Order-aware sliding window ───────────────────────────────────────────
  const orderedBatters = batters.filter(b => b.order > 0).sort((a, b) => a.order - b.order);

  let chosen = null;
  let bestScore = -Infinity;

  if (orderedBatters.length >= size) {
    for (let start = 0; start <= orderedBatters.length - size; start++) {
      const window = orderedBatters.slice(start, start + size);
      const adjScore = computeStackAdjacency(window);
      const projScore = window.reduce((s, p) => s + (p.median || p.avgPpg || 0) * vegasScale, 0);
      const score = projScore + adjScore * 3.0;
      if (score > bestScore) { bestScore = score; chosen = window; }
    }
  }

  // ── Fallback: not enough confirmed orders ─────────────────────────────────
  if (!chosen) {
    chosen = [...batters]
      .sort((a, b) => (b.median || b.avgPpg || 0) * vegasScale - (a.median || a.avgPpg || 0) * vegasScale)
      .slice(0, size);
  }

  const ownValues = chosen.map(p => p.own || 0);
  const avgOwn = ownValues.reduce((s, v) => s + v, 0) / ownValues.length;
  const maxOwn = Math.max(...ownValues);
  return {
    id: `virtual_${team}_${size}`,
    players: chosen.map(p => p.name),
    team,
    proj: chosen.reduce((s, p) => s + (p.median || 0), 0),
    // Blend of max and average: a chalk anchor at 40% own still pulls the score up
    // even when the other players are low-owned. Penalises "one chalk + two values" stacks.
    own: maxOwn * 0.5 + avgOwn * 0.5,
    isVirtual: true
  };
}

// Synthesize N-man virtual stacks for every team present in pool.
// Used when stackSize is set to 4, or as fallback when no stack files are loaded.
function buildAutoStacks(pool, size, vegasData = {}) {
  const teams = [...new Set(pool.filter(p => !rp(p, 'P') && p.salary > 0).map(p => p.team))];
  return teams.map(team => buildVirtualStack(team, pool, new Set(), size, vegasData)).filter(Boolean);
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
  // Use slot-type-aware minimums: pitchers cost much more than batters.
  // $5500 per open P slot, $3000 per open batter slot — rejects stacks that
  // would leave too little budget for the two SP positions.
  const minRemaining = tempLu.reduce((s, p, i) => p ? s : s + (DK_SLOTS[i].key === 'P' ? 5500 : MIN_SALARY_PER_SLOT), 0);
  if (stackSalary + minRemaining > SALARY_CAP) return false;
  for (let i = 0; i < ROSTER_SIZE; i++) { if (tempLu[i] !== requiredSlots[i]) requiredSlots[i] = tempLu[i]; }
  return true;
}

// Min-exposure-aware trim for the sim-filter pass.
// The sim filter generates an overflow pool and keeps the top numLineups by ROI — but a
// naive top-N can drop the very lineups that were carrying a player/team MIN-exposure
// target, silently violating it. This selects numLineups lineups that still satisfy the
// MIN overrides where feasible, while otherwise preferring the highest-ROI lineups.
//
// candidates: simResults sorted by simROI_lb desc. Returns an array of lineups.
// Greedy repair: start with the top-N by ROI, then for each unmet minimum swap in the
// highest-ROI candidate that helps and swap out the lowest-ROI kept lineup that is safe
// to remove (i.e. removing it won't push any OTHER minimum below its target).
function selectWithMinExposure(candidates, numLineups, playerOverrides, teamExposureOverrides) {
  const playerMin = {};
  for (const [name, ov] of Object.entries(playerOverrides || {})) if (ov && ov.min != null) playerMin[name] = Math.ceil(numLineups * ov.min);
  const teamMin = {};
  for (const [team, ov] of Object.entries(teamExposureOverrides || {})) if (ov && ov.min != null) teamMin[team] = Math.ceil(numLineups * ov.min);
  const pNames = Object.keys(playerMin), tNames = Object.keys(teamMin);
  if (!pNames.length && !tNames.length) return candidates.slice(0, numLineups).map(r => r.lu);

  // Tag each candidate with which min-targeted players it rosters and which min-targeted
  // teams it stacks (3+ batters — matches teamStackCounts semantics).
  const tag = r => {
    const players = r.lu.filter(Boolean);
    const names = new Set(players.map(p => p.name));
    const teamCts = {};
    players.forEach(p => { if (!rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
    const stackTeams = new Set(Object.entries(teamCts).filter(([, n]) => n >= 3).map(([t]) => t));
    return { lu: r.lu, players: pNames.filter(n => names.has(n)), teams: tNames.filter(t => stackTeams.has(t)) };
  };
  const tagged = candidates.map(tag); // preserves ROI-desc order
  const kept = tagged.slice(0, numLineups);
  const rest = tagged.slice(numLineups);

  const pCount = {}; pNames.forEach(n => pCount[n] = 0);
  const tCount = {}; tNames.forEach(t => tCount[t] = 0);
  kept.forEach(k => { k.players.forEach(n => pCount[n]++); k.teams.forEach(t => tCount[t]++); });

  let guard = 0;
  while (guard++ < numLineups * 3) {
    // Pick the most-deficient unmet minimum.
    let need = null, needType = null, maxDef = 0;
    for (const n of pNames) { const def = playerMin[n] - pCount[n]; if (def > maxDef) { maxDef = def; need = n; needType = 'p'; } }
    for (const t of tNames) { const def = teamMin[t] - tCount[t]; if (def > maxDef) { maxDef = def; need = t; needType = 't'; } }
    if (!need) break; // every minimum satisfied

    const helps = c => needType === 'p' ? c.players.includes(need) : c.teams.includes(need);
    const inIdx = rest.findIndex(helps);
    if (inIdx === -1) break; // no candidate can satisfy this minimum — genuinely infeasible

    // Lowest-ROI kept lineup (kept is ROI-desc, scan from end) that doesn't help this need
    // and whose removal won't drop another minimum below target.
    let outPos = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (helps(k)) continue;
      let safe = true;
      for (const n of k.players) if (pCount[n] <= playerMin[n]) { safe = false; break; }
      if (safe) for (const t of k.teams) if (tCount[t] <= teamMin[t]) { safe = false; break; }
      if (!safe) continue;
      outPos = i; break;
    }
    if (outPos === -1) break; // can't free a slot without breaking another minimum

    const incoming = rest.splice(inIdx, 1)[0];
    const outgoing = kept.splice(outPos, 1)[0];
    outgoing.players.forEach(n => pCount[n]--); outgoing.teams.forEach(t => tCount[t]--);
    incoming.players.forEach(n => pCount[n]++); incoming.teams.forEach(t => tCount[t]++);
    kept.push(incoming); rest.push(outgoing);
  }
  return kept.map(k => k.lu);
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
    maxOverlap = 5,        // max players shared between any two lineups (0 = disabled)
    lockedTeams = [],      // teams whose stacks are prioritised every lineup
    bannedTeams = [],      // teams fully excluded from the portfolio
    allowBvP = false,      // if false, pitcher and opposing batters cannot share a lineup
    playerOverrides = {},  // { playerName: { min: 0-1, max: 0-1 } } per-player exposure bounds
    stackPct5 = null,      // % of lineups that should target a 5-man stack (null = auto)
    stackSize = null,      // 3 | 4 | 5 | null — forces all lineups to use this stack size; overrides stackPct5
    teamExposureOverrides = {}, // { teamName: { min: 0-1, max: 0-1 } } per-team stack exposure bounds
    context = {},
    iterations = 5000,
    simFilter = false,     // if true, generate overflow lineups and keep top numLineups by sim ROI
    simFilterPct = 50,     // % of extra lineups to generate beyond numLineups (e.g. 50 = 150% total)
    simFilterSims = 5000,  // number of sim iterations for the filter pass (higher = more accurate ranking, 5K reduces SE enough for reliable ROI filtering)
    payoutType = 'top20',  // payout structure passed to simulatePortfolio for filter scoring
    simROIMin = null,      // lower bound for sim ROI band (e.g. -15 = -15%). null = no lower bound
    simROIMax = null,      // upper bound for sim ROI band (e.g. 0 = 0%). null = no upper bound
    minSalary = 48500,     // reject lineups below this total salary
    ownershipLambda = 0.04, // GPP ownership diversity penalty passed through to optimizeLineup
    maxSpPairLineups = 0,  // max lineups sharing the same SP duo (0 = disabled)
    maxGameExposure = 0.65, // Fix 3: max fraction of lineups stacking the same game (0 = disabled)
    bbEnabled = true,        // whether to place bring-back batters after primary stack
    bbMinOppImplied = 4.0,   // min opponent implied total to trigger bring-back
    bbTarget = null,         // forced bring-back count (null = auto: 1 or 2 based on game O/U)
    maxAvgOwnership = 0,     // reject lineups whose avg player ownership exceeds this % (0 = off)
    secondaryStack = null,   // cross-game secondary stack: null/'off' = disabled, 'auto', 2, or 3
  } = opts;

  // targetLineups: how many to generate before sim-filter trims back to numLineups.
  // Exposure caps (hardMax) always use numLineups so caps aren't inflated by overflow.
  const targetLineups = simFilter ? Math.round(numLineups * (1 + simFilterPct / 100)) : numLineups;

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
    target5ManCount = stackPct5 != null ? Math.round(numLineups * stackPct5 / 100)
                     : (stacks5.length > 0 ? Math.round(numLineups * 0.65) : 0);
  }
  let lineups5ManCount = 0;

  // Pre-compute banned player set — stays constant for the entire portfolio
  const bannedNames = new Set(
    pool.filter(p => bannedTeams.includes(p.team)).map(p => p.name)
  );

  // ── Min-salary feasibility guard ────────────────────────────────────────────
  // The min-salary floor (default 48500) rejects any lineup totalling below it. On a
  // cheap or short slate the pool's richest valid lineup can fall under that floor, in
  // which case EVERY candidate is rejected and the portfolio silently comes back empty
  // (the UI then shows nothing). Build the richest valid lineup (greedy by salary) to
  // find the achievable ceiling; if the requested floor sits above it, lower the floor
  // to a feasible value and surface a warning rather than emitting zero lineups.
  let effectiveMinSalary = minSalary;
  let minSalaryRelaxed = null;
  if (minSalary > 0) {
    const richest = greedyFill(pool, p => p.salary || 0, bannedNames, new Array(ROSTER_SIZE).fill(null), allowBvP, 5);
    if (richest && richest.every(Boolean)) {
      const maxReachable = richest.reduce((s, p) => s + (p.salary || 0), 0);
      if (minSalary > maxReachable) {
        effectiveMinSalary = Math.max(0, maxReachable - 300);
        minSalaryRelaxed = { requested: minSalary, appliedFloor: effectiveMinSalary, maxReachable };
      }
    }
  }

  // Also filter stacks that belong to banned teams
  const allowedStacks3 = stacks3.filter(s => !bannedTeams.includes(s.team));
  const allowedStacks5 = stacks5.filter(s => !bannedTeams.includes(s.team));

  // When stackSize=4, synthesize 4-man virtual stacks from pool and use exclusively.
  // For stackSize=3/5, auto-synth is used only as fallback (virtual stack path in generateGppLineup).
  const autoStacks4 = stackSize === 4 ? buildAutoStacks(pool, 4, context?.vegasData || {}).filter(s => !bannedTeams.includes(s.team)) : [];

  // Effective stacks passed to generateGppLineup.
  // stackSize=5 → only 5-man stacks; stackSize=3 → only 3-man stacks;
  // stackSize=4 → auto-synth 4-man passed as stacks3; mix → both pools.
  const effectiveStacks3 = stackSize === 4 ? autoStacks4 : stackSize === 5 ? [] : [...allowedStacks3];
  const effectiveStacks5 = stackSize === 3 ? []           : stackSize === 4 ? [] : [...allowedStacks5];

  // Track teams that have no uploaded stack entry so we can flag them.
  const virtualStackTeams = new Set();

  // Auto-synthesize virtual stacks for any pool team missing from the stack files.
  // Without this, teams absent from the stacks file can only appear as random fillers —
  // their batters never form a correlated cluster, defeating GPP stack construction.
  // stackSize=4 already handled above via buildAutoStacks; skip to avoid duplication.
  if (stackSize !== 4 && (effectiveStacks3.length > 0 || effectiveStacks5.length > 0)) {
    const stackedTeams = new Set([...effectiveStacks3, ...effectiveStacks5].map(s => s.team));
    const poolTeams = [...new Set(pool.filter(p => !rp(p, 'P') && p.salary > 0 && !bannedTeams.includes(p.team)).map(p => p.team))];
    const vegasData = context?.vegasData || {};
    poolTeams.forEach(team => {
      if (stackedTeams.has(team)) return;
      const synthSize = stackSize === 5 ? 5 : 3; // match the forced size, default to 3-man
      const virtual = buildVirtualStack(team, pool, new Set(), synthSize, vegasData);
      if (!virtual) return;
      virtualStackTeams.add(team); // flag so UI can warn user
      if (stackSize === 5) effectiveStacks5.push(virtual);
      else effectiveStacks3.push(virtual);
    });
  }

  // Also flag locked teams with no stack entry (pre-existing behavior).
  // Use effectiveStacks (which includes autoStacks4 in stackSize=4 mode) so locked teams
  // with a synthesized 4-man stack aren't falsely warned as having no stack.
  lockedTeams.forEach(t => {
    const hasStack = [...effectiveStacks3, ...effectiveStacks5].some(s => s.team === t);
    if (!hasStack) virtualStackTeams.add(t);
  });

  // Only count stacks that buildCandidates will actually consider (proj > 0).
  // Zero-proj stacks are silently skipped in buildCandidates but used to inflate this
  // threshold — causing the recycle cycle to NEVER fire when zero-proj stacks are present.
  const totalAvailableStacks = effectiveStacks3.filter(s => s.proj > 0).length
                             + effectiveStacks5.filter(s => s.proj > 0).length;

  const lineups = [];
  const exposureCounts = {};
  const usedStackIds = new Set();
  // Counts lineups where the forced stack size wasn't fully achieved (stackSize-1 batters placed).
  let stackShortfallCount = 0;
  // Stacks tried-but-rejected (dup/overlap) within the current recycle cycle.
  // Excluded from pendingStackIds so the engine doesn't keep picking the same
  // optimal stack that already produced a duplicate lineup.
  const triedInCurrentRecycleCycle = new Set();
  // Tracks how many accepted lineups contain a 3+ batter stack per team
  const teamStackCounts = {};
  // Fix 3: tracks how many accepted lineups have their primary stack in each game.
  // Key = p.game string (e.g. "NYY@BOS") of the largest-stack team.
  const gameStackCounts = {};
  // Helper: find the game of the primary stack team in a lineup.
  const getPrimaryStackGame = lu => {
    const teamCts = {};
    lu.forEach(p => { if (p && !rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
    const primaryTeam = Object.entries(teamCts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return primaryTeam ? (pool.find(p => p.team === primaryTeam)?.game || primaryTeam) : null;
  };
  // SP pair concentration: tracks how many lineups use each 2-SP combination.
  // Key = sorted SP names joined by '|'. maxSpPairLineups=0 disables the check.
  const spPairCounts = {};

  // Fix 4: playerName -> Set<lineupIndex> for O(players) overlap checking
  const playerLineupIndex = new Map();

  // Exact-duplicate guard: always active regardless of maxOverlap setting.
  // maxOverlap=0 means "no soft overlap limit" — it must NOT mean "allow identical lineups".
  const usedFingerprints = new Set();

  // Fix 2: Round-robin index for locked teams — only advances on accepted lineups
  let lockedTeamIdx = 0;

  // Fix 1: Loop until targetLineups valid lineups are built, with a safety cap on attempts.
  // When simFilter is on, targetLineups > numLineups so we generate an overflow pool to
  // sim-rank and trim. Exposure hard-caps always reference numLineups so the per-player
  // and per-team caps aren't inflated by the extra overflow lineups.
  // Budget: 50× target — last few lineups on constrained slates can each take 50-100+
  // attempts as the viable player pool shrinks; 30× was too tight and caused early exit.
  // Reduced from 80× after batching yields per-acceptance — fewer wasted attempts needed.
  // stackSize != null is more constrained — every attempt must place a specific-sized stack,
  // so per-attempt rejection rates are much higher. Use 80× budget for forced-stack modes.
  const maxAttempts = Math.max(500, targetLineups * (stackSize != null ? 80 : 50));
  let attempts = 0;

  // Diagnostic counters — surfaced in return value and console for debugging
  const _diag = { nullLu: 0, incompleteLu: 0, stackSizeFail: 0, dupFail: 0, overlapFail: 0, recycleCount: 0 };

  // Pre-build validation: check team batter depth for 5-man stack targeting.
  // Fires when any 5-man stack lineups are planned (mix-100% or stackSize=5).
  // Reports which teams can't form a 5-man stack from the current projection pool
  // so the user sees a meaningful explanation instead of 100+ null-lu failures.
  if (target5ManCount != null && target5ManCount > 0) {
    const teamBatterCounts = {};
    pool.filter(p => !rp(p, 'P') && (p.median > 0 || p.ceiling > 0)).forEach(p => {
      if (!bannedNames.has(p.name)) teamBatterCounts[p.team] = (teamBatterCounts[p.team] || 0) + 1;
    });
    const thinTeams = Object.entries(teamBatterCounts)
      .filter(([, c]) => c < 5)
      .map(([t, c]) => `${t}(${c})`);
    if (thinTeams.length > 0) {
      console.warn(`[Portfolio] Teams with <5 projectable batters — 5-man stacks not feasible for: ${thinTeams.join(', ')}. Engine will fall back to 3-man for these teams.`);
      _diag.thinTeams = thinTeams;
    }
  }

  // Track consecutive null returns caused by prefer5Man. If 5-man stacks can't be
  // placed (not enough stacks, players excluded, salary too tight), we must fallback
  // to 3-man stacks rather than burning all maxAttempts returning null.
  let consecutive5ManFails = 0;
  const MAX_5MAN_FAILS = 15; // after this many, relax to 3-man for current attempt

  // Overlap relaxation: if overlapFail is burning >70% of attempts and we're still short,
  // auto-raise the effective overlap cap by 1 every 200 attempts to avoid hard deadlock.
  let effectiveMaxOverlap = maxOverlap;
  let lastRelaxAt = 0;

  // Game cap relaxation: when other games can't supply the remaining lineups, progressively
  // open the dominant game's cap by 5% every 80 game-cap failures until we reach 100%.
  let effectiveMaxGameExposure = maxGameExposure;
  let gameCapFailStreak = 0;
  let lastGameCapRelaxAt = 0;

  // Scale ownership penalty by slate concentration.
  // Baseline = 8 games. Turbo (4 games) → 2× lambda; full main slate (16 games) → 0.5×.
  // On short slates the field is densely concentrated, so ownership pressure must increase
  // proportionally to still produce differentiated lineups.
  const slateGameCount = new Set(pool.filter(p => p.game).map(p => p.game)).size || 8;
  const effectiveOwnershipLambda = ownershipLambda * Math.max(0.5, Math.min(2.0, 8 / Math.max(slateGameCount, 1)));

  // Exposure relaxation: if exact-duplicate failures dominate (all valid lineups the engine
  // generates are already in the set), the optimizer has converged and the only escape is to
  // open up one more appearance per player. Increment by 1 every 60 null-lu or 20 dup
  // failures, up to a ceiling of 25% of numLineups, so the last few slots can be filled
  // without visibly distorting the overall exposure distribution.
  let exposureRelax = 0;
  // 25% ceiling: on tight slates with limited stacks, 2 extra appearances (10% of 20) is not
  // enough to escape the final-lineup deadlock when the combination space is genuinely small.
  const MAX_EXPOSURE_RELAX = Math.max(1, Math.ceil(numLineups * 0.25));
  let dupFailStreak = 0;
  // Null-lu streak: tracks consecutive attempts where generateGppLineup returned null
  // (no valid stack could be placed). The dup-streak relaxation can't trigger here
  // because dupFailStreak resets to 0 on every null return. This separate counter
  // provides an independent escape path for "all stacks exhausted" deadlocks.
  let nullLuStreak = 0;
  const MAX_NULL_STREAK = Math.max(25, targetLineups * 3); // 60 for 20 lineups
  // Salary-floor relaxation: when the min-salary floor persistently rejects otherwise-valid
  // lineups it's set higher than this pool/stack combination can reach, so we step it down
  // rather than let it starve the portfolio to empty (see the feasibility pre-clamp above).
  // Keyed on cumulative salaryFail (like the null-lu relaxation) so interspersed accepts
  // don't stall the step-down; on a healthy slate the floor is reachable and this never fires.
  const SALARY_RELAX_AFTER = 25;   // cumulative salary fails per floor step-down
  const SALARY_RELAX_STEP = 1000;  // amount to lower the floor each relaxation tick

  while (lineups.length < targetLineups && attempts < maxAttempts) {
    attempts++;

    // Unconditional responsiveness yield (top of loop). The per-acceptance yield at
    // the bottom is skipped by every fast-reject `continue` path (dup/salary/stack-size),
    // so during a late-build deadlock — where the engine grinds many attempts failing to
    // find a distinct lineup — the worker would otherwise spin with NO progress update,
    // freezing the count (e.g. "stuck at 19/20") and looking hung even though it's still
    // searching. Yielding every 150 attempts here keeps progress flowing and lets the
    // worker post the current count so the UI shows ongoing work instead of a freeze.
    if (attempts % 150 === 0) {
      if (onProgress) onProgress(lineups.length, targetLineups, lineups.length);
      await new Promise(r => setTimeout(r, 0));
    }

    // Build exclusion set: banned + over-exposed players (respecting per-player max overrides)
    const excludeOverExposed = new Set(bannedNames);
    pool.forEach(p => {
      const ov = playerOverrides[p.name];
      const count = exposureCounts[p.name] || 0;
      if (ov?.max != null) {
        // Hard cap for per-player override: same approach as team exposure overrides.
        // Running-ratio (count/lineups.length) oscillates and can overshoot the target,
        // especially for batters in GPP stacks. Hard cap gives exact enforcement.
        // max(1,...) prevents floor rounding to 0 on small lineup counts, which would
        // immediately exclude everyone and hang the generator.
        // NOTE: explicit user overrides are NOT relaxed by exposureRelax (unlike the
        // global default cap below) — a user-set max is a directive, not a soft target.
        // This matches the team-override path, which also omits exposureRelax.
        const hardMax = Math.max(1, Math.floor(numLineups * ov.max));
        if (count >= hardMax) excludeOverExposed.add(p.name);
      } else if (lineups.length > 0) {
        // Hard cap for global defaults: exclude a player after they've hit the absolute
        // cap (threshold × numLineups, rounded down). Unlike running ratio (count/built),
        // hard cap never oscillates — a player sits out only after truly reaching the
        // ceiling, so stack players with high projections aren't prematurely excluded
        // mid-build (which caused 90+ null stack failures with the running ratio approach).
        // exposureRelax adds 1 extra appearance per relaxation tick, opening the cap
        // slightly to help the engine break deadlocks in the final lineups.
        const threshold = rp(p, 'P') ? maxExposurePitcher : maxExposure;
        const hardMax = Math.max(1, Math.floor(numLineups * threshold)) + exposureRelax;
        if (count >= hardMax) excludeOverExposed.add(p.name);
      }
    });

    // Build set of teams whose stack exposure has hit its max — exclude them from stacking.
    // Also build set of teams whose min exposure requires them to be stacked now.
    // remaining uses numLineups (not targetLineups) so min-exposure targets don't drift.
    const bannedStackTeams = new Set();
    const forcedStackTeams = new Set();
    if (Object.keys(teamExposureOverrides).length) {
      const remaining = Math.max(0, numLineups - lineups.length);
      for (const [team, ov] of Object.entries(teamExposureOverrides)) {
        const count = teamStackCounts[team] || 0;

        if (ov.max != null) {
          // Hard cap: compute the absolute max lineup count, not a running ratio.
          // Running ratio (count / lineups.length) fires too early — 1/2 = 50% bans a
          // team immediately even if the cap is 30% of 20 lineups = 6 total.
          // Math.max(1,...) ensures a team is never banned before it appears
          // even once — a hardMax of 0 from a small ov.max would immediately
          // exclude the team from all stacking.
          const hardMax = Math.max(1, Math.floor(numLineups * ov.max));
          if (count >= hardMax) {
            bannedStackTeams.add(team);
            // Also exclude individual players from this team so the optimizer can't
            // accidentally create a natural 3-batter cluster that bypasses the ban.
            pool.forEach(p => { if (p.team === team && !rp(p, 'P')) excludeOverExposed.add(p.name); });
          }
        }

        if (ov.min != null) {
          const targetCount = Math.ceil(numLineups * ov.min);
          if (remaining > 0 && targetCount - count >= remaining) forcedStackTeams.add(team);
        }
      }
    }

    // Build force-include set: players whose min exposure won't be met unless included now.
    // Fix 6: remaining is based on valid lineups still needed (not total attempts made),
    // so the threshold triggers correctly regardless of how many attempts were discarded.
    // remaining is clamped to numLineups so overflow doesn't suppress forced includes.
    const forceNames = new Set();
    if (Object.keys(playerOverrides).length) {
      const remaining = Math.max(0, numLineups - lineups.length);
      pool.forEach(p => {
        const ov = playerOverrides[p.name];
        if (!ov?.min) return;
        const targetCount = Math.ceil(numLineups * ov.min);
        const currentCount = exposureCounts[p.name] || 0;
        if (remaining > 0 && targetCount - currentCount >= remaining) {
          forceNames.add(p.name);
          excludeOverExposed.delete(p.name); // can't exclude a forced player
        }
      });
    }

    // Fix 7: prefer5Man is based on accepted lineup count, so discarded attempts don't
    // consume stack variety — the engine keeps targeting 5-man stacks until the quota
    // of accepted lineups with 5-man stacks is actually met.
    // Safety: if 5-man stacks fail repeatedly, temporarily relax to 3-man so we don't
    // burn all maxAttempts returning null and end up with zero lineups.
    let prefer5Man = null;
    if (target5ManCount != null) {
      if (consecutive5ManFails >= MAX_5MAN_FAILS) {
        prefer5Man = false; // fallback to 3-man for this attempt
      } else {
        prefer5Man = lineups5ManCount < target5ManCount;
      }
    }

    let lu;
    let newlyChosenStackIds = []; // stack IDs picked by generateGppLineup this attempt
    if (contestType === 'cash') {
      lu = generateCashLineup(pool, excludeOverExposed, context, iterations, allowBvP, forceNames);
    } else if (contestType === 'single') {
      lu = generateSingleLineup(pool, excludeOverExposed, context, iterations, allowBvP, forceNames);
    } else {
      // Fix 2: Read current locked team before any advance; only advance on acceptance
      const targetLockedTeam = lockedTeams.length > 0
        ? lockedTeams[lockedTeamIdx % lockedTeams.length]
        : null;

      // Fix 3: Recycle stack IDs when all available stacks have been used (counting
      // both committed and tried-but-rejected), so large portfolios maintain stack
      // correlation structure. Also trigger exposure relaxation when a full cycle
      // exhausts all stacks without finding new lineups.
      const totalUsedInCycle = usedStackIds.size + triedInCurrentRecycleCycle.size;
      if (totalAvailableStacks > 0 && totalUsedInCycle >= totalAvailableStacks) {
        usedStackIds.clear();
        triedInCurrentRecycleCycle.clear();
        // Reset 5-man fail counter so 5-man stacks get a fresh evaluation each cycle.
        // Without this reset, once consecutive5ManFails >= MAX_5MAN_FAILS the engine
        // permanently locks into 3-man mode (the counter only resets on accepted lineups),
        // excluding 5-man stacks that could produce unique combinations with jitter.
        consecutive5ManFails = 0;
        // Always count the recycle event so tests and diagnostics can confirm it fired.
        // Relaxation only increments if below cap. Log gated behind debug — this fires
        // on every recycle cycle and is high-volume noise during normal operation.
        _diag.recycleCount++;
        dlog(`[Portfolio] All ${totalAvailableStacks} stacks exhausted in cycle — exposureRelax ${exposureRelax}→${exposureRelax < MAX_EXPOSURE_RELAX ? exposureRelax + 1 : exposureRelax} (${lineups.length}/${targetLineups} built)`);
        if (exposureRelax < MAX_EXPOSURE_RELAX) {
          exposureRelax++;
        }
      }

      // Fix 7: Pass a snapshot of usedStackIds (plus stacks tried-but-rejected in this
      // cycle) so the engine won't re-pick stacks that already produced duplicate lineups.
      const pendingStackIds = new Set([...usedStackIds, ...triedInCurrentRecycleCycle]);

      lu = generateGppLineup(
        pool, excludeOverExposed, context,
        effectiveStacks3, effectiveStacks5, pendingStackIds,
        iterations, contestSize,
        targetLockedTeam, pool, allowBvP, forceNames, prefer5Man,
        bannedStackTeams, forcedStackTeams, stackSize, teamStackCounts, payoutType,
        exposureRelax > 0 ? 3.0 : 0,  // jitter: add score noise in recycle phase to break deterministic deadlock
        effectiveOwnershipLambda,
        bbEnabled, bbMinOppImplied, bbTarget, secondaryStack
      );

      // Capture which stack IDs were newly chosen during this attempt.
      // These are the IDs in pendingStackIds that weren't already in usedStackIds
      // or triedInCurrentRecycleCycle — i.e. newly added by generateGppLineup.
      newlyChosenStackIds = [...pendingStackIds].filter(
        id => !usedStackIds.has(id) && !triedInCurrentRecycleCycle.has(id)
      );

      // Commit pending stack IDs when lineup is generated (before validation).
      // triedInCurrentRecycleCycle is only cleared by the recycle cycle (line ~1689) so
      // null-producing stacks accumulate correctly until a full cycle completes.
      if (lu) {
        for (const id of pendingStackIds) {
          if (!usedStackIds.has(id)) usedStackIds.add(id);
        }
      } else if (prefer5Man === true) {
        consecutive5ManFails++;
      }
    }

    if (!lu) {
      _diag.nullLu++;
      dupFailStreak = 0;
      // A stack was placed but the lineup was rejected (e.g. prefer5Man check) — mark
      // those stack IDs as tried-in-cycle so the engine doesn't retry the same losing
      // stack on every subsequent attempt.
      if (newlyChosenStackIds.length > 0) {
        newlyChosenStackIds.forEach(id => triedInCurrentRecycleCycle.add(id));
      }
      nullLuStreak++;
      // Exposure relaxation for null-lu deadlock: use cumulative _diag.nullLu (total nulls,
      // never resets) rather than nullLuStreak (streak that resets on any dup fail). When
      // null and dup fails alternate, the streak never accumulates — but cumulative nulls do.
      if (_diag.nullLu % MAX_NULL_STREAK === 0 && exposureRelax < MAX_EXPOSURE_RELAX) {
        exposureRelax++;
        dlog(`[Portfolio] ${_diag.nullLu} total null-lu — exposureRelax +${exposureRelax} (${lineups.length}/${targetLineups} built)`);
      }
    } else {
      nullLuStreak = 0; // any non-null lineup resets the null-lu streak
      if (!lu.every(Boolean)) {
        _diag.incompleteLu++; dupFailStreak = 0;
        // First 3 incompleteLu attempts log inline (sampling pattern); rest are bucketed
        // by empty-slot signature so the final summary can show which slots most often fail.
        const emptySlots = lu.map((p, i) => p ? null : DK_SLOTS[i].key).filter(Boolean).join(',');
        if (_diag.incompleteLu <= 3) {
          console.warn('[Portfolio] Incomplete lineup — empty slots:', emptySlots);
        }
        _diag.incompleteSlotPatterns = _diag.incompleteSlotPatterns || {};
        _diag.incompleteSlotPatterns[emptySlots] = (_diag.incompleteSlotPatterns[emptySlots] || 0) + 1;
      }
    }

    const prevCount = lineups.length;
    if (lu && lu.every(Boolean)) {
      // Reject lineups below the minimum salary floor (user-configurable).
      // effectiveMinSalary is the feasibility-clamped floor — equal to minSalary on a
      // normal slate, lowered automatically when the pool can't reach the requested floor.
      if (effectiveMinSalary > 0) {
        const luSalary = lu.reduce((s, p) => s + (p.salary || 0), 0);
        if (luSalary < effectiveMinSalary) {
          _diag.salaryFail = (_diag.salaryFail || 0) + 1;
          // Every SALARY_RELAX_AFTER cumulative rejections, step the floor down so a floor
          // that's too high for this pool can't deadlock the build to empty.
          if (_diag.salaryFail % SALARY_RELAX_AFTER === 0 && effectiveMinSalary > 0) {
            effectiveMinSalary = Math.max(0, effectiveMinSalary - SALARY_RELAX_STEP);
            if (minSalaryRelaxed) minSalaryRelaxed.appliedFloor = effectiveMinSalary;
            else minSalaryRelaxed = { requested: minSalary, appliedFloor: effectiveMinSalary, maxReachable: null };
          }
          continue;
        }
      }

      // Validate stack size constraint: reject lineups that don't meet the forced stack size
      if (stackSize != null) {
        const teamCtsCheck = {};
        lu.forEach(p => { if (!rp(p, 'P')) teamCtsCheck[p.team] = (teamCtsCheck[p.team] || 0) + 1; });
        const maxTeamCount = Math.max(0, ...Object.values(teamCtsCheck));
        if (maxTeamCount < stackSize) { _diag.stackSizeFail++; continue; } // discard and retry
      }

      // Exact-duplicate check — always runs, independent of maxOverlap.
      const luNames = new Set(lu.filter(Boolean).map(p => p.name));
      const fp = [...luNames].sort().join('|');
      if (usedFingerprints.has(fp)) {
        _diag.dupFail++;
        dupFailStreak++;
        if (prefer5Man === true) consecutive5ManFails++;
        // Mark this stack as tried-but-rejected so the engine picks a different one next time
        newlyChosenStackIds.forEach(id => triedInCurrentRecycleCycle.add(id));
        continue;
      }

      // ── Deadlock escalation ("auto-relax to hit the target") ──────────────────
      // When several constraint-tighteners stack (forced stack size + low overlap +
      // exposure caps + sim-filter overflow), the distinct-lineup space collapses and
      // the conservative relaxation below caps out long before reaching the count —
      // the "stuck at 16/19 of 20" failure mode. Once we're past 40% of the attempt
      // budget and STILL short of the final requested count (numLineups, not the
      // sim-filter overflow target), escalate hard: open the overlap cap all the way
      // and lift the exposure ceiling. The exact-duplicate guard still prevents
      // identical lineups, and with sim-filter on the looser overflow is sim-ranked
      // and trimmed back to the best numLineups — so quality is largely recovered.
      const behindFinalCount = lineups.length < numLineups;
      const desperate = behindFinalCount && attempts > maxAttempts * 0.40;
      const overlapCeil = desperate ? (ROSTER_SIZE - 1) : 6; // 9 = effectively off
      const exposureCeil = desperate ? Math.max(MAX_EXPOSURE_RELAX, Math.ceil(numLineups * 0.50))
                                     : MAX_EXPOSURE_RELAX;

      // Progressive overlap relaxation: when overlap is a significant share of ALL failures
      // (not just total attempts), raise the overlap cap by 1. Using share-of-failures
      // (overlapFail / (overlapFail + dupFail)) rather than share-of-attempts prevents the
      // threshold from going unmet when dup failures co-occur. In desperation the cadence
      // tightens (every 75 attempts) and the share gate is dropped so the cap can climb
      // fully open without waiting on the failure-mix heuristic.
      if (maxOverlap > 0 && attempts - lastRelaxAt >= (desperate ? 75 : 200)
          && effectiveMaxOverlap < overlapCeil && lineups.length < targetLineups) {
        const totalFails = _diag.overlapFail + _diag.dupFail;
        const overlapShare = _diag.overlapFail / Math.max(1, totalFails);
        if (desperate || overlapShare > 0.40) {
          effectiveMaxOverlap = Math.min(overlapCeil, effectiveMaxOverlap + 1);
          lastRelaxAt = attempts;
          dlog(`[Portfolio] Overlap cap relaxed to ${effectiveMaxOverlap}${desperate ? ' (desperate)' : ''} after ${attempts} attempts (overlap ${Math.round(overlapShare*100)}% of failures, ${lineups.length}/${targetLineups} built)`);
        }
      }

      // Exposure relaxation: when exact-duplicate failures dominate (consecutive dup
      // rejections), the optimizer has converged and the only escape is to open one extra
      // appearance per player so new combinations become reachable. The ceiling lifts in
      // desperation (up to ~50% of numLineups) when over-exposure is the binding limit.
      if (dupFailStreak > 0 && dupFailStreak % 20 === 0 && exposureRelax < exposureCeil) {
        exposureRelax++;
        dlog(`[Portfolio] Exposure cap relaxed +${exposureRelax} after ${dupFailStreak} consecutive dup failures (${lineups.length}/${targetLineups} built)`);
      }

      // Early exit: unique lineup space genuinely exhausted — don't burn remaining budget.
      // Uses dupFailStreak (consecutive dup failures) rather than cumulative dup rate so
      // that natural high-dup phases during stack recycling don't trigger a premature exit.
      // Only fires once EVERY relaxation lever is fully spent — overlap fully open and
      // exposure at its (possibly lifted) ceiling — so the desperate escalation above
      // always gets its chance before we concede the slate is genuinely maxed out.
      const fullyRelaxed = (maxOverlap === 0 || effectiveMaxOverlap >= ROSTER_SIZE - 1)
                        && exposureRelax >= exposureCeil;
      if (fullyRelaxed && dupFailStreak > maxAttempts * 0.50) {
        dlog(`[Portfolio] Space exhausted: ${dupFailStreak} consecutive dup failures at max relaxation — ${lineups.length}/${targetLineups} is the feasible limit`);
        _diag.exhausted = true;
        break;
      }

      // Fix 4: Check maxOverlap via the player index — O(players) instead of O(lineups²)
      let tooSimilar = false;
      if (effectiveMaxOverlap > 0 && lineups.length > 0) {
        const overlapCounts = new Map();
        for (const name of luNames) {
          const indices = playerLineupIndex.get(name);
          if (!indices) continue;
          for (const luIdx of indices) {
            const c = (overlapCounts.get(luIdx) || 0) + 1;
            if (c > effectiveMaxOverlap) { tooSimilar = true; break; }
            overlapCounts.set(luIdx, c);
          }
          if (tooSimilar) break;
        }
      }
      if (tooSimilar) {
        _diag.overlapFail++;
        dupFailStreak = 0;
        if (prefer5Man === true) consecutive5ManFails++;
        newlyChosenStackIds.forEach(id => triedInCurrentRecycleCycle.add(id));
      }

      // Max avg ownership filter: reject high-chalk lineups when a cap is set.
      if (maxAvgOwnership > 0) {
        const avgOwn = lu.reduce((s, p) => s + (p.own || 0), 0) / lu.length;
        if (avgOwn > maxAvgOwnership) { _diag.ownCapFail = (_diag.ownCapFail || 0) + 1; continue; }
      }

      // SP same-game guard: reject lineups where SP1 and SP2 are in the same game.
      // Opposing pitchers create correlated variance — both score well in pitcher duels,
      // both suffer in high-scoring games — removing the independent-game upside that
      // GPP construction requires. Always active for dual-pitcher lineups.
      // Uses opp field (primary) with game field as fallback so the guard fires even
      // when the opponent field is absent (e.g. unconfirmed slates or partial DK imports).
      let sameGameSP = false;
      if (!tooSimilar) {
        const sps = lu.filter(p => rp(p, 'P'));
        if (sps.length === 2) {
          const oppCheck = sps[0].opp && sps[1].opp &&
            (sps[0].team === sps[1].opp || sps[1].team === sps[0].opp);
          const gameCheck = sps[0].game && sps[1].game && sps[0].game === sps[1].game;
          sameGameSP = !!(oppCheck || gameCheck);
          if (sameGameSP) _diag.sameGameSPFail = (_diag.sameGameSPFail || 0) + 1;
        }
      }

      // SP pair concentration check: when maxSpPairLineups > 0, reject lineups whose
      // pitcher duo is already at the cap. This breaks the pattern where all lineups
      // share the same elite-SP combo, which concentrates correlated upside/bust risk.
      let spPairBlocked = false;
      if (!tooSimilar && !sameGameSP && maxSpPairLineups > 0) {
        const spNames = lu.filter(p => rp(p, 'P')).map(p => p.name).sort();
        const spKey = spNames.join('|');
        if (spKey && (spPairCounts[spKey] || 0) >= maxSpPairLineups) {
          _diag.spPairFail = (_diag.spPairFail || 0) + 1;
          spPairBlocked = true;
          dupFailStreak = 0;
        }
      }

      // Game exposure cap — reject lineups that would push a single game above
      // effectiveMaxGameExposure fraction of the portfolio. Relaxes progressively
      // when other games can't supply the remaining lineups.
      let gameCapBlocked = false;
      if (!tooSimilar && !sameGameSP && !spPairBlocked && effectiveMaxGameExposure > 0 && lineups.length > 0) {
        const game = getPrimaryStackGame(lu);
        if (game) {
          const hardMax = Math.floor(numLineups * effectiveMaxGameExposure);
          if ((gameStackCounts[game] || 0) >= hardMax) {
            gameCapBlocked = true;
            _diag.gameCapFail = (_diag.gameCapFail || 0) + 1;
            gameCapFailStreak++;
            dupFailStreak = 0;
            // Progressive game cap relaxation: when we've failed many times on this cap,
            // open it by 5% so the dominant game can absorb the remaining lineups.
            if (gameCapFailStreak - lastGameCapRelaxAt >= 80 && effectiveMaxGameExposure < 1.0 && lineups.length < targetLineups) {
              effectiveMaxGameExposure = Math.min(1.0, effectiveMaxGameExposure + 0.05);
              lastGameCapRelaxAt = gameCapFailStreak;
              dlog(`[Portfolio] Game cap relaxed to ${Math.round(effectiveMaxGameExposure * 100)}% after ${gameCapFailStreak} cap failures (${lineups.length}/${targetLineups} built)`);
            }
          }
        }
      }

      if (!tooSimilar && !sameGameSP && !spPairBlocked && !gameCapBlocked) {
        // ── FINAL SAFETY CHECK: Reject any lineup over salary cap ──────────
        // This should never happen (optimizeLineup checks it), but edge cases in
        // stack placement or Phase 3 modifications can cause overages. Catch them here.
        const salTotal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
        if (salTotal > SALARY_CAP) {
          _diag.salaryCapFail = (_diag.salaryCapFail || 0) + 1;
          dupFailStreak = 0;
          continue; // reject and retry
        }

        const acceptedIdx = lineups.length;
        lineups.push(lu);
        dupFailStreak = 0;
        usedFingerprints.add(fp);
        lu.forEach(p => {
          exposureCounts[p.name] = (exposureCounts[p.name] || 0) + 1;
          // Fix 4: Maintain player→lineup index for future overlap checks
          if (!playerLineupIndex.has(p.name)) playerLineupIndex.set(p.name, new Set());
          playerLineupIndex.get(p.name).add(acceptedIdx);
        });
        // Fix 2: Advance locked-team round-robin only when a GPP lineup is accepted
        if (contestType !== 'cash' && contestType !== 'single' && lockedTeams.length > 0) lockedTeamIdx++;
        // Reset 5-man fallback counter on accepted lineups only (not on generated-but-rejected)
        consecutive5ManFails = 0;
        // Track 5-man stack usage and per-team stack counts
        const teamCts = {};
        lu.forEach(p => { if (!rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
        if (target5ManCount != null && Object.values(teamCts).some(c => c >= 5)) lineups5ManCount++;
        Object.entries(teamCts).forEach(([team, c]) => {
          if (c >= 3) teamStackCounts[team] = (teamStackCounts[team] || 0) + 1;
        });
        // Track under-sized placements when a forced stack size was requested.
        // minResolved allows stackSize-1 anchors, so a "5-man" lineup may only land 4 batters.
        if (stackSize != null) {
          const maxTeamBatters = Object.values(teamCts).length > 0 ? Math.max(...Object.values(teamCts)) : 0;
          if (maxTeamBatters < stackSize) stackShortfallCount++;
        }
        // Record SP pair for concentration tracking
        if (maxSpPairLineups > 0) {
          const spNames = lu.filter(p => rp(p, 'P')).map(p => p.name).sort();
          const spKey = spNames.join('|');
          if (spKey) spPairCounts[spKey] = (spPairCounts[spKey] || 0) + 1;
        }
        // Fix 3: record primary stack game count
        if (maxGameExposure > 0) {
          const game = getPrimaryStackGame(lu);
          if (game) gameStackCounts[game] = (gameStackCounts[game] || 0) + 1;
        }
      }
    }

    // Yield on acceptance or every 25 attempts. Fast-reject paths use `continue` and skip
    // this entirely. Batching cuts scheduler wakeups by ~90% vs yielding every attempt.
    if (lineups.length > prevCount || attempts % 25 === 0) {
      if (onProgress) onProgress(lineups.length, targetLineups, lineups.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Diagnostic summary
  if (effectiveMaxOverlap > maxOverlap) _diag.overlapRelaxed = effectiveMaxOverlap;
  if (effectiveMaxGameExposure > maxGameExposure) _diag.gameCapRelaxed = Math.round(effectiveMaxGameExposure * 100);
  dlog(`[Portfolio] ${lineups.length}/${targetLineups} lineups built in ${attempts}/${maxAttempts} attempts`, _diag);
  if (_diag.recycleCount > 0) dlog(`[Portfolio] stacks exhausted in cycle: ${_diag.recycleCount} recycle(s) during ${lineups.length}/${targetLineups} build`);
  // Final incomplete-lineup summary — only fires when there were more than the first
  // 3 sampled inline. Shows which roster slot patterns most often went unfilled so the
  // user can target the bottleneck (e.g. "5x missing 2P" = pitcher cap too low).
  if (_diag.incompleteLu > 3 && _diag.incompleteSlotPatterns) {
    const topPatterns = Object.entries(_diag.incompleteSlotPatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([slots, count]) => `${count}× missing [${slots || 'all'}]`)
      .join(', ');
    console.warn(`[Portfolio] Incomplete lineup summary — ${_diag.incompleteLu} total attempts produced empty roster slots. Top patterns: ${topPatterns}. Common cause: salary cap exhaustion or overlap cap excluding all eligible fillers.`);
  }
  if (lineups.length === 0) {
    const viableP = pool.filter(p => rp(p, 'P') && p.salary > 0 && !bannedNames.has(p.name)).length;
    const viableB = pool.filter(p => !rp(p, 'P') && p.salary > 0 && !bannedNames.has(p.name)).length;
    console.warn(`[Portfolio] Zero lineups! Pool: ${viableP} pitchers, ${viableB} batters | stacks3: ${effectiveStacks3.length}, stacks5: ${effectiveStacks5.length} | stackSize: ${stackSize} | contestType: ${contestType}`);
  }

  // ── Sim-ROI filter pass ──────────────────────────────────────────────────
  // When simFilter is enabled, we generated targetLineups > numLineups.
  // Score each lineup with a lightweight simulation, keep the top numLineups
  // by sim ROI, then recompute exposure from the trimmed set.
  let simFilterStats = null; // surfaced in return value for UI transparency
  if (simFilter && lineups.length > numLineups) {
    if (onProgress) onProgress(maxAttempts, maxAttempts, lineups.length);
    await new Promise(r => setTimeout(r, 0));

    const simResults = await simulatePortfolio(lineups, pool, simFilterSims, contestType, null, null, payoutType, contestSize, true,
      onProgress ? (done, total) => onProgress(-(done + 1), total) : null,
      opts.customPayoutConfig || null
    );
    // simResults is sorted by simROI_lb desc (penalised for noise). Apply band filter if bounds are set.
    // Band candidates = lineups whose simROI falls within [simROIMin, simROIMax].
    // If fewer than numLineups qualify, fill the gap with the closest out-of-band
    // lineups (by absolute distance to the nearest bound) rather than leaving slots empty.
    let kept;
    let inBandCount = 0;
    const hasBand = simROIMin != null || simROIMax != null;
    if (hasBand) {
      const inBand = simResults.filter(r =>
        (simROIMin == null || r.simROI >= simROIMin) &&
        (simROIMax == null || r.simROI <= simROIMax)
      );
      inBandCount = inBand.length;
      if (inBand.length >= numLineups) {
        // More than enough — take the top numLineups within the band (closest to upper bound = best ROI)
        kept = inBand.slice(0, numLineups).map(r => r.lu);
      } else {
        // Not enough in-band — fill remainder with nearest out-of-band lineups
        const inBandSet = new Set(inBand.map(r => r.lu));
        const outOfBand = simResults
          .filter(r => !inBandSet.has(r.lu))
          .sort((a, b) => {
            // Distance = how far outside the band the lineup is
            const distA = simROIMin != null && a.simROI < simROIMin ? simROIMin - a.simROI
                        : simROIMax != null && a.simROI > simROIMax ? a.simROI - simROIMax : 0;
            const distB = simROIMin != null && b.simROI < simROIMin ? simROIMin - b.simROI
                        : simROIMax != null && b.simROI > simROIMax ? b.simROI - simROIMax : 0;
            return distA - distB;
          });
        kept = [...inBand, ...outOfBand].slice(0, numLineups).map(r => r.lu);
      }
    } else {
      inBandCount = simResults.length; // no band — all qualify
      // Min-exposure-aware trim: keep the top numLineups by ROI but protect any player/team
      // MIN-exposure targets that a naive top-N would drop. (When an ROI band is set, the
      // band selection above takes precedence and min-protection is not applied.)
      kept = selectWithMinExposure(simResults, numLineups, playerOverrides, teamExposureOverrides);
    }

    // Record per-lineup simROI for the kept set so the UI can show the distribution
    const keptSet = new Set(kept);
    const keptResults = simResults.filter(r => keptSet.has(r.lu));
    const keptROIs = keptResults.map(r => r.simROI);
    const backfilled = hasBand ? Math.max(0, numLineups - inBandCount) : 0;
    simFilterStats = {
      generated: lineups.length,        // total lineup candidates before filter
      inBand: hasBand ? inBandCount : null,
      backfilled,                        // how many were filled from outside the band
      simROIMin: keptROIs.length ? Math.min(...keptROIs) : null,
      simROIMax: keptROIs.length ? Math.max(...keptROIs) : null,
      simROIMean: keptROIs.length ? parseFloat((keptROIs.reduce((s, v) => s + v, 0) / keptROIs.length).toFixed(1)) : null,
    };

    // Recompute exposureCounts from the trimmed lineup set
    const newCounts = {};
    kept.forEach(lu => { lu.forEach(p => { newCounts[p.name] = (newCounts[p.name] || 0) + 1; }); });
    for (const k of Object.keys(exposureCounts)) exposureCounts[k] = newCounts[k] || 0;

    // Replace lineups in place
    lineups.length = 0;
    kept.forEach(lu => lineups.push(lu));
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

  // Players who exceeded their original (pre-relaxation) cap due to auto-relaxation.
  // Surfaced so users can see exactly who was over-played when caps were opened.
  const exposureCapBreached = [];
  if (exposureRelax > 0 && lineups.length > 0) {
    pool.forEach(p => {
      const cnt = exposureCounts[p.name];
      if (!cnt) return;
      const ov = playerOverrides[p.name];
      const originalThreshold = ov?.max != null ? ov.max : (rp(p, 'P') ? maxExposurePitcher : maxExposure);
      const originalCap = Math.max(1, Math.floor(numLineups * originalThreshold));
      if (cnt > originalCap) {
        exposureCapBreached.push({
          name: p.name,
          count: cnt,
          pct: parseFloat((cnt / lineups.length * 100).toFixed(1)),
          originalCap,
          originalCapPct: Math.round(originalThreshold * 100),
          isPitcher: rp(p, 'P')
        });
      }
    });
    exposureCapBreached.sort((a, b) => b.pct - a.pct);
  }

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

  // Bring-back rate: count GPP lineups that include at least one batter from the opposing
  // team of the primary stack. Surfaced in the results summary so users can verify that
  // bring-back placement is actually working for their salary/exposure configuration.
  let bringBackCount = 0;
  if (contestType === 'gpp' && bbEnabled && lineups.length > 0) {
    lineups.forEach(lu => {
      const teamCts_bb = {};
      lu.forEach(p => { if (!rp(p, 'P')) teamCts_bb[p.team] = (teamCts_bb[p.team] || 0) + 1; });
      if (!Object.keys(teamCts_bb).length) return;
      const primaryTeam = Object.entries(teamCts_bb).sort((a, b) => b[1] - a[1])[0][0];
      const opp = pool.find(p => p.team === primaryTeam && p.opp)?.opp;
      if (opp && lu.some(p => p && p.team === opp && !rp(p, 'P'))) bringBackCount++;
    });
  }

  return {
    lineups, playerExposure, teamExposure, teamStackCounts,
    totalLineups: lineups.length,
    requested: numLineups,  // original requested count — UI warns when lineups.length < requested
    stackSize,             // forced stack size (3|4|5|null) — used by UI for contextual advice
    stackShortfallCount,  // lineups where forced stack size wasn't fully achieved (under-sized)
    bringBackCount,       // GPP lineups that include ≥1 batter from the primary stack's opponent
    exposureRelaxUsed: exposureRelax, // > 0 means caps were opened to fill lineups
    exposureCapBreached, // [{ name, count, pct, originalCap, originalCapPct, isPitcher }] — players over their stated cap
    minSalaryRelaxed,    // { requested, appliedFloor, maxReachable } when the min-salary floor was auto-lowered to stay feasible; null otherwise
    virtualStackTeams: [...virtualStackTeams],
    pitcherWarnings, teamExposureWarnings,
    bannedTeams, lockedTeams,
    diversity: null, // computed lazily in renderPortfolioResults — avoids O(n²) on the hot path
    simFilterStats,  // null if sim filter was not used
    spPairCounts,    // { 'SP1|SP2': count } — SP duo exposure across portfolio
    gameStackCounts, // Fix 3: { game: count } — primary-stack game exposure across portfolio
    _diag  // diagnostic counters for debugging
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
function generateGppLineup(pool, excludeNames, context, stacks3, stacks5, usedStackIds, iterations, contestSize, lockedTeam, fullPool, allowBvP = false, forceInclude = new Set(), prefer5Man = null, bannedStackTeams = new Set(), forcedStackTeams = new Set(), stackSize = null, teamStackCounts = {}, payoutType = 'top20', jitter = 0, ownershipLambda = 0, bbEnabled = true, bbMinOppImplied = 4.0, bbTarget = null, secondaryStackTarget = null) {
  const requiredSlots = new Array(ROSTER_SIZE).fill(null);
  let usedStackTeam = null;

  // Build ordered candidate stacks. prefer5Man: true = favor 5-man, false = favor 3-man, null = auto.
  // Sort by: (proj * impliedTotal/4.5) - own*0.3 — teams in high run environments rank higher.
  const vegasData = context?.vegasData || {};
  const minImpliedTotal = context?.minImpliedTotal || 0;
  const stackImplied = team => vegasData[team]?.impliedTotal || 4.5;
  // Pre-compute correlation bonus for user-uploaded stacks.
  // Expressed as a fraction of the base projection so it scales correctly with
  // the repeatPenalty (which was calibrated against proj * vegas / 4.5 magnitudes).
  // Virtual stacks are already order-optimised during buildVirtualStack so they
  // get no additional correlation adjustment here.
  const _corrBonusCache = new Map();
  const getStackCorrBonus = stack => {
    if (stack.isVirtual) return 0;
    if (_corrBonusCache.has(stack.id)) return _corrBonusCache.get(stack.id);
    const stackPlayers = stack.players
      .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase()))
      .filter(Boolean);
    if (stackPlayers.length < 2 || !stack.proj || stack.proj <= 0) {
      _corrBonusCache.set(stack.id, 0);
      return 0;
    }
    const p90 = calcAnalyticalStackP90(stackPlayers);
    // Bonus = (P90 / base_proj - 1) × base_proj × 0.3
    // → 30% of the correlation-driven upside lift, capped at ±3 pts so it
    //   acts as a tiebreaker between similar stacks without displacing the
    //   repeatPenalty's ability to spread exposure across teams.
    const bonus = Math.min(3, Math.max(-1, (p90 / stack.proj - 1.0) * stack.proj * 0.3));
    _corrBonusCache.set(stack.id, bonus);
    return bonus;
  };

  // Blended ownership for uploaded stacks: max player own × 0.5 + avg × 0.5.
  // A stack with one 40%-owned chalk anchor penalises more than average-only would.
  // Virtual stacks already use this formula in buildVirtualStack, so pass through.
  const blendedStackOwn = stack => {
    if (stack.isVirtual) return stack.own || 0;
    const owns = stack.players.map(name => {
      const pl = pool.find(p => p.name.toLowerCase() === name.toLowerCase());
      return pl?.own || 0;
    });
    if (!owns.length) return stack.own || 0;
    const avg = owns.reduce((s, v) => s + v, 0) / owns.length;
    return Math.max(...owns) * 0.5 + avg * 0.5;
  };

  const sortByValue = (a, b) => {
    // Penalise teams already heavily stacked in the portfolio to spread stack exposure.
    const repeatPenaltyA = (teamStackCounts[a.team] || 0) * 1.5;
    const repeatPenaltyB = (teamStackCounts[b.team] || 0) * 1.5;
    // Adjacency bonus for user-uploaded stacks: prefer stacks whose players sit
    // adjacent in the batting order. Virtual stacks are already order-optimised
    // during buildVirtualStack so they don't need a second pass here.
    const adjBonusA = a.isVirtual ? 0 : computeStackAdjacencyFromPool(a.players, pool) * 2.0;
    const adjBonusB = b.isVirtual ? 0 : computeStackAdjacencyFromPool(b.players, pool) * 2.0;
    // Correlation bonus replaces the static adjacency bonus when the correlated P90
    // is measurably higher than the base projection (i.e. batters are genuinely correlated).
    const corrBonusA = getStackCorrBonus(a);
    const corrBonusB = getStackCorrBonus(b);
    // PRIMARY SIGNAL: use analytical P90 (correlated upside) instead of mean projection
    // This promotes stacks with high ceiling and tight correlation over high mean but spread
    const stackPlayersA = a.players.map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase())).filter(Boolean);
    const stackPlayersB = b.players.map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase())).filter(Boolean);
    const p90A = stackPlayersA.length >= 2 ? calcAnalyticalStackP90(stackPlayersA) : a.proj || 0;
    const p90B = stackPlayersB.length >= 2 ? calcAnalyticalStackP90(stackPlayersB) : b.proj || 0;
    const scoreA = p90A * (stackImplied(a.team) / 4.5) - blendedStackOwn(a) * 0.3 - repeatPenaltyA + adjBonusA + corrBonusA;
    const scoreB = p90B * (stackImplied(b.team) / 4.5) - blendedStackOwn(b) * 0.3 - repeatPenaltyB + adjBonusB + corrBonusB;
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
  // Zero-projection stack warnings are deduped per-build via this Set. Previously the
  // warning fired on every buildCandidates() call (200+ times per 20-lineup build),
  // drowning out anything else in the console. Each stack ID warns at most once now.
  const _zeroProjWarned = new Set();
  const buildCandidates = () => {
    // Filter out stacks for teams that have hit their exposure max or are below min implied total.
    // Warn when uploaded stacks are silently dropped because projections haven't been loaded yet.
    const avail5 = stacks5.filter(s => {
      if (s.proj <= 0 && !s.isVirtual && !_zeroProjWarned.has(s.id)) {
        _zeroProjWarned.add(s.id);
        console.warn(`[Stacks] 5-man stack for ${s.team} (id=${s.id}) has proj=0 — skipped. Load projections or upload ROO data.`);
      }
      return s.proj > 0 && !usedStackIds.has(s.id) && !bannedStackTeams.has(s.team) && passesEnvironment(s.team);
    }).sort(sortByValue);
    const avail3 = stacks3.filter(s => {
      if (s.proj <= 0 && !s.isVirtual && !_zeroProjWarned.has(s.id)) {
        _zeroProjWarned.add(s.id);
        console.warn(`[Stacks] 3-man stack for ${s.team} (id=${s.id}) has proj=0 — skipped. Load projections or upload ROO data.`);
      }
      return s.proj > 0 && !usedStackIds.has(s.id) && !bannedStackTeams.has(s.team) && passesEnvironment(s.team);
    }).sort(sortByValue);

    // When a specific stack size is forced, only use the matching pool — no cross-size fallback.
    // stackSize=4 candidates are passed in as stacks3 (autoStacks4), so avail3 holds them.
    let primary, secondary;
    if (stackSize === 5) { primary = avail5; secondary = []; }
    else if (stackSize === 3) { primary = avail3; secondary = []; }
    else if (stackSize === 4) { primary = avail3; secondary = []; }
    else {
      // Mix mode: primary/secondary driven by prefer5Man flag
      primary = prefer5Man === false ? avail3 : avail5;
      secondary = prefer5Man === false ? avail5 : avail3;
    }
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
    // Shuffle primary and secondary independently so the priority order is preserved:
    // when prefer5Man=true, all 5-man stacks are tried before any 3-man stack, preventing
    // the 3-man-first placement that triggers the has5ManLeft null-return path on every attempt.
    const shuffle = arr => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Wider candidate windows give each attempt more options, reducing the
    // chance that the only feasible combination is outside the slice.
    return [...shuffle(primary.slice(0, 25)), ...shuffle(secondary.slice(0, 20))];
  };

  const candidates = (stacks5.length > 0 || stacks3.length > 0) ? buildCandidates() : [];

  // Minimum resolved players required before attempting placement.
  // For forced stack sizes: require all stackSize players. With bring-back and secondary
  // stacks consuming remaining batter slots, a 4-player placement from a 5-man file entry
  // leaves no room for the greedy fill to add the 5th, causing near-certain rejection at
  // the stackSizeFail gate (line 2702). Requiring all stackSize prevents these wasted
  // attempts. Mix mode with prefer5Man: require the full stack count for 5-man stacks.
  // Mix mode fallback: require at least 3 so a partially-degraded stack can still be used.
  const minResolved = stackSize != null ? () => stackSize
                    : prefer5Man === true ? stack => Math.max(4, stack.players.length - 1)
                    : stack => Math.min(3, stack.players.length);

  for (const stack of candidates) {
    const stackPlayers = stack.players
      .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase() && !excludeNames.has(p.name)))
      .filter(Boolean);
    if (stackPlayers.length < minResolved(stack)) continue;

    const tempSlots = new Array(ROSTER_SIZE).fill(null);
    if (tryPlaceStack(stackPlayers, tempSlots, pool)) {
      // Adjacency filter: only active when ALL stack batters have confirmed batting orders.
      // Requires at least one pair of players within 2 spots — scattered stacks like
      // (1-3-6-8-9) lose most inning-chain correlation that makes stacking valuable in GPP.
      // Threshold raised from 50% → 100% confirmed: at 50% many partial-confirmation slates
      // would reject every uploaded stack and fall through to stackless lineups, hurting
      // portfolio quality. The adjacency bonus in computeStackBonus still rewards better
      // stacks during scoring even when this hard filter can't fire.
      const orderedBatters = stackPlayers.filter(p => p.order > 0);
      if (orderedBatters.length === stackPlayers.length && orderedBatters.length >= 2) {
        const orders = orderedBatters.map(p => p.order).sort((a, b) => a - b);
        const hasAdjacent = orders.some((o, i) => i < orders.length - 1 && orders[i + 1] - o <= 2);
        if (!hasAdjacent) continue; // scattered batting positions — try next candidate
      }
      for (let i = 0; i < ROSTER_SIZE; i++) { if (tempSlots[i]) requiredSlots[i] = tempSlots[i]; }
      usedStackTeam = stack.team;
      usedStackIds.add(stack.id); // virtual stacks have id='virtual_TEAM_SIZE'; track all
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
      if (stackPlayers.length >= (stackSize || 3)) {
        const tempSlots = new Array(ROSTER_SIZE).fill(null);
        if (tryPlaceStack(stackPlayers, tempSlots, pool)) {
          for (let i = 0; i < ROSTER_SIZE; i++) { if (tempSlots[i]) requiredSlots[i] = tempSlots[i]; }
          usedStackTeam = lockedTeam;
          usedStackIds.add(virtual.id); // track virtual stack so it's not retried this cycle
        }
      }
    }
  }

  // If a specific stack size was forced but still no stack placed (no stacks file or all degraded),
  // auto-synthesize from the pool. Tries teams in descending projected-score order.
  if (!usedStackTeam && stackSize != null) {
    const srcPool = fullPool || pool;
    const batters = srcPool.filter(p => !rp(p, 'P') && p.salary > 0 && (p.median > 0 || p.avgPpg > 0) && !bannedStackTeams.has(p.team) && passesEnvironment(p.team));
    const teamScore = {};
    batters.forEach(p => { teamScore[p.team] = (teamScore[p.team] || 0) + (p.median || p.avgPpg || 0); });
    const teams = Object.keys(teamScore).sort((a, b) => teamScore[b] - teamScore[a]);
    for (const team of teams) {
      const virtual = buildVirtualStack(team, srcPool, excludeNames, stackSize);
      if (!virtual) continue;
      const stackPlayers = virtual.players
        .map(name => pool.find(p => p.name.toLowerCase() === name.toLowerCase() && !excludeNames.has(p.name)))
        .filter(Boolean);
      if (stackPlayers.length < stackSize) continue;
      const tempSlots = new Array(ROSTER_SIZE).fill(null);
      if (tryPlaceStack(stackPlayers, tempSlots, pool)) {
        for (let i = 0; i < ROSTER_SIZE; i++) { if (tempSlots[i]) requiredSlots[i] = tempSlots[i]; }
        usedStackTeam = team;
        usedStackIds.add(virtual.id); // track virtual stack so it's not retried this cycle
        break;
      }
    }
  }

  // ── Bring-back: 1–2 batters from the opposing team in the same game ──────────
  // After a primary stack is placed, take 1 player from the opponent of usedStackTeam
  // (or 2 when the game total is ≥11.0). Bring-backs capture the correlation that
  // both offenses benefit when a game goes high-scoring and are the primary mechanism
  // for generating truly differentiated, ceiling-heavy GPP lineups.
  //
  // Fix 2 — Gate on opponent's implied total (≥4.0), not the full game total.
  // The old gate (gameTotal ≥ 8.0) fired even when the opponent implied only 2–3 runs
  // (e.g., a 8.2-total game where the primary stack implies 6.2 and the opp implies 2.0).
  // Using the opponent's own implied total ensures bring-backs come from offenses with
  // real scoring upside, not because the primary stack's team happened to inflate the O/U.
  let usedBringBackTeam = null;
  const stackOpp = usedStackTeam ? (pool.find(p => p.team === usedStackTeam && p.opp))?.opp : null;
  const stackOppImplied = stackOpp ? (vegasData[stackOpp]?.impliedTotal || 0) : 0;
  const bbGameTotal = vegasData[usedStackTeam]?.gameTotal || 0;
  // Reserve hitter slots for a secondary stack so bring-back + secondary don't both try to
  // consume the same room. DK rosters have 8 hitter slots; a 5-primary + 3-secondary already
  // fills all 8, so on deep primaries the bring-back is trimmed (or skipped) in favour of the
  // cross-game secondary, which adds an independent ceiling source rather than a same-game hedge.
  //
  // Secondary stacking is a large-slate strategy. In AUTO mode it stands down on small slates,
  // where forcing a second stack just clones lineups (no room for diversity) and is poor
  // strategy on a concentrated slate anyway. The right measure is the number of games that
  // actually contain a STACKABLE team (≥4 batters) — the raw game count over-counts venues
  // where no real secondary is possible (a team with 1–2 listed players). An explicit 2/3
  // honours the user's deliberate choice regardless of slate size.
  const _secTeamBatters = {};
  pool.forEach(p => { if (!rp(p, 'P') && p.salary > 0 && ((p.median || 0) > 0 || (p.ceiling || 0) > 0)) _secTeamBatters[p.team] = (_secTeamBatters[p.team] || 0) + 1; });
  const stackableGames = new Set(
    pool.filter(p => !rp(p, 'P') && p.game && (_secTeamBatters[p.team] || 0) >= 4).map(p => p.game)
  ).size;
  const secActive = !!secondaryStackTarget && secondaryStackTarget !== 'off'
    && !(secondaryStackTarget === 'auto' && stackableGames < 5);
  const secReserve = secActive
    ? (secondaryStackTarget === 'auto' ? 2 : parseInt(secondaryStackTarget) || 0)
    : 0;
  if (bbEnabled && usedStackTeam && stackOpp && stackOppImplied >= bbMinOppImplied) {
    const primaryBatters = requiredSlots.filter(p => p && !rp(p, 'P')).length;
    const bbRoom = Math.max(0, 8 - primaryBatters - secReserve);
    const bringBackTarget = Math.min(bbRoom, bbTarget != null ? bbTarget : (bbGameTotal >= 11.0 ? 2 : 1));

    {
      const alreadyPlaced = new Set(requiredSlots.filter(Boolean).map(p => p.name));

      // Score bring-back candidates with batting order PA weight and Vegas-scaled projection.
      // Top-of-order bring-backs from high-implied teams generate the most ceiling correlation.
      const bbCandidates = pool.filter(p =>
        p.team === stackOpp &&
        !rp(p, 'P') &&
        !excludeNames.has(p.name) &&
        !alreadyPlaced.has(p.name) &&
        p.salary > 0 &&
        (p.median > 0 || p.ceiling > 0)
      ).sort((a, b) => {
        const oMa = orderPAMult(a.order), oMb = orderPAMult(b.order);
        const vegasScale = stackOppImplied / 4.5;
        // Ownership-weighted scoring: divide by own^0.6 to reduce over-owned bring-backs
        // This creates natural diversification without explicit capping
        const ownWeightA = Math.pow(Math.max(a.own || 1, 1), 0.6);
        const ownWeightB = Math.pow(Math.max(b.own || 1, 1), 0.6);
        const sa = ((a.ceiling || 0) * 0.65 + (a.median || 0) * 0.35) * oMa * vegasScale / ownWeightA - (a.own || 0) * 0.06;
        const sb = ((b.ceiling || 0) * 0.65 + (b.median || 0) * 0.35) * oMb * vegasScale / ownWeightB - (b.own || 0) * 0.06;
        return sb - sa;
      });

      let placed = 0;
      for (const bb of bbCandidates) {
        if (placed >= bringBackTarget) break;
        // BvP check: skip if there's already a pitcher who faces this batter's team.
        if (!allowBvP && requiredSlots.some(p => p && rp(p, 'P') && p.opp === bb.team)) continue;
        // Per-team cap: don't exceed maxBattersPerTeam on the bring-back team.
        const bbTeamCount = requiredSlots.filter(p => p && !rp(p, 'P') && p.team === bb.team).length;
        if (bbTeamCount >= 5) break; // can't place any more from this team
        // Salary headroom check — use slot-type-aware minimums for remaining open slots.
        // bb is a batter, so it consumes one batter slot; remaining open slots keep their type mins.
        const salUsed = requiredSlots.reduce((s, p) => s + (p ? p.salary : 0), 0);
        const minAllOpen = DK_SLOTS.reduce((s, slot, si) =>
          requiredSlots[si] ? s : s + (slot.key === 'P' ? 5500 : MIN_SALARY_PER_SLOT), 0);
        // After placing bb, one batter slot's reservation is consumed by bb itself
        const minAfterPlace = minAllOpen - MIN_SALARY_PER_SLOT;
        if (salUsed + bb.salary + minAfterPlace > SALARY_CAP) continue;
        // Place in first eligible open slot.
        for (let i = 0; i < ROSTER_SIZE; i++) {
          if (requiredSlots[i] || !DK_SLOTS[i].eligible(bb)) continue;
          requiredSlots[i] = bb;
          alreadyPlaced.add(bb.name);
          if (placed === 0) usedBringBackTeam = bb.team; // track for scoreFn context
          placed++;
          break;
        }
      }
    }
  }

  // ── Secondary stack: a 2–3 man cluster from a DIFFERENT game's team ──────────
  // The classic large-field two-stack (4-3 / 5-2 / 4-2-2). Unlike the bring-back (same
  // game as the primary — a hedge that both sides erupt), this adds a SECOND, independent
  // correlated ceiling source from another game, which is the structure that actually wins
  // big GPPs. Best-effort: if no eligible team fits the remaining slots/salary, the lineup
  // is still valid (the optimizer fills the rest). Skipped entirely when secReserve === 0.
  let usedSecondaryTeam = null;
  if (secReserve > 0 && usedStackTeam) {
    const primaryGame = (pool.find(p => p.team === usedStackTeam) || {}).game || null;
    const battersPlaced = requiredSlots.filter(p => p && !rp(p, 'P')).length;
    const openHitterSlots = 8 - battersPlaced;
    if (openHitterSlots >= 2) {
      const excludeTeams = new Set([usedStackTeam, stackOpp, usedBringBackTeam].filter(Boolean));
      const rosteredSpOpps = new Set(requiredSlots.filter(p => p && rp(p, 'P') && p.opp).map(p => p.opp));
      // Eligible secondary teams: have batters, in a DIFFERENT game than the primary, pass
      // the environment gate, not banned, and (unless allowBvP) not the opponent of an SP
      // we've already rostered (which would create a banned batter-vs-pitcher pairing).
      const teamHasBatters = {};
      pool.forEach(p => {
        if (rp(p, 'P') || excludeTeams.has(p.team) || excludeNames.has(p.name)) return;
        if (!(p.salary > 0) || !((p.median || 0) > 0 || (p.ceiling || 0) > 0)) return;
        if (primaryGame && p.game === primaryGame) return;   // must be a different game
        if (!allowBvP && rosteredSpOpps.has(p.team)) return; // would clash with our SP
        if (bannedStackTeams.has(p.team)) return;
        if (!passesEnvironment(p.team)) return;
        teamHasBatters[p.team] = (teamHasBatters[p.team] || 0) + 1;
      });
      // Eligible teams with ≥2 batters; in auto mode require a genuinely good run
      // environment (≥4.3 implied) up front so the gate doesn't depend on iteration order.
      const autoMode = secondaryStackTarget === 'auto';
      let eligibleTeams = Object.keys(teamHasBatters).filter(t => teamHasBatters[t] >= 2);
      if (autoMode) eligibleTeams = eligibleTeams.filter(t => stackImplied(t) >= 4.3);
      eligibleTeams.sort((a, b) => stackImplied(b) - stackImplied(a));
      // Rotate the secondary across the portfolio: shuffle the top few environment-qualified
      // teams so different lineups pair with different second games. Strict best-first would
      // clone the same secondary into every lineup, collapsing diversity (dup exhaustion).
      const topK = eligibleTeams.slice(0, Math.min(4, eligibleTeams.length));
      for (let i = topK.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [topK[i], topK[j]] = [topK[j], topK[i]]; }
      const orderedTeams = [...topK, ...eligibleTeams.slice(4)];
      for (const team of orderedTeams) {
        // Size up to 3 only when there's room and the total is strong (auto); explicit
        // sizes (2/3) always attempt, clamped to the open hitter slots.
        let size = autoMode
          ? (openHitterSlots >= 3 && stackImplied(team) >= 4.6 ? 3 : 2)
          : Math.min(parseInt(secondaryStackTarget) || 2, openHitterSlots);
        size = Math.min(size, openHitterSlots);
        if (size < 2) continue;

        // Select this team's batters that fit the REMAINING open slots. We can't reuse
        // buildVirtualStack here — it picks the best adjacency window regardless of position,
        // but the primary stack has already consumed C/1B/2B/etc., so the secondary must be
        // drawn from players eligible for whatever slots are still open (mostly SS/OF). Sort
        // by PA-weighted ceiling so the cluster still skews to high-upside top-of-order bats.
        const teamBatters = pool.filter(p =>
          p.team === team && !rp(p, 'P') && !excludeNames.has(p.name) &&
          !requiredSlots.some(rs => rs && rs.name === p.name) &&
          p.salary > 0 && ((p.median || 0) > 0 || (p.ceiling || 0) > 0)
        ).sort((a, b) =>
          ((b.ceiling || 0) * 0.6 + (b.median || 0) * 0.4) * orderPAMult(b.order)
          - ((a.ceiling || 0) * 0.6 + (a.median || 0) * 0.4) * orderPAMult(a.order)
        );

        // Tentatively place up to `size` into open slots; roll back if we can't reach 2 so
        // we never scatter a lone batter from a team that couldn't form a real secondary.
        const placedIdx = [];
        for (const sp of teamBatters) {
          if (placedIdx.length >= size) break;
          const salUsed = requiredSlots.reduce((s, p) => s + (p ? p.salary : 0), 0);
          const minAllOpen = DK_SLOTS.reduce((s, slot, si) =>
            requiredSlots[si] ? s : s + (slot.key === 'P' ? 5500 : MIN_SALARY_PER_SLOT), 0);
          if (salUsed + sp.salary + (minAllOpen - MIN_SALARY_PER_SLOT) > SALARY_CAP) continue;
          for (let i = 0; i < ROSTER_SIZE; i++) {
            if (requiredSlots[i] || !DK_SLOTS[i].eligible(sp)) continue;
            requiredSlots[i] = sp;
            placedIdx.push(i);
            break;
          }
        }
        if (placedIdx.length >= 2) { usedSecondaryTeam = team; break; }
        placedIdx.forEach(i => { requiredSlots[i] = null; }); // roll back partial placement
      }
    }
  }

  // Precompute all player scores once — avoids re-evaluating the same scoreGpp context
  // on every greedy swap (was ~30M calls for a 20-lineup run). Stack/bring-back context
  // is stable within this call, so caching is safe.
  // Collect placed stack members' batting order positions for adjacency-aware depth boost.
  const primaryStackOrders = usedStackTeam
    ? requiredSlots.filter(p => p && !rp(p, 'P') && p.team === usedStackTeam && p.order > 0).map(p => p.order)
    : [];
  const scoreCtx = { ...context, pool, contestSize, primaryStackTeam: usedStackTeam, bringBackTeam: usedBringBackTeam, secondaryStackTeam: usedSecondaryTeam, primaryStackOrders };
  const baseScores = new Map(pool.map(p => [p.name, scoreGpp(p, scoreCtx)]));
  // Always apply jitter: 0.5 FPTS amplitude in the first cycle to break the determinism
  // that causes identical non-stack fillers across attempts (which floods dup tracking);
  // 3.0 FPTS in the recycle phase to force broader exploration.
  const effectiveJitter = jitter > 0 ? jitter : 0.5;
  const jitterMap = new Map(pool.map(p => [p.name, (Math.random() - 0.5) * effectiveJitter]));
  const scoreFn = p => (baseScores.get(p.name) || 0) + (jitterMap.get(p.name) || 0);
  const stackBonusFn = lu => gppStackBonus(lu, usedStackTeam, payoutType);

  // When a specific stackSize is forced, reject lineups that failed to place a stack.
  // This causes the portfolio builder to discard and retry, rather than accepting a
  // lineup with only a natural 2-3 player cluster.
  if (stackSize != null && !usedStackTeam) return null;

  // In mix mode targeting 5-man, reject if the placed stack has fewer than 5 batters —
  // BUT only when 5-man stacks are actually still available. If the entire avail5 pool
  // is exhausted (all used or filtered out), falling back to a 3-man stack is correct;
  // requiring placed≥5 when avail5 is empty would null-return every attempt and burn
  // the entire attempt budget without ever building another lineup.
  if (prefer5Man === true && !stackSize) {
    const placed = requiredSlots.filter(p => p && !rp(p, 'P') && p.team === usedStackTeam).length;
    // A 5-man stack is "genuinely available" only when:
    //   - not already committed to a lineup in this cycle
    //   - team isn't banned or exposure-capped
    //   - team passes Vegas/weather environment gates
    //   - at least 4 of its players are non-excluded (allow 1 capped player — greedy fills the gap
    //     from the same team; requiring ALL 5 was too strict and caused a cascade of null returns
    //     when high-exposure stack members got capped mid-build).
    const has5ManLeft = stacks5.some(s => {
      if (s.proj <= 0 || usedStackIds.has(s.id) || bannedStackTeams.has(s.team)) return false;
      if (!passesEnvironment(s.team)) return false;
      const resolved = s.players.filter(
        name => pool.find(p => p.name.toLowerCase() === name.toLowerCase() && !excludeNames.has(p.name))
      );
      return resolved.length >= Math.max(4, s.players.length - 1);
    });
    if (!usedStackTeam || (placed < 5 && has5ManLeft)) return null;
  }

  // In the recycle phase (jitter > 0), enable diversity mode in upgradeSalary so
  // the upgrade pass doesn't always normalize jitter-diversified lineups back to the
  // same high-salary chalk picks. diversityMode randomly samples among the top-3
  // salary-valid candidates instead of always taking #1.
  return optimizeLineup(pool, scoreFn, { excludeNames, requiredSlots, iterations, stackBonusFn, allowBvP, forceInclude, contestType: 'gpp', ownershipLambda, diversityMode: true });
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
    correlationScore: corrScore,
    avgBattingOrder: avgOrder,
    salaryEfficiency: salary > 0 ? (medianPts / salary * 1000).toFixed(2) : 'N/A',
    filledSlots: players.length,
    uniqueTeams: [...new Set(players.map(p => p.team))].length,
    uniqueGames: [...new Set(players.map(p => p.game).filter(Boolean))].length
  };
}

// ── Calibration System ──────────────────────────────────────────────────────

// Stored calibration factors — applied to player projections before optimization
let _calibration = { pitcherScale: 1.0, batterScale: 1.0, positionScales: {} };

function setCalibration(cal) {
  _calibration = { pitcherScale: 1.0, batterScale: 1.0, positionScales: {}, ...(cal || {}) };
}

function getCalibration() {
  return { ..._calibration };
}

// Returns a new pool array with projections scaled by calibration factors.
// positionScales (e.g. { SP: 0.91, OF: 0.59 }) take priority over the blanket
// pitcherScale/batterScale fallbacks. If everything is 1.0 returns the original
// array unchanged (no allocation).
function calibratePool(pool) {
  const { pitcherScale = 1.0, batterScale = 1.0, positionScales = {} } = _calibration;
  const hasPositionScales = Object.keys(positionScales).length > 0;
  if (pitcherScale === 1.0 && batterScale === 1.0 && !hasPositionScales) return pool;
  return pool.map(p => {
    // DK classic normalizes all pitchers to rosterPos='P'; also check 'SP'/'RP' for other formats
    const isPitcher = rp(p, 'P') || rp(p, 'SP') || rp(p, 'RP');
    const primaryPos = (p.rosterPos || p.dkPos || '').split('/')[0].trim();
    let scale;
    if (hasPositionScales && positionScales[primaryPos] !== undefined) {
      scale = positionScales[primaryPos];
    } else {
      scale = isPitcher ? pitcherScale : batterScale;
    }
    if (scale === 1.0) return p;
    return {
      ...p,
      floor: parseFloat(((p.floor || 0) * scale).toFixed(2)),
      median: parseFloat(((p.median || 0) * scale).toFixed(2)),
      ceiling: parseFloat(((p.ceiling || 0) * scale).toFixed(2))
    };
  });
}

// ── Calibration Analysis ────────────────────────────────────────────────────
//
// Compares projected medians to actual DK scores across historical slates to
// detect systematic bias by position, salary tier, and batting order.
//
// historyEntries: array of { playerActuals: { playerName: dkScore } }
// pool:           current projection pool (used to look up median/dkPos/salary/order)
//
// Returns an object with:
//   overall:       mean(actual / projected) across all matched players
//   rmse:          root-mean-squared error (projected vs actual)
//   positionBias:  { pos: ratio } — e.g. { SP: 0.92, OF: 1.04 }
//   tierBias:      { 'elite'|'mid'|'value': ratio }
//   orderBias:     { '1'..'9': ratio }
//   sampleSize:    total player-slate observations used
//   calibration:   a setCalibration()-compatible object derived from positionBias
//
// Ratios > 1.0 = projections are underestimating; < 1.0 = overestimating.
function computeCalibrationFactors(historyEntries, pool) {
  const byPos   = {};
  const byTier  = {};
  const byOrder = {};
  let globalSum = 0, globalCount = 0, sse = 0;

  const playerMap = {};
  for (const p of (pool || [])) {
    const key = (p.name || '').toLowerCase();
    playerMap[key] = p;
  }

  const MIN_SAMPLES = 20;

  for (const entry of (historyEntries || [])) {
    const actuals = entry.playerActuals;
    if (!actuals) continue;
    for (const [name, actual] of Object.entries(actuals)) {
      if (actual == null || actual === '') continue;
      const score = parseFloat(actual);
      if (isNaN(score)) continue;
      const p = playerMap[name.toLowerCase()];
      if (!p || !p.median || p.median <= 0) continue;

      const ratio = score / p.median;
      const pos   = (p.dkPos || p.rosterPos || '').split('/')[0].trim();
      const sal   = p.salary || 0;
      const tier  = sal >= 8000 ? 'elite' : sal >= 6500 ? 'mid' : 'value';
      const ord   = String(p.order || '');

      if (pos) {
        if (!byPos[pos])   byPos[pos]   = { sum: 0, n: 0 };
        byPos[pos].sum += ratio; byPos[pos].n++;
      }
      if (!byTier[tier]) byTier[tier] = { sum: 0, n: 0 };
      byTier[tier].sum += ratio; byTier[tier].n++;
      if (ord && ord >= '1' && ord <= '9') {
        if (!byOrder[ord]) byOrder[ord] = { sum: 0, n: 0 };
        byOrder[ord].sum += ratio; byOrder[ord].n++;
      }

      globalSum += ratio;
      globalCount++;
      sse += (score - p.median) ** 2;
    }
  }

  if (globalCount === 0) return null;

  const overall = parseFloat((globalSum / globalCount).toFixed(4));
  const rmse    = parseFloat(Math.sqrt(sse / globalCount).toFixed(2));

  const positionBias = {};
  for (const [pos, s] of Object.entries(byPos)) {
    if (s.n >= MIN_SAMPLES) positionBias[pos] = parseFloat((s.sum / s.n).toFixed(4));
  }

  const tierBias = {};
  for (const [tier, s] of Object.entries(byTier)) {
    if (s.n >= MIN_SAMPLES) tierBias[tier] = parseFloat((s.sum / s.n).toFixed(4));
  }

  const orderBias = {};
  for (const [ord, s] of Object.entries(byOrder)) {
    if (s.n >= 10) orderBias[ord] = parseFloat((s.sum / s.n).toFixed(4));
  }

  // Derive setCalibration()-compatible object from position bias.
  // Uses SP bias for pitcherScale, average batter position bias for batterScale.
  const batterPositions = ['C', '1B', '2B', '3B', 'SS', 'OF'];
  const batterBiases = batterPositions.map(pos => positionBias[pos]).filter(Boolean);
  const avgBatterBias = batterBiases.length > 0
    ? parseFloat((batterBiases.reduce((s, v) => s + v, 0) / batterBiases.length).toFixed(4))
    : overall;

  return {
    overall, rmse, sampleSize: globalCount,
    positionBias, tierBias, orderBias,
    calibration: {
      pitcherScale: positionBias['SP'] || overall,
      batterScale:  avgBatterBias,
      positionScales: positionBias
    }
  };
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

// Fix 5 — Continuous linear pitcher stuff boost (replaces step functions).
// Step functions created cliff-edge distortions: 25.9% whiff scored identically to 18%,
// then 26% jumped +4% in a single percentage point. Continuous scaling eliminates these.
// Calibrated so elite values still reach the same ±0.10/0.06 outer bounds as before.
function pitcherStuffBoost(player) {
  if (!player.whiffRate && !player.fastballVelo && !player.xERA) return 1.0;
  const whiff = player.whiffRate || 0;   // league avg ~23%
  const velo  = player.fastballVelo || 0; // league avg ~93 mph
  const hh    = player.hardHitRate || 0;  // league avg ~40% (lower = better)
  const xera  = player.xERA || 0;         // league avg ~4.00

  // (whiff - 23) * 0.0143 → 30% → +0.10, 26% → +0.043, 18% → -0.071 (cap -0.08)
  const whiffBoost = whiff > 0 ? Math.max(-0.08, Math.min(0.10, (whiff - 23) * 0.0143)) : 0;

  // (velo - 93) * 0.020 → 96 mph → +0.06, 90 mph → -0.06
  const veloBoost = velo > 0 ? Math.max(-0.06, Math.min(0.06, (velo - 93) * 0.020)) : 0;

  // (40 - hh) * 0.0086 → hh=33 → +0.06, hh=40 → 0, hh=47 → -0.06
  const hhBoost = hh > 0 ? Math.max(-0.06, Math.min(0.06, (40 - hh) * 0.0086)) : 0;

  // (4.00 - xera) * 0.075 → xERA=3.20 → +0.06, xERA=4.80 → -0.06
  const xeraBoost = xera > 0 ? Math.max(-0.06, Math.min(0.06, (4.00 - xera) * 0.075)) : 0;

  return Math.max(0.85, Math.min(1.25, 1.0 + whiffBoost + veloBoost + hhBoost + xeraBoost));
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

// ── Defense vs Position (DvP) Adjustment ────────────────────────────────────
// dvpData = { teamAbbr: { pos: { avgAllowed, rank, totalTeams } } }
// rank: 1 = most DK pts allowed to that position (easiest matchup), totalTeams = up to 30.
// Applied to batters only — pitcher DvP is not meaningful with this data structure.
function dvpMultiplier(player, dvpData) {
  if (!dvpData || rp(player, 'P')) return 1.0;
  const dvpPos = player.dkPos ? player.dkPos.split('/')[0].trim() : null;
  if (!dvpPos || !player.opp) return 1.0;
  const entry = dvpData[player.opp]?.[dvpPos];
  if (!entry || !entry.rank || !entry.totalTeams || entry.totalTeams < 2) return 1.0;
  // pct: 0.0 = easiest (rank 1, allows most pts), 1.0 = toughest
  const pct = (entry.rank - 1) / (entry.totalTeams - 1);
  // ±6% max: best matchup → +6%, worst → -6%, avg → 0%
  return 1.0 + (0.5 - pct) * 0.12;
}

// ── 14-Day Form Adjustment ────────────────────────────────────────────────────
// Uses per-player recent performance vs. their projection to detect hot/cold streaks.
// Batters:  recentAvgDK vs. player.median → hot streak = ceiling boost, slump = penalty.
// Pitchers: recentERA vs. league-avg baseline (4.20) → recent dominance or struggles.
// formWeight (0–100) from blendWeights scales the full effect.
// Requires ≥3 recent games for signal; returns 1.0 when data is absent.
// Max magnitude: ±6% — conservative to avoid over-weighting small samples.
function formMultiplier(player, formWeight) {
  if (!formWeight || formWeight <= 0) return 1.0;
  const wt = formWeight / 100;
  const MAX_BOOST = 0.06;

  if (rp(player, 'P')) {
    if (!player.recentERA || !player.recentGames || player.recentGames < 3) return 1.0;
    // Positive eraDelta = pitching better than league avg; negative = worse
    const eraDelta = 4.20 - player.recentERA;
    // ±1.0 ERA from avg → ±3% at full weight
    const rawBoost = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, eraDelta * 0.03));
    return 1.0 + rawBoost * wt;
  }

  if (!player.recentAvgDK || !player.median || player.median <= 0 || !player.recentGames || player.recentGames < 3) return 1.0;
  const ratio = player.recentAvgDK / player.median;
  // 20% hotter than projection → +6%; 20% cooler → -6%. Linear in between.
  const rawBoost = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, (ratio - 1.0) * 0.30));
  return 1.0 + rawBoost * wt;
}

// ── Platoon Split Adjustment ─────────────────────────────────────────────────
// batterHand: 'L' | 'R' | 'S' (switch) — from ROO projection file
// pitcherHand: 'L' | 'R' — from the opposing pitcher's ROO hand column
//
// Empirical platoon splits (2020–2024 FanGraphs wOBA differentials):
//   L vs L: ~-30 pts wOBA vs same hand baseline → ≈ -7% DFS pts
//   R vs R: ~-20 pts wOBA → ≈ -5% DFS pts
//   L vs R: ~+15 pts wOBA → ≈ +5% DFS pts
//   R vs L: ~+20 pts wOBA → ≈ +6% DFS pts
//   Switch:  always bats from advantaged side → ≈ +4% on average
//
// Values deliberately conservative — projection CSVs may already partially capture
// platoon, so we apply only the residual edge not reflected in the median/ceiling.
function platoonMultiplier(batterHand, pitcherHand) {
  if (!batterHand || !pitcherHand) return 1.0;
  const bh = batterHand.toUpperCase().charAt(0);
  const ph = pitcherHand.toUpperCase().charAt(0);
  if (bh === 'S') return 1.04;  // switch — always from advantaged side
  if (bh === 'L' && ph === 'L') return 0.93; // same-hand disadvantage (larger for L/L)
  if (bh === 'R' && ph === 'R') return 0.95; // same-hand disadvantage (smaller for R/R)
  if (bh === 'L' && ph === 'R') return 1.05; // platoon advantage
  if (bh === 'R' && ph === 'L') return 1.06; // platoon advantage (larger for R vs L)
  return 1.0;
}

// ── PA-weighted platoon (starter + bullpen) ──────────────────────────────────
// Fix #5: a batter faces the opposing STARTER for only ~62% of his plate appearances;
// the other ~38% come against the bullpen. Applying the full starter-hand platoon edge
// to 100% of expected production (the old behaviour) systematically overstates it,
// especially against a starter likely to be lifted early.
//
// We PA-weight the starter platoon edge by the starter share and handle the bullpen
// share separately:
//   • If the opposing bullpen's right-handed-innings share is known (bullpenInfo.rhpShare,
//     0–1), blend the reliever-platoon edge across that L/R mix.
//   • Otherwise the bullpen share regresses to neutral (1.0) — we don't invent a lean we
//     can't support, but we also stop pretending the starter faces every PA.
// STARTER_PA_SHARE is conservative; bumping it toward 1.0 recovers the old behaviour.
const STARTER_PA_SHARE = 0.62;
function platoonMultiplierPAWeighted(batterHand, starterHand, bullpenInfo = null) {
  if (!batterHand || !starterHand) return 1.0;
  const starterEdge = platoonMultiplier(batterHand, starterHand);

  let bullpenEdge = 1.0;
  const rhpShare = bullpenInfo && bullpenInfo.rhpShare != null ? bullpenInfo.rhpShare : null;
  if (rhpShare != null && rhpShare >= 0 && rhpShare <= 1) {
    bullpenEdge = rhpShare * platoonMultiplier(batterHand, 'R')
                + (1 - rhpShare) * platoonMultiplier(batterHand, 'L');
  }

  return STARTER_PA_SHARE * starterEdge + (1 - STARTER_PA_SHARE) * bullpenEdge;
}

// ── Unconfirmed Lineup Penalty ───────────────────────────────────────────────
// Reduces the optimizer score for players not yet confirmed in the batting order.
// Only activates when context.hasConfirmedData = true (confirmed lineups have been
// fetched for this slate). Without that flag, returns 1.0 so unloaded states are
// not penalised.
//
// Priority order:
//   1. player.playProb (0–1): explicit probability of playing. Used when a player
//      is listed as questionable/doubtful and the user or data feed has set a play
//      probability. E.g. playProb=0.55 on a questionable player scales their
//      projection by 55%, reflecting that they might DNP entirely.
//      Note: playProb=1.0 (or undefined) means "assume fully available".
//   2. player.isConfirmed: standard confirmed-lineup check.
//   3. Fallback: -12% (batters) or -10% (pitchers) for unconfirmed players.
function unconfirmedMultiplier(player, context) {
  // Explicit play probability takes priority — used for injury/questionable modeling.
  if (player.playProb !== undefined && player.playProb >= 0 && player.playProb < 1.0) {
    return Math.max(0, player.playProb);
  }
  if (!context?.hasConfirmedData) return 1.0;
  if (player.isConfirmed) return 1.0;
  return rp(player, 'P') ? 0.90 : 0.88;
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
// gameExposure: { [game]: count } — how many lineups have their primary stack in each game
// maxGameExposurePct: 0–1 fraction of lineups concentrating on the single most-stacked game
function computePortfolioDiversity(lineups) {
  if (lineups.length < 2) return { avgOverlap: 0, maxOverlap: 0, score: 100, distribution: {}, pairs: 0, gameExposure: {}, maxGameExposurePct: 0 };

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

  // ── Game exposure: track which game each lineup's primary stack is from ─────
  // "Primary stack" = team with the most batters in the lineup (ties: first alphabetically).
  // This catches over-concentration on a single game even when player-level overlap
  // looks fine (e.g. all lineups stack different LAD subsets but always in one game).
  const gameExposure = {};
  for (const lu of lineups) {
    const teamCts = {};
    lu.filter(Boolean).forEach(p => { if (!rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
    const primaryTeam = Object.entries(teamCts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    const game = primaryTeam ? lu.find(p => p && p.team === primaryTeam)?.game : null;
    if (game) gameExposure[game] = (gameExposure[game] || 0) + 1;
  }
  const maxGameExposurePct = lineups.length > 0
    ? parseFloat((Math.max(0, ...Object.values(gameExposure)) / lineups.length).toFixed(2))
    : 0;

  // Derive actual roster size from the data — ROSTER_SIZE constant is for classic (10),
  // but showdown lineups have 6 players; using the wrong constant inflates diversity scores.
  const actualRosterSize = lineups[0]?.filter(Boolean).length || ROSTER_SIZE;
  const avgOverlap = parseFloat((totalOverlap / pairs).toFixed(1));
  const score = Math.round(Math.max(0, (actualRosterSize - avgOverlap) / actualRosterSize * 100));
  return { avgOverlap, maxOverlap: maxOv, score, distribution: dist, pairs, gameExposure, maxGameExposurePct };
}

// ── Portfolio Simulation ─────────────────────────────────────────────────────

// Build a synthetic opponent lineup by sampling players from the pool
// weighted by their projected ownership (field proxy).
// Realistic GPP field lineups stack — pick a primary team and lock in 3 batters
// from that team first, then fill remaining slots with ownership-weighted picks.
// cache: optional pre-computed { batters, pitchers, slotBatters } from simulatePortfolio.
// Avoids redundant pool.filter() on every one of the 2000+ field lineup builds.
function buildFieldLineup(pool, cache = null) {
  const batters  = cache ? cache.batters  : pool.filter(p => !rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  const pitchers = cache ? cache.pitchers : pool.filter(p => rp(p, 'P')  && p.own > 0 && p.salary > 0 && p.median > 0);
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

  // Variable stack size: 50% 3-man, 30% 4-man, 20% 5-man — mirrors real GPP field distribution
  const stackRoll = Math.random();
  const targetStackSize = stackRoll < 0.50 ? 3 : stackRoll < 0.80 ? 4 : 5;

  const stackBatters = batters.filter(p => p.team === stackTeam);
  let stackFilled = 0;
  const shuffledStack = stackBatters.slice().sort(() => Math.random() - 0.5 + (Math.random() > 0.5 ? 0.2 : -0.2));
  for (let i = 2; i < ROSTER_SIZE && stackFilled < targetStackSize; i++) {
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

  // ── Secondary mini-stack: 2 batters from a different game ──────────────────
  // Real GPP field lineups are almost never one stack + singles — they typically
  // pair a primary stack with a 2-man mini-stack from another game (4-3, 3-3, etc.).
  // Modelling this produces a wider, heavier-tailed field score distribution that
  // more accurately reflects what lineups are actually competing against.
  const primaryGame = batters.find(p => p.team === stackTeam)?.game;
  if (primaryGame) {
    const miniCandsBatters = batters.filter(p => !usedNames.has(p.name) && p.game !== primaryGame);
    if (miniCandsBatters.length >= 2) {
      // Pick a secondary stack team ownership-weighted from batters in other games
      const secTeamOwn = {};
      miniCandsBatters.forEach(p => { secTeamOwn[p.team] = (secTeamOwn[p.team] || 0) + (p.own || 1); });
      const secTeams = Object.keys(secTeamOwn);
      const totalSecOwn = secTeams.reduce((s, t) => s + secTeamOwn[t], 0);
      let rs = Math.random() * totalSecOwn;
      let secondTeam = secTeams[secTeams.length - 1];
      for (const t of secTeams) { rs -= secTeamOwn[t]; if (rs <= 0) { secondTeam = t; break; } }

      const miniPool = miniCandsBatters.filter(p => p.team === secondTeam);
      // Variable secondary size: ~35% of field lineups run a 3-man secondary, the rest 2-man.
      // Mirrors the real field (and now our own builder, which can place a 2–3 secondary), so
      // simROI compares like-for-like instead of against a field that only ever 2-stacks.
      const miniTarget = Math.random() < 0.35 ? 3 : 2;
      let miniPlaced = 0;
      for (let i = 2; i < ROSTER_SIZE && miniPlaced < miniTarget; i++) {
        if (lu[i]) continue;
        const slot = DK_SLOTS[i];
        const eligible = miniPool.filter(p => !usedNames.has(p.name) && slot.eligible(p));
        if (!eligible.length) continue;
        const pick = pickWeighted(eligible);
        lu[i] = pick; usedNames.add(pick.name); miniPlaced++;
      }
    }
  }

  // Fill remaining empty batter slots with ownership-weighted picks.
  // Use pre-grouped slot eligibility from cache when available to avoid re-filtering all batters.
  for (let i = 2; i < ROSTER_SIZE; i++) {
    if (lu[i]) continue;
    const slot = DK_SLOTS[i];
    const eligible = cache ? cache.slotBatters[i - 2] : batters.filter(p => slot.eligible(p));
    const cands = eligible.filter(p => !usedNames.has(p.name));
    if (!cands.length) continue;
    const pick = pickWeighted(cands);
    lu[i] = pick; usedNames.add(pick.name);
  }
  return lu.every(Boolean) ? lu : null;
}

// Sample a full lineup score with intra-lineup correlation using Cholesky decomposition.
// Reuses the same asymmetric distribution as samplePlayerScore but with correlated z-scores.
//
// Fix #4: applies the shared _corrDampener (default 1.0) rather than a hardcoded 0.5.
// Previously this path used 0.5 while simulateLineup used _corrDampener, so the
// displayed P10/P50/P90 (from simulateLineup) and the cashRate/ROI numbers (from this
// path, via simulatePortfolio) were computed at different correlation strengths.
// Both paths now share the same dampener so the distribution shown to the user matches
// the distribution the ROI engine ranks on. The user-facing corrDampener slider still
// scales both consistently.
function sampleCorrelatedLineup(players, L) {
  const n = players.length;
  const z = [];
  for (let i = 0; i < n; i++) z.push(randNorm());
  const correlated = [];
  for (let i = 0; i < n; i++) {
    let val = 0;
    for (let j = 0; j <= i; j++) val += L[i][j] * z[j];
    correlated.push(val);
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += samplePlayerScore(players[i], correlated[i] * _corrDampener);
  }
  return total;
}

// Run per-lineup Monte Carlo across the full portfolio.
// Returns array of per-lineup stats sorted by simROI_lb (lower-confidence-bound ROI) descending.
// fieldLineups: number of synthetic opponent lineups to simulate (field size proxy).
// Async: yields to the UI thread every 200 field sims and every 5 user lineups
// so the browser never freezes on large portfolios.
// ── Lineup duplication estimate ("dupes") ────────────────────────────────────
// Estimates how many OTHER entries in a contest of `contestSize` are expected to be
// IDENTICAL to this lineup. Dupes split the top of the payout: a lineup duplicated 40×
// in a 100k-field GPP shares any first-place finish 41 ways, so low dupes = high
// leverage. This is the headline metric SaberSim/Stokastic charge for, and it is the
// mechanical reason behind the "high cash rate / negative ROI" failure mode — chalk
// builds win when everyone else's identical build also wins.
//
// Model: each field entry is approximated as an independent draw whose probability of
// matching this exact lineup is the product of its players' ownership fractions. The raw
// independent product massively UNDERstates real dupes because the field clusters onto a
// small set of valid, high-projection constructions — a 5-man stack is effectively ONE
// correlated decision, not five independent ones. We correct for this clustering by
// raising the product to DUPE_CONCENTRATION (≈0.5): for a 10-man roster this behaves as
// though ~5 independent choices drive duplication, which lands dupe counts in the
// observed range (a chalk lineup ≈ 8–10 dupes in a 100k field, a contrarian one ≈ 0).
// Returns { expected, pUnique, risk }.
const DUPE_CONCENTRATION = 0.5;
function estimateDupes(players, contestSize = 1000) {
  const valid = (players || []).filter(Boolean);
  if (!valid.length || contestSize <= 1) return { expected: 0, pUnique: 1, risk: 'Unique' };
  let logProd = 0;
  for (const p of valid) {
    // Clamp ownership into a sane range; treat missing/zero ownership as a small default
    // so a single un-projected player doesn't collapse the whole estimate to zero.
    const ownPct = p.own > 0 ? p.own : 3;
    logProd += Math.log(Math.min(0.95, Math.max(0.005, ownPct / 100)));
  }
  const expected = (contestSize - 1) * Math.exp(logProd * DUPE_CONCENTRATION);
  const pUnique = Math.exp(-expected); // Poisson P(0 other identical entries)
  const risk = expected < 0.5 ? 'Unique' : expected < 2 ? 'Low' : expected < 8 ? 'Med' : 'High';
  return { expected, pUnique, risk };
}

// ── Sim-derived "optimal lineup %" + true leverage ───────────────────────────
// For each Monte Carlo draw we sample every player's fantasy score (with a shared
// per-team game-environment shock so a team's bats boom together — the dominant MLB
// correlation), build the highest-scoring valid lineup for that draw, and tally
// appearances. A player's optimal% = fraction of draws in which they land in the optimal
// lineup. This is the game-theory leverage signal the paid tools sell:
//   trueLeverage = optimal% − ownership%
// so a player optimal in 30% of winning lineups but only 10% owned is +20 (a strong GPP
// play), while a 40%-owned chalk bat that's optimal 25% of the time is −15 (a fade).
// Cheap by design: independent per-player sampling + one shared team shock + a greedy
// fill per draw — no Cholesky, so 300–500 draws over a full pool run in well under a sec.
function computeOptimalExposure(pool, opts = {}) {
  const { numDraws = 400, allowBvP = false, maxBattersPerTeam = 5, teamShock = 0.35 } = opts;
  const players = (pool || []).filter(p => p && p.salary > 0 && p.median > 0);
  if (players.length < ROSTER_SIZE) return {};

  const counts = new Map();
  for (const p of players) counts.set(p.name, 0);

  for (let d = 0; d < numDraws; d++) {
    const teamShocks = new Map();
    const drawScores = new Map();
    for (const p of players) {
      const team = p.team || '?';
      if (!teamShocks.has(team)) teamShocks.set(team, randNorm(0, 1));
      const base = samplePlayerScore(p);
      // Same-team correlation: shift batters by a shared team shock scaled by their own
      // upside spread, so a team that "booms" this draw pulls its whole stack up together.
      // Pitchers are left idiosyncratic (no positive same-team-bat correlation).
      const isP = rp(p, 'P');
      const spread = Math.max(1, (p.ceiling || p.median) - (p.median || 0));
      const score = base + (isP ? 0 : teamShock * teamShocks.get(team) * spread);
      drawScores.set(p.name, Math.max(0, score));
    }
    const lu = greedyFill(players, q => drawScores.get(q.name) || 0, new Set(),
                          new Array(ROSTER_SIZE).fill(null), allowBvP, maxBattersPerTeam);
    if (!lu || lu.some(x => !x)) continue;
    for (const p of lu) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  }

  const out = {};
  for (const p of players) {
    const pct = parseFloat((counts.get(p.name) / numDraws * 100).toFixed(1));
    out[p.name] = { optimalPct: pct, trueLeverage: parseFloat((pct - (p.own || 0)).toFixed(1)) };
  }
  return out;
}

async function simulatePortfolio(lineups, pool, numSims = 2000, contestType = 'gpp', manualCashLine = null, manualWinLine = null, payoutType = 'top20', contestSize = 1000, skipLineupStats = false, onSimProgress = null, customPayoutConfig = null) {
  if (!lineups.length || !pool.length) return [];

  const isCash = contestType === 'cash';

  // Payout config: cashPct = fraction of field that cashes, payoutMultipliers for EV
  const payoutConfig = {
    top20:   { cashPct: 0.20, cashMult: 2.5,  winMult: 15,  winPct: 0.005 },
    top10:   { cashPct: 0.10, cashMult: 4.0,  winMult: 20,  winPct: 0.002 },
    winner:  { cashPct: 0.01, cashMult: 80.0, winMult: 80,  winPct: 0.005 },
    double:  { cashPct: 0.50, cashMult: 1.9,  winMult: 1.9, winPct: 0.50 },
    // custom: overridden by customPayoutConfig when provided
    custom:  customPayoutConfig || { cashPct: 0.20, cashMult: 2.5, winMult: 15, winPct: 0.005 },
  };
  const pc = (isCash ? { cashPct: 0.50, cashMult: 1.9, winMult: 1.9, winPct: 0.50 }
                     : (payoutConfig[payoutType] || payoutConfig.top20));

  // ── Multi-tier payout curve (Fix #3) ────────────────────────────────────────
  // Real GPP payouts have many rungs (top 0.1%, 0.5%, 1%, 2%, 5%, 10%, 20% …), each
  // paying a different multiple of the entry fee. The old model collapsed this to two
  // points (min-cash + top-0.5%), which under-rewards the 5×–40× mid-ladder finishes
  // that actually drive GPP ROI — exactly the finishes a high-ceiling lineup earns.
  //
  // Each tier is { pctTop, mult, lev }: finishing within the top `pctTop` fraction of
  // the field pays `mult`× the entry fee; `lev` marks the exclusive tiers where field
  // duplication matters, so ownLeverage is applied there. Tiers are evaluated as DISJOINT
  // bands (a top-2% finish is paid the 2% rung, not also the 5%/10%/20% rungs), so there
  // is no double counting. cash/custom derive a 2-tier curve that exactly reproduces the
  // previous behaviour.
  const STANDARD_TIERS = {
    top20: [
      { pctTop: 0.001, mult: 50,  lev: true },
      { pctTop: 0.005, mult: 20,  lev: true },
      { pctTop: 0.02,  mult: 8,   lev: false },
      { pctTop: 0.05,  mult: 4,   lev: false },
      { pctTop: 0.10,  mult: 2.5, lev: false },
      { pctTop: 0.20,  mult: 1.5, lev: false },
    ],
    top10: [
      { pctTop: 0.001, mult: 60,  lev: true },
      { pctTop: 0.005, mult: 25,  lev: true },
      { pctTop: 0.02,  mult: 10,  lev: false },
      { pctTop: 0.05,  mult: 5,   lev: false },
      { pctTop: 0.10,  mult: 3,   lev: false },
    ],
    winner: [
      { pctTop: 0.001, mult: 120, lev: true },
      { pctTop: 0.005, mult: 40,  lev: true },
      { pctTop: 0.01,  mult: 15,  lev: false },
    ],
  };

  // Resolve the active tier set. A custom config may supply its own `tiers`; otherwise
  // cash and custom fall back to a 2-tier {win, cash} curve equivalent to the legacy math.
  let tiers;
  if (isCash) {
    tiers = [{ pctTop: pc.cashPct, mult: pc.cashMult, lev: false }];
  } else if (payoutType === 'custom') {
    if (Array.isArray(customPayoutConfig?.tiers) && customPayoutConfig.tiers.length) {
      tiers = customPayoutConfig.tiers.map(t => ({ pctTop: t.pctTop, mult: t.mult, lev: !!t.lev }));
    } else {
      tiers = [
        { pctTop: pc.winPct,  mult: pc.winMult,  lev: true },
        { pctTop: pc.cashPct, mult: pc.cashMult, lev: false },
      ];
    }
  } else {
    tiers = STANDARD_TIERS[payoutType] || STANDARD_TIERS.top20;
  }
  // Sort ascending by pctTop (most exclusive first) and drop degenerate tiers.
  tiers = tiers.filter(t => t.pctTop > 0 && t.mult > 0).sort((a, b) => a.pctTop - b.pctTop);
  if (!tiers.length) tiers = [{ pctTop: 0.20, mult: 1.5, lev: false }];

  // Pre-compute pool filters and slot eligibility once — reused across all numSims field builds
  // to avoid O(pool × slots × numSims) redundant filter work inside buildFieldLineup.
  const _fBatters  = pool.filter(p => !rp(p, 'P') && p.own > 0 && p.salary > 0 && p.median > 0);
  const _fPitchers = pool.filter(p => rp(p, 'P')  && p.own > 0 && p.salary > 0 && p.median > 0);
  const _fSlotBatters = DK_SLOTS.slice(2).map(slot => _fBatters.filter(p => slot.eligible(p)));
  const _fieldCache = { batters: _fBatters, pitchers: _fPitchers, slotBatters: _fSlotBatters };

  // Pre-build field score distribution once (shared across all lineups for consistency).
  // Field lineups use correlated sampling to model realistic GPP variance.
  // Yield every 200 sims so the UI thread stays responsive.
  const fieldScores = [];
  for (let s = 0; s < numSims; s++) {
    if (s > 0 && s % 200 === 0) await new Promise(r => setTimeout(r, 0));
    const fieldLu = buildFieldLineup(pool, _fieldCache);
    if (!fieldLu) { fieldScores.push(0); continue; }
    const fieldPlayers = fieldLu.filter(Boolean);
    const fieldCorr = buildCorrelationMatrix(fieldPlayers);
    const fieldL = cholesky(fieldCorr);
    fieldScores.push(sampleCorrelatedLineup(fieldPlayers, fieldL));
  }
  fieldScores.sort((a, b) => a - b);

  // Field score line for each payout tier (the score needed to reach that tier).
  // tiers are ascending by pctTop, so tierLines is descending (most exclusive = highest).
  const fieldLineFor = pctTop => {
    const idx = Math.min(fieldScores.length - 1, Math.floor(fieldScores.length * (1 - pctTop)));
    return fieldScores[idx] || 0;
  };
  const tierLines = tiers.map(t => fieldLineFor(t.pctTop));
  // Honour manual cash/win line overrides: the win line pins the most-exclusive tier,
  // the cash line pins the least-exclusive (largest pctTop) tier. Intermediate tiers
  // stay field-derived. This preserves the manual-line feature under the tiered model.
  if (manualWinLine != null) tierLines[0] = manualWinLine;
  if (manualCashLine != null) tierLines[tierLines.length - 1] = manualCashLine;
  // cashLine / winLine retained for the result payload + UI (least / most exclusive tier).
  const winLine = tierLines[0];
  const cashLine = tierLines[tierLines.length - 1];

  // Process each lineup sequentially, yielding every 5 lineups so the browser
  // can paint progress updates and stay interactive throughout.
  const results = [];
  for (let i = 0; i < lineups.length; i++) {
    if (i % 5 === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (onSimProgress) onSimProgress(i, lineups.length);
    }
    const lu = lineups[i];
    if (!lu || !lu.every(Boolean)) continue;
    // skipLineupStats=true in the filter pass — p10/p50/p90 aren't used for ranking
    // and simulateLineup would run numSims wasted iterations per lineup.
    const luSim = skipLineupStats ? null : simulateLineup(lu, numSims);
    if (!skipLineupStats && !luSim) continue;

    const players = lu.filter(Boolean);
    const L = getCachedCholesky(players); // reuses simulateLineup's Cholesky when same lineup

    // Ownership leverage: low-ownership lineups have less field duplication,
    // so when they hit they face fewer ties at the top. Scale win payout up
    // for low-own builds, down for chalk. Neutral at ~15% avg ownership.
    const avgOwn = players.reduce((s, p) => s + (p.own || 0), 0) / players.length;
    // Cap at 1.35 — a 35% max win-payout boost for low-ownership lineups.
    // Slope scaled by log10(contestSize)/3 so leverage is context-aware:
    //   ~0.67 at 1k entries (small GPP), ~1.0 at 1M (massive field).
    // In a 50-person single-entry, low ownership barely matters since there are
    // few duplicated lineups; in a 50k-entry max-field the leverage is significant.
    const sizeScale = Math.log10(Math.max(contestSize, 100)) / 3;
    const ownLeverage = Math.max(0.75, Math.min(1.35, 1.0 + (15 - avgOwn) * 0.025 * sizeScale));

    // Bootstrap SE: split sims into B_SE groups so we can estimate simulation noise.
    // simROI_lb = simROI - SE is used as the ranking key during the filter pass,
    // preventing the filter from systematically selecting "lucky" noise outliers.
    const B_SE = 20;
    const groupSz = Math.floor(numSims / B_SE);
    const nTiers = tierLines.length;

    // Per-tier hit counts: tierHits[j] = sims whose score reached tier j (cumulative,
    // i.e. score >= tierLines[j]). groupTierHits[g][j] is the same within each SE group.
    const tierHits = new Array(nTiers).fill(0);
    const groupTierHits = Array.from({ length: B_SE }, () => new Array(nTiers).fill(0));
    // When stats were computed (display pass), simulateLineup already drew numSims
    // correlated totals through the same L — reuse them instead of sampling a second
    // numSims here, which halves the work of the display sim. The filter pass
    // (skipLineupStats) has no luSim, so it samples fresh as before.
    const reuseTotals = luSim ? luSim.rawTotals : null;
    for (let s = 0; s < numSims; s++) {
      const ourScore = reuseTotals ? reuseTotals[s] : sampleCorrelatedLineup(players, L);
      const g = Math.min(Math.floor(s / groupSz), B_SE - 1);
      // tierLines is descending; once a score clears tier j it clears every less-exclusive
      // tier too, so we can break at the first (most exclusive) tier it reaches.
      for (let j = 0; j < nTiers; j++) {
        if (ourScore >= tierLines[j]) {
          for (let k = j; k < nTiers; k++) { tierHits[k]++; groupTierHits[g][k]++; }
          break;
        }
      }
    }
    // cashRate = reached the least-exclusive tier; winRate = reached the most-exclusive.
    const cashRate = tierHits[nTiers - 1] / numSims;
    const winRate  = tierHits[0] / numSims;

    // Tiered EV (Fix #3).
    //
    // tierHits[j] is cumulative P(reach tier j) × numSims. The DISJOINT band probability
    // of finishing exactly in tier j (better than tier j+1 but not as good as tier j-1) is
    //   band_0 = P(reach tier 0)
    //   band_j = P(reach tier j) − P(reach tier j-1)   for j ≥ 1
    // Each band is paid its own tier multiplier (× ownLeverage for the lev-flagged exclusive
    // tiers), so there is no double counting. EV = Σ band_j × mult_j; ROI = EV − 1.
    //
    // For cash (double-up) the single tier carries no win component and ownLeverage does
    // not apply (the payout is fixed regardless of uniqueness) — this reduces to the
    // previous cashRate × cashMult − 1.
    const tierEV = (hits, total) => {
      let ev = 0;
      for (let j = 0; j < nTiers; j++) {
        const cum = hits[j] / total;
        const prevCum = j > 0 ? hits[j - 1] / total : 0;
        const band = cum - prevCum;
        const lev = (!isCash && tiers[j].lev) ? ownLeverage : 1.0;
        ev += band * tiers[j].mult * lev;
      }
      return ev;
    };
    const simROI = tierEV(tierHits, numSims) - 1;

    // Compute bootstrap SE from group-level ROIs.
    // SE estimates how much simROI would vary across re-runs at this sample size.
    // simROI_lb = simROI - SE penalises high-variance estimates during filter ranking,
    // so the filter keeps genuinely better lineups rather than noise winners.
    const groupROIs = [];
    for (let g = 0; g < B_SE; g++) {
      const gROI = tierEV(groupTierHits[g], groupSz) - 1;
      groupROIs.push(gROI * 100);
    }
    const meanGROI = groupROIs.reduce((s, v) => s + v, 0) / B_SE;
    // SE of the overall simROI estimate = sample_SD_of_groups / sqrt(B_SE).
    // The naive formula (population SD of groups) overestimates by sqrt(B_SE) ≈ 4.5×,
    // which inflates the penalty for high-variance (high-ceiling) lineups and causes
    // the filter to systematically prefer low-variance/consistent builds over GPP-
    // optimal high-upside builds when simROI values are close.
    const sdGroups  = Math.sqrt(groupROIs.reduce((s, v) => s + (v - meanGROI) ** 2, 0) / (B_SE - 1));
    const simROI_se = parseFloat((sdGroups / Math.sqrt(B_SE)).toFixed(1));
    const simROI_lb = parseFloat((simROI * 100 - simROI_se).toFixed(1));

    // Expected duplication of this exact lineup across the contest field (Feature #1).
    const dup = estimateDupes(players, contestSize);

    results.push({
      lu,
      expectedDupes: parseFloat(dup.expected.toFixed(2)),
      pUnique: parseFloat((dup.pUnique * 100).toFixed(0)),
      dupeRisk: dup.risk,
      p10: luSim ? luSim.p10 : null,
      p50: luSim ? luSim.p50 : null,
      p90: luSim ? luSim.p90 : null,
      mean: luSim ? luSim.mean : null,
      cashRate: parseFloat((cashRate * 100).toFixed(1)),
      winRate: parseFloat((winRate * 100).toFixed(2)),
      cashLine: parseFloat(cashLine.toFixed(1)),
      winLine: parseFloat(winLine.toFixed(1)),
      simROI: parseFloat((simROI * 100).toFixed(1)),
      simROI_lb,
      simROI_se,
      ownLeverage: parseFloat(ownLeverage.toFixed(2))
    });
  }

  // Sort by lower-confidence-bound ROI so the filter pass selects genuinely
  // better lineups rather than ones that got lucky in the simulation noise.
  results.sort((a, b) => b.simROI_lb - a.simROI_lb);
  return results;
}

// ── Showdown Optimizer ───────────────────────────────────────────────────────
// Single-game DFS: 1 CPT (1.5× salary + points, isCpt=true) + 5 FLEX (isFlex=true).
// CPT medians are already scaled ×1.5 in app.js at pool-build time, so scoring
// functions need no special-casing — slot eligibility handles the separation.
// The name-duplicate check (lu.some(lp => lp.name === p.name)) naturally enforces
// the no-CPT+FLEX-same-player rule since both variants share the same base name.

function greedyFillShowdown(pool, scoreFn, excludeNames = new Set(), requiredSlots = new Array(SHOWDOWN_ROSTER_SIZE).fill(null), relaxed = false) {
  const lu = [...requiredSlots];
  const isNotInjured = p => p.dkStatus !== 'O' && p.dkStatus !== 'D' &&
    p.injuryType !== 'IL' && p.injuryType !== 'DL' && !(p.injuryFlag && !p.injuryType);
  const sorted = [...pool].filter(p => !excludeNames.has(p.name) && p.salary > 0 && isNotInjured(p))
    .sort((a, b) => scoreFn(b) - scoreFn(a));
  // Reserve only the absolute cheapest eligible player per remaining slot so the greedy
  // fill can always complete without over-constraining expensive picks in earlier slots.
  const realisticMin = relaxed ? SHOWDOWN_SLOTS.map(() => 0) : SHOWDOWN_SLOTS.map((slot, i) => {
    if (lu[i]) return 0;
    const eligible = pool.filter(p => slot.eligible(p) && !excludeNames.has(p.name) && p.salary > 0 && isNotInjured(p))
      .sort((a, b) => a.salary - b.salary);
    if (!eligible.length) return MIN_SALARY_PER_SLOT;
    return eligible[0].salary; // cheapest eligible = minimum reserve
  });
  for (let i = 0; i < SHOWDOWN_ROSTER_SIZE; i++) {
    if (lu[i]) continue;
    for (const p of sorted) {
      if (lu.some(lp => lp && lp.name === p.name)) continue;
      if (!SHOWDOWN_SLOTS[i].eligible(p)) continue;
      const salSoFar = lu.reduce((s, lp) => s + (lp ? lp.salary : 0), 0);
      const reserveRemaining = realisticMin.reduce((s, m, j) => j > i && !lu[j] ? s + m : s, 0);
      if (salSoFar + p.salary > SHOWDOWN_SALARY_CAP - reserveRemaining) continue;
      lu[i] = p;
      break;
    }
  }
  return lu;
}

function optimizeShowdownLineup(pool, scoreFn, opts = {}) {
  const {
    excludeNames = new Set(),
    requiredSlots = new Array(SHOWDOWN_ROSTER_SIZE).fill(null),
    forceInclude = new Set(),
    exposureLimits = null,
  } = opts;

  const effectiveRequired = [...requiredSlots];
  if (forceInclude.size) {
    for (const fname of forceInclude) {
      if (effectiveRequired.some(p => p?.name === fname)) continue;
      const fp = pool.find(p => p.name === fname && !excludeNames.has(p.name) && p.salary > 0);
      if (!fp) continue;
      for (let i = 0; i < SHOWDOWN_ROSTER_SIZE; i++) {
        if (!effectiveRequired[i] && SHOWDOWN_SLOTS[i].eligible(fp)) { effectiveRequired[i] = fp; break; }
      }
    }
  }

  const excluded = new Set(excludeNames);
  if (exposureLimits) {
    pool.forEach(p => { if ((exposureLimits[p.name] || 1) <= 0) excluded.add(p.name); });
  }
  effectiveRequired.forEach(p => { if (p) excluded.delete(p.name); });

  let lu = greedyFillShowdown(pool, scoreFn, excluded, effectiveRequired);
  // If the salary-reservation pass failed, retry without the reservation (guarantees a lineup)
  if (!lu || lu.some(p => !p)) {
    lu = greedyFillShowdown(pool, scoreFn, excluded, effectiveRequired, /* relaxed */ true);
  }
  if (!lu || lu.some(p => !p)) return lu;

  // Use nameId (unique per CPT/FLEX entry) as cache key so CPT and FLEX variants
  // of the same player don't share a cached score.
  const scoreCache = new Map();
  const cachedScore = p => {
    const key = p.nameId || (p.name + (p.isCpt ? '|cpt' : p.isFlex ? '|flex' : ''));
    if (!scoreCache.has(key)) scoreCache.set(key, scoreFn(p));
    return scoreCache.get(key);
  };

  // Salary utilization bonus: computed lazily so the cache is populated by slotPools
  // before we evaluate. Scales with the top player's score so it remains meaningful
  // regardless of projection magnitude (zero projections vs full ROO data).
  const lineupTotalScore = lineup => {
    // Avoid spread on potentially large Map — use reduce instead of Math.max(...values())
    const maxScore = scoreCache.size
      ? scoreCache.values().reduce?.((m, v) => Math.max(m, v), 0) ??
        [...scoreCache.values()].reduce((m, v) => Math.max(m, v), 0)
      : 1;
    return lineup.reduce((s, p) => s + cachedScore(p), 0) +
      (lineup.reduce((s, p) => s + p.salary, 0) / SHOWDOWN_SALARY_CAP) * (maxScore * 0.1);
  };

  // No projection requirement — showdown players may not have ROO projections yet;
  // the greedy seed already handles that case and the local search improves when data exists.
  const slotPools = SHOWDOWN_SLOTS.map((slot, i) => {
    if (effectiveRequired[i]) return [];
    return pool
      .filter(p => slot.eligible(p) && !excluded.has(p.name) && p.salary > 0)
      .sort((a, b) => cachedScore(b) - cachedScore(a));
  });

  let improved = true;
  let passes = 0;
  while (improved && passes < 15) {
    improved = false;
    passes++;
    for (let i = 0; i < SHOWDOWN_ROSTER_SIZE; i++) {
      if (effectiveRequired[i]) continue;
      const curTotal = lineupTotalScore(lu);
      const salWithoutCur = lu.reduce((s, p, j) => s + (p && j !== i ? p.salary : 0), 0);
      let bestTotal = curTotal;
      let bestPick = null;
      for (const cand of slotPools[i]) {
        if (lu.some((p, j) => p && j !== i && p.name === cand.name)) continue;
        if (salWithoutCur + cand.salary > SHOWDOWN_SALARY_CAP) continue;
        const testLu = [...lu]; testLu[i] = cand;
        const testTotal = lineupTotalScore(testLu);
        if (testTotal > bestTotal) { bestTotal = testTotal; bestPick = cand; }
      }
      if (bestPick) { lu[i] = bestPick; improved = true; }
    }
  }
  return lu;
}

async function buildShowdownPortfolio(pool, opts = {}, onProgress = null) {
  const {
    numLineups = 20,
    maxExposure = 0.60,
    contestType = 'gpp',
    maxOverlap = 4,
    playerExposureOverrides = {},
    minSalary = 0,
    context = {},
  } = opts;

  const cptPlayers = pool.filter(p => p.isCpt === true);
  const flexPlayers = pool.filter(p => p.isFlex === true);

  if (!cptPlayers.length || flexPlayers.length < 5) {
    console.warn('[Showdown portfolio] Pool missing CPT/FLEX flags. CPT:', cptPlayers.length, 'FLEX:', flexPlayers.length, '— ensure DK showdown salary file was loaded.');
    return { lineups: [], exposureCounts: {} };
  }

  const lineups = [];
  const exposureCounts = {}; // combined (used for cap enforcement)
  const cptCounts = {};      // CPT slot only
  const flexCounts = {};     // FLEX slots only
  let attempts = 0;
  const maxAttempts = Math.max(300, numLineups * 30);
  const _diag = { nullLu: 0, overlapFail: 0, dupFail: 0 };

  // Player→lineup index for O(players) overlap checks
  const playerLineupIndex = new Map();
  const usedFingerprints = new Set();

  // Progressive overlap relaxation: auto-raise cap after 60 consecutive overlap-only failures
  let effectiveMaxOverlap = maxOverlap;
  let overlapStreak = 0;

  while (lineups.length < numLineups && attempts < maxAttempts) {
    attempts++;

    // Yield to the event loop every 25 attempts so the main thread stays responsive
    // (buildShowdownPortfolio runs on the main thread, not in a worker). Without this,
    // even a 300-attempt run blocks the UI for several seconds, appearing frozen.
    if (attempts % 25 === 0) {
      if (onProgress) onProgress(lineups.length / numLineups);
      await new Promise(r => setTimeout(r, 0));
    }

    const excluded = new Set();
    pool.forEach(p => {
      const cnt = exposureCounts[p.name] || 0;
      const maxPct = playerExposureOverrides[p.name]?.max ?? maxExposure;
      const maxCnt = Math.max(1, Math.floor(maxPct * numLineups));
      if (cnt >= maxCnt) excluded.add(p.name);
    });

    // Player MIN-exposure overrides (parity with the classic builder): force a player in
    // once the lineups still needed can no longer satisfy the player's min target unless
    // they appear now. exposureCounts is keyed by name and shared across the CPT/FLEX
    // variants, so the override governs the player's combined exposure.
    const forceNames = new Set();
    if (Object.keys(playerExposureOverrides).length) {
      const remaining = Math.max(0, numLineups - lineups.length);
      if (remaining > 0) {
        for (const [name, ov] of Object.entries(playerExposureOverrides)) {
          if (!ov || ov.min == null) continue;
          const targetCount = Math.ceil(numLineups * ov.min);
          const currentCount = exposureCounts[name] || 0;
          if (targetCount - currentCount >= remaining) {
            forceNames.add(name);
            excluded.delete(name); // a forced player can't also be excluded
          }
        }
      }
    }

    // GPP: jitter diversifies lineup composition across iterations.
    // Cash: no jitter — floor-focused scoring should be deterministic so the
    // same best players are consistently selected rather than randomly swapped.
    const jitter = contestType === 'gpp' ? () => (Math.random() - 0.5) * 0.8 : () => 0;
    const scoreFn = p => {
      const base = contestType === 'cash'
        ? scoreCash(p, { ...context, pool })
        : scoreGpp(p, { ...context, pool });
      return base + jitter();
    };

    const lu = optimizeShowdownLineup(pool, scoreFn, { excludeNames: excluded, forceInclude: forceNames });
    if (!lu || lu.some(p => !p)) { _diag.nullLu++; overlapStreak = 0; continue; }

    const salTotal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    if (salTotal > SHOWDOWN_SALARY_CAP) { overlapStreak = 0; continue; }
    if (minSalary > 0 && salTotal < minSalary) { _diag.salaryFail = (_diag.salaryFail || 0) + 1; overlapStreak = 0; continue; }

    const luNames = new Set(lu.map(p => p && p.name).filter(Boolean));
    // Captain-aware fingerprint: same 6 players with a different captain = distinct lineup
    const cptName = lu[0]?.name || '';
    const flexFp = lu.slice(1).filter(Boolean).map(p => p.name).sort().join('|');
    const fp = cptName + '|' + flexFp;
    if (usedFingerprints.has(fp)) { _diag.dupFail++; overlapStreak = 0; continue; }

    // Progressive overlap relaxation: raise cap after 60 consecutive attempts blocked only by overlap
    if (overlapStreak >= 60 && effectiveMaxOverlap > 0 && lineups.length < numLineups) {
      effectiveMaxOverlap = Math.min(SHOWDOWN_ROSTER_SIZE - 2, effectiveMaxOverlap + 1);
      overlapStreak = 0;
    }

    let tooSimilar = false;
    if (effectiveMaxOverlap > 0 && lineups.length > 0) {
      const overlapCounts = new Map();
      for (const name of luNames) {
        const indices = playerLineupIndex.get(name);
        if (!indices) continue;
        for (const luIdx of indices) {
          const c = (overlapCounts.get(luIdx) || 0) + 1;
          if (c > effectiveMaxOverlap) { tooSimilar = true; break; }
          overlapCounts.set(luIdx, c);
        }
        if (tooSimilar) break;
      }
    }
    if (tooSimilar) { _diag.overlapFail++; overlapStreak++; continue; }
    overlapStreak = 0;

    usedFingerprints.add(fp);
    const acceptedIdx = lineups.length;
    lu.filter(Boolean).forEach(p => {
      exposureCounts[p.name] = (exposureCounts[p.name] || 0) + 1;
      if (p.isCpt) cptCounts[p.name] = (cptCounts[p.name] || 0) + 1;
      else flexCounts[p.name] = (flexCounts[p.name] || 0) + 1;
      if (!playerLineupIndex.has(p.name)) playerLineupIndex.set(p.name, new Set());
      playerLineupIndex.get(p.name).add(acceptedIdx);
    });
    lineups.push(lu);
    if (onProgress) onProgress(lineups.length / numLineups);
  }
  if (effectiveMaxOverlap > maxOverlap) _diag.overlapRelaxed = effectiveMaxOverlap;
  dlog(`[Showdown portfolio] ${lineups.length}/${numLineups} in ${attempts}/${maxAttempts} attempts`, _diag);

  return { lineups, exposureCounts, cptCounts, flexCounts, requested: numLineups, _diag, exposureRelaxUsed: 0 };
}

// ── Slate-Type Defaults (Fix 8) ─────────────────────────────────────────────
// Returns recommended portfolio parameters for a given slate game count.
// Turbo slates (4 games) need higher ownership pressure, tighter overlap, more
// 5-man stacks, and stricter game exposure caps due to extreme field concentration.
// Full main slates (12+ games) can tolerate looser exposure and more variation.
function getSlateDefaults(slateGameCount) {
  const n = slateGameCount || 8;
  if (n <= 4) return {
    maxExposure: 0.50, maxExposurePitcher: 0.50,
    maxOverlap: 4, stackPct5: 80, ownershipLambda: 0.08,
    maxGameExposure: 0.55, minSalary: 48500,
    label: 'Turbo (≤4 games)'
  };
  if (n <= 6) return {
    maxExposure: 0.55, maxExposurePitcher: 0.55,
    maxOverlap: 4, stackPct5: 72, ownershipLambda: 0.06,
    maxGameExposure: 0.60, minSalary: 48500,
    label: 'Short slate (5–6 games)'
  };
  if (n >= 12) return {
    maxExposure: 0.65, maxExposurePitcher: 0.65,
    maxOverlap: 6, stackPct5: 55, ownershipLambda: 0.03,
    maxGameExposure: 0.70, minSalary: 48500,
    label: 'Full main slate (12+ games)'
  };
  // 7–11 game main slate — engine defaults
  return {
    maxExposure: 0.60, maxExposurePitcher: 0.60,
    maxOverlap: 5, stackPct5: 65, ownershipLambda: 0.04,
    maxGameExposure: 0.65, minSalary: 48500,
    label: 'Main slate (7–11 games)'
  };
}

// ── Best Plays Analysis ─────────────────────────────────────────────────────
// Surfaces the single best plays for single-entry (floor/value) and GPP
// (leverage/contrarian stacks). Research-backed thresholds:
//   SP: K% ≥ 22%, opp implied < 4.0, win prob > 50%
//   SE stack: implied ≥ 4.5, batting order 1-5, OBP/contact profile
//   GPP stack: rank 3-6 by implied total (not chalk #1-#2), low avg ownership
//   Bring-back: opposing team in contrarian stack's game (game-stack correlation)

function getBestPlays(pool, ctx, contestSize) {
  contestSize = contestSize || 1000;
  ctx = ctx || {};
  const vegasData = ctx.vegasData || {};

  // Detect slate size from pool — number of distinct games in play.
  // Used to scale contrarian targeting: on a 4-game slate, #2-#5 are the contrarian
  // candidates; on a 15-game slate, #3-#6 is more appropriate.
  const slateGameCount = new Set(pool.filter(p => p.game).map(p => p.game)).size || 8;

  const pitchers = pool.filter(p => rp(p, 'P') && !p.isOpener && p.median > 0);
  const batters  = pool.filter(p => !rp(p, 'P') && p.median > 0);
  const gppCtx   = Object.assign({}, ctx, { contestSize });

  dlog('[getBestPlays] pool=%d pitchers=%d batters=%d games=%d contestSize=%d',
    pool.length, pitchers.length, batters.length, slateGameCount, contestSize);
  if (!pitchers.length) console.warn('[getBestPlays] No projected pitchers in pool — pitcher picks will be empty');
  if (!batters.length)  console.warn('[getBestPlays] No projected batters in pool — all batter sections will be empty');
  const teamsWithoutVegas = [...new Set(pool.map(p => p.team).filter(Boolean))].filter(t => !vegasData[t]);
  if (teamsWithoutVegas.length) dlog('[getBestPlays] Teams missing vegas data: %s', teamsWithoutVegas.join(', '));

  // Score all players without mutating pool entries
  function scoreSet(players) {
    return players.map(p => {
      const ss = scoreSingle(p, ctx);
      const gs = scoreGpp(p, gppCtx);
      const lv = calcLeverage(p, contestSize);
      const implied    = (vegasData[p.team] || {}).impliedTotal || 0;
      const oppImplied = (vegasData[p.opp]  || {}).impliedTotal || 0;
      const value = p.salary > 0 ? (p.median / p.salary * 1000) : 0;
      return { p, ss, gs, lv, implied, oppImplied, value };
    });
  }

  const pitcherScores = scoreSet(pitchers);
  const batterScores  = scoreSet(batters);

  // Build team groupings keyed by team abbr
  const teamMap = {};
  batterScores.forEach(e => {
    const t = e.p.team;
    if (!teamMap[t]) teamMap[t] = { team: t, entries: [], game: e.p.game || '', opp: e.p.opp || '' };
    teamMap[t].entries.push(e);
  });

  // Rank teams by implied total (primary GPP stack ordering)
  const teamRanks = Object.values(teamMap).map(t => {
    const top5 = [...t.entries].sort((a, b) => b.p.median - a.p.median).slice(0, 5);
    const implied    = (vegasData[t.team] || {}).impliedTotal || 0;
    const oppImplied = (vegasData[t.opp]  || {}).impliedTotal || 0;
    const ou     = implied + oppImplied;
    const avgOwn  = top5.reduce((s, e) => s + (e.p.own || 0), 0) / Math.max(1, top5.length);
    const avgCeil = top5.reduce((s, e) => s + (e.p.ceiling || 0), 0) / Math.max(1, top5.length);
    const avgGpp  = top5.reduce((s, e) => s + e.gs, 0) / Math.max(1, top5.length);
    return { team: t.team, implied, oppImplied, ou, avgOwn, avgCeil, avgGpp, top5, game: t.game, opp: t.opp };
  }).filter(t => t.implied > 0 || t.avgGpp > 0).sort((a, b) => b.implied - a.implied || b.avgGpp - a.avgGpp);

  // ── SINGLE ENTRY ─────────────────────────────────────────────────────────────

  // Best pitchers: ranked by single-entry score (floor + K% + matchup)
  const sePitchers = [...pitcherScores]
    .sort((a, b) => b.ss - a.ss)
    .slice(0, 2)
    .map(({ p, ss, gs, lv, oppImplied }) => {
      const tags = [];
      if (p.kRate >= 25) tags.push({ label: `K% ${p.kRate.toFixed(0)}%`, type: 'good' });
      else if (p.kRate >= 20) tags.push({ label: `K% ${p.kRate.toFixed(0)}%`, type: 'ok' });
      else if (p.kRate > 0) tags.push({ label: `K% ${p.kRate.toFixed(0)}%`, type: 'bad' });
      if (oppImplied > 0 && oppImplied <= 3.8) tags.push({ label: `Opp ${oppImplied.toFixed(1)} R (elite)`, type: 'good' });
      else if (oppImplied > 0 && oppImplied <= 4.3) tags.push({ label: `Opp ${oppImplied.toFixed(1)} R`, type: 'ok' });
      else if (oppImplied > 4.5) tags.push({ label: `Opp ${oppImplied.toFixed(1)} R`, type: 'bad' });
      const wp = p.winProb || 0;
      if (wp >= 0.60) tags.push({ label: `${Math.round(wp * 100)}% WP`, type: 'good' });
      else if (wp >= 0.50) tags.push({ label: `${Math.round(wp * 100)}% WP`, type: 'ok' });
      else if (wp > 0)   tags.push({ label: `${Math.round(wp * 100)}% WP`, type: 'bad' });
      return { p, ss, gs, lv, oppImplied, tags };
    });

  // Best hitter stack: team whose top-3 order-1-5 batters have highest avg single score
  const seStacks = Object.values(teamMap).map(t => {
    const orderly = t.entries.filter(e => e.p.order >= 1 && e.p.order <= 5);
    const top3 = [...orderly].sort((a, b) => b.ss - a.ss).slice(0, 3);
    if (top3.length < 2) return null;
    const avgSS    = top3.reduce((s, e) => s + e.ss, 0) / top3.length;
    const implied  = (vegasData[t.team] || {}).impliedTotal || 0;
    const avgFloor = top3.reduce((s, e) => s + (e.p.floor || 0), 0) / top3.length;
    return { team: t.team, entries: top3, avgSS, implied, avgFloor, game: t.game };
  }).filter(Boolean).sort((a, b) => b.avgSS - a.avgSS);
  const seStack = seStacks[0] || null;

  // Value plays: median ÷ salary (pts per $1000)
  const valuePlays = [...batterScores]
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // ── GPP ──────────────────────────────────────────────────────────────────────

  // Research: 64.5% of GPP wins used a 5-man stack; 83.8% had at least 4-man.
  // The top-implied teams are heavily chalked — target the next tier down for leverage.
  // Slate-aware contrarian band:
  //   ≤6 teams: contrarian starts at rank 2 (only top 1 is "chalk" in such a small pool)
  //   7-10 teams: rank 2 (standard short slate)
  //   11+ teams: rank 3 (standard main slate — top 2 are over-chalked)
  // Also detect "tight cluster" where #1-#3 are within 0.3 runs of each other —
  // in that case, all three are effectively chalk, push contrarian start to rank 4.
  const totalTeams = teamRanks.length;
  let contrarianStart = totalTeams <= 6 ? 1 : totalTeams <= 10 ? 1 : 2;
  if (teamRanks.length >= 3 && (teamRanks[0].implied - teamRanks[2].implied) < 0.3) {
    contrarianStart = Math.max(contrarianStart, 3); // top-3 is a chalk cluster
  }
  const contrarianEnd = Math.min(totalTeams - 1, contrarianStart + 4);
  const contrarianCandidates = teamRanks.slice(contrarianStart, contrarianEnd + 1).sort((a, b) => a.avgOwn - b.avgOwn);
  const contrarianStack = contrarianCandidates[0] || null;
  dlog('[getBestPlays] teamRanks top-5 (by implied): %s',
    teamRanks.slice(0, 5).map(t => `${t.team} ${t.implied.toFixed(1)}`).join(', '));
  dlog('[getBestPlays] contrarian band: ranks %d-%d → candidates: %s → selected: %s (avgOwn %.1f%%)',
    contrarianStart + 1, contrarianEnd + 1,
    contrarianCandidates.map(t => t.team).join(', '),
    contrarianStack?.team || 'NONE',
    contrarianStack?.avgOwn || 0);
  if (!contrarianStack) console.warn('[getBestPlays] No contrarian stack found — not enough teams with vegas data');
  const contrarianRank  = contrarianStack
    ? teamRanks.findIndex(t => t.team === contrarianStack.team) + 1
    : null;
  // Chalk warning: include #1 always, and #2 if the implied-total gap between #1 and #2
  // is less than 0.5 runs (otherwise #2 has meaningfully different expected output).
  const chalkCount = teamRanks.length >= 2 && (teamRanks[0].implied - teamRanks[1].implied) < 0.5 ? 2 : 1;

  // Bring-back: 2-3 hitters from the opposing team in the contrarianStack's game.
  // Captures game-stack correlation — both offenses benefit from a high-scoring game.
  let bringBack = null;
  if (contrarianStack && teamMap[contrarianStack.opp]) {
    const oppEntries = teamMap[contrarianStack.opp].entries
      .filter(e => e.p.order >= 1 && e.p.order <= 7)
      .sort((a, b) => b.gs - a.gs)
      .slice(0, 3);
    if (oppEntries.length >= 2) {
      const avgOwn   = oppEntries.reduce((s, e) => s + (e.p.own || 0), 0) / oppEntries.length;
      const oImplied = (vegasData[contrarianStack.opp] || {}).impliedTotal || 0;
      bringBack = { team: contrarianStack.opp, entries: oppEntries, avgOwn, implied: oImplied };
    }
  }

  // Leverage plays: ceiling ÷ ownership ratio, require ceiling > 22 and own < 18
  const leveragePlays = [...batterScores, ...pitcherScores]
    .filter(e => (e.p.own || 0) < 18 && (e.p.ceiling || 0) > 22)
    .map(e => ({ ...e, levScore: (e.p.ceiling || 0) / Math.max((e.p.own || 0.5), 0.5) }))
    .sort((a, b) => b.levScore - a.levScore)
    .slice(0, 8);

  // Boom/bust: low ownership (<12%), high ceiling/median ratio — the one-off HR play
  const boomBust = [...batterScores]
    .filter(e => (e.p.own || 0) < 12 && (e.p.ceiling || 0) > 25)
    .map(e => ({ ...e, upside: (e.p.ceiling || 0) / Math.max(e.p.median || 1, 1) }))
    .sort((a, b) => b.upside - a.upside)
    .slice(0, 5);

  return {
    singleEntry: { pitchers: sePitchers, stack: seStack, valuePlays },
    gpp: { chalkStacks: teamRanks.slice(0, chalkCount), contrarianStack, contrarianRank, bringBack, leveragePlays, boomBust, teamRanks },
    slateContext: { gameCount: slateGameCount, totalTeams, contrarianStart: contrarianStart + 1, contrarianEnd: contrarianEnd + 1 },
  };
}

// ── Field Distribution Simulation ────────────────────────────────────────

// Generate synthetic field lineups for GPP ROI calculation
function generateFieldLineups(pool, numField = 50, context = {}) {
  if (!pool || pool.length < ROSTER_SIZE) return [];
  const fieldLineups = [];
  // Create synthetic field by running optimizer at population ownership levels
  for (let i = 0; i < numField; i++) {
    // Small jitter to ownership creates field variance
    const fieldPool = pool.map(p => ({
      ...p,
      own: (p.own || 0) * (0.85 + Math.random() * 0.30) // ±15% ownership jitter
    }));
    const fieldLu = optimizeLineup(fieldPool, p => scoreGpp(p, context), {
      iterations: 2000,
      contestType: 'gpp',
      ownershipLambda: 0.02 // light ownership pressure (field less ownership-aware)
    });
    if (fieldLu && fieldLu.every(Boolean)) fieldLineups.push(fieldLu);
  }
  return fieldLineups.slice(0, numField);
}

// Compute true GPP ROI: portfolio vs. synthetic field
function computeGppRoi(portfolioLineups, fieldLineups, portfolioSims, payoutStructure = null) {
  if (!portfolioLineups.length || !fieldLineups.length || !portfolioSims.length) return null;
  
  // Default payout structure (top 20% cash)
  const numField = fieldLineups.length || 100;
  const payout = payoutStructure || {
    cashPlaces: Math.ceil(numField * 0.20),
    winPlace: 1,
    toWin: numField * 10,
    toCash: 10
  };
  
  const results = [];
  for (const sim of portfolioSims) {
    const portfolioScores = portfolioLineups.map((lu, idx) => {
      const luScore = lu.filter(Boolean).reduce((s, p) => {
        return s + (sim.playerScores?.[p.name] || sim.playerStats?.find(ps => ps.name === p.name)?.p50 || p.median || 0);
      }, 0);
      return { idx, score: luScore };
    });
    
    const fieldScores = fieldLineups.map((lu, idx) => {
      const luScore = lu.filter(Boolean).reduce((s, p) => {
        return s + (sim.playerScores?.[p.name] || sim.playerStats?.find(ps => ps.name === p.name)?.p50 || p.median || 0);
      }, 0);
      return { idx: -1 - idx, score: luScore }; // negative to distinguish
    });
    
    const allLineups = [...portfolioScores, ...fieldScores].sort((a, b) => b.score - a.score);
    
    const portfolioCashes = portfolioScores.filter(lu => {
      const rank = allLineups.findIndex(x => x.idx === lu.idx);
      return rank >= 0 && rank < payout.cashPlaces;
    }).length;
    
    const portfolioWins = portfolioScores.filter(lu => {
      const rank = allLineups.findIndex(x => x.idx === lu.idx);
      return rank === 0;
    }).length;
    
    results.push({ portfolioCashes, portfolioWins });
  }
  
  // Aggregate metrics
  const totalCashes = results.reduce((s, r) => s + r.portfolioCashes, 0);
  const totalWins = results.reduce((s, r) => s + r.portfolioWins, 0);
  const cashRate = totalCashes / (results.length * portfolioLineups.length);
  const winRate = totalWins / results.length;
  const expectedPayout = totalWins * payout.toWin + Math.max(0, totalCashes - totalWins) * payout.toCash;
  const roi = (expectedPayout / (results.length * portfolioLineups.length * 10)) - 1;
  
  return { cashRate, winRate, roi, totalCashes, totalWins, fieldSize: numField };
}

// ── Know Your Edge: lineup edge profile vs chalk field baseline ───────────────
// Prices one lineup against a synthetic "chalk" baseline and a tiered payout model.
// Returns a structured profile suitable for display in the Edge Card.
//
// opts:
//   payoutType  — 'top20' | 'top10' | 'winner' | 'double'
//   fieldSize   — total entries in the contest
//   entryFee    — dollars per entry
//   cashLine    — score threshold for bottom cash tier (from sim score-line inputs)
//   top10Line   — score threshold for mid tier
//   winLine     — score threshold for top tier
function computeEdgeProfile(lineup, rawTotals, pool, opts = {}) {
  const {
    payoutType = 'top20',
    fieldSize  = 10000,
    entryFee   = 20,
    cashLine   = null,
    top10Line  = null,
    winLine    = null,
  } = opts;

  const players = (lineup || []).filter(Boolean);
  if (!players.length) return null;
  const n = rawTotals?.length || 0;

  // ── Payout multipliers per tier (gross, includes entry-fee return) ──────────
  // Three tiers mapped to the three score lines: win / top10 / cash
  const payoutMults = {
    top20:  { win: 18, top10: 5.0, cash: 2.0 },
    top10:  { win: 30, top10: 8.0, cash: 3.0 },
    winner: { win: 80, top10: 12,  cash: 1.5 },
    double: { win: 1.9, top10: 1.9, cash: 1.9 },
  };
  const mults = payoutMults[payoutType] || payoutMults.top20;

  // ── ROI estimation from raw sim totals ───────────────────────────────────────
  let roi = null, ev = null, cashPct = null, top10Pct = null, winPct = null;
  if (n > 0) {
    const sorted = rawTotals.slice().sort((a, b) => a - b);
    const pctAt  = f => sorted[Math.max(0, Math.floor((1 - f) * n))];
    const cl  = cashLine  ?? pctAt(0.20);
    const t10 = top10Line ?? pctAt(0.10);
    const wl  = winLine   ?? pctAt(0.03);

    cashPct  = rawTotals.filter(s => s >= cl).length  / n;
    top10Pct = rawTotals.filter(s => s >= t10).length / n;
    winPct   = rawTotals.filter(s => s >= wl).length  / n;

    // Ownership leverage: contrarian lineups share prizes with fewer co-winners
    const avgOwn = players.reduce((s, p) => s + (p.own || 0), 0) / players.length;
    const sizeScale = Math.log10(Math.max(fieldSize, 100)) / 3;
    const ownLev = Math.max(0.75, Math.min(1.5, 1.0 + (15 - avgOwn) * 0.025 * sizeScale));

    const w  = Math.max(0, winPct);
    const t  = Math.max(0, top10Pct - winPct);
    const c  = Math.max(0, cashPct  - top10Pct);
    ev  = (w * mults.win * ownLev + t * mults.top10 + c * mults.cash) * entryFee;
    roi = (ev / entryFee - 1) * 100;
  }

  // ── Chalk baseline: best-owned unique player at each DK slot ────────────────
  const chalkSeen = new Set();
  const chalk = DK_SLOTS.map(slot => {
    const best = pool
      .filter(p => slot.eligible(p) && !chalkSeen.has(p.name) && (p.own || 0) > 0)
      .sort((a, b) => (b.own || 0) - (a.own || 0))[0] || null;
    if (best) chalkSeen.add(best.name);
    return best;
  }).filter(Boolean);

  const chalkAvgOwn  = chalk.length ? chalk.reduce((s, p) => s + (p.own  || 0), 0) / chalk.length : 0;
  const chalkBatOwn  = chalk.filter(p => !rp(p, 'P')).reduce((s, p) => s + (p.own || 0), 0) / Math.max(1, chalk.filter(p => !rp(p, 'P')).length);
  const chalkPitOwn  = chalk.filter(p =>  rp(p, 'P')).reduce((s, p) => s + (p.own || 0), 0) / Math.max(1, chalk.filter(p =>  rp(p, 'P')).length);
  const chalkProj    = chalk.reduce((s, p) => s + (p.median || 0), 0);
  const chalkLev     = chalk.reduce((s, p) => s + calcLeverage(p, fieldSize), 0);

  // ── Your lineup metrics ──────────────────────────────────────────────────────
  const batters  = players.filter(p => !rp(p, 'P'));
  const pitchers = players.filter(p =>  rp(p, 'P'));
  const lineupAvgOwn = players.reduce((s, p) => s + (p.own || 0), 0) / players.length;
  const lineupBatOwn = batters.length  ? batters.reduce((s, p) => s + (p.own || 0), 0) / batters.length  : 0;
  const lineupPitOwn = pitchers.length ? pitchers.reduce((s, p) => s + (p.own || 0), 0) / pitchers.length : 0;
  const lineupProj   = players.reduce((s, p) => s + (p.median || 0), 0);
  const lineupLev    = players.reduce((s, p) => s + calcLeverage(p, fieldSize), 0);

  // ── Dupe risk ────────────────────────────────────────────────────────────────
  const { expected: dupesExpected, pUnique, risk: dupeRisk } = estimateDupes(players, fieldSize);

  return {
    // ROI
    roi, ev, entryFee, payoutType, fieldSize,
    cashPct, top10Pct, winPct,
    // Lineup ownership
    lineupAvgOwn, lineupBatOwn, lineupPitOwn,
    lineupProj, lineupLev,
    // Chalk baseline
    chalkAvgOwn, chalkBatOwn, chalkPitOwn,
    chalkProj, chalkLev,
    // Deltas (positive = you lead)
    projDelta: lineupProj - chalkProj,
    ownDelta:  chalkAvgOwn - lineupAvgOwn, // positive = you're more contrarian
    levDelta:  lineupLev   - chalkLev,
    // Dupe
    dupesExpected, pUnique, dupeRisk,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

return {
  // Constants
  SALARY_CAP, ROSTER_SIZE, MIN_SALARY_PER_SLOT, DK_SLOTS,
  SHOWDOWN_SALARY_CAP, SHOWDOWN_ROSTER_SIZE, SHOWDOWN_SLOTS,
  rp,

  // Debug control
  setDebug, getDebug,

  // Simulation
  simulateLineup,
  computeLineupRates,
  simulatePortfolio,
  samplePlayerScore,
  estimateDupes,
  computeOptimalExposure,

  // Correlation
  getCorrelation,
  buildCorrelationMatrix,
  buildPairCorrelations,
  getPairCorrelation,
  setCorrScale, getCorrScale,
  setSimDiversity, getSimDiversity,
  setCorrDampener, getCorrDampener,
  setVegasContext, // for game-O/U-aware correlation scaling

  // Tail-event calibration (Fix #3)
  setTailRates, getTailRates, computeTailRatesFromHistory,

  // Scoring
  scoreCash, scoreSingle, scoreGpp,
  calcLeverage, calcGppScore,
  optimalExposureBoost,

  // Adjustments
  weatherMultiplier, weatherMultiplierDirectional, parkMultiplier,
  vegasAdjustment, vegasPitcherAdjustment,
  teamScoringAdjustment,
  statcastCeilingBoost, pitcherStuffBoost, bullpenAdjustment, catcherFramingAdjustment, sprintSpeedBoost, calcPortfolioOverlap, computePortfolioDiversity, umpireMultiplier,
  dvpMultiplier, platoonMultiplier, platoonMultiplierPAWeighted, unconfirmedMultiplier,
  computeStackAdjacency, computeStackAdjacencyFromPool,

  // Projection blending
  blendProjections,

  // Optimizer
  optimizeLineup, solveOptimal, greedyFill,
  generateCashLineup, generateSingleLineup, generateGppLineup,
  gppStackBonus,

  // Portfolio
  buildPortfolio,
  buildShowdownPortfolio, optimizeShowdownLineup,

  // Field distribution simulation (NEW: True GPP ROI computation)
  generateFieldLineups,
  computeGppRoi,

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
  calibratePool,
  computeCalibrationFactors,

  // Stack synthesis
  buildVirtualStack, buildAutoStacks,

  // Stack analytics
  calcAnalyticalStackP90,

  // Field simulation & true GPP ROI (NEW: Field distribution model)
  generateFieldLineups,
  computeGppRoi,
  computeEdgeProfile,

  // Slate defaults (Fix 8)
  getSlateDefaults,

  // Ownership helpers (Fix 1)
  positionalOwnDefault, effectiveOwn,

  // Ownership projection & input-sanity layer (Fix #1)
  projectOwnership, auditOwnership, applyOwnershipProjection,

  // Internal projection engine (season rate stats → DK point estimates)
  estimateBatterPA, buildInternalBatterProjection, buildInternalPitcherProjection, buildInternalProjections,

  // Best Plays surfacing & Phase 3 automation
  getBestPlays, bestPlaysWeighting, analyzePortfolioDiversity, enforceContrarianStack, enforcePlayInclusionTarget,
};

})();
